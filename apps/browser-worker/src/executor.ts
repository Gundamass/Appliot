import { ApprovalStore, PolicyDeniedError, verifyAndConsumeApproval } from "@resume/action-policy";
import type { ExecutableCommand, WorkerResponse } from "@resume/contracts";
import type { Locator, Route } from "playwright-core";
import { basename } from "node:path";
import { BrowserObserver, type BrowserObservation } from "./observer.js";
import type { ActivityMonitor } from "./activity-monitor.js";
import { selectChoiceGroup, selectCustomControl } from "./control-adapters.js";

type ExecutionResponse = Extract<WorkerResponse, { type: "execution_result" }>;

const UPLOAD_PARSE_SAMPLE_MS = 100;
const UPLOAD_PARSE_WAIT_CAP_MS = 8_000;

export class ControlledExecutor {
  private readonly approvals = new ApprovalStore();
  private current?: BrowserObservation;

  constructor(
    private readonly observer: BrowserObserver,
    private readonly approvalKey: Uint8Array,
    private readonly fileResolver?: (fileId: string) => Promise<string | undefined>,
    private readonly activityMonitor?: Pick<ActivityMonitor, "runAutomation">
  ) {}

  async observe(taskId: string) {
    this.current = await this.observer.observe(taskId);
    return this.current.snapshot;
  }

  async execute(command: ExecutableCommand, isCurrent: () => boolean = () => true): Promise<ExecutionResponse> {
    const current = this.current;
    if (!current || current.snapshot.taskId !== command.taskId || current.snapshot.id !== command.snapshotId) {
      return this.blocked(command, "stale_snapshot", current?.snapshot);
    }
    let expectedReadback: unknown;
    const warnings: string[] = [];

    try {
      verifyAndConsumeApproval(command, this.approvalKey, this.approvals);
    } catch (error) {
      return this.blocked(
        command,
        error instanceof PolicyDeniedError ? error.code : "approval_invalid",
        current.snapshot
      );
    }

    try {
      if (!isCurrent()) return this.blocked(command, "execution_invalidated", current.snapshot);
      if (command.type === "fill") {
        expectedReadback = command.value;
        const locator = current.registry.field(command.fieldId);
        if (!locator) return this.blocked(command, "field_not_found", current.snapshot);
        const field = current.snapshot.fields.find((candidate) => candidate.id === command.fieldId);
        if (!isCurrent()) return this.blocked(command, "execution_invalidated", current.snapshot);
        await this.runAutomation(async () => {
          if (!isCurrent()) return;
          if (field?.type === "checkbox") {
            await locator.setChecked(Boolean(command.value));
          } else {
            await locator.fill(String(command.value ?? ""));
          }
          await locator.blur();
        });
      } else if (command.type === "select") {
        const locator = current.registry.field(command.fieldId);
        if (!locator) return this.blocked(command, "field_not_found", current.snapshot);
        const field = current.snapshot.fields.find((candidate) => candidate.id === command.fieldId);
        if (!isCurrent()) return this.blocked(command, "execution_invalidated", current.snapshot);
        await this.runAutomation(async () => {
          if (!isCurrent()) return;
          if (field?.type === "radio" && field.interactionMode === "choice_group") {
            expectedReadback = await selectChoiceGroup(locator, command.value);
          } else if (field?.type === "radio") {
            await locator.check();
            expectedReadback = true;
          } else if (field?.controlKind === "custom") {
            const selected = await selectCustomControl(locator, command.value);
            expectedReadback = selected.selectedValue;
            if (selected.recovered) warnings.push("control_recovered_after_readback_mismatch");
          } else {
            expectedReadback = (await locator.selectOption({ label: command.value }))[0];
          }
        });
      } else if (command.type === "click_intermediate") {
        if (current.snapshot.errors.length > 0) {
          return this.blocked(command, "page_not_valid", current.snapshot);
        }
        const locator = current.registry.action(command.actionId);
        if (!locator) return this.blocked(command, "action_not_found", current.snapshot);
        if (!await isObjectivelySafeIntermediate(locator)) {
          return this.blocked(command, "unsafe_intermediate_action", current.snapshot);
        }
        if (!isCurrent()) return this.blocked(command, "execution_invalidated", current.snapshot);
        const violation = await this.runAutomation(() => isCurrent()
          ? guardedIntermediateClick(locator)
          : Promise.resolve("execution_invalidated"));
        if (violation) return this.blocked(command, violation, current.snapshot);
      } else if (command.type === "upload") {
        const locator = current.registry.field(command.fieldId);
        if (!locator) return this.blocked(command, "field_not_found", current.snapshot);
        const filePath = await this.fileResolver?.(command.fileId);
        if (!filePath) return this.blocked(command, "file_not_registered", current.snapshot);
        if (!isCurrent()) return this.blocked(command, "execution_invalidated", current.snapshot);
        await this.runAutomation(() => isCurrent() ? locator.setInputFiles(filePath) : Promise.resolve());
        expectedReadback = basename(filePath);
        if (!isCurrent()) return this.blocked(command, "execution_invalidated", current.snapshot);
      } else {
        return this.blocked(command, "operation_not_supported", current.snapshot);
      }

      this.current = await this.observer.observe(command.taskId);
      if (command.type === "upload"
        && isResumeUploadField(current.snapshot.fields.find((field) => field.id === command.fieldId))) {
        const parsed = await this.waitForUploadParsing(current, command.taskId, command.fieldId, isCurrent);
        if (parsed.status === "execution_invalidated") {
          return this.blocked(command, "execution_invalidated", this.current?.snapshot ?? current.snapshot);
        }
        this.current = parsed.observation;
        if (parsed.status === "timeout") {
          return {
            type: "execution_result",
            taskId: command.taskId,
            snapshotId: this.current.snapshot.id,
            commandType: command.type,
            status: "failed",
            actualValue: this.current.snapshot.fields.find((field) => field.id === command.fieldId)?.currentValue ?? null,
            snapshot: this.current.snapshot,
            errors: ["upload_parse_timeout"]
          };
        }
      }
      const intermediateProgressed = command.type !== "click_intermediate"
        || hasObservablePageProgress(current.snapshot, this.current.snapshot);
      const actualValue = command.type === "click_intermediate"
        ? this.current.snapshot.url
        : this.current.snapshot.fields.find((field) => field.id === command.fieldId)?.currentValue;
      const uploadProgressed = command.type === "upload"
        && hasParsedUploadReplacement(current.snapshot, this.current.snapshot, command.fieldId);
      const readbackMatches = (command.type === "click_intermediate"
        ? true
        : command.type === "upload"
          ? (typeof actualValue === "string" && actualValue.includes(String(expectedReadback ?? ""))) || uploadProgressed
          : actualValue === expectedReadback)
        && intermediateProgressed;
      return {
        type: "execution_result",
        taskId: command.taskId,
        snapshotId: this.current.snapshot.id,
        commandType: command.type,
        status: readbackMatches ? "applied" : "failed",
        actualValue,
        snapshot: this.current.snapshot,
        errors: readbackMatches
          ? this.current.snapshot.errors
          : [command.type === "click_intermediate" ? "intermediate_no_progress" : "readback_mismatch"],
        ...(warnings.length === 0 ? {} : { warnings })
      };
    } catch (error) {
      this.current = await this.observer.observe(command.taskId);
      return {
        type: "execution_result",
        taskId: command.taskId,
        snapshotId: this.current.snapshot.id,
        commandType: command.type,
        status: "failed",
        actualValue: null,
        snapshot: this.current.snapshot,
        errors: [error instanceof Error ? error.message : String(error)]
      };
    }
  }

  private runAutomation<T>(operation: () => Promise<T>): Promise<T> {
    return this.activityMonitor?.runAutomation(operation) ?? operation();
  }

  private async waitForUploadParsing(
    initial: BrowserObservation,
    taskId: string,
    uploadFieldId: string,
    isCurrent: () => boolean
  ): Promise<{
    status: "stable" | "timeout" | "execution_invalidated";
    observation: BrowserObservation;
  }> {
    let previous = initial;
    let stablePairs = 0;
    const deadline = Date.now() + UPLOAD_PARSE_WAIT_CAP_MS;

    while (Date.now() < deadline) {
      if (!isCurrent()) return { status: "execution_invalidated", observation: previous };
      await delay(UPLOAD_PARSE_SAMPLE_MS);
      if (!isCurrent()) return { status: "execution_invalidated", observation: previous };

      const next = await this.observer.observe(taskId);
      if (next.snapshot.errors.length > 0) return { status: "stable", observation: next };
      if (hasParsedUploadReplacement(initial.snapshot, next.snapshot, uploadFieldId)) {
        stablePairs = uploadSnapshotFingerprint(previous.snapshot) === uploadSnapshotFingerprint(next.snapshot)
          ? stablePairs + 1
          : 0;
        if (stablePairs >= 1) return { status: "stable", observation: next };
      } else {
        stablePairs = 0;
      }
      previous = next;
    }

    return { status: "timeout", observation: previous };
  }

  private blocked(
    command: ExecutableCommand,
    error: string,
    snapshot = this.current?.snapshot
  ): ExecutionResponse {
    if (!snapshot) throw new Error("没有可用于阻断响应的浏览器快照");
    return {
      type: "execution_result",
      taskId: command.taskId,
      snapshotId: snapshot.id,
      commandType: command.type,
      status: "blocked",
      actualValue: null,
      snapshot,
      errors: [error]
    };
  }
}

type IntermediateViolation = "terminal_submission_blocked" | "unsafe_intermediate_navigation" | "execution_invalidated";

async function isObjectivelySafeIntermediate(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    if (element instanceof HTMLAnchorElement) {
      if (element.hasAttribute("download")) return false;
      const target = element.getAttribute("target")?.trim().toLocaleLowerCase() ?? "";
      if (target !== "" && target !== "_self") return false;
      try {
        const destination = new URL(element.href, location.href);
        return destination.origin === location.origin
          && (destination.protocol === "http:" || destination.protocol === "https:");
      } catch {
        return false;
      }
    }
    if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) {
      return element.type.toLocaleLowerCase() === "button";
    }
    return false;
  });
}

async function guardedIntermediateClick(locator: Locator): Promise<IntermediateViolation | undefined> {
  const page = locator.page();
  const context = page.context();
  const allowedOrigin = new URL(page.url()).origin;
  let violation: IntermediateViolation | undefined;
  const routeHandler = async (route: Route): Promise<void> => {
    const request = route.request();
    if (request.method() !== "GET") {
      violation = "terminal_submission_blocked";
      await route.abort("blockedbyclient");
      return;
    }
    if (request.isNavigationRequest() && new URL(request.url()).origin !== allowedOrigin) {
      violation = "unsafe_intermediate_navigation";
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  };

  await context.route("**/*", routeHandler);
  await page.evaluate(`(() => {
    const listener = (event) => {
      event.preventDefault();
      window.__resumeIntermediateSubmitGuard.blocked = true;
    };
    window.__resumeIntermediateSubmitGuard = { blocked: false, listener };
    document.addEventListener("submit", listener, true);
  })()`);

  try {
    await locator.click();
  } catch (error) {
    if (!violation) throw error;
  } finally {
    await context.unroute("**/*", routeHandler);
  }

  const nativeSubmitBlocked = await page.evaluate(`(() => {
    const guard = window.__resumeIntermediateSubmitGuard;
    if (!guard) return false;
    document.removeEventListener("submit", guard.listener, true);
    delete window.__resumeIntermediateSubmitGuard;
    return guard.blocked;
  })()`).catch(() => false);
  return nativeSubmitBlocked ? "terminal_submission_blocked" : violation;
}

function hasObservablePageProgress(before: BrowserObservation["snapshot"], after: BrowserObservation["snapshot"]): boolean {
  return before.url !== after.url
    || before.stage !== after.stage
    || before.title !== after.title
    || before.fields.map(fieldStructure).join("\u0000") !== after.fields.map(fieldStructure).join("\u0000")
    || before.actions.map((action) => `${action.id}:${action.class}:${action.text}`).join("\u0000")
      !== after.actions.map((action) => `${action.id}:${action.class}:${action.text}`).join("\u0000")
    || before.errors.join("\u0000") !== after.errors.join("\u0000");
}

function fieldStructure(field: BrowserObservation["snapshot"]["fields"][number]): string {
  return `${field.type}:${field.label}:${field.semanticHint ?? ""}`;
}

function isResumeUploadField(field: BrowserObservation["snapshot"]["fields"][number] | undefined): boolean {
  return field?.type === "file" && /resume|cv|简历/iu.test(`${field.semanticHint ?? ""} ${field.label}`);
}

function uploadSnapshotFingerprint(snapshot: BrowserObservation["snapshot"]): string {
  return JSON.stringify({
    fields: snapshot.fields.map((field) => ({
      id: field.id,
      type: field.type,
      label: field.label,
      required: field.required,
      semanticHint: field.semanticHint ?? "",
      currentValue: field.currentValue,
      options: field.options
    })),
    errors: snapshot.errors
  });
}

function hasParsedUploadReplacement(
  before: BrowserObservation["snapshot"],
  after: BrowserObservation["snapshot"],
  uploadFieldId: string
): boolean {
  if (after.errors.length > 0) return false;
  if (after.fields.some((field) => field.id === uploadFieldId && field.type === "file")) return false;
  const previousFields = new Map(
    before.fields.filter((field) => field.type !== "file").map((field) => [fieldStructure(field), field])
  );
  return after.fields.some((field) => {
    if (field.type === "file") return false;
    const previous = previousFields.get(fieldStructure(field));
    if (!previous) return true;
    return JSON.stringify(previous.currentValue) !== JSON.stringify(field.currentValue)
      && hasUploadValue(field.currentValue);
  });
}

function hasUploadValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== false;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
