import { createHash } from "node:crypto";
import type {
  AgentGraphState,
  ApplicationExecutionState,
  ExecutableCommand,
  FormSnapshot,
  HumanInterrupt
} from "@resume/contracts";
import {
  applicationCommandId,
  type ApplicationTools,
  type FieldResolutionBatch,
  type ReadbackResult,
  type ResolvedApplicationField
} from "../application-tools.js";
import type { SubgraphPort, SubgraphPortInput, SubgraphPortResult } from "../main-graph.js";
import type { TraceSink } from "../trace-sink.js";

const MAX_TRACKED_IDS = 100;

export interface ApplicationExecutionSubgraphDependencies {
  tools: ApplicationTools;
  traceSink: TraceSink;
  now?: () => Date;
  onInterrupt?: (interrupt: HumanInterrupt) => void;
}

type ResolutionInterrupt = {
  kind: HumanInterrupt["kind"];
  reasonCode: string;
  questionIds: string[];
  evidenceIds: string[];
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

  if (resume.action === "cancel" || resume.action === "reject") {
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
  record(dependencies, state, "normalize_fields", "node", "completed", "fields_normalized", {
    counts: { fields: snapshot.fields.length }
  });

  return resolveAndExecute(dependencies, state, application, snapshot);
}

async function resolveAndExecute(
  dependencies: ApplicationExecutionSubgraphDependencies,
  state: AgentGraphState,
  application: ApplicationExecutionState,
  snapshot: FormSnapshot
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

  const deterministicInterrupt = findResolutionInterrupt(deterministic.resolutions, "deterministic");
  if (deterministicInterrupt !== undefined) {
    return interruptResult(
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
    const semanticInterrupt = findResolutionInterrupt(resolutions.resolutions, "semantic");
    if (semanticInterrupt !== undefined) {
      return interruptResult(
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
      executionEpoch: nextEpoch
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
    return runCommands(dependencies, state, application, snapshot, [navigation], "phase_boundary");
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
    return invalidateAndFail(dependencies, state, application, "application_execution_not_applied", "execute_plan");
  }

  const readback = await verifyReadback(dependencies, state, application, authorized);
  if (readback.status === "stopped") return readback.result;
  application = readback.application;

  let audit;
  try {
    audit = await dependencies.tools.fullPageAudit({
      taskId: state.taskId,
      snapshot: readback.snapshot,
      expected: authorized,
      reason: auditReason
    });
  } catch {
    return invalidateAndFail(dependencies, state, application, "application_full_page_audit_failed", "full_page_audit");
  }
  application = withSnapshot(application, audit.snapshot);
  record(dependencies, state, "full_page_audit", "tool_call", audit.mismatches.length === 0 ? "completed" : "blocked", audit.mismatches.length === 0 ? "page_audit_passed" : "page_audit_mismatch", {
    counts: { mismatches: audit.mismatches.length }
  });
  if (audit.mismatches.length > 0) {
    return invalidateAndFail(dependencies, state, application, "FULL_PAGE_AUDIT_MISMATCH", "full_page_audit");
  }
  return routeNext(dependencies, state, application, audit.snapshot);
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
      evidenceIds: evidenceIdsFor([content])
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

function interruptResult(
  dependencies: ApplicationExecutionSubgraphDependencies,
  state: AgentGraphState,
  application: ApplicationExecutionState,
  currentNode: string,
  input: ResolutionInterrupt
): SubgraphPortResult {
  const pendingInterrupt = createInterrupt(state, application, input, dependencies.now);
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
    ...(extra.counts === undefined ? {} : { counts: extra.counts })
  });
}

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values)];
}
