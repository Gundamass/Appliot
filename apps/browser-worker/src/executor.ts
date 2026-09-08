import { ApprovalStore, PolicyDeniedError, verifyAndConsumeApproval } from "@resume/action-policy";
import type { ExecutableCommand, WorkerResponse } from "@resume/contracts";
import type { Route } from "playwright-core";
import { basename } from "node:path";
import { BrowserObserver, type BrowserObservation } from "./observer.js";
import type { ActivityMonitor } from "./activity-monitor.js";
import { selectChoiceGroup, selectCustomControl, type ControlTarget } from "./control-adapters.js";
import {
  runtimeTraceHash,
  type RuntimeTracePhase,
  type RuntimeTraceSink
} from "./runtime-trace.js";

type ExecutionResponse = Extract<WorkerResponse, { type: "execution_result" }>;

const UPLOAD_PARSE_SAMPLE_MS = 100;
const UPLOAD_PARSE_WAIT_CAP_MS = 8_000;
const FIELD_STABLE_WINDOW_MS = 300;
const FIELD_STABLE_WAIT_CAP_MS = 2_000;

export class ControlledExecutor {
  private readonly approvals = new ApprovalStore();
  private current: BrowserObservation | undefined;
  private readonly invalidatedSnapshots = new Map<string, BrowserObservation["snapshot"]>();

  constructor(
    private readonly observer: BrowserObserver,
    private readonly approvalKey: Uint8Array,
    private readonly fileResolver?: (fileId: string) => Promise<string | undefined>,
    private readonly activityMonitor?: Pick<ActivityMonitor, "runAutomation">,
    private readonly trace?: RuntimeTraceSink
  ) {}

  async observe(taskId: string) {
    const observed = await this.observer.observe(taskId);
    await this.replaceCurrent(observed);
    this.invalidatedSnapshots.delete(taskId);
    return observed.snapshot;
  }

  async invalidate(taskId: string): Promise<void> {
    const current = this.current;
    if (current?.snapshot.taskId !== taskId) return;
    this.current = undefined;
    this.invalidatedSnapshots.set(taskId, current.snapshot);
    await current.registry.release();
  }

  async release(): Promise<void> {
    const current = this.current;
    this.current = undefined;
    this.invalidatedSnapshots.clear();
    await current?.registry.release();
  }

  async execute(command: ExecutableCommand, isCurrent: () => boolean = () => true): Promise<ExecutionResponse> {
    const current = this.current;
    if (!isCurrent()) {
      return this.blocked(
        command,
        "execution_invalidated",
        current?.snapshot ?? this.invalidatedSnapshots.get(command.taskId)
      );
    }
    if (!current || current.snapshot.taskId !== command.taskId || current.snapshot.id !== command.snapshotId) {
      return this.blocked(command, "stale_snapshot", current?.snapshot);
    }
    try {
      verifyAndConsumeApproval(command, this.approvalKey, this.approvals);
    } catch (error) {
      return this.blocked(
        command,
        error instanceof PolicyDeniedError ? error.code : "approval_invalid",
        current.snapshot
      );
    }

    const startedAt = Date.now();
    let activePhase: RuntimeTracePhase | undefined;
    let expectedReadback: unknown;
    const warnings: string[] = [];

    try {
      if (!isCurrent()) return this.blocked(command, "execution_invalidated", current.snapshot);
      const targetField = command.type === "click_intermediate"
        ? undefined
        : current.snapshot.fields.find((field) => field.id === command.fieldId);
      const targetAction = command.type === "click_intermediate"
        ? current.snapshot.actions.find((action) => action.id === command.actionId)
        : undefined;
      if (command.type === "click_intermediate" && targetAction === undefined) {
        return this.blocked(command, "action_not_found", current.snapshot);
      }
      if (command.type !== "click_intermediate" && targetField === undefined) {
        return this.blocked(command, "field_not_found", current.snapshot);
      }
      if (command.type === "click_intermediate" && current.snapshot.errors.length > 0) {
        return this.blocked(command, "page_not_valid", current.snapshot);
      }

      activePhase = "prepare";
      const prepared = await current.registry.prepare(
        command.nodeRef,
        command.nodeRef.observedAt,
        command.type === "click_intermediate" ? "action" : "field"
      );
      this.recordTrace(command, activePhase, startedAt, "ok");
      activePhase = "apply";

      if (command.type === "fill") {
        expectedReadback = command.value;
        await this.runAutomation(async () => {
          requireCurrent(isCurrent);
          if (targetField?.type === "checkbox") {
            await prepared.setChecked(Boolean(command.value));
          } else {
            await prepared.fill(String(command.value ?? ""));
          }
          await prepared.blur();
        });
      } else if (command.type === "select") {
        await this.runAutomation(async () => {
          requireCurrent(isCurrent);
          if (targetField?.type === "radio" && targetField.interactionMode === "choice_group") {
            expectedReadback = await selectChoiceGroup(prepared, command.value);
          } else if (targetField?.type === "radio") {
            await prepared.check();
            expectedReadback = true;
          } else if (targetField?.controlKind === "custom") {
            const selected = await selectCustomControl(prepared, command.value);
            expectedReadback = selected.selectedValue;
            if (selected.recovered) warnings.push("control_recovered_after_readback_mismatch");
          } else {
            expectedReadback = (await prepared.selectOption({ label: command.value }))[0];
          }
        });
      } else if (command.type === "click_intermediate") {
        if (!await isObjectivelySafeIntermediate(prepared)) {
          return this.blocked(command, "unsafe_intermediate_action", current.snapshot);
        }
        const violation = await this.runAutomation(() => {
          requireCurrent(isCurrent);
          return guardedIntermediateClick(prepared);
        });
        if (violation) return this.blocked(command, violation, current.snapshot);
      } else if (command.type === "upload") {
        const filePath = await this.fileResolver?.(command.fileId);
        if (!filePath) return this.blocked(command, "file_not_registered", current.snapshot);
        if (!isCurrent()) {
          this.recordTrace(command, activePhase, startedAt, "execution_invalidated");
          activePhase = undefined;
          return this.blocked(command, "execution_invalidated", current.snapshot);
        }
        await this.runAutomation(async () => {
          requireCurrent(isCurrent);
          await prepared.setInputFiles(filePath);
        });
        expectedReadback = basename(filePath);
        requireCurrent(isCurrent);
      } else {
        return this.blocked(command, "operation_not_supported", current.snapshot);
      }
      this.recordTrace(command, activePhase, startedAt, "ok");
      activePhase = undefined;

      if (command.type === "fill" || command.type === "select") {
        activePhase = "settle-1";
        await prepared.waitForStableWindow(FIELD_STABLE_WINDOW_MS, FIELD_STABLE_WAIT_CAP_MS, isCurrent);
        this.recordTrace(command, activePhase, startedAt, "ok");
        activePhase = "readback-1";
        const first = await prepared.readValue();
        const firstMatches = fieldReadbackMatches(targetField, first, expectedReadback);
        this.recordTrace(command, activePhase, startedAt, firstMatches ? "match" : "mismatch");

        activePhase = "settle-2";
        await prepared.waitForStableWindow(FIELD_STABLE_WINDOW_MS, FIELD_STABLE_WAIT_CAP_MS, isCurrent);
        this.recordTrace(command, activePhase, startedAt, "ok");
        activePhase = "readback-2";
        const second = await prepared.readValue();
        const secondMatches = fieldReadbackMatches(targetField, second, expectedReadback);
        const resultCode = firstMatches && !secondMatches
          ? "controlled_value_reverted"
          : secondMatches ? "match" : "mismatch";
        this.recordTrace(command, activePhase, startedAt, resultCode);
        activePhase = undefined;

        const observed = await this.observer.observe(command.taskId);
        await this.replaceCurrent(observed);
        const mismatch = isDateComponentField(targetField)
          ? "date_component_readback_mismatch"
          : "readback_mismatch";
        const error = !firstMatches
          ? mismatch
          : !secondMatches ? "controlled_value_reverted" : undefined;
        return {
          type: "execution_result",
          taskId: command.taskId,
          snapshotId: observed.snapshot.id,
          commandType: command.type,
          status: error === undefined ? "applied" : "failed",
          actualValue: second,
          snapshot: observed.snapshot,
          errors: error === undefined ? observed.snapshot.errors : [error],
          ...(warnings.length === 0 ? {} : { warnings })
        };
      }

      let observed = await this.observer.observe(command.taskId);
      await this.replaceCurrent(observed);
      if (command.type === "upload"
        && isResumeUploadField(current.snapshot.fields.find((field) => field.id === command.fieldId))) {
        const parsed = await this.waitForUploadParsing(current, command.taskId, command.fieldId, isCurrent);
        if (parsed.status === "execution_invalidated") {
          return this.blocked(command, "execution_invalidated", this.current?.snapshot ?? current.snapshot);
        }
        await this.replaceCurrent(parsed.observation);
        observed = parsed.observation;
        if (parsed.status === "timeout") {
          return {
            type: "execution_result",
            taskId: command.taskId,
            snapshotId: observed.snapshot.id,
            commandType: command.type,
            status: "failed",
            actualValue: observed.snapshot.fields.find((field) => field.id === command.fieldId)?.currentValue ?? null,
            snapshot: observed.snapshot,
            errors: ["upload_parse_timeout"]
          };
        }
      }
      const intermediateProgressed = command.type !== "click_intermediate"
        || hasObservablePageProgress(current.snapshot, observed.snapshot);
      const actualValue = command.type === "click_intermediate"
        ? observed.snapshot.url
        : observed.snapshot.fields.find((field) => field.id === command.fieldId)?.currentValue;
      const uploadProgressed = command.type === "upload"
        && hasParsedUploadReplacement(current.snapshot, observed.snapshot, command.fieldId);
      const dateComponent = isDateComponentField(targetField);
      const readbackMatches = (command.type === "click_intermediate"
        ? true
        : command.type === "upload"
          ? (typeof actualValue === "string" && actualValue.includes(String(expectedReadback ?? ""))) || uploadProgressed
          : dateComponent
            ? normalizedDateComponent(actualValue) === normalizedDateComponent(expectedReadback)
            : actualValue === expectedReadback)
        && intermediateProgressed;
      return {
        type: "execution_result",
        taskId: command.taskId,
        snapshotId: observed.snapshot.id,
        commandType: command.type,
        status: readbackMatches ? "applied" : "failed",
        actualValue,
        snapshot: observed.snapshot,
        errors: readbackMatches
          ? observed.snapshot.errors
          : [command.type === "click_intermediate"
              ? "intermediate_no_progress"
              : dateComponent ? "date_component_readback_mismatch" : "readback_mismatch"],
        ...(warnings.length === 0 ? {} : { warnings })
      };
    } catch (error) {
      const code = executionErrorCode(error);
      if (activePhase !== undefined) this.recordTrace(command, activePhase, startedAt, code);
      let snapshot = this.current?.snapshot ?? current.snapshot;
      try {
        const observed = await this.observer.observe(command.taskId);
        await this.replaceCurrent(observed);
        snapshot = observed.snapshot;
      } catch {
        // Preserve the last trusted snapshot when the page cannot be observed.
      }
      return {
        type: "execution_result",
        taskId: command.taskId,
        snapshotId: snapshot.id,
        commandType: command.type,
        status: "failed",
        actualValue: null,
        snapshot,
        errors: [code]
      };
    }
  }

  private runAutomation<T>(operation: () => Promise<T>): Promise<T> {
    return this.activityMonitor?.runAutomation(operation) ?? operation();
  }

  private recordTrace(
    command: ExecutableCommand,
    phase: RuntimeTracePhase,
    startedAt: number,
    resultCode: string
  ): void {
    this.trace?.record({
      taskIdHash: runtimeTraceHash(command.taskId),
      snapshotId: command.snapshotId,
      documentId: command.nodeRef.documentId,
      mutationEpoch: command.nodeRef.observedAt,
      nodeRefHash: runtimeTraceHash(`${command.nodeRef.documentId}\u0000${command.nodeRef.nodeId}`),
      phase,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      resultCode
    });
  }

  private async replaceCurrent(next: BrowserObservation): Promise<void> {
    const previous = this.current;
    this.current = next;
    if (previous !== undefined && previous !== next) await previous.registry.release();
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

function isDateComponentField(field: BrowserObservation["snapshot"]["fields"][number] | undefined): boolean {
  if (field === undefined) return false;
  if (/(?:date|startDate|endDate|birthDate)\.(?:year|month|day)$/iu.test(field.semanticHint ?? "")) {
    return true;
  }
  const label = field.label.normalize("NFKC");
  return /(?:日期|时间|date|time)/iu.test(label)
    && /(?:年|月|日|号|year|month|day)/iu.test(label);
}

function normalizedDateComponent(value: unknown): string {
  const normalized = String(value ?? "").normalize("NFKC").trim().replace(/[年月日号]$/u, "");
  return /^\d{1,4}$/u.test(normalized) ? String(Number(normalized)) : normalized;
}

function fieldReadbackMatches(
  field: BrowserObservation["snapshot"]["fields"][number] | undefined,
  actual: unknown,
  expected: unknown
): boolean {
  return isDateComponentField(field)
    ? normalizedDateComponent(actual) === normalizedDateComponent(expected)
    : actual === expected;
}

function requireCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) throw Object.assign(new Error("execution_invalidated"), {
    code: "execution_invalidated"
  });
}

function executionErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error
    && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return error instanceof Error ? error.message : String(error);
}

type IntermediateViolation = "terminal_submission_blocked" | "unsafe_intermediate_navigation" | "execution_invalidated";

async function isObjectivelySafeIntermediate(locator: ControlTarget): Promise<boolean> {
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

async function guardedIntermediateClick(locator: ControlTarget): Promise<IntermediateViolation | undefined> {
  const page = locator.page;
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
    if (!previous) return hasUploadValue(field.currentValue);
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
