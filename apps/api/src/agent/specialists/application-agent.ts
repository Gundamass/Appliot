import { createHash } from "node:crypto";
import {
  ApplicationFieldSemanticSchema,
  type ApplicationFieldSemantic,
  type AgentGraphState,
  type ApplicationContentReview,
  type ApplicationFieldCoverage,
  type ApplicationExecutionState,
  type ExecutableCommand,
  type HumanInterrupt,
  type HumanResume,
  type RuntimeHumanInterrupt,
  type RuntimeHumanResume,
  type EvidenceRef,
  type FormSnapshot,
  type SkillBinding
} from "@resume/contracts";
import {
  applicationCommandId,
  type ApplicationExecutionResult,
  type ApplicationTools,
  type FullPageAuditResult,
  type ReadbackResult
} from "../application-tools.js";
import {
  createApplicationExecutionSubgraph,
  type ApplicationSkillRuntimePort
} from "../subgraphs/application-execution.js";
import type { TraceSink } from "../trace-sink.js";
import type {
  RuntimeExecutor,
  RuntimeExecutorInput,
  RuntimeExecutorResult
} from "../runtime/execution-loop.js";
import type { EvidenceStore } from "../observations/evidence-store.js";
import {
  createRuntimeApplicationStateStore,
  restoreFieldCoverage,
  redactFieldCoverage,
  type RuntimeApplicationPendingInterrupt,
  type RuntimeApplicationState,
  type RuntimeApplicationStateStore
} from "../runtime/application-state-store.js";
import { createFieldCoverageStore, type FieldCoverageStore } from "../../applications/field-coverage.js";
import type { SkillExecutionRecordInput } from "../../application-skills/skill-execution-recorder.js";

const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_ITERATIONS = 64;
type ApplicationSubgraphResult = Awaited<ReturnType<ReturnType<typeof createApplicationExecutionSubgraph>>>;

export interface ApplicationAgentOptions {
  readonly tools: ApplicationTools;
  readonly evidenceStore: EvidenceStore;
  readonly profileRevision?: () => number;
  readonly now?: () => string;
  readonly approvalTtlMs?: number;
  readonly maxIterations?: number;
  readonly traceSink?: TraceSink;
  readonly stateStore?: RuntimeApplicationStateStore;
  readonly fieldCoverage?: FieldCoverageStore;
  readonly skillRuntime?: ApplicationSkillRuntimePort;
  readonly skillExecutionRecorder?: {
    record(input: SkillExecutionRecordInput): Promise<unknown>;
  };
  readonly onContentReview?: (input: {
    readonly taskId: string;
    readonly interrupt: RuntimeHumanInterrupt;
    readonly review: ApplicationContentReviewDraft;
  }) => void | Promise<void>;
}

type ApplicationContentReviewDraft = Omit<ApplicationContentReview, "id">;

/**
 * The application specialist is the only Runtime executor that can reach
 * browser-backed application tools. It runs the trusted application subgraph
 * until the next durable boundary and maps human stops to Runtime interrupts.
 * Final submission is acknowledgement-only: no branch creates or sends a
 * submit command.
 */
export function createApplicationAgent(options: ApplicationAgentOptions): RuntimeExecutor {
  const stateStore = options.stateStore ?? createRuntimeApplicationStateStore();
  const fieldCoverage = options.fieldCoverage ?? createFieldCoverageStore();
  const now = options.now ?? (() => new Date().toISOString());
  const approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  if (!Number.isInteger(approvalTtlMs) || approvalTtlMs <= 0) throw new Error("application_approval_ttl_invalid");
  if (!Number.isInteger(maxIterations) || maxIterations < 1) throw new Error("application_max_iterations_invalid");

  return {
    async execute(input): Promise<RuntimeExecutorResult> {
      if (input.signal.aborted) {
        return { status: "failed", errorCode: "application_execution_cancelled", retryable: false };
      }

      const taskId = applicationTaskId(input);
      const applicationUrl = applicationUrlFor(input);
      const persisted = await stateStore.get(input.runId);
      if (persisted?.fieldCoverage !== undefined && fieldCoverage.snapshot(taskId) === undefined) {
        fieldCoverage.restore(taskId, restoreFieldCoverage(persisted.fieldCoverage));
      }
      const persist = (nextApplication: ApplicationExecutionState, pending?: HumanInterrupt) =>
        persistApplicationState(
          stateStore,
          input,
          nextApplication,
          pending,
          now,
          fieldCoverage.snapshot(taskId)
        );
      const previousApplication = persisted === undefined
        ? undefined
        : applicationFromPersisted(persisted, applicationUrl, input.executionEpoch);
      const previous = persisted?.pendingInterrupt === undefined || previousApplication === undefined
        ? undefined
        : {
            applicationInterrupt: persisted.pendingInterrupt,
            runtimeInterrupt: toRuntimeInterrupt(
              persisted.pendingInterrupt,
              input,
              approvalTtlMs,
              now,
              [],
              previousApplication,
              persisted.pendingInterrupt
            ),
            application: previousApplication
          };

      // The Runtime supervisor owns the irreversible approval gate. Once it
      // resumes, record an acknowledgement without touching the browser.
      if (input.step.objective === "final_submit"
        || input.step.risk === "irreversible"
        || previous?.applicationInterrupt.kind === "final_review") {
        const completed = {
          status: "completed" as const,
          outputRef: `review:${input.runId}:${input.step.id}`,
          evidenceRefs: registerEvidence(options.evidenceStore, input, "review", `review:${input.runId}:${input.step.id}`),
          toolCallsUsed: 0,
          retryable: false
        };
        await persist({
          ...(previousApplication ?? initialApplication(applicationUrl, input.executionEpoch)),
          finalReviewLocked: true
        });
        return completed;
      }

      let application = previousApplication ?? initialApplication(applicationUrl, input.executionEpoch);
      let resume: HumanResume | undefined;
      let state: AgentGraphState;
      if (previous !== undefined && input.humanResume !== undefined) {
        state = initialGraphState(input, taskId, application, "interrupted", previous.applicationInterrupt);
        resume = toApplicationResume(input.humanResume, previous.applicationInterrupt);
      } else if (previous !== undefined) {
        return {
          status: "interrupted",
          pendingInterrupt: previous.runtimeInterrupt,
          evidenceRefs: registerEvidence(options.evidenceStore, input, "observation", `browser:snapshot:${application.snapshotId ?? "unknown"}`),
          toolCallsUsed: 0,
          retryable: false
        };
      } else {
        state = initialGraphState(input, taskId, application, "running");
      }

      const skillAttempt = new SkillAttemptEvidence(input, taskId, now());
      if (application.skillBinding !== undefined && application.skillTrace !== undefined) {
        skillAttempt.bind(
          application.skillBinding,
          application.skillTrace.pageVariantId,
          application.skillTrace.allocation
        );
      }
      const finish = async (
        result: RuntimeExecutorResult,
        terminalResult: SkillExecutionRecordInput["terminalResult"]
      ): Promise<RuntimeExecutorResult> => {
        if (options.skillExecutionRecorder === undefined || !skillAttempt.isBound()) return result;
        try {
          await options.skillExecutionRecorder.record(skillAttempt.complete({
            terminalResult,
            completedAt: now(),
            retries: application.retryCount,
            userCorrections: input.humanResume?.action === "correct" ? 1 : 0
          }));
          return result;
        } catch {
          return {
            status: "failed",
            errorCode: "application_skill_evidence_persistence_failed",
            evidenceRefs: result.evidenceRefs,
            toolCallsUsed: result.toolCallsUsed,
            retryable: false
          };
        }
      };

      // A first Skill binding must be durably pinned before any browser write.
      // Existing resumes already have a checkpoint and retain its binding.
      if (persisted === undefined) await persist(application);

      let lastCommand: ExecutableCommand | undefined;
      let commandCount = 0;
      let lastResult: ApplicationSubgraphResult | undefined;
      const subgraph = createApplicationExecutionSubgraph({
        tools: trackedTools(options.tools, (command) => {
          lastCommand = command;
          commandCount += 1;
        }, skillAttempt),
        fieldCoverage,
        ...(options.skillRuntime === undefined ? {} : {
          skillRuntime: trackSkillRuntime(options.skillRuntime, skillAttempt)
        }),
        traceSink: options.traceSink ?? emptyTraceSink,
        now: () => new Date(now()),
        onInterrupt: () => undefined,
        onContentReview: async ({ taskId: reviewTask, interrupt, review }) => {
          const runtimeInterrupt = toRuntimeInterrupt(interrupt, input, approvalTtlMs, now);
          await options.onContentReview?.({ taskId: reviewTask, interrupt: runtimeInterrupt, review });
        }
      });

      try {
        for (let iteration = 0; iteration < maxIterations; iteration += 1) {
          if (input.signal.aborted) {
            return finish(
              { status: "failed", errorCode: "application_execution_cancelled", retryable: false },
              "cancelled"
            );
          }
          lastResult = await subgraph({ state, ...(resume === undefined ? {} : { resume }) });
          resume = undefined;
          application = lastResult.application ?? application;
          await persist(application);

          if (lastResult.status === "interrupted" && lastResult.pendingInterrupt !== undefined) {
            const evidenceRefs = executionEvidence(options.evidenceStore, input, application, lastCommand);
            const runtimeInterrupt = toRuntimeInterrupt(
              lastResult.pendingInterrupt,
              input,
              approvalTtlMs,
              now,
              evidenceRefs,
              application
            );
            await persist(application, {
              ...lastResult.pendingInterrupt,
              evidenceIds: [...new Set([
                ...lastResult.pendingInterrupt.evidenceIds,
                ...evidenceRefs.map((ref) => ref.id)
              ])].slice(0, 100)
            });
            return finish({
              status: "interrupted",
              pendingInterrupt: runtimeInterrupt,
              evidenceRefs,
              toolCallsUsed: commandCount,
              retryable: false
            }, "handoff");
          }

          if (lastResult.status === "failed") {
            await persist(application);
            return finish({
              status: "failed",
              errorCode: lastResult.error?.code ?? "application_specialist_failed",
              evidenceRefs: executionEvidence(options.evidenceStore, input, application, lastCommand),
              toolCallsUsed: commandCount,
              retryable: false
            }, "failed");
          }

          const completedCount = application.completedCommandIds?.length ?? 0;
          if (completedCount > commandCount) commandCount = completedCount;

          state = initialGraphState(input, taskId, application, "running");
          // A successful command plus readback satisfies the current Runtime
          // step. The subgraph's `running` status only means another page
          // transaction could be attempted; that belongs to a subsequent
          // Runtime dispatch with a fresh checkpoint.
          if (commandCount > 0) break;
          if (lastResult.status === "running") continue;
          break;
        }
      } catch (error) {
        await persist(application);
        return finish({
          status: "failed",
          errorCode: "application_specialist_failed",
          evidenceRefs: executionEvidence(options.evidenceStore, input, application, lastCommand),
          toolCallsUsed: commandCount,
          retryable: false
        }, "failed");
      }

      const evidenceRefs = executionEvidence(options.evidenceStore, input, application, lastCommand);
      await persist(application);
      if (lastResult?.status === "running" && commandCount === 0) {
        return finish({
          status: "failed",
          errorCode: "application_specialist_iteration_limit",
          evidenceRefs,
          toolCallsUsed: commandCount,
          retryable: true
        }, "failed");
      }
      return finish({
        status: "completed",
        outputRef: application.snapshotId === undefined
          ? `application:${taskId}:completed`
          : `application:${taskId}:snapshot:${application.snapshotId}`,
        evidenceRefs,
        toolCallsUsed: commandCount,
        retryable: false
      }, "completed_pre_submit");
    }
  };
}

function initialGraphState(
  input: RuntimeExecutorInput,
  taskId: string,
  application: ApplicationExecutionState,
  status: AgentGraphState["status"],
  pendingInterrupt?: HumanInterrupt
): AgentGraphState {
  return {
    threadId: `runtime:${input.runId}`,
    runId: input.runId,
    taskId,
    graphVersion: "agent-v1",
    status,
    profileRevision: profileRevisionFor(input),
    currentSubgraph: "application",
    ...(pendingInterrupt === undefined ? {} : { pendingInterrupt }),
    auditEventIds: [],
    application
  };
}

function initialApplication(applicationUrl: string, executionEpoch: number): ApplicationExecutionState {
  return {
    applicationUrl,
    executionEpoch,
    retryCount: 0,
    finalReviewLocked: false,
    plannedCommandIds: [],
    completedCommandIds: []
  };
}

function applicationFromPersisted(
  persisted: RuntimeApplicationState,
  applicationUrl: string,
  executionEpoch: number
): ApplicationExecutionState {
  if (persisted.applicationUrl !== applicationUrl && applicationUrl !== "https://invalid.example/") {
    throw new Error("application_state_identity_mismatch");
  }
  return {
    applicationUrl: persisted.applicationUrl,
    ...(persisted.snapshotId === undefined ? {} : { snapshotId: persisted.snapshotId }),
    ...(persisted.fieldIds === undefined ? {} : { fieldIds: [...persisted.fieldIds] }),
    plannedCommandIds: [...persisted.plannedCommandIds],
    completedCommandIds: [...persisted.completedCommandIds],
    ...(persisted.skillBinding === undefined ? {} : { skillBinding: persisted.skillBinding }),
    ...(persisted.skillTrace === undefined ? {} : { skillTrace: persisted.skillTrace }),
    retryCount: persisted.retryCount,
    finalReviewLocked: persisted.finalReviewLocked,
    executionEpoch: Math.max(persisted.executionEpoch, executionEpoch)
  };
}

async function persistApplicationState(
  store: RuntimeApplicationStateStore,
  input: RuntimeExecutorInput,
  application: ApplicationExecutionState,
  pendingInterrupt?: HumanInterrupt,
  now: () => string = () => new Date().toISOString(),
  coverage?: ApplicationFieldCoverage
): Promise<void> {
  const taskId = applicationTaskId(input);
  await store.save({
    version: "1.1.0",
    runId: input.runId,
    taskId,
    applicationUrl: application.applicationUrl,
    ...(application.snapshotId === undefined ? {} : { snapshotId: application.snapshotId }),
    executionEpoch: application.executionEpoch,
    ...(application.fieldIds === undefined ? {} : { fieldIds: [...application.fieldIds] }),
    plannedCommandIds: [...(application.plannedCommandIds ?? [])],
    completedCommandIds: [...(application.completedCommandIds ?? [])],
    ...(application.skillBinding === undefined ? {} : { skillBinding: application.skillBinding }),
    ...(application.skillTrace === undefined ? {} : { skillTrace: application.skillTrace }),
    retryCount: application.retryCount,
    finalReviewLocked: application.finalReviewLocked,
    ...(coverage === undefined ? {} : { fieldCoverage: redactFieldCoverage(coverage) }),
    ...(pendingInterrupt === undefined ? {} : {
      pendingInterrupt: pendingInterruptForState(input, application, pendingInterrupt)
    }),
    updatedAt: now()
  });
}

function pendingInterruptForState(
  input: RuntimeExecutorInput,
  application: ApplicationExecutionState,
  pending: HumanInterrupt
): RuntimeApplicationPendingInterrupt {
  const taskId = applicationTaskId(input);
  const executionEpoch = pending.kind === "final_review"
    ? input.executionEpoch
    : application.executionEpoch;
  const snapshotId = application.snapshotId;
  const binding = pending.kind === "final_review"
    ? applicationApprovalBinding(input, application, pending)
    : undefined;
  return {
    ...pending,
    runId: input.runId,
    taskId,
    stepId: input.step.id,
    planRevision: input.plan.revision,
    executionEpoch,
    ...(snapshotId === undefined ? {} : { snapshotId }),
    ...(binding === undefined ? {} : {
      targetFingerprint: binding.targetFingerprint,
      payloadHash: binding.payloadHash
    }),
    safetyStateRef: `application:${taskId}:epoch:${executionEpoch}:snapshot:${snapshotId ?? "unknown"}`
  };
}

function applicationTaskId(input: RuntimeExecutorInput): string {
  const value = input.request?.metadata?.applicationTaskId
    ?? input.requestContext?.metadata.applicationTaskId;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : `application:${input.runId}`;
}

function applicationUrlFor(input: RuntimeExecutorInput): string {
  const metadataValue = input.request?.metadata?.applicationUrl
    ?? input.requestContext?.metadata.applicationUrl;
  if (typeof metadataValue === "string" && metadataValue.trim().length > 0) return metadataValue;
  const entity = input.intent.entities.applicationUrl?.value;
  if (typeof entity === "string" && entity.trim().length > 0) return entity;
  return "https://invalid.example/";
}

function profileRevisionFor(input: RuntimeExecutorInput): number {
  const value = input.request?.metadata?.profileRevision
    ?? input.requestContext?.metadata.profileRevision;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function toApplicationResume(input: RuntimeHumanResume, pending: HumanInterrupt): HumanResume {
  const action = input.action === "cancel" || input.action === "reject"
    ? input.action
    : input.action === "correct" ? "correct" : input.action === "approve" ? "approve" : "confirm";
  return { interruptId: pending.id, action, values: input.values };
}

function interruptReason(kind: HumanInterrupt["kind"]): RuntimeHumanInterrupt["reason"] {
  switch (kind) {
    case "final_review": return "final_submit";
    case "login": return "authentication";
    case "challenge": return "captcha";
    case "missing_fact":
    case "fact_conflict":
    case "field_semantics": return "ambiguous_fact";
    case "content_review": return "high_risk_action";
  }
}

function toRuntimeInterrupt(
  interrupt: HumanInterrupt,
  input: RuntimeExecutorInput,
  approvalTtlMs: number,
  now: () => string,
  evidence: readonly EvidenceRef[] = [],
  application?: ApplicationExecutionState,
  binding?: RuntimeApplicationPendingInterrupt
): RuntimeHumanInterrupt {
  const reason = interruptReason(interrupt.kind);
  const taskId = binding?.taskId ?? applicationTaskId(input);
  const runId = binding?.runId ?? input.runId;
  // Browser commands maintain their own monotonically increasing safety epoch.
  // The final-submit binding, however, is owned by Runtime and must use the
  // Runtime epoch so the supervisor can validate the interrupt before resume.
  const executionEpoch = binding?.executionEpoch
    ?? (reason === "final_submit" ? input.executionEpoch : application?.executionEpoch ?? input.executionEpoch);
  const snapshotId = binding?.snapshotId ?? application?.snapshotId;
  const approvalBinding = reason === "final_submit" && application !== undefined
    ? applicationApprovalBinding(input, application, interrupt)
    : undefined;
  const questionIds = [...new Set(interrupt.questionIds)].slice(0, 50);
  const evidenceRefs = [...new Set([
    ...interrupt.evidenceIds,
    ...evidence.map((ref) => ref.id)
  ])].slice(0, 100);
  return {
    interruptId: interrupt.id,
    reason,
    summary: bounded(interrupt.reasonCode),
    evidenceRefs,
    proposedAction: {
      runId,
      taskId,
      stepId: binding?.stepId ?? input.step.id,
      planRevision: binding?.planRevision ?? input.plan.revision,
      executionEpoch,
      ...(snapshotId === undefined ? {} : { snapshotId }),
      ...(approvalBinding === undefined ? {} : {
        targetFingerprint: approvalBinding.targetFingerprint,
        payloadHash: approvalBinding.payloadHash
      }),
      questionIds,
      safetyStateRef: binding?.safetyStateRef
        ?? `application:${taskId}:epoch:${executionEpoch}:snapshot:${snapshotId ?? "unknown"}`,
      kind: reason === "final_submit" ? "final_submit" : "application_review"
    },
    expiresAt: new Date(Date.parse(now()) + approvalTtlMs).toISOString()
  };
}

function applicationApprovalBinding(
  input: RuntimeExecutorInput,
  application: ApplicationExecutionState,
  pending: { kind?: string } | undefined
): { targetFingerprint: string; payloadHash: string } | undefined {
  if (application.snapshotId === undefined) return undefined;
  const taskId = applicationTaskId(input);
  const target = {
    taskId,
    applicationUrl: application.applicationUrl,
    snapshotId: application.snapshotId,
    fieldIds: [...(application.fieldIds ?? [])]
  };
  const payload = {
    taskId,
    stepId: input.step.id,
    planRevision: input.plan.revision,
    applicationUrl: application.applicationUrl,
    snapshotId: application.snapshotId,
    fieldIds: [...(application.fieldIds ?? [])],
    plannedCommandIds: [...(application.plannedCommandIds ?? [])],
    completedCommandIds: [...(application.completedCommandIds ?? [])],
    reason: pending?.kind ?? "final_review"
  };
  return {
    targetFingerprint: createHash("sha256").update(JSON.stringify(target), "utf8").digest("hex"),
    payloadHash: createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex")
  };
}

function trackedTools(
  source: ApplicationTools,
  onCommand: (command: ExecutableCommand) => void,
  skillAttempt?: SkillAttemptEvidence
): ApplicationTools {
  return {
    ...source,
    normalize(snapshot) {
      const normalized = source.normalize(snapshot);
      skillAttempt?.observe(normalized);
      return normalized;
    },
    async buildPlan(input) {
      const commands = await source.buildPlan(input);
      skillAttempt?.plan(input.snapshot, commands);
      return commands;
    },
    async execute(command) {
      onCommand(command);
      try {
        const result = await source.execute(command);
        skillAttempt?.executed(command, result);
        return result;
      } catch (error) {
        skillAttempt?.failed("write", "write_failed", skillAttempt.semanticFor(command));
        throw error;
      }
    },
    async readback(taskId, expected) {
      try {
        const result = await source.readback(taskId, expected);
        skillAttempt?.readback(expected, result);
        return result;
      } catch (error) {
        skillAttempt?.failed("readback", "readback_mismatch");
        throw error;
      }
    },
    async fullPageAudit(input) {
      try {
        const result = await source.fullPageAudit(input);
        skillAttempt?.audit(result);
        return result;
      } catch (error) {
        skillAttempt?.failed("audit", "audit_mismatch");
        throw error;
      }
    }
  };
}

function trackSkillRuntime(
  source: ApplicationSkillRuntimePort,
  attempt: SkillAttemptEvidence
): ApplicationSkillRuntimePort {
  return {
    async resolve(input) {
      const result = await source.resolve(input);
      if (result.kind === "selected"
        && result.pageVariantId !== undefined
        && result.allocation !== undefined) {
        attempt.bind(result.binding, result.pageVariantId, result.allocation);
      }
      return result;
    }
  };
}

type SkillFailure = SkillExecutionRecordInput["failures"][number];
type SkillFieldPlan = SkillExecutionRecordInput["fieldPlans"][number];
type SkillReadback = SkillExecutionRecordInput["readbacks"][number];

class SkillAttemptEvidence {
  private binding?: SkillBinding;
  private pageVariantId?: string;
  private allocation?: "champion" | "challenger";
  private readonly observedSemantics = new Set<ApplicationFieldSemantic>();
  private readonly fieldPlans = new Map<ApplicationFieldSemantic, SkillFieldPlan>();
  private readonly readbacks = new Map<ApplicationFieldSemantic, SkillReadback>();
  private readonly semanticByCommand = new Map<string, ApplicationFieldSemantic>();
  private readonly expectedUrlByCommand = new Map<string, string>();
  private readonly semanticsByField = new Map<string, ApplicationFieldSemantic>();
  private readonly auditMismatchClasses = new Set<SkillExecutionRecordInput["auditMismatchClasses"][number]>();
  private readonly failures: SkillFailure[] = [];

  public constructor(
    private readonly input: RuntimeExecutorInput,
    private readonly taskId: string,
    private readonly startedAt: string
  ) {}

  public isBound(): boolean {
    return this.binding !== undefined && this.pageVariantId !== undefined && this.allocation !== undefined;
  }

  public bind(binding: SkillBinding, pageVariantId: string, allocation: "champion" | "challenger"): void {
    if (this.binding !== undefined) return;
    this.binding = binding;
    this.pageVariantId = pageVariantId;
    this.allocation = allocation;
  }

  public observe(snapshot: FormSnapshot): void {
    for (const field of snapshot.fields) {
      const parsed = ApplicationFieldSemanticSchema.safeParse(semanticTemplate(field.semanticHint));
      if (!parsed.success) continue;
      this.observedSemantics.add(parsed.data);
      this.semanticsByField.set(field.id, parsed.data);
    }
  }

  public plan(snapshot: FormSnapshot, commands: readonly ExecutableCommand[]): void {
    this.observe(snapshot);
    for (const command of commands) {
      const semantic = this.semanticFor(command);
      if (semantic === undefined) continue;
      const commandId = applicationCommandId(command);
      this.semanticByCommand.set(commandId, semantic);
      this.expectedUrlByCommand.set(commandId, snapshot.url);
      this.fieldPlans.set(semantic, { semantic, outcome: "resolved" });
    }
  }

  public semanticFor(command: ExecutableCommand): ApplicationFieldSemantic | undefined {
    const mapped = this.semanticByCommand.get(applicationCommandId(command));
    if (mapped !== undefined) return mapped;
    return "fieldId" in command ? this.semanticsByField.get(command.fieldId) : undefined;
  }

  public executed(command: ExecutableCommand, result: ApplicationExecutionResult): void {
    const semantic = this.semanticFor(command);
    if (semantic === undefined) return;
    if (this.expectedUrlByCommand.get(applicationCommandId(command)) !== result.snapshot.url
      || (result.errors ?? []).some((error) => /execution context was destroyed.*navigation|because of a navigation/iu.test(error))) {
      this.auditMismatchClasses.add("unexpected_navigation");
    }
    if (result.status === "applied") {
      this.fieldPlans.set(semantic, { semantic, outcome: "filled" });
      return;
    }
    this.fieldPlans.set(semantic, { semantic, outcome: "failed", errorClass: "write_failed" });
    this.failed("write", "write_failed", semantic);
  }

  public readback(expected: readonly ExecutableCommand[], result: ReadbackResult): void {
    for (const command of expected) {
      const semantic = this.semanticFor(command);
      if (semantic === undefined) continue;
      if (result.status === "confirmed") {
        this.readbacks.set(semantic, { semantic, outcome: "verified" });
      } else if (result.status === "challenge") {
        this.readbacks.set(semantic, { semantic, outcome: "failed", errorClass: "challenge" });
        this.failed("readback", "challenge", semantic);
      } else {
        this.readbacks.set(semantic, { semantic, outcome: "failed", errorClass: "readback_mismatch" });
        this.failed("readback", "readback_mismatch", semantic);
      }
    }
  }

  public audit(result: FullPageAuditResult): void {
    for (const mismatch of result.mismatches) {
      this.auditMismatchClasses.add("unexpected_value");
      this.failed("audit", "audit_mismatch", this.semanticsByField.get(mismatch.fieldId));
    }
  }

  public failed(stage: SkillFailure["stage"], errorClass: SkillFailure["errorClass"], semantic?: ApplicationFieldSemantic): void {
    this.failures.push({ stage, errorClass, ...(semantic === undefined ? {} : { semantic }) });
  }

  public complete(input: {
    terminalResult: SkillExecutionRecordInput["terminalResult"];
    completedAt: string;
    retries: number;
    userCorrections: number;
  }): SkillExecutionRecordInput {
    if (!this.isBound()) throw new Error("application_skill_attempt_unbound");
    return {
      taskId: this.taskId,
      attemptId: attemptId(this.input),
      binding: this.binding!,
      pageVariantId: this.pageVariantId!,
      allocation: this.allocation!,
      observedSemantics: [...this.observedSemantics],
      fieldPlans: [...this.fieldPlans.values()],
      readbacks: [...this.readbacks.values()],
      auditMismatchClasses: [...this.auditMismatchClasses],
      failures: [...this.failures],
      userCorrections: input.userCorrections,
      retries: Math.min(3, Math.max(0, input.retries)),
      recoveries: 0,
      durationMs: Math.max(0, Date.parse(input.completedAt) - Date.parse(this.startedAt)),
      terminalResult: input.terminalResult,
      startedAt: this.startedAt,
      completedAt: input.completedAt
    };
  }
}

function semanticTemplate(value: unknown): unknown {
  return typeof value === "string"
    ? value.replace(/^([a-z]+)\[\d+\]/u, "$1[]")
    : value;
}

function attemptId(input: RuntimeExecutorInput): string {
  const identity = [
    input.runId,
    input.step.id,
    input.step.attemptToken ?? input.step.attempt,
    input.humanResume?.interruptId ?? "initial"
  ].join("\0");
  return `attempt-${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 32)}`;
}

function executionEvidence(
  store: EvidenceStore,
  input: RuntimeExecutorInput,
  application: ApplicationExecutionState,
  command: ExecutableCommand | undefined
): EvidenceRef[] {
  const refs = registerEvidence(store, input, "observation", `browser:snapshot:${application.snapshotId ?? "unknown"}`);
  if (command !== undefined) refs.push(...registerEvidence(store, input, "action", `browser:action:${applicationCommandId(command)}`));
  return refs;
}

function registerEvidence(
  store: EvidenceStore,
  input: RuntimeExecutorInput,
  kind: EvidenceRef["kind"],
  sourceRef: string
): EvidenceRef[] {
  try {
    const invocationId = input.step.attemptToken ?? `${input.runId}:${input.step.id}:${input.step.attempt}`;
    const record = store.register({
      runId: input.runId,
      stepId: input.step.id,
      invocationId,
      kind,
      sourceRef: sourceRef.slice(0, 256),
      contentHash: createHash("sha256")
        .update(`${input.runId}\u0000${input.step.id}\u0000${sourceRef}`)
        .digest("hex")
    });
    return [{
      id: record.id,
      kind: record.kind,
      sourceRef: record.sourceRef,
      contentHash: record.contentHash,
      ...(record.locator === undefined ? {} : { locator: record.locator })
    }];
  } catch {
    return [];
  }
}

function bounded(value: string): string {
  return value.trim().slice(0, 2_000) || "Human confirmation is required.";
}

const emptyTraceSink: TraceSink = {
  record() {
    return "trace:application";
  },
  list() {
    return [];
  }
};
