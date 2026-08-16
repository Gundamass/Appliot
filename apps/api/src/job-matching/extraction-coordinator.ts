import { createHash } from "node:crypto";
import {
  JobMatchMutationGuardSchema,
  JobPostingSchema,
  type ExtractedJobPage,
  type FilterPlan,
  type JobExpectationSnapshot,
  type JobMatchMutationGuard,
  type JobPageSnapshot,
  type JobPosting,
  type JobPostingDraft
} from "@resume/contracts";
import type { JobAdapter } from "@resume/job-matching";
import type { JobMatchRepository, StoredJobMatchSession } from "./job-match-repository.js";

export const DEFAULT_EXTRACTION_BUDGET = {
  maxPages: 100,
  maxDurationMs: 900_000,
  maxNewJobs: 2_000,
  maxConsecutiveNoNewPages: 2,
  readAttempts: 2
} as const;

export interface ExtractionBudget {
  maxPages: number;
  maxDurationMs: number;
  maxNewJobs: number;
  maxConsecutiveNoNewPages: number;
  readAttempts: number;
}

interface JobBrowserPort {
  observeJob(ownerId: string): Promise<JobPageSnapshot>;
  applyJobFilters(ownerId: string, plan: FilterPlan, executionEpoch: number): Promise<JobPageSnapshot>;
  advanceJobPage(ownerId: string, cursor: string | undefined, executionEpoch: number): Promise<JobPageSnapshot>;
}

export interface ExtractionCoordinatorDependencies {
  repository: JobMatchRepository;
  browser: JobBrowserPort;
  adapters: readonly JobAdapter[];
  now?: () => number;
  nowIso?: () => string;
}

export interface ExtractionRunResult {
  state: "completed" | "paused";
  stopReason: "complete" | "no_new_jobs" | "page_limit" | "duration_limit" | "job_limit";
  pagesRead: number;
  newJobs: number;
}

export function createExtractionCoordinator(dependencies: ExtractionCoordinatorDependencies) {
  const now = dependencies.now ?? Date.now;
  const nowIso = dependencies.nowIso ?? (() => new Date().toISOString());
  const adapters = new Map(dependencies.adapters.map((adapter) => [adapter.source, adapter]));

  const adapterFor = (session: StoredJobMatchSession): JobAdapter => {
    const adapter = session.source === undefined ? undefined : adapters.get(session.source);
    if (adapter === undefined || adapter.version !== session.adapterVersion) {
      throw new Error("job_adapter_contract_mismatch");
    }
    return adapter;
  };

  return {
    async confirmFilters(
      sessionId: string,
      expectation: JobExpectationSnapshot,
      rawGuard: JobMatchMutationGuard
    ): Promise<{ expectation: JobExpectationSnapshot; plan: FilterPlan; snapshot: JobPageSnapshot }> {
      const guard = JobMatchMutationGuardSchema.parse(rawGuard);
      const session = dependencies.repository.get(sessionId, { required: true });
      if (session.version !== guard.sessionVersion) throw new Error("job_match_version_conflict");
      if (session.state !== "awaiting_filter_confirmation") throw new Error("job_filter_confirmation_not_allowed");
      const plan = adapterFor(session).mapFilters(expectation);
      const snapshot = await dependencies.browser.applyJobFilters(sessionId, plan, session.executionEpoch);
      if (!filterReadbackMatches(plan, snapshot)) throw new Error("job_filter_readback_mismatch");
      return { expectation, plan, snapshot };
    },

    async runExtraction(
      sessionId: string,
      overrides: Partial<ExtractionBudget> = {}
    ): Promise<ExtractionRunResult> {
      const budget = extractionBudget(overrides);
      const session = dependencies.repository.get(sessionId, { required: true });
      if (session.state !== "extracting_jobs") throw new Error("job_extraction_not_allowed");
      const adapter = adapterFor(session);
      const startedAt = now();
      let pagesRead = 0;
      let newJobs = 0;
      let consecutiveNoNewPages = 0;
      let cursor = session.cursor?.continuationToken;
      let usePersistedCursor = session.cursor !== undefined;
      const known = new Set(session.postings.map(postingIdentity));

      while (true) {
        const read = await readWithRetry(async () => {
          const snapshot = usePersistedCursor
            ? await dependencies.browser.advanceJobPage(sessionId, cursor, session.executionEpoch)
            : await dependencies.browser.observeJob(sessionId);
          return { snapshot, extracted: adapter.extractList(snapshot) };
        }, budget.readAttempts);
        usePersistedCursor = true;
        pagesRead += 1;

        const timestamp = nowIso();
        const candidates = read.extracted.postings.map((draft) => postingFromDraft(sessionId, draft, timestamp));
        const uniquePostings: JobPosting[] = [];
        for (const posting of candidates) {
          const identity = postingIdentity(posting);
          if (known.has(identity)) continue;
          known.add(identity);
          uniquePostings.push(posting);
        }
        newJobs += uniquePostings.length;
        consecutiveNoNewPages = uniquePostings.length === 0 ? consecutiveNoNewPages + 1 : 0;

        const elapsedMs = Math.max(0, now() - startedAt);
        const stopReason = extractionStopReason({
          extracted: read.extracted,
          pagesRead,
          elapsedMs,
          newJobs,
          consecutiveNoNewPages,
          budget
        });
        cursor = read.extracted.nextCursor;
        const cursorValue = stopReason === "complete"
          ? "complete"
          : cursor ?? read.snapshot.id;
        dependencies.repository.saveExtractionPage({
          sessionId,
          idempotencyKey: `extraction:${sessionId}:${read.snapshot.id}:${cursorValue}`,
          postings: uniquePostings,
          cursor: {
            value: cursorValue,
            pagesRead,
            elapsedMs,
            newJobs,
            consecutiveNoNewPages,
            ...(cursor === undefined ? {} : { continuationToken: cursor }),
            ...(stopReason === undefined ? {} : { stopReason })
          },
          event: {
            type: stopReason === undefined ? "extraction_page_saved" : "extraction_stopped",
            payload: { pagesRead, newJobs: uniquePostings.length, stopReason: stopReason ?? "continue" }
          },
          createdAt: timestamp
        });

        if (stopReason !== undefined) {
          const paused = stopReason === "page_limit" || stopReason === "duration_limit" || stopReason === "job_limit";
          dependencies.repository.mutate(sessionId, session.version, (current) => ({
            ...current,
            state: paused ? "paused" : "matching_jobs",
            stopReason
          }));
          return {
            state: paused ? "paused" : "completed",
            stopReason,
            pagesRead,
            newJobs
          };
        }
      }
    }
  };
}

function filterReadbackMatches(plan: FilterPlan, snapshot: JobPageSnapshot): boolean {
  return plan.mapped.every((mapped) => {
    const readback = snapshot.filterState.find((filter) => filter.key === mapped.key);
    return readback !== undefined
      && readback.values.length === mapped.values.length
      && mapped.values.every((value, index) => value === readback.values[index]);
  });
}

async function readWithRetry<T>(operation: () => Promise<T>, attempts: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function extractionBudget(overrides: Partial<ExtractionBudget>): ExtractionBudget {
  const budget = { ...DEFAULT_EXTRACTION_BUDGET, ...overrides };
  if (Object.values(budget).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("job_extraction_budget_invalid");
  }
  return budget;
}

function extractionStopReason(input: {
  extracted: ExtractedJobPage;
  pagesRead: number;
  elapsedMs: number;
  newJobs: number;
  consecutiveNoNewPages: number;
  budget: ExtractionBudget;
}): ExtractionRunResult["stopReason"] | undefined {
  if (!input.extracted.hasNext) return "complete";
  if (input.consecutiveNoNewPages >= input.budget.maxConsecutiveNoNewPages) return "no_new_jobs";
  if (input.pagesRead >= input.budget.maxPages) return "page_limit";
  if (input.elapsedMs >= input.budget.maxDurationMs) return "duration_limit";
  if (input.newJobs >= input.budget.maxNewJobs) return "job_limit";
  return undefined;
}

function postingFromDraft(sessionId: string, draft: JobPostingDraft, extractedAt: string): JobPosting {
  const contentHash = `sha256:${hash(JSON.stringify({
    source: draft.source,
    sourceJobId: draft.sourceJobId ?? null,
    canonicalUrl: draft.canonicalUrl,
    title: draft.title,
    organization: draft.organization,
    location: draft.location ?? null,
    employmentType: draft.employmentType ?? null,
    description: draft.description,
    requirements: draft.requirements,
    adapterVersion: draft.adapterVersion
  }))}`;
  const sourceIdentity = draft.sourceJobId ?? draft.canonicalUrl;
  return JobPostingSchema.parse({
    ...draft,
    id: `posting-${hash(`${sessionId}:${draft.source}:${sourceIdentity}:${contentHash}`)}`,
    contentHash,
    extractedAt
  });
}

function postingIdentity(posting: JobPosting): string {
  return `${posting.source}:${posting.sourceJobId ?? posting.canonicalUrl}:${posting.contentHash}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
