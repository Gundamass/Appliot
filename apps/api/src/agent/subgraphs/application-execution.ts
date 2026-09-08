import { createHash } from "node:crypto";
import type {
  AgentGraphState,
  ApplicationContentReview,
  ApplicationExecutionState,
  ExecutableCommand,
  FormSnapshot,
  HumanInterrupt,
  ApplicationFieldSemantic,
  SkillBinding,
  SkillDirective,
  SkillTraceDimensions
} from "@resume/contracts";
import { SkillBindingSchema, SkillDirectiveSchema } from "@resume/contracts";
import {
  applicationCommandId,
  type ApplicationTools,
  type FieldResolutionBatch,
  type ReadbackResult,
  type ResolvedApplicationField
} from "../application-tools.js";
import type { SubgraphPort, SubgraphPortInput, SubgraphPortResult } from "../main-graph.js";
import type { TraceSink } from "../trace-sink.js";
import type { FieldCoverageStore } from "../../applications/field-coverage.js";

const MAX_TRACKED_IDS = 100;

export interface ApplicationExecutionSubgraphDependencies {
  tools: ApplicationTools;
  traceSink: TraceSink;
  fieldCoverage?: FieldCoverageStore;
  skillRuntime?: ApplicationSkillRuntimePort;
  now?: () => Date;
  onInterrupt?: (interrupt: HumanInterrupt) => void;
  onContentReview?: (input: {
    taskId: string;
    interrupt: HumanInterrupt;
    review: ContentReviewDraft;
  }) => void | Promise<void>;
}

export interface ApplicationSkillRuntimePort {
  resolve(input: {
    runId: string;
    taskId: string;
    snapshot: FormSnapshot;
    binding?: SkillBinding;
  }): Promise<
    | {
        kind: "selected";
        binding: SkillBinding;
        pageVariantId?: string;
        allocation?: "champion" | "challenger";
        directives: readonly SkillDirective[];
      }
    | { kind: "observe_only_handoff"; reason: "page_unmatched" | "safe_version_unavailable" }
    | { kind: "not_applicable" }
  >;
}

export type ContentReviewDraft = Omit<ApplicationContentReview, "id">;

type ResolutionInterrupt = {
  kind: HumanInterrupt["kind"];
  reasonCode: string;
  questionIds: string[];
  evidenceIds: string[];
  contentReview?: ContentReviewDraft;
};

type ReadbackVerification =
  | {
      status: "confirmed";
      application: ApplicationExecutionState;
      snapshot: FormSnapshot;
    }
  | {
      status: "stopped";
      result: SubgraphPortResult;
    };

type FullPageAuditVerification =
  | {
      status: "confirmed";
      application: ApplicationExecutionState;
      snapshot: FormSnapshot;
    }
  | {
      status: "stopped";
      result: SubgraphPortResult;
    };

type ResolutionCounts = {
  verified: number;
  deferred: number;
  needsQuestion: number;
  blocked: number;
};

/**
 * The outer LangGraph owns persistence and resume delivery. This port keeps a
 * single browser operation bounded to a fresh snapshot, rather than allowing a
 * model or a stale checkpoint to manufacture a write command.
 */
export function createApplicationExecutionSubgraph(
  dependencies: ApplicationExecutionSubgraphDependencies
): SubgraphPort {
  return async (input) => {
    if (input.state.currentSubgraph !== "application") {
      return failed(input.state.application, "application_subgraph_mismatch", "observe_page");
    }
    if (input.resume !== undefined) return resumeApplication(dependencies, input);
    return executeApplication(dependencies, input.state);
  };
}

async function resumeApplication(
  dependencies: ApplicationExecutionSubgraphDependencies,
  input: SubgraphPortInput
): Promise<SubgraphPortResult> {
  const application = input.state.application;
  const pendingInterrupt = input.state.pendingInterrupt;
  const resume = input.resume!;
  if (input.state.status !== "interrupted" || application === undefined || pendingInterrupt === undefined) {
    return failed(application, "application_resume_not_pending", "apply_resume");
  }
  if (pendingInterrupt.id !== resume.interruptId) {
    return failed(application, "application_resume_interrupt_mismatch", "apply_resume");
  }

  if (resume.action === "cancel") {
    let executionEpoch: number;
    try {
      executionEpoch = await dependencies.tools.invalidate(input.state.taskId);
      await dependencies.tools.release(input.state.taskId);
    } catch {
      return failed(application, "application_cancel_invalidation_failed", "cancelled");
    }
    const cancelled = { ...application, executionEpoch, finalReviewLocked: application.finalReviewLocked };
    record(dependencies, input.state, "cancelled", "safety_block", "completed", "application_cancelled");
    return { status: "cancelled", currentNode: "cancelled", application: cancelled };
  }

  if (resume.action === "reject") {
    if (pendingInterrupt.kind !== "content_review") {
      return failed(application, "application_reject_action_invalid", "apply_resume");
    }
    let executionEpoch: number;
    try {
      executionEpoch = await dependencies.tools.invalidate(input.state.taskId);
      await dependencies.tools.release(input.state.taskId);
    } catch {
      return failed(application, "content_review_rejection_invalidation_failed", "content_review_rejected");
    }
    const rejected = { ...application, executionEpoch, finalReviewLocked: application.finalReviewLocked };
    record(dependencies, input.state, "content_review_rejected", "safety_block", "completed", "content_review_rejected");
    return failed(rejected, "content_review_rejected", "content_review_rejected");
  }

  if (pendingInterrupt.kind === "final_review") {
    if (resume.action !== "approve" && resume.action !== "confirm") {
      return failed(application, "application_final_review_action_invalid", "apply_resume");
    }
    record(dependencies, input.state, "apply_resume", "node", "completed", "final_review_acknowledged");
    // A human acknowledgement completes graph ownership only. It never sends a submit command.
    return {
      status: "completed",
      currentNode: "final_review_acknowledged",
      application: { ...application, finalReviewLocked: true }
    };
  }

  if (resume.action !== "confirm" && resume.action !== "correct" && resume.action !== "approve") {
    return failed(application, "application_resume_action_invalid", "apply_resume");
  }
  record(dependencies, input.state, "apply_resume", "node", "completed", "application_resume_accepted");
  return executeApplication(dependencies, input.state);
}

async function executeApplication(
  dependencies: ApplicationExecutionSubgraphDependencies,
  state: AgentGraphState
): Promise<SubgraphPortResult> {
  const initial = state.application;
  if (initial === undefined) return failed(undefined, "application_state_missing", "observe_page");

  let observed: FormSnapshot;
  try {
    observed = await dependencies.tools.observe(state.taskId);
  } catch {
    return failed(initial, "application_observe_failed", "observe_page");
  }
  let application = withSnapshot(initial, observed);
  syncUserCoverage(dependencies.fieldCoverage, state.taskId, observed);
  record(dependencies, state, "observe_page", "tool_call", "completed", "snapshot_observed", {
    counts: { fields: observed.fields.length, actions: observed.actions.length }
  });

  record(dependencies, state, "classify_page", "node", "completed", pageReason(observed));
  const classified = await routeClassifiedPage(dependencies, state, application, observed, "classify_page");
  if (classified !== undefined) return classified;

  let snapshot: FormSnapshot;
  try {
    snapshot = dependencies.tools.normalize(observed);
  } catch {
    return failed(application, "application_normalization_failed", "normalize_fields");
  }
  application = withSnapshot(application, snapshot);
  syncUserCoverage(dependencies.fieldCoverage, state.taskId, snapshot);
  record(dependencies, state, "normalize_fields", "node", "completed", "fields_normalized", {
    counts: { fields: snapshot.fields.length }
  });

  let skillSemanticOrder: ApplicationFieldSemantic[] | undefined;
  if (dependencies.skillRuntime !== undefined) {
    let selection: Awaited<ReturnType<ApplicationSkillRuntimePort["resolve"]>>;
    try {
      selection = await dependencies.skillRuntime.resolve({
        runId: state.runId,
        taskId: state.taskId,
        snapshot,
        ...(application.skillBinding === undefined ? {} : { binding: application.skillBinding })
      });
    } catch {
      selection = { kind: "observe_only_handoff", reason: "safe_version_unavailable" };
    }
    if (selection.kind === "observe_only_handoff") {
      return interruptResult(dependencies, state, application, "select_application_skill", {
        kind: "field_semantics",
        reasonCode: selection.reason === "page_unmatched"
          ? "application_skill_page_unmatched"
          : "application_skill_unavailable",
        questionIds: [],
        evidenceIds: []
      });
    }
    if (selection.kind === "selected") {
      const parsedBinding = SkillBindingSchema.safeParse(selection.binding);
      const parsedDirectives = selection.directives.map((directive) => SkillDirectiveSchema.safeParse(directive));
      if (!parsedBinding.success || parsedDirectives.some((directive) => !directive.success)) {
        return interruptResult(dependencies, state, application, "select_application_skill", {
          kind: "field_semantics",
          reasonCode: "application_skill_unavailable",
          questionIds: [],
          evidenceIds: []
        });
      }
      if (application.skillBinding !== undefined && !sameSkillBinding(application.skillBinding, parsedBinding.data)) {
        return failed(application, "application_skill_binding_changed", "select_application_skill");
      }
      const directives = parsedDirectives.map((directive) => directive.data!);
      const skillTrace = selection.pageVariantId === undefined || selection.allocation === undefined
        ? undefined
        : {
            skillId: parsedBinding.data.skillId,
            skillVersion: parsedBinding.data.version,
            pageFingerprintHash: parsedBinding.data.pageFingerprintHash,
            pageVariantId: selection.pageVariantId,
            allocation: selection.allocation
          } satisfies SkillTraceDimensions;
      application = {
        ...application,
        skillBinding: parsedBinding.data,
        ...(skillTrace === undefined ? {} : { skillTrace })
      };
      skillSemanticOrder = directives
        .filter((directive): directive is Extract<SkillDirective, { kind: "resolve-field" }> => directive.kind === "resolve-field")
        .map((directive) => directive.semantic);
      record(dependencies, state, "select_application_skill", "node", "completed", "application_skill_bound", {
        counts: { directives: directives.length },
        ...(skillTrace === undefined ? {} : { skill: skillTrace })
      });
    }
  }

  return resolveAndExecute(dependencies, state, application, snapshot, skillSemanticOrder);
}

async function resolveAndExecute(
  dependencies: ApplicationExecutionSubgraphDependencies,
  state: AgentGraphState,
  application: ApplicationExecutionState,
  snapshot: FormSnapshot,
  skillSemanticOrder?: readonly ApplicationFieldSemantic[]
): Promise<SubgraphPortResult> {
  let deterministic: FieldResolutionBatch;
  try {
    deterministic = await dependencies.tools.resolveFields({
      taskId: state.taskId,
      snapshot,
      profileRevision: state.profileRevision,
      phase: "deterministic"
    });
  } catch {
    return failed(application, "application_deterministic_resolution_failed", "deterministic_semantics");
  }
  record(dependencies, state, "deterministic_semantics", "tool_call", "completed", "deterministic_fields_resolved", {
    candidateIds: fieldIds(deterministic.resolutions),
    counts: resolutionCounts(deterministic)
  });
  recordCoverage(dependencies.fieldCoverage, state.taskId, deterministic.resolutions);

  const deterministicInterrupt = findResolutionInterrupt(deterministic.resolutions, "deterministic");
  if (deterministicInterrupt !== undefined) {
    return await interruptResult(
      dependencies,
      state,
      application,
      "deterministic_semantics",
      deterministicInterrupt
    );
  }

  const deterministicCommands = resolvableCount(deterministic);
  const deferredFieldIds = deterministic.resolutions
    .filter((resolution) => resolution.status === "deferred")
    .map((resolution) => resolution.field.id);
  let resolutions = deterministic;

  if (deterministicCommands === 0 && deferredFieldIds.length > 0) {
    record(dependencies, state, "retrieve_semantic_candidates", "node", "completed", "semantic_candidates_requested", {
      candidateIds: deferredFieldIds,
      counts: { fields: deferredFieldIds.length }
    });
    try {
      resolutions = await dependencies.tools.resolveFields({
        taskId: state.taskId,
        snapshot,
        profileRevision: state.profileRevision,
        phase: "semantic",
        fieldIds: deferredFieldIds
      });
    } catch {
      return failed(application, "application_semantic_resolution_failed", "judge_field_semantics");
    }
    record(dependencies, state, "judge_field_semantics", "model_decision", "completed", "semantic_fields_resolved", {
      candidateIds: fieldIds(resolutions.resolutions),
      counts: resolutionCounts(resolutions)
    });
    recordCoverage(dependencies.fieldCoverage, state.taskId, resolutions.resolutions);
    const semanticInterrupt = findResolutionInterrupt(resolutions.resolutions, "semantic");
    if (semanticInterrupt !== undefined) {
      return await interruptResult(
        dependencies,
        state,
        application,
        "judge_field_semantics",
        semanticInterrupt
      );
    }
  } else {
    record(dependencies, state, "retrieve_semantic_candidates", "node", "skipped", "deterministic_resolution_available");
    record(dependencies, state, "judge_field_semantics", "model_decision", "skipped", "semantic_judgement_not_needed");
  }

  record(dependencies, state, "retrieve_profile_facts", "node", "completed", "evidence_resolution_completed", {
    counts: resolutionCounts(resolutions)
  });
  record(dependencies, state, "compose_values", "node", "completed", "values_composed", {
    counts: { ready: resolvableCount(resolutions) }
  });
  record(dependencies, state, "verify_evidence_and_risk", "safety_block", "accepted", "evidence_and_risk_verified", {
    candidateIds: verifiedFieldIds(resolutions)
  });

  const nextEpoch = application.executionEpoch + 1;
  let planned: ExecutableCommand[];
  try {
    planned = await dependencies.tools.buildPlan({
      taskId: state.taskId,
      snapshot,
      resolutions,
      executionEpoch: nextEpoch,
      ...(skillSemanticOrder === undefined ? {} : { skillSemanticOrder })
    });
  } catch {
    return failed(application, "application_fill_plan_failed", "build_fill_plan");
  }
  record(dependencies, state, "build_fill_plan", "tool_call", "completed", "fill_plan_built", {
    candidateIds: planned.map(applicationCommandId),
    counts: { commands: planned.length }
  });

  if (planned.length > 0) {
    return runCommands(dependencies, state, application, snapshot, planned, "field_applied");
  }

  let navigation: ExecutableCommand | undefined;
  try {
    navigation = await dependencies.tools.buildNavigationPlan({
      taskId: state.taskId,
      snapshot,
      executionEpoch: nextEpoch
    });
  } catch {
    return failed(application, "application_navigation_plan_failed", "build_fill_plan");
  }
  if (navigation !== undefined) {
    record(dependencies, state, "build_fill_plan", "tool_call", "completed", "navigation_plan_built", {
      candidateIds: [applicationCommandId(navigation)],
      counts: { commands: 1 }
    });
    const audit = await verifyFullPageAudit(
      dependencies,
      state,
      application,
      snapshot,
      [],
      "phase_boundary"
    );
    if (audit.status === "stopped") return audit.result;
    return runCommands(dependencies, state, audit.application, audit.snapshot, [navigation], "phase_boundary");
  }

  if (hasTerminalAction(snapshot)) {
    return lockFinalReview(dependencies, state, application, snapshot, "route_next");
  }
  record(dependencies, state, "route_next", "node", "completed", "waiting_for_page_change");
  return { status: "running", currentNode: "route_next", application };
}

async function runCommands(
  dependencies: ApplicationExecutionSubgraphDependencies,
  state: AgentGraphState,
  application: ApplicationExecutionState,
  snapshot: FormSnapshot,
  planned: readonly ExecutableCommand[],
  auditReason: "field_applied" | "phase_boundary"
): Promise<SubgraphPortResult> {
  if (planned.length !== 1 || !planned.every((command) => isPermittedCommand(command, snapshot))) {
    record(dependencies, state, "build_fill_plan", "safety_block", "blocked", "application_command_denied", {
      counts: { commands: planned.length }
    });
    return failed(application, "application_command_denied", "build_fill_plan");
  }
  const plannedIds = planned.map(applicationCommandId);
  application = {
    ...application,
    plannedCommandIds: appendIds(application.plannedCommandIds, plannedIds),
    executionEpoch: planned[0]!.executionEpoch
  };

  let authorized: ExecutableCommand[];
  try {
    authorized = [];
    for (const command of planned) authorized.push(await dependencies.tools.authorize(command, snapshot));
  } catch {
    return failed(application, "application_authorization_failed", "authorize_plan");
  }
  if (!authorized.every((command) => isPermittedCommand(command, snapshot))) {
    return failed(application, "application_authorization_denied", "authorize_plan");
  }
  record(dependencies, state, "authorize_plan", "tool_call", "completed", "commands_authorized", {
    candidateIds: authorized.map(applicationCommandId),
    counts: { commands: authorized.length }
  });

  let result;
  try {
    result = await dependencies.tools.execute(authorized[0]!);
  } catch {
    markCommandFailures(dependencies.fieldCoverage, authorized, "application_execution_failed");
    return invalidateAndFail(
      dependencies,
      state,
      application,
      "application_execution_failed",
      "execute_plan"
    );
  }
  let executionSnapshot: FormSnapshot;
  try {
    executionSnapshot = dependencies.tools.normalize(result.snapshot);
  } catch {
    return invalidateAndFail(
      dependencies,
      state,
      application,
      "application_normalization_failed",
      "execute_plan"
    );
  }
  application = withSnapshot({
    ...application,
    completedCommandIds: appendIds(application.completedCommandIds, authorized.map(applicationCommandId))
  }, executionSnapshot);
  record(dependencies, state, "execute_plan", "tool_call", result.status === "applied" ? "completed" : "blocked", result.status === "applied" ? "command_applied" : "command_not_applied", {
    candidateIds: authorized.map(applicationCommandId),
    counts: { commands: authorized.length }
  });

  if (executionSnapshot.challenge !== undefined) {
    return interruptForChallenge(dependencies, state, application, executionSnapshot, "execute_plan");
  }
  if (result.status !== "applied") {
    markCommandFailures(dependencies.fieldCoverage, authorized, result.errors[0] ?? "application_execution_not_applied");
    return invalidateAndFail(dependencies, state, application, "application_execution_not_applied", "execute_plan");
  }

  const readback = await verifyReadback(dependencies, state, application, authorized);
  if (readback.status === "stopped") return readback.result;
  application = readback.application;
  if (readback.snapshot !== undefined) {
    markCommandsFilled(dependencies.fieldCoverage, authorized, result.warnings ?? []);
    syncUserCoverage(dependencies.fieldCoverage, state.taskId, readback.snapshot);
  }

  if (auditReason === "field_applied") {
    const audit = await verifyFullPageAudit(
      dependencies,
      state,
      application,
      readback.snapshot,
      authorized,
      auditReason
    );
    if (audit.status === "stopped") return audit.result;
    application = audit.application;
    return routeNext(dependencies, state, application, audit.snapshot);
  }
  return routeNext(dependencies, state, application, readback.snapshot);
}

async function verifyFullPageAudit(
  dependencies: ApplicationExecutionSubgraphDependencies,
  state: AgentGraphState,
  application: ApplicationExecutionState,
  snapshot: FormSnapshot,
  expected: readonly ExecutableCommand[],
  reason: "field_applied" | "phase_boundary"
): Promise<FullPageAuditVerification> {
  let audit;
  try {
    audit = await dependencies.tools.fullPageAudit({
      taskId: state.taskId,
      snapshot,
      expected: [...expected],
      reason
    });
  } catch {
    return {
      status: "stopped",
      result: await invalidateAndFail(dependencies, state, application, "application_full_page_audit_failed", "full_page_audit")
    };
  }
  const auditedApplication = withSnapshot(application, audit.snapshot);
  record(dependencies, state, "full_page_audit", "tool_call", audit.mismatches.length === 0 ? "completed" : "blocked", audit.mismatches.length === 0 ? "page_audit_passed" : "page_audit_mismatch", {
    counts: { mismatches: audit.mismatches.length }
  });
  if (audit.mismatches.length > 0) {
    for (const mismatch of audit.mismatches) {
      dependencies.fieldCoverage?.markFailed(state.taskId, mismatch.fieldId, "FULL_PAGE_AUDIT_MISMATCH");
    }
    return {
      status: "stopped",
      result: await invalidateAndFail(dependencies, state, auditedApplication, "FULL_PAGE_AUDIT_MISMATCH", "full_page_audit")
    };
  }
  return { status: "confirmed", application: auditedApplication, snapshot: audit.snapshot };
}

async function verifyReadback(
  dependencies: ApplicationExecutionSubgraphDependencies,
  state: AgentGraphState,
  application: ApplicationExecutionState,
  expected: readonly ExecutableCommand[]
): Promise<ReadbackVerification> {
  let first: ReadbackResult;
  try {
    first = await dependencies.tools.readback(state.taskId, [...expected]);
  } catch {
    return {
      status: "stopped",
      result: await invalidateAndFail(dependencies, state, application, "application_readback_failed", "double_readback")
    };
  }
  const firstResult = await handleReadbackResult(dependencies, state, application, first, expected, false);
  if (firstResult.status !== "retry") return firstResult;

  try {
    const second = await dependencies.tools.readback(state.taskId, [...expected]);
    const secondResult = await handleReadbackResult(
      dependencies,
      state,
      firstResult.application,
      second,
      expected,
      true
    );
    if (secondResult.status !== "retry") return secondResult;
    return {
      status: "stopped",
      result: await invalidateAndFail(
        dependencies,
        state,
        secondResult.application,
        "READBACK_MISMATCH",
        "double_readback"
      )
    };
  } catch {
    return {
      status: "stopped",
      result: await invalidateAndFail(
        dependencies,
        state,
        firstResult.application,
        "application_readback_failed",
        "double_readback"
      )
    };
  }
}

async function handleReadbackResult(
  dependencies: ApplicationExecutionSubgraphDependencies,
  state: AgentGraphState,
  application: ApplicationExecutionState,
  readback: ReadbackResult,
  expected: readonly ExecutableCommand[],
  retried: boolean
): Promise<ReadbackVerification | { status: "retry"; application: ApplicationExecutionState }> {
  const current = withSnapshot(application, readback.snapshot);
  if (readback.status === "challenge") {
    return {
      status: "stopped",
      result: await interruptForChallenge(dependencies, state, current, readback.snapshot, "double_readback")
    };
  }
  if (readback.status === "confirmed") {
    record(dependencies, state, "double_readback", "tool_call", "completed", "double_readback_confirmed", {
      candidateIds: expected.map(applicationCommandId),
      counts: { observations: readback.observations }
    });
    return { status: "confirmed", application: current, snapshot: readback.snapshot };
  }

  const retriedApplication = { ...current, retryCount: 1 };
  for (const mismatch of readback.mismatches) {
    dependencies.fieldCoverage?.markFailed(state.taskId, mismatch.fieldId, readback.code);
  }
  record(dependencies, state, "double_readback", "safety_block", "blocked", readback.code, {
    candidateIds: expected.map(applicationCommandId),
    counts: { observation: readback.observation, mismatches: readback.mismatches.length }
  });
  if (!retried && application.retryCount === 0) {
    return { status: "retry", application: retriedApplication };
  }
  return {
    status: "stopped",
    result: await invalidateAndFail(
      dependencies,
      state,
      retriedApplication,
      "READBACK_MISMATCH",
      "double_readback"
    )
  };
}

async function routeNext(
  dependencies: ApplicationExecutionSubgraphDependencies,
  state: AgentGraphState,
  application: ApplicationExecutionState,
  snapshot: FormSnapshot
): Promise<SubgraphPortResult> {
  record(dependencies, state, "route_next", "node", "completed", pageReason(snapshot));
  const classified = await routeClassifiedPage(dependencies, state, application, snapshot, "route_next");
  if (classified !== undefined) return classified;
  return { status: "running", currentNode: "route_next", application: withSnapshot(application, snapshot) };
}

async function routeClassifiedPage(
  dependencies: ApplicationExecutionSubgraphDependencies,
  state: AgentGraphState,
  application: ApplicationExecutionState,
  snapshot: FormSnapshot,
  currentNode: string
): Promise<SubgraphPortResult | undefined> {
  if (snapshot.challenge !== undefined) {
    return interruptForChallenge(dependencies, state, application, snapshot, currentNode);
  }
  if (snapshot.stage === "login") {
    return interruptResult(dependencies, state, withSnapshot(application, snapshot), currentNode, {
      kind: "login",
      reasonCode: "login_required",
      questionIds: [],
      evidenceIds: []
    });
  }
  if (snapshot.stage === "review" || snapshot.stage === "success") {
    return lockFinalReview(dependencies, state, application, snapshot, currentNode);
  }
  if (snapshot.stage !== "application_form") {
    return failed(withSnapshot(application, snapshot), "application_page_unrecognized", currentNode);
  }
  return undefined;
}

async function interruptForChallenge(
  dependencies: ApplicationExecutionSubgraphDependencies,
  state: AgentGraphState,
  application: ApplicationExecutionState,
  snapshot: FormSnapshot,
  currentNode: string
): Promise<SubgraphPortResult> {
  let executionEpoch: number;
  try {
    executionEpoch = await dependencies.tools.invalidate(state.taskId);
  } catch {
    return failed(application, "challenge_invalidation_failed", currentNode);
  }
  const interrupted = withSnapshot({ ...application, executionEpoch }, snapshot);
  record(dependencies, state, currentNode, "safety_block", "blocked", "challenge_detected");
  return interruptResult(dependencies, state, interrupted, currentNode, {
    kind: "challenge",
    reasonCode: boundedReason(snapshot.challenge?.reasonCode, "challenge_detected"),
    questionIds: [],
    evidenceIds: []
  });
}

async function lockFinalReview(
  dependencies: ApplicationExecutionSubgraphDependencies,
  state: AgentGraphState,
  application: ApplicationExecutionState,
  snapshot: FormSnapshot,
  currentNode: string
): Promise<SubgraphPortResult> {
  let executionEpoch: number;
  try {
    executionEpoch = await dependencies.tools.invalidate(state.taskId);
  } catch {
    return failed(application, "final_review_invalidation_failed", currentNode);
  }
  const locked = withSnapshot({ ...application, executionEpoch, finalReviewLocked: true }, snapshot);
  record(dependencies, state, currentNode, "safety_block", "blocked", "final_review_locked");
  return interruptResult(dependencies, state, locked, currentNode, {
    kind: "final_review",
    reasonCode: "final_review_required",
    questionIds: [],
    evidenceIds: []
  });
}

async function invalidateAndFail(
  dependencies: ApplicationExecutionSubgraphDependencies,
  state: AgentGraphState,
  application: ApplicationExecutionState,
  code: string,
  currentNode: string
): Promise<SubgraphPortResult> {
  try {
    const executionEpoch = await dependencies.tools.invalidate(state.taskId);
    return failed({ ...application, executionEpoch }, code, currentNode);
  } catch {
    return failed(application, "application_invalidation_failed", currentNode);
  }
}

function findResolutionInterrupt(
  resolutions: readonly ResolvedApplicationField[],
  phase: "deterministic" | "semantic"
): ResolutionInterrupt | undefined {
  const content = resolutions.find((resolution) => resolution.requiresContentReview);
  if (content !== undefined) {
    return {
      kind: "content_review",
      reasonCode: "content_review_required",
      questionIds: [`field:${content.field.id}`],
      evidenceIds: evidenceIdsFor([content]),
      contentReview: {
        fieldId: content.field.id,
        fieldLabel: content.field.label,
        original: content.contentReview?.original ?? String(content.value ?? ""),
        draft: String(content.value ?? ""),
        reasons: content.contentReview?.reasons ?? ["Human approval is required before this content can be filled."],
        evidence: content.contentReview?.evidence ?? [],
        unsupportedClaims: content.contentReview?.unsupportedClaims ?? [],
        status: content.contentReview?.status ?? "needs_review"
      }
    };
  }

  const review = resolutions.find((resolution) => resolution.assessment?.status === "review");
  if (review !== undefined) {
    return {
      kind: "field_semantics",
      reasonCode: "field_semantics_review",
      questionIds: [`field:${review.field.id}`],
      evidenceIds: evidenceIdsFor([review])
    };
  }

  const blocked = resolutions.find((resolution) => resolution.status === "blocked");
  if (blocked !== undefined) {
    return {
      kind: "field_semantics",
      reasonCode: "field_resolution_blocked",
      questionIds: [`field:${blocked.field.id}`],
      evidenceIds: evidenceIdsFor([blocked])
    };
  }

  const missing = resolutions.find((resolution) =>
    resolution.field.required && resolution.status === "needs_question"
  );
  if (missing !== undefined) {
    return {
      kind: "missing_fact",
      reasonCode: "profile_fact_required",
      questionIds: [`field:${missing.field.id}`],
      evidenceIds: evidenceIdsFor([missing])
    };
  }

  if (phase === "semantic") {
    const unresolved = resolutions.find((resolution) =>
      resolution.field.required && (resolution.status === "deferred" || resolution.status === "needs_question")
    );
    if (unresolved !== undefined) {
      return {
        kind: "field_semantics",
        reasonCode: "field_semantics_unresolved",
        questionIds: [`field:${unresolved.field.id}`],
        evidenceIds: evidenceIdsFor([unresolved])
      };
    }
  }
  return undefined;
}

async function interruptResult(
  dependencies: ApplicationExecutionSubgraphDependencies,
  state: AgentGraphState,
  application: ApplicationExecutionState,
  currentNode: string,
  input: ResolutionInterrupt
): Promise<SubgraphPortResult> {
  const pendingInterrupt = createInterrupt(state, application, input, dependencies.now);
  if (input.contentReview !== undefined) {
    try {
      await dependencies.onContentReview?.({
        taskId: state.taskId,
        interrupt: pendingInterrupt,
        review: input.contentReview
      });
    } catch {
      return failed(application, "content_review_persistence_failed", currentNode);
    }
  }
  record(dependencies, state, currentNode, "interrupt", "pending", input.reasonCode, {
    evidenceIds: pendingInterrupt.evidenceIds,
    counts: { questions: pendingInterrupt.questionIds.length }
  });
  try {
    dependencies.onInterrupt?.(pendingInterrupt);
  } catch {
    // Interrupt delivery is advisory; persisted graph state remains authoritative.
  }
  return {
    status: "interrupted",
    currentNode,
    pendingInterrupt,
    application
  };
}

function createInterrupt(
  state: AgentGraphState,
  application: ApplicationExecutionState,
  input: ResolutionInterrupt,
  now: (() => Date) | undefined
): HumanInterrupt {
  const questionIds = uniqueIds(input.questionIds).slice(0, 50);
  const evidenceIds = uniqueIds(input.evidenceIds).slice(0, 100);
  const seed = [
    state.runId,
    state.taskId,
    application.snapshotId ?? "",
    application.executionEpoch,
    input.kind,
    input.reasonCode,
    ...questionIds,
    ...evidenceIds
  ].join("|");
  return {
    id: `interrupt_${createHash("sha256").update(seed).digest("hex")}`,
    kind: input.kind,
    reasonCode: input.reasonCode,
    questionIds,
    evidenceIds,
    createdAt: (now ?? (() => new Date()))().toISOString()
  };
}

function withSnapshot(
  application: ApplicationExecutionState,
  snapshot: FormSnapshot
): ApplicationExecutionState {
  return {
    ...application,
    snapshotId: snapshot.id,
    fieldIds: uniqueIds(snapshot.fields.map((field) => field.id)).slice(0, MAX_TRACKED_IDS)
  };
}

function syncUserCoverage(
  store: FieldCoverageStore | undefined,
  taskId: string,
  snapshot: FormSnapshot
): void {
  if (store === undefined) return;
  store.retain(taskId, new Set(snapshot.fields.map((field) => field.id)));
  for (const field of snapshot.fields) {
    if (!hasUserValue(field.currentValue)) continue;
    store.markUserFilled(taskId, {
      fieldId: field.id,
      label: field.label,
      ...(field.semanticHint === undefined ? {} : { semantic: field.semanticHint })
    });
  }
}

function recordCoverage(
  store: FieldCoverageStore | undefined,
  taskId: string,
  resolutions: readonly ResolvedApplicationField[]
): void {
  if (store === undefined) return;
  for (const resolution of resolutions) {
    const assessment = resolution.assessment;
    if (assessment !== undefined) store.record(taskId, assessment);
  }
}

function markCommandsFilled(
  store: FieldCoverageStore | undefined,
  commands: readonly ExecutableCommand[],
  warnings: readonly string[]
): void {
  if (store === undefined) return;
  for (const command of commands) {
    if (command.type === "click_intermediate") continue;
    store.markFilled(command.taskId, command.fieldId, [...warnings]);
  }
}

function markCommandFailures(
  store: FieldCoverageStore | undefined,
  commands: readonly ExecutableCommand[],
  reason: string
): void {
  if (store === undefined) return;
  for (const command of commands) {
    if (command.type === "click_intermediate") continue;
    store.markFailed(command.taskId, command.fieldId, reason);
  }
}

function hasUserValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function resolvableCount(batch: FieldResolutionBatch): number {
  return batch.resolutions.filter((resolution) =>
    resolution.status === "verified" && !resolution.requiresContentReview && resolution.value !== undefined
  ).length;
}

function verifiedFieldIds(batch: FieldResolutionBatch): string[] {
  return batch.resolutions
    .filter((resolution) => resolution.status === "verified" && !resolution.requiresContentReview)
    .map((resolution) => resolution.field.id)
    .slice(0, MAX_TRACKED_IDS);
}

function resolutionCounts(batch: FieldResolutionBatch): ResolutionCounts {
  const counts: ResolutionCounts = {
    verified: 0,
    deferred: 0,
    needsQuestion: 0,
    blocked: 0
  };
  for (const resolution of batch.resolutions) {
    if (resolution.status === "verified") counts.verified += 1;
    if (resolution.status === "deferred") counts.deferred += 1;
    if (resolution.status === "needs_question") counts.needsQuestion += 1;
    if (resolution.status === "blocked") counts.blocked += 1;
  }
  return counts;
}

function fieldIds(resolutions: readonly ResolvedApplicationField[]): string[] {
  return uniqueIds(resolutions.map((resolution) => resolution.field.id)).slice(0, MAX_TRACKED_IDS);
}

function evidenceIdsFor(resolutions: readonly ResolvedApplicationField[]): string[] {
  return uniqueIds(resolutions.flatMap((resolution) =>
    (resolution.assessment?.evidence ?? []).map((evidence) =>
      `evidence_${createHash("sha256").update([
        evidence.documentId,
        evidence.page,
        evidence.extraction,
        evidence.text
      ].join("\u0000")).digest("hex")}`
    )
  )).slice(0, 100);
}

function appendIds(existing: readonly string[] | undefined, additions: readonly string[]): string[] {
  return uniqueIds([...(existing ?? []), ...additions]).slice(-MAX_TRACKED_IDS);
}

function hasTerminalAction(snapshot: FormSnapshot): boolean {
  return snapshot.actions.some((action) => action.class === "terminal_submit");
}

function isPermittedCommand(command: ExecutableCommand, snapshot: FormSnapshot): boolean {
  if (command.type === "fill" || command.type === "select" || command.type === "upload") {
    return snapshot.fields.some((field) => field.id === command.fieldId);
  }
  if (command.type === "click_intermediate") {
    const action = snapshot.actions.find((candidate) => candidate.id === command.actionId);
    return action?.class === "intermediate_navigation" || action?.class === "intermediate_save";
  }
  return false;
}

function pageReason(snapshot: FormSnapshot): string {
  if (snapshot.challenge !== undefined) return "challenge_detected";
  if (snapshot.stage === "login") return "login_page";
  if (snapshot.stage === "review" || snapshot.stage === "success") return "final_review_page";
  if (snapshot.stage === "application_form") return "application_form_page";
  return "unknown_page";
}

function boundedReason(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? fallback : normalized.slice(0, 80);
}

function failed(
  application: ApplicationExecutionState | undefined,
  code: string,
  currentNode: string
): SubgraphPortResult {
  return {
    status: "failed",
    currentNode,
    error: { code, retryable: false, node: currentNode },
    ...(application === undefined ? {} : { application })
  };
}

function sameSkillBinding(left: SkillBinding, right: SkillBinding): boolean {
  return left.skillId === right.skillId
    && left.version === right.version
    && left.site === right.site
    && left.pageFingerprintHash === right.pageFingerprintHash
    && left.allocationId === right.allocationId;
}

function record(
  dependencies: ApplicationExecutionSubgraphDependencies,
  state: AgentGraphState,
  node: string,
  kind: "node" | "tool_call" | "model_decision" | "interrupt" | "safety_block",
  outcome: string,
  reasonCode: string,
  extra: {
    candidateIds?: string[];
    evidenceIds?: string[];
    counts?: Record<string, number>;
    skill?: SkillTraceDimensions;
  } = {}
): void {
  dependencies.traceSink.record({
    runId: state.runId,
    taskId: state.taskId,
    node,
    kind,
    outcome,
    reasonCode,
    ...(extra.candidateIds === undefined ? {} : { candidateIds: uniqueIds(extra.candidateIds).slice(0, 100) }),
    ...(extra.evidenceIds === undefined ? {} : { evidenceIds: uniqueIds(extra.evidenceIds).slice(0, 100) }),
    ...(extra.counts === undefined ? {} : { counts: extra.counts }),
    ...(extra.skill === undefined ? {} : { skill: extra.skill })
  });
}

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values)];
}
