import { createHash, randomUUID } from "node:crypto";
import type {
  ApplicationContentReview,
  ApplicationFieldAssessment,
  ExecutableCommand,
  FormField,
  FormSnapshot,
  ProfileFact,
  WorkerResponse
} from "@resume/contracts";
import { annotateDjiFields } from "../applications/dji-field-catalog.js";
import { deriveEntrySemanticHints } from "../applications/entry-field-semantics.js";
import {
  createFullPageAuditCoordinator,
  type AuditMismatch,
  type FullPageAuditReason,
  type FullPageAuditCoordinator,
  valuesMatch
} from "../applications/full-page-audit.js";
import { compatibleExperienceIndexes } from "../applications/experience-routing.js";
import { fieldOperationKey } from "../applications/field-operation-key.js";

export type ApplicationExecutionResult = Extract<WorkerResponse, { type: "execution_result" }>;
export type FieldResolutionPhase = "deterministic" | "semantic";

export interface ApplicationFieldResolution {
  status: "verified" | "deferred" | "needs_question" | "blocked";
  assessment?: ApplicationFieldAssessment;
  value?: unknown;
  question?: string;
  fieldPath?: string;
  requiresContentReview?: boolean;
  contentReview?: Pick<
    ApplicationContentReview,
    "original" | "reasons" | "evidence" | "unsupportedClaims" | "status"
  >;
}

export interface ResolvedApplicationField extends ApplicationFieldResolution {
  field: FormField;
}

export interface FieldResolutionBatch {
  token: string;
  snapshotId: string;
  phase: FieldResolutionPhase;
  resolutions: readonly ResolvedApplicationField[];
}

export interface ResolveFieldsInput {
  taskId: string;
  snapshot: FormSnapshot;
  profileRevision: number;
  phase: FieldResolutionPhase;
  fieldIds?: readonly string[];
}

export interface BuildFillPlanInput {
  taskId: string;
  snapshot: FormSnapshot;
  resolutions: FieldResolutionBatch;
  executionEpoch: number;
}

export interface BuildNavigationPlanInput {
  taskId: string;
  snapshot: FormSnapshot;
  executionEpoch: number;
}

export interface ReadbackMismatch {
  fieldId: string;
  expectedValue: unknown;
  actualValue: unknown;
}

export type ReadbackResult =
  | {
      status: "confirmed";
      observations: 2;
      snapshot: FormSnapshot;
    }
  | {
      status: "challenge";
      snapshot: FormSnapshot;
    }
  | {
      status: "mismatch";
      observation: 1 | 2;
      code: "controlled_value_reverted" | "control_unstable" | "field_missing";
      snapshot: FormSnapshot;
      mismatches: ReadbackMismatch[];
    };

export interface FullPageAuditResult {
  snapshot: FormSnapshot;
  mismatches: AuditMismatch[];
}

interface BrowserApplicationPort {
  observe(taskId: string): Promise<FormSnapshot>;
  execute(command: ExecutableCommand, executionEpoch?: number): Promise<ApplicationExecutionResult>;
  invalidateExecution?(taskId: string, executionEpoch: number): Promise<void>;
  releaseTask?(taskId: string): Promise<void>;
}

export interface ApplicationToolDependencies {
  browser: BrowserApplicationPort;
  resolveField(
    taskId: string,
    field: FormField,
    phase: FieldResolutionPhase
  ): Promise<ApplicationFieldResolution>;
  resolveApprovedContent?(taskId: string, field: FormField): Promise<unknown | undefined> | unknown | undefined;
  approve(input: {
    taskId: string;
    snapshotId: string;
    targetId: string;
    operation: ExecutableCommand["type"];
    nodeRef: FormField["nodeRef"];
    executionEpoch: number;
  }, snapshot: FormSnapshot): string;
  resolveFileId?: (taskId: string, field: FormField) => string | undefined;
  listProfileFacts?: () => readonly ProfileFact[];
  normalizeSnapshot?: (snapshot: FormSnapshot) => FormSnapshot;
}

export interface ApplicationTools {
  observe(taskId: string): Promise<FormSnapshot>;
  normalize(snapshot: FormSnapshot): FormSnapshot;
  resolveFields(input: ResolveFieldsInput): Promise<FieldResolutionBatch>;
  buildPlan(input: BuildFillPlanInput): Promise<ExecutableCommand[]>;
  buildNavigationPlan(input: BuildNavigationPlanInput): Promise<ExecutableCommand | undefined>;
  authorize(command: ExecutableCommand, snapshot: FormSnapshot): Promise<ExecutableCommand>;
  execute(command: ExecutableCommand): Promise<ApplicationExecutionResult>;
  readback(taskId: string, expected: ExecutableCommand[]): Promise<ReadbackResult>;
  fullPageAudit(input: {
    taskId: string;
    snapshot: FormSnapshot;
    expected: ExecutableCommand[];
    reason: FullPageAuditReason;
  }): Promise<FullPageAuditResult>;
  invalidate(taskId: string): Promise<number>;
  release(taskId: string): Promise<void>;
}

interface PlannedCommand {
  command: ExecutableCommand;
  field?: FormField;
  expectedValue?: unknown;
}

interface TaskAuditState {
  coordinator: FullPageAuditCoordinator;
  recordedCommandIds: Set<string>;
}

const EMPTY_APPROVAL = "";

/**
 * Browser writes remain behind this adapter so a graph node cannot fabricate a
 * current snapshot, NodeRef, approval, or epoch. The maps are process-local by
 * design; checkpoints retain only IDs and fresh observations rebuild plans.
 */
export function createApplicationTools(dependencies: ApplicationToolDependencies): ApplicationTools {
  const latestSnapshots = new Map<string, FormSnapshot>();
  const latestEpochs = new Map<string, number>();
  const resolutionBatches = new Map<string, FieldResolutionBatch>();
  const plannedCommands = new Map<string, PlannedCommand>();
  const authorizedApprovals = new Map<string, string>();
  const executedCommands = new Set<string>();
  const audits = new Map<string, TaskAuditState>();

  const remember = (snapshot: FormSnapshot): FormSnapshot => {
    latestSnapshots.set(snapshot.taskId, snapshot);
    return snapshot;
  };

  const currentSnapshot = (taskId: string): FormSnapshot => {
    const snapshot = latestSnapshots.get(taskId);
    if (snapshot === undefined) throw new Error("current_snapshot_missing");
    return snapshot;
  };

  const normalize = (snapshot: FormSnapshot): FormSnapshot => {
    const normalized = dependencies.normalizeSnapshot?.(snapshot) ?? normalizeSnapshot(
      snapshot,
      dependencies.listProfileFacts?.() ?? []
    );
    return remember(normalized);
  };

  const assertCurrentSnapshot = (taskId: string, snapshot: FormSnapshot): void => {
    if (snapshot.taskId !== taskId) throw new Error("task_mismatch");
    const current = currentSnapshot(taskId);
    if (current.id !== snapshot.id) throw new Error("stale_snapshot");
  };

  const reserveEpoch = (taskId: string, executionEpoch: number): void => {
    const current = latestEpochs.get(taskId) ?? 0;
    if (!Number.isInteger(executionEpoch) || executionEpoch <= current) {
      throw new Error("stale_execution_epoch");
    }
    latestEpochs.set(taskId, executionEpoch);
  };

  const auditFor = (taskId: string): TaskAuditState => {
    const existing = audits.get(taskId);
    if (existing !== undefined) return existing;
    const created: TaskAuditState = {
      coordinator: createFullPageAuditCoordinator(taskId),
      recordedCommandIds: new Set()
    };
    audits.set(taskId, created);
    return created;
  };

  return {
    async observe(taskId) {
      return remember(await dependencies.browser.observe(taskId));
    },

    normalize,

    async resolveFields(input) {
      assertCurrentSnapshot(input.taskId, input.snapshot);
      if (!Number.isInteger(input.profileRevision) || input.profileRevision < 0) {
        throw new Error("profile_revision_invalid");
      }
      const requested = input.fieldIds === undefined ? undefined : new Set(input.fieldIds);
      const fields = input.snapshot.fields.filter((field) =>
        !hasValue(field.currentValue)
        && !isHumanAcknowledgement(field)
        && (requested === undefined || requested.has(field.id))
      );
      const resolutions = await Promise.all(fields.map(async (field) => {
        try {
          const approvedContent = await dependencies.resolveApprovedContent?.(input.taskId, field);
          if (approvedContent !== undefined) {
            return { field, status: "verified" as const, value: approvedContent };
          }
          return { field, ...await dependencies.resolveField(input.taskId, field, input.phase) };
        } catch {
          return { field, status: "blocked" as const };
        }
      }));
      const batch: FieldResolutionBatch = {
        token: randomUUID(),
        snapshotId: input.snapshot.id,
        phase: input.phase,
        resolutions
      };
      resolutionBatches.set(batch.token, batch);
      return batch;
    },

    async buildPlan(input) {
      assertCurrentSnapshot(input.taskId, input.snapshot);
      const known = resolutionBatches.get(input.resolutions.token);
      if (known === undefined || known !== input.resolutions || known.snapshotId !== input.snapshot.id) {
        throw new Error("resolution_batch_invalid");
      }
      const candidate = known.resolutions.find(({ field, status, value, requiresContentReview }) =>
        status === "verified"
        && !requiresContentReview
        && value !== undefined
        && !hasValue(input.snapshot.fields.find((item) => item.id === field.id)?.currentValue)
      );
      if (candidate === undefined) return [];

      reserveEpoch(input.taskId, input.executionEpoch);
      const currentField = input.snapshot.fields.find((field) => field.id === candidate.field.id);
      if (currentField === undefined || !sameNodeRef(currentField.nodeRef, candidate.field.nodeRef)) {
        throw new Error("node_ref_mismatch");
      }
      const command = draftFieldCommand(
        input.snapshot,
        currentField,
        candidate.value,
        input.executionEpoch,
        dependencies.resolveFileId
      );
      rememberPlan(plannedCommands, command, { command, field: currentField, expectedValue: candidate.value });
      return [command];
    },

    async buildNavigationPlan(input) {
      assertCurrentSnapshot(input.taskId, input.snapshot);
      const action = input.snapshot.actions.find((candidate) =>
        candidate.class === "intermediate_navigation" || candidate.class === "intermediate_save"
      );
      if (action === undefined) return undefined;
      reserveEpoch(input.taskId, input.executionEpoch);
      const command: ExecutableCommand = {
        type: "click_intermediate",
        taskId: input.taskId,
        snapshotId: input.snapshot.id,
        actionId: action.id,
        nodeRef: action.nodeRef,
        executionEpoch: input.executionEpoch,
        approval: EMPTY_APPROVAL
      };
      rememberPlan(plannedCommands, command, { command });
      return command;
    },

    async authorize(command, snapshot) {
      assertCurrentSnapshot(command.taskId, snapshot);
      if (snapshot.id !== command.snapshotId) throw new Error("stale_snapshot");
      assertCommandBinding(command, snapshot);
      const id = applicationCommandId(command);
      const planned = plannedCommands.get(id);
      if (planned === undefined) throw new Error("command_not_planned");
      if (command.executionEpoch !== (latestEpochs.get(command.taskId) ?? 0)) {
        throw new Error("stale_execution_epoch");
      }
      const approval = dependencies.approve({
        taskId: command.taskId,
        snapshotId: command.snapshotId,
        targetId: command.type === "click_intermediate" ? command.actionId : command.fieldId,
        operation: command.type,
        nodeRef: command.nodeRef,
        executionEpoch: command.executionEpoch
      }, snapshot);
      const authorized = { ...command, approval } as ExecutableCommand;
      authorizedApprovals.set(id, approval);
      return authorized;
    },

    async execute(command) {
      const id = applicationCommandId(command);
      if (command.executionEpoch !== (latestEpochs.get(command.taskId) ?? 0)) {
        throw new Error("stale_execution_epoch");
      }
      const planned = plannedCommands.get(id);
      if (planned === undefined || authorizedApprovals.get(id) !== command.approval) {
        throw new Error("command_not_authorized");
      }
      const snapshot = currentSnapshot(command.taskId);
      if (snapshot.id !== command.snapshotId) throw new Error("stale_snapshot");
      assertCommandBinding(command, snapshot);
      authorizedApprovals.delete(id);
      const result = await dependencies.browser.execute(command, command.executionEpoch);
      remember(result.snapshot);
      executedCommands.add(id);
      return result;
    },

    async readback(taskId, expected) {
      for (const command of expected) {
        const id = applicationCommandId(command);
        if (!executedCommands.has(id)) throw new Error("readback_command_not_executed");
      }

      const first = normalize(await dependencies.browser.observe(taskId));
      if (first.challenge !== undefined) return { status: "challenge", snapshot: first };
      const firstMismatches = readbackMismatches(plannedCommands, expected, first);
      if (firstMismatches.length > 0) {
        return {
          status: "mismatch",
          observation: 1,
          code: mismatchCode(firstMismatches),
          snapshot: first,
          mismatches: firstMismatches
        };
      }

      const second = normalize(await dependencies.browser.observe(taskId));
      if (second.challenge !== undefined) return { status: "challenge", snapshot: second };
      if (!sameStableWindow(first, second)) {
        return {
          status: "mismatch",
          observation: 2,
          code: "control_unstable",
          snapshot: second,
          mismatches: []
        };
      }
      const secondMismatches = readbackMismatches(plannedCommands, expected, second);
      if (secondMismatches.length > 0) {
        return {
          status: "mismatch",
          observation: 2,
          code: mismatchCode(secondMismatches),
          snapshot: second,
          mismatches: secondMismatches
        };
      }
      return { status: "confirmed", observations: 2, snapshot: second };
    },

    async fullPageAudit(input) {
      assertCurrentSnapshot(input.taskId, input.snapshot);
      const audit = auditFor(input.taskId);
      for (const command of input.expected) {
        const id = applicationCommandId(command);
        const planned = plannedCommands.get(id);
        if (planned?.field === undefined || planned.expectedValue === undefined || audit.recordedCommandIds.has(id)) continue;
        const operationKey = auditableOperationKey(input.taskId, planned.field);
        if (operationKey === undefined) continue;
        audit.coordinator.recordApplied(operationKey, planned.expectedValue, planned.field.id);
        audit.recordedCommandIds.add(id);
      }
      if (!audit.coordinator.shouldAudit(input.reason)) {
        return { snapshot: input.snapshot, mismatches: [] };
      }
      return { snapshot: input.snapshot, mismatches: audit.coordinator.audit(input.snapshot) };
    },

    async invalidate(taskId) {
      const nextEpoch = (latestEpochs.get(taskId) ?? 0) + 1;
      latestEpochs.set(taskId, nextEpoch);
      for (const [id, command] of plannedCommands) {
        if (command.command.taskId === taskId) {
          plannedCommands.delete(id);
          authorizedApprovals.delete(id);
          executedCommands.delete(id);
        }
      }
      await dependencies.browser.invalidateExecution?.(taskId, nextEpoch);
      return nextEpoch;
    },

    async release(taskId) {
      await dependencies.browser.releaseTask?.(taskId);
      latestSnapshots.delete(taskId);
      latestEpochs.delete(taskId);
      audits.delete(taskId);
      for (const [id, command] of plannedCommands) {
        if (command.command.taskId === taskId) {
          plannedCommands.delete(id);
          authorizedApprovals.delete(id);
          executedCommands.delete(id);
        }
      }
    }
  };
}

export function applicationCommandId(command: ExecutableCommand): string {
  const binding = command.type === "click_intermediate"
    ? { targetId: command.actionId }
    : command.type === "upload"
      ? { targetId: command.fieldId, fileId: command.fileId }
      : { targetId: command.fieldId, value: command.value };
  return createHash("sha256").update(JSON.stringify({
    type: command.type,
    taskId: command.taskId,
    snapshotId: command.snapshotId,
    nodeRef: command.nodeRef,
    executionEpoch: command.executionEpoch,
    ...binding
  })).digest("hex");
}

function rememberPlan(
  plans: Map<string, PlannedCommand>,
  command: ExecutableCommand,
  planned: PlannedCommand
): void {
  plans.set(applicationCommandId(command), planned);
}

function normalizeSnapshot(snapshot: FormSnapshot, profileFacts: readonly ProfileFact[]): FormSnapshot {
  const catalogued = annotateDjiFields(snapshot);
  return {
    ...catalogued,
    fields: deriveEntrySemanticHints(catalogued.fields, {
      experienceIndexesBySection: {
        work: compatibleExperienceIndexes(profileFacts, "work"),
        internship: compatibleExperienceIndexes(profileFacts, "internship"),
        work_combined: compatibleExperienceIndexes(profileFacts, "work_combined")
      }
    })
  };
}

function draftFieldCommand(
  snapshot: FormSnapshot,
  field: FormField,
  value: unknown,
  executionEpoch: number,
  resolveFileId: ApplicationToolDependencies["resolveFileId"]
): ExecutableCommand {
  const common = {
    taskId: snapshot.taskId,
    snapshotId: snapshot.id,
    fieldId: field.id,
    nodeRef: field.nodeRef,
    executionEpoch,
    approval: EMPTY_APPROVAL
  };
  if (field.type === "select" || field.type === "radio") {
    return { type: "select", ...common, value: String(value) };
  }
  if (field.type === "file") {
    const fileId = resolveFileId?.(snapshot.taskId, field);
    if (fileId === undefined || fileId.length === 0) throw new Error("resume_file_unavailable");
    return { type: "upload", ...common, fileId };
  }
  return { type: "fill", ...common, value };
}

function assertCommandBinding(command: ExecutableCommand, snapshot: FormSnapshot): void {
  if (command.type === "click_intermediate") {
    const action = snapshot.actions.find((candidate) => candidate.id === command.actionId);
    if (action === undefined || !sameNodeRef(action.nodeRef, command.nodeRef)) throw new Error("node_ref_mismatch");
    if (action.class === "terminal_submit" || action.class === "unknown_side_effect") {
      throw new Error("terminal_submit_denied");
    }
    return;
  }
  const field = snapshot.fields.find((candidate) => candidate.id === command.fieldId);
  if (field === undefined || !sameNodeRef(field.nodeRef, command.nodeRef)) throw new Error("node_ref_mismatch");
  if (command.type === "select" && field.type !== "select" && field.type !== "radio") {
    throw new Error("field_operation_mismatch");
  }
  if (command.type === "upload" && field.type !== "file") throw new Error("field_operation_mismatch");
  if (command.type === "fill" && ["select", "radio", "file"].includes(field.type)) {
    throw new Error("field_operation_mismatch");
  }
}

function readbackMismatches(
  plans: ReadonlyMap<string, PlannedCommand>,
  expected: readonly ExecutableCommand[],
  snapshot: FormSnapshot
): ReadbackMismatch[] {
  const mismatches: ReadbackMismatch[] = [];
  for (const command of expected) {
    if (command.type === "click_intermediate") continue;
    const planned = plans.get(applicationCommandId(command));
    if (planned?.field === undefined) {
      mismatches.push({ fieldId: command.fieldId, expectedValue: undefined, actualValue: undefined });
      continue;
    }
    const observed = findReadbackField(snapshot, planned.field);
    if (observed === undefined) {
      mismatches.push({ fieldId: planned.field.id, expectedValue: planned.expectedValue, actualValue: undefined });
      continue;
    }
    if (command.type === "upload") {
      if (!hasValue(observed.currentValue)) {
        mismatches.push({ fieldId: planned.field.id, expectedValue: "file_present", actualValue: observed.currentValue });
      }
      continue;
    }
    if (!valuesMatch(planned.expectedValue, observed.currentValue, observed)) {
      mismatches.push({
        fieldId: planned.field.id,
        expectedValue: planned.expectedValue,
        actualValue: observed.currentValue
      });
    }
  }
  return mismatches;
}

function findReadbackField(snapshot: FormSnapshot, planned: FormField): FormField | undefined {
  const sameId = snapshot.fields.find((field) => field.id === planned.id);
  if (sameId !== undefined) return sameId;
  if (planned.semanticHint === undefined) return undefined;
  const candidates = snapshot.fields.filter((field) =>
    field.semanticHint === planned.semanticHint
    && field.label === planned.label
    && field.sectionHint === planned.sectionHint
    && (field.interactionMode ?? field.type) === (planned.interactionMode ?? planned.type)
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function mismatchCode(mismatches: readonly ReadbackMismatch[]): "controlled_value_reverted" | "field_missing" {
  return mismatches.some((mismatch) => mismatch.actualValue === undefined) ? "field_missing" : "controlled_value_reverted";
}

function sameStableWindow(left: FormSnapshot, right: FormSnapshot): boolean {
  return left.url === right.url
    && left.stage === right.stage
    && left.frameRef.documentId === right.frameRef.documentId
    && left.mutationEpoch === right.mutationEpoch;
}

function sameNodeRef(left: FormField["nodeRef"], right: FormField["nodeRef"]): boolean {
  return left.documentId === right.documentId
    && left.nodeId === right.nodeId
    && left.observedAt === right.observedAt;
}

function auditableOperationKey(taskId: string, field: FormField): string | undefined {
  if (field.semanticHint === undefined) return undefined;
  const entryIndex = /^[^[.]+\[(\d+)\]/u.exec(field.semanticHint)?.[1];
  return fieldOperationKey({
    taskId,
    semanticPath: field.semanticHint,
    controlRole: field.interactionMode ?? field.type,
    fieldLabel: field.label,
    ...(field.sectionHint === undefined ? {} : { sectionHint: field.sectionHint }),
    ...(entryIndex === undefined ? {} : { entryIndex: Number(entryIndex) })
  });
}

function hasValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== false;
}

function isHumanAcknowledgement(field: FormField): boolean {
  if (field.type !== "checkbox" && field.type !== "radio") return false;
  return /privacy\s*(?:policy|notice)|terms\s*(?:and|of)\s*(?:conditions|use)|\bi\s*(?:certify|declare|acknowledge)\b|真实性|隐私政策|隐私声明|用户协议|法律声明|本人承诺.*(?:真实|准确)/iu.test(field.label);
}
