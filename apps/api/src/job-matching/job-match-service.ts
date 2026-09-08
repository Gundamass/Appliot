import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  ConflictJobSelectionInputSchema,
  JOB_RECOMMENDATION_LIMIT,
  JobMatchMutationGuardSchema,
  JobSelectionInputSchema,
  type ConflictJobSelectionInput,
  type FilterPlan,
  type JobExpectationSnapshot,
  type JobMatchMutationGuard,
  type JobMatchResult,
  type JobPageSnapshot,
  type JobSelectionInput
} from "@resume/contracts";
import type { JobAdapter } from "@resume/job-matching";
import type {
  ApplicationTaskRepository,
  StoredApplicationTask
} from "../applications/application-task-repository.js";
import { prepareApplicationTarget as prepareTarget, type PreparedApplicationTarget } from "../applications/application-target.js";
import type { BrowserOwnershipLease } from "../browser/browser-ownership-lease.js";
import type { JobMatchTraceSink } from "../observability/job-match-trace.js";
import type { JobMatchAggregate, JobMatchRepository, StoredJobMatchSession } from "./job-match-repository.js";

interface JobMatchBrowserPort {
  open(ownerId: string, url: string): Promise<unknown>;
  observeJob(ownerId: string): Promise<JobPageSnapshot>;
  invalidateExecution?(ownerId: string, executionEpoch: number): Promise<void>;
  releaseTask?(ownerId: string): Promise<void>;
}

interface ExtractionServicePort {
  confirmFilters(sessionId: string, expectation: JobExpectationSnapshot, guard: JobMatchMutationGuard): Promise<unknown>;
  runExtraction(sessionId: string): Promise<unknown>;
}

interface MatcherServicePort {
  match(sessionId: string): Promise<unknown>;
}

interface JobMatchServiceDependencies {
  repository: JobMatchRepository;
  applicationTasks: ApplicationTaskRepository;
  browser: JobMatchBrowserPort;
  browserOwnershipLease: BrowserOwnershipLease;
  adapters: readonly JobAdapter[];
  expectationSnapshot(): JobExpectationSnapshot;
  profileRevision(): number;
  extraction: ExtractionServicePort;
  matcher: MatcherServicePort;
  trace?: JobMatchTraceSink;
  createId?: (kind: "session" | "application") => string;
  prepareApplicationTask?: (input: { taskId: string; applicationUrl: string }) => void;
  prepareApplicationTarget?: (rawUrl: string, identity: string) => Promise<PreparedApplicationTarget>;
  submissionCount?: () => number;
}

export type PresentedJobMatchSession = JobMatchAggregate & { filterPlan?: FilterPlan };

export type JobMatchCreateResult = PresentedJobMatchSession | {
  redirect: "application";
  applicationUrl: string;
};

export function createJobMatchService(dependencies: JobMatchServiceDependencies) {
  const createId = dependencies.createId ?? (() => randomUUID());
  const prepareApplicationTarget = dependencies.prepareApplicationTarget ?? prepareTarget;
  const adapterBySource = new Map(dependencies.adapters.map((adapter) => [adapter.source, adapter]));

  const present = (aggregate: JobMatchAggregate): PresentedJobMatchSession => {
    const adapter = aggregate.source === undefined ? undefined : adapterBySource.get(aggregate.source);
    const presented = { ...aggregate, results: presentedResults(aggregate.results) };
    return adapter === undefined || adapter.version !== aggregate.adapterVersion
      ? presented
      : { ...presented, filterPlan: adapter.mapFilters(aggregate.expectation) };
  };

  const finalizeMatching = async (sessionId: string): Promise<JobMatchAggregate> => {
    const current = dependencies.repository.get(sessionId, { required: true });
    if (current.state !== "matching_jobs") return current;
    await dependencies.matcher.match(sessionId);
    const matched = dependencies.repository.get(sessionId, { required: true });
    dependencies.repository.mutate(sessionId, matched.version, (session) => ({
      ...session,
      state: "awaiting_job_selection",
      profileRevision: dependencies.profileRevision()
    }));
    const completed = dependencies.repository.get(sessionId, { required: true });
    releaseOwner(dependencies, sessionId);
    await dependencies.browser.releaseTask?.(sessionId).catch(() => undefined);
    return completed;
  };

  const extractAndMatch = async (sessionId: string): Promise<JobMatchAggregate> => {
    await dependencies.extraction.runExtraction(sessionId);
    return finalizeMatching(sessionId);
  };

  const get = (sessionId: string): PresentedJobMatchSession => {
    let aggregate = dependencies.repository.get(sessionId, { required: true });
    const postingHashes = new Map(aggregate.postings.map((posting) => [posting.id, posting.contentHash]));
    const dependenciesChanged = aggregate.profileRevision !== dependencies.profileRevision()
      || aggregate.expectation.revision !== aggregate.expectationRevision
      || aggregate.results.some((result) =>
        result.scoringVersion !== aggregate.scoringVersion
        || postingHashes.get(result.postingId) !== result.postingContentHash
      );
    if (dependenciesChanged && aggregate.results.some((result) => !result.stale)) {
      dependencies.repository.markResultsStale(sessionId);
      aggregate = dependencies.repository.get(sessionId, { required: true });
    }
    return present(aggregate);
  };

  const service = {
    async create(input: { url: string }): Promise<JobMatchCreateResult> {
      const url = normalizeEntryUrl(requireWebUrl(input.url), dependencies.adapters);
      const expectation = dependencies.expectationSnapshot();
      if (expectation.criteria.length === 0) throw new Error("job_expectation_required");
      const sessionId = createId("session");
      const owner = dependencies.browserOwnershipLease.acquire({ ownerKind: "job_match", ownerId: sessionId });
      try {
        await dependencies.browser.open(sessionId, url);
        const identified = await observeAndIdentifyEntry(dependencies.browser, sessionId, dependencies.adapters);
        if (identified.entryKind === "application_form") {
          dependencies.browserOwnershipLease.release(owner);
          await dependencies.browser.releaseTask?.(sessionId);
          recordTrace(dependencies.trace, { sessionId, source: identified.adapter.source, stage: "application_redirect" });
          return { redirect: "application", applicationUrl: url };
        }
        const state = identified.entryKind === "job_list"
          ? "awaiting_filter_confirmation" as const
          : "opening_job_page" as const;
        const created = dependencies.repository.create({
          id: sessionId,
          initialUrl: url,
          state,
          entryKind: identified.entryKind,
          source: identified.adapter.source,
          adapterVersion: identified.adapter.version,
          executionEpoch: owner.executionEpoch,
          profileRevision: dependencies.profileRevision(),
          expectation
        });
        recordTrace(dependencies.trace, {
          sessionId,
          source: identified.adapter.source,
          adapterVersion: identified.adapter.version,
          scoringVersion: "job-match-v1",
          stage: state
        });
        return present(created);
      } catch (error) {
        releaseOwner(dependencies, sessionId);
        await dependencies.browser.releaseTask?.(sessionId).catch(() => undefined);
        recordTrace(dependencies.trace, { sessionId, stage: "create_failed", errorCode: errorCode(error) });
        throw error;
      }
    },

    get,

    async confirmFilters(
      sessionId: string,
      expectation: JobExpectationSnapshot,
      rawGuard: JobMatchMutationGuard
    ): Promise<JobMatchAggregate> {
      const guard = JobMatchMutationGuardSchema.parse(rawGuard);
      const current = requireMutation(dependencies.repository, sessionId, guard, "awaiting_filter_confirmation");
      await dependencies.extraction.confirmFilters(sessionId, expectation, guard);
      dependencies.repository.confirmExpectation(sessionId, current.version, expectation);
      return present(await extractAndMatch(sessionId));
    },

    async pause(sessionId: string, rawGuard: JobMatchMutationGuard): Promise<JobMatchAggregate> {
      const guard = JobMatchMutationGuardSchema.parse(rawGuard);
      const current = requireMutation(dependencies.repository, sessionId, guard, "extracting_jobs");
      const nextEpoch = current.executionEpoch + 1;
      await dependencies.browser.invalidateExecution?.(sessionId, nextEpoch);
      dependencies.repository.mutate(sessionId, current.version, (session) => ({
        ...session,
        state: "paused",
        executionEpoch: nextEpoch,
        stopReason: "paused_by_user"
      }));
      releaseOwner(dependencies, sessionId);
      return dependencies.repository.get(sessionId, { required: true });
    },

    async resume(sessionId: string, rawGuard: JobMatchMutationGuard): Promise<JobMatchAggregate> {
      const guard = JobMatchMutationGuardSchema.parse(rawGuard);
      const current = requireMutation(
        dependencies.repository,
        sessionId,
        guard,
        ["awaiting_login", "awaiting_challenge", "paused"]
      );
      const owner = dependencies.browserOwnershipLease.acquire({ ownerKind: "job_match", ownerId: sessionId });
      try {
        const observed = await dependencies.browser.observeJob(sessionId);
        const identified = identifyEntry(observed, dependencies.adapters);
        if (identified.entryKind === "application_form") throw new Error("unsupported_job_entry");
        dependencies.repository.mutate(sessionId, current.version, (session) => {
          const { stopReason: _stopReason, errorCode: _errorCode, ...rest } = session;
          return {
            ...rest,
            state: "opening_job_page",
            entryKind: identified.entryKind,
            source: identified.adapter.source,
            adapterVersion: identified.adapter.version,
            executionEpoch: owner.executionEpoch
          };
        });
        return dependencies.repository.get(sessionId, { required: true });
      } catch (error) {
        releaseOwner(dependencies, sessionId);
        throw error;
      }
    },

    async continueExtraction(sessionId: string, guard: JobMatchMutationGuard): Promise<JobMatchAggregate> {
      await service.resume(sessionId, guard);
      const opened = dependencies.repository.get(sessionId, { required: true });
      dependencies.repository.mutate(sessionId, opened.version, (session) => ({ ...session, state: "extracting_jobs" }));
      return present(await extractAndMatch(sessionId));
    },

    async rematch(sessionId: string, rawGuard: JobMatchMutationGuard): Promise<JobMatchAggregate> {
      const guard = JobMatchMutationGuardSchema.parse(rawGuard);
      const current = requireMutation(dependencies.repository, sessionId, guard, ["awaiting_job_selection", "matching_jobs"]);
      dependencies.repository.markResultsStale(sessionId);
      await dependencies.matcher.match(sessionId);
      dependencies.repository.mutate(sessionId, current.version, (session) => ({
        ...session,
        state: "awaiting_job_selection",
        profileRevision: dependencies.profileRevision()
      }));
      return present(dependencies.repository.get(sessionId, { required: true }));
    },

    select(sessionId: string, rawInput: JobSelectionInput): StoredJobMatchSession {
      const input = JobSelectionInputSchema.parse(rawInput);
      const aggregate = selectionAggregate(dependencies.repository, sessionId, input);
      if (hasConflict(aggregate.result)) throw new Error("job_match_conflict_confirmation_required");
      return persistSelection(dependencies.repository, aggregate.session, aggregate.result, input, undefined);
    },

    selectConflict(sessionId: string, rawInput: ConflictJobSelectionInput): StoredJobMatchSession {
      const input = ConflictJobSelectionInputSchema.parse(rawInput);
      const aggregate = selectionAggregate(dependencies.repository, sessionId, input);
      if (!hasConflict(aggregate.result)) throw new Error("job_match_conflict_confirmation_not_required");
      const currentHash = conflictSummaryHash(aggregate.result);
      if (input.conflictSummaryHash !== currentHash) throw new Error("job_match_conflict_confirmation_stale");
      return persistSelection(dependencies.repository, aggregate.session, aggregate.result, input, currentHash);
    },

    async convert(
      sessionId: string,
      rawInput: JobSelectionInput | ConflictJobSelectionInput
    ): Promise<StoredApplicationTask> {
      const base = JobSelectionInputSchema.parse(rawInput);
      let aggregate = dependencies.repository.get(sessionId, { required: true });
      const selectedResult = aggregate.results.find((result) => result.id === aggregate.selectedResultId);
      if (selectedResult === undefined) throw new Error("job_match_selected_result_missing");
      validateResultGuard(selectedResult, base);
      if (aggregate.conflictSummaryHash !== undefined) {
        const conflict = ConflictJobSelectionInputSchema.safeParse(rawInput);
        if (!conflict.success || conflict.data.conflictSummaryHash !== aggregate.conflictSummaryHash) {
          throw new Error("job_match_conflict_confirmation_stale");
        }
      }
      if (aggregate.conversionIdempotencyKey === base.idempotencyKey && aggregate.applicationTaskId !== undefined) {
        const replay = dependencies.applicationTasks.get(aggregate.applicationTaskId);
        if (replay === undefined) throw new Error("application_task_not_found");
        return replay;
      }
      if (aggregate.version !== base.sessionVersion) throw new Error("job_match_version_conflict");
      if (aggregate.state !== "selected") throw new Error("job_match_conversion_not_allowed");
      const selectedPosting = aggregate.postings.find((posting) => posting.id === selectedResult.postingId);
      if (selectedPosting === undefined || selectedPosting.contentHash !== base.postingContentHash) {
        throw new Error("job_match_posting_changed");
      }
      if ((dependencies.submissionCount?.() ?? 0) !== 0) throw new Error("job_match_submission_invariant_violated");
      const prepared = await prepareApplicationTarget(
        selectedPosting.canonicalUrl,
        `job-match:${sessionId}:${base.idempotencyKey}`
      );
      const existing = dependencies.applicationTasks.get(prepared.id);
      const application = dependencies.applicationTasks.createFromJob({
        id: prepared.id,
        name: selectedPosting.title,
        applicationUrl: prepared.applicationUrl
      });
      if (existing === undefined) {
        dependencies.prepareApplicationTask?.({ taskId: application.id, applicationUrl: application.applicationUrl });
      }
      dependencies.repository.mutate(sessionId, aggregate.version, (session) => ({
        ...session,
        state: "converted_to_application",
        applicationTaskId: application.id,
        conversionIdempotencyKey: base.idempotencyKey
      }));
      releaseOwner(dependencies, sessionId);
      if ((dependencies.submissionCount?.() ?? 0) !== 0) throw new Error("job_match_submission_invariant_violated");
      aggregate = dependencies.repository.get(sessionId, { required: true });
      recordTrace(dependencies.trace, {
        sessionId,
        ...(aggregate.source === undefined ? {} : { source: aggregate.source }),
        ...(aggregate.adapterVersion === undefined ? {} : { adapterVersion: aggregate.adapterVersion }),
        scoringVersion: aggregate.scoringVersion,
        stage: "converted_to_application",
        contentHash: selectedPosting.contentHash
      });
      return application;
    },

    async cancel(sessionId: string, rawGuard: JobMatchMutationGuard): Promise<JobMatchAggregate> {
      const guard = JobMatchMutationGuardSchema.parse(rawGuard);
      const current = requireMutation(dependencies.repository, sessionId, guard);
      const nextEpoch = current.executionEpoch + 1;
      await dependencies.browser.invalidateExecution?.(sessionId, nextEpoch);
      dependencies.repository.mutate(sessionId, current.version, (session) => ({
        ...session,
        state: "cancelled",
        executionEpoch: nextEpoch,
        stopReason: "cancelled_by_user"
      }));
      releaseOwner(dependencies, sessionId);
      await dependencies.browser.releaseTask?.(sessionId);
      return dependencies.repository.get(sessionId, { required: true });
    }
  };

  return service;
}

export function conflictSummaryHash(result: JobMatchResult): string {
  const conflicts = result.outcomes
    .filter((outcome) => outcome.outcome === "conflict")
    .map(({ requirementId, outcome, reasonCode }) => ({ requirementId, outcome, reasonCode }))
    .sort((left, right) => compareText(left.requirementId, right.requirementId));
  return `sha256:${hash(JSON.stringify({
    resultId: result.id,
    resultVersion: result.version,
    postingContentHash: result.postingContentHash,
    conflicts
  }))}`;
}

function identifyEntry(snapshot: JobPageSnapshot, adapters: readonly JobAdapter[]): {
  adapter: JobAdapter;
  entryKind: "job_list" | "job_detail" | "application_form";
} {
  for (const adapter of adapters) {
    const entryKind = adapter.identify(snapshot);
    if (entryKind !== "unsupported") return { adapter, entryKind };
  }
  throw new Error("unsupported_job_entry");
}

const JOB_ENTRY_OBSERVATION_RETRY_COUNT = 20;
const JOB_ENTRY_OBSERVATION_RETRY_DELAY_MS = 250;

async function observeAndIdentifyEntry(
  browser: Pick<JobMatchBrowserPort, "observeJob">,
  ownerId: string,
  adapters: readonly JobAdapter[]
): Promise<ReturnType<typeof identifyEntry>> {
  for (let attempt = 0; attempt < JOB_ENTRY_OBSERVATION_RETRY_COUNT; attempt += 1) {
    const snapshot = await browser.observeJob(ownerId);
    try {
      return identifyEntry(snapshot, adapters);
    } catch (error) {
      if (!isPendingSpaSnapshot(snapshot) || attempt === JOB_ENTRY_OBSERVATION_RETRY_COUNT - 1) throw error;
      await delay(JOB_ENTRY_OBSERVATION_RETRY_DELAY_MS);
    }
  }
  throw new Error("unsupported_job_entry");
}

function isPendingSpaSnapshot(snapshot: JobPageSnapshot): boolean {
  return snapshot.entryHint === "unknown"
    && snapshot.jobCards.length === 0
    && snapshot.challenge === undefined
    && !snapshot.boundaries.some((boundary) => boundary.visible && boundary.interactive);
}

function selectionAggregate(
  repository: JobMatchRepository,
  sessionId: string,
  input: JobSelectionInput
): { session: JobMatchAggregate; result: JobMatchResult } {
  const session = repository.get(sessionId, { required: true });
  if (session.selectionIdempotencyKey === input.idempotencyKey && session.selectedResultId === input.resultId) {
    const replay = session.results.find((result) => result.id === input.resultId);
    if (replay === undefined) throw new Error("job_match_result_not_found");
    return { session, result: replay };
  }
  if (session.version !== input.sessionVersion) throw new Error("job_match_version_conflict");
  if (session.state !== "awaiting_job_selection") throw new Error("job_match_selection_not_allowed");
  const result = session.results.find((candidate) => candidate.id === input.resultId);
  if (result === undefined) throw new Error("job_match_result_not_found");
  validateResultGuard(result, input);
  if (result.stale) throw new Error("job_match_result_stale");
  return { session, result };
}

function validateResultGuard(result: JobMatchResult, input: JobSelectionInput): void {
  if (result.version !== input.resultVersion) throw new Error("job_match_result_version_conflict");
  if (result.postingContentHash !== input.postingContentHash) throw new Error("job_match_posting_changed");
}

function persistSelection(
  repository: JobMatchRepository,
  session: JobMatchAggregate,
  result: JobMatchResult,
  input: JobSelectionInput,
  conflictHash: string | undefined
): StoredJobMatchSession {
  if (session.selectionIdempotencyKey === input.idempotencyKey && session.selectedResultId === input.resultId) return session;
  return repository.mutate(session.id, session.version, (current) => {
    const { conflictSummaryHash: _conflictSummaryHash, ...rest } = current;
    return {
      ...rest,
      state: "selected",
      selectedResultId: result.id,
      selectedPostingContentHash: result.postingContentHash,
      selectionIdempotencyKey: input.idempotencyKey,
      ...(conflictHash === undefined ? {} : { conflictSummaryHash: conflictHash })
    };
  });
}

function requireMutation(
  repository: JobMatchRepository,
  sessionId: string,
  guard: JobMatchMutationGuard,
  allowedStates?: StoredJobMatchSession["state"] | StoredJobMatchSession["state"][]
): JobMatchAggregate {
  const current = repository.get(sessionId, { required: true });
  if (current.version !== guard.sessionVersion) throw new Error("job_match_version_conflict");
  if (allowedStates !== undefined) {
    const allowed = Array.isArray(allowedStates) ? allowedStates : [allowedStates];
    if (!allowed.includes(current.state)) throw new Error("job_match_mutation_not_allowed");
  }
  return current;
}

function hasConflict(result: JobMatchResult): boolean {
  return result.outcomes.some((outcome) => outcome.outcome === "conflict");
}

function presentedResults(results: readonly JobMatchResult[]): JobMatchResult[] {
  const recommendations = results.filter((result) => !hasConflict(result)).sort(compareResults);
  const conflicts = results.filter(hasConflict).sort(compareResults);
  return [...recommendations, ...conflicts].slice(0, JOB_RECOMMENDATION_LIMIT);
}

function compareResults(left: JobMatchResult, right: JobMatchResult): number {
  return right.rankingScore - left.rankingScore
    || right.fitScore - left.fitScore
    || right.confidence - left.confidence
    || compareText(left.id, right.id);
}

function releaseOwner(dependencies: JobMatchServiceDependencies, sessionId: string): void {
  const owner = dependencies.browserOwnershipLease.current();
  if (owner?.ownerKind === "job_match" && owner.ownerId === sessionId) {
    dependencies.browserOwnershipLease.release(owner);
  }
}

function requireWebUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid_job_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid_job_url");
  return url.href;
}

function normalizeEntryUrl(value: string, adapters: readonly JobAdapter[]): string {
  const parsed = new URL(value);
  for (const adapter of adapters) {
    const normalized = adapter.normalizeEntryUrl?.(parsed);
    if (normalized !== undefined) return requireWebUrl(normalized.href);
  }
  return value;
}

function recordTrace(trace: JobMatchTraceSink | undefined, input: Parameters<JobMatchTraceSink["record"]>[0]): void {
  try { trace?.record(input); } catch { /* Diagnostics must not alter workflow behavior. */ }
}

function errorCode(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "job_match_unknown_error";
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
