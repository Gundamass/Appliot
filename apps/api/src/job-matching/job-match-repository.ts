import {
  JobExpectationSnapshotSchema,
  JobMatchResultSchema,
  JobMatchSessionStateSchema,
  JobPostingSchema,
  type JobEntryKind,
  type JobExpectationSnapshot,
  type JobMatchResult,
  type JobMatchSessionState,
  type JobPosting,
  type JobSource
} from "@resume/contracts";
import type { SqliteDatabase } from "../db/client.js";

export interface StoredJobMatchSession {
  id: string;
  version: number;
  state: JobMatchSessionState;
  initialUrl: string;
  scoringVersion: "job-match-v1";
  profileRevision: number;
  expectationRevision: number;
  executionEpoch: number;
  createdAt: string;
  updatedAt: string;
  entryKind?: JobEntryKind;
  source?: JobSource;
  adapterVersion?: string;
  selectedResultId?: string;
  selectedPostingContentHash?: string;
  conflictSummaryHash?: string;
  selectionIdempotencyKey?: string;
  applicationTaskId?: string;
  conversionIdempotencyKey?: string;
  stopReason?: string;
  errorCode?: string;
}

export interface StoredExtractionCursor {
  value: string;
  pagesRead: number;
  elapsedMs: number;
  newJobs: number;
  consecutiveNoNewPages: number;
  continuationToken?: string;
  stopReason?: string;
  updatedAt: string;
}

export interface StoredJobMatchEvent {
  id: number;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
  idempotencyKey?: string;
}

export interface JobMatchAggregate extends StoredJobMatchSession {
  expectation: JobExpectationSnapshot;
  postings: JobPosting[];
  results: JobMatchResult[];
  events: StoredJobMatchEvent[];
  cursor?: StoredExtractionCursor;
}

export interface CreateJobMatchSessionInput {
  id: string;
  initialUrl: string;
  state: JobMatchSessionState;
  entryKind?: JobEntryKind;
  source?: JobSource;
  adapterVersion?: string;
  executionEpoch?: number;
  profileRevision: number;
  expectation: JobExpectationSnapshot;
  createdAt?: string;
}

export interface SaveExtractionPageInput {
  sessionId: string;
  idempotencyKey: string;
  postings: JobPosting[];
  cursor: Omit<StoredExtractionCursor, "updatedAt" | "continuationToken" | "stopReason"> & {
    continuationToken?: string;
    stopReason?: string;
  };
  event: { type: string; payload: Record<string, unknown> };
  createdAt?: string;
}

export interface JobMatchRepository {
  create(input: CreateJobMatchSessionInput): JobMatchAggregate;
  get(sessionId: string): JobMatchAggregate | undefined;
  get(sessionId: string, options: { required: true }): JobMatchAggregate;
  mutate(
    sessionId: string,
    expectedVersion: number,
    mutation: (session: StoredJobMatchSession) => StoredJobMatchSession
  ): StoredJobMatchSession;
  confirmExpectation(
    sessionId: string,
    expectedVersion: number,
    expectation: JobExpectationSnapshot
  ): StoredJobMatchSession;
  saveExtractionPage(input: SaveExtractionPageInput): { replayed: boolean; newJobs: number };
  saveResults(sessionId: string, results: JobMatchResult[], createdAt?: string): void;
  markResultsStale(sessionId: string): number;
}

interface SessionRow {
  id: string;
  version: number;
  state: string;
  entry_kind: JobEntryKind | null;
  source: JobSource | null;
  initial_url: string;
  adapter_version: string | null;
  scoring_version: "job-match-v1";
  profile_revision: number;
  expectation_revision: number;
  execution_epoch: number;
  selected_result_id: string | null;
  selected_posting_content_hash: string | null;
  conflict_summary_hash: string | null;
  selection_idempotency_key: string | null;
  application_task_id: string | null;
  conversion_idempotency_key: string | null;
  stop_reason: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface JsonRow { payload_json: string }
interface PostingRow extends JsonRow { id: string }
interface ResultRow extends JsonRow { id: string; stale: number }
interface CursorRow {
  cursor_json: string;
  pages_read: number;
  elapsed_ms: number;
  new_jobs: number;
  consecutive_no_new_pages: number;
  continuation_token: string | null;
  stop_reason: string | null;
  updated_at: string;
}
interface EventRow {
  id: number;
  sequence: number;
  type: string;
  idempotency_key: string | null;
  payload_json: string;
  created_at: string;
}

export function createJobMatchRepository(database: SqliteDatabase): JobMatchRepository {
  const insertSession = database.prepare(`
    INSERT INTO job_match_sessions (
      id, version, state, entry_kind, source, initial_url, adapter_version, scoring_version, profile_revision,
      expectation_revision, execution_epoch, created_at, updated_at
    ) VALUES (?, 0, ?, ?, ?, ?, ?, 'job-match-v1', ?, ?, ?, ?, ?)
  `);
  const insertExpectation = database.prepare(`
    INSERT INTO job_match_expectation_snapshots (
      session_id, revision, payload_json, confirmed_at, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const findSession = database.prepare("SELECT * FROM job_match_sessions WHERE id = ?");
  const findExpectation = database.prepare(`
    SELECT payload_json FROM job_match_expectation_snapshots
    WHERE session_id = ? AND revision = ?
  `);
  const findPostings = database.prepare(`
    SELECT id, payload_json FROM job_postings WHERE session_id = ? ORDER BY extracted_at ASC, id ASC
  `);
  const findResults = database.prepare(`
    SELECT id, stale, payload_json FROM job_match_results WHERE session_id = ? ORDER BY created_at ASC, id ASC
  `);
  const findCursor = database.prepare("SELECT * FROM job_extraction_cursors WHERE session_id = ?");
  const findEvents = database.prepare(`
    SELECT id, sequence, type, idempotency_key, payload_json, created_at
    FROM job_match_events WHERE session_id = ? ORDER BY sequence ASC
  `);
  const findIdempotentEvent = database.prepare(`
    SELECT id FROM job_match_events WHERE session_id = ? AND idempotency_key = ?
  `);
  const nextEventSequence = database.prepare(`
    SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM job_match_events WHERE session_id = ?
  `);
  const updateSession = database.prepare(`
    UPDATE job_match_sessions SET
      version = ?, state = ?, entry_kind = ?, source = ?, initial_url = ?, adapter_version = ?,
      scoring_version = ?, profile_revision = ?, expectation_revision = ?, execution_epoch = ?,
      selected_result_id = ?, selected_posting_content_hash = ?, conflict_summary_hash = ?,
      selection_idempotency_key = ?, application_task_id = ?, conversion_idempotency_key = ?,
      stop_reason = ?, error_code = ?, updated_at = ?
    WHERE id = ? AND version = ?
  `);
  const insertPosting = database.prepare(`
    INSERT OR IGNORE INTO job_postings (
      id, session_id, source, source_job_id, canonical_url, content_hash, payload_json, extracted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const saveCursor = database.prepare(`
    INSERT INTO job_extraction_cursors (
      session_id, cursor_json, pages_read, elapsed_ms, new_jobs,
      consecutive_no_new_pages, continuation_token, stop_reason, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      cursor_json = excluded.cursor_json,
      pages_read = excluded.pages_read,
      elapsed_ms = excluded.elapsed_ms,
      new_jobs = excluded.new_jobs,
      consecutive_no_new_pages = excluded.consecutive_no_new_pages,
      continuation_token = excluded.continuation_token,
      stop_reason = excluded.stop_reason,
      updated_at = excluded.updated_at
  `);
  const insertEvent = database.prepare(`
    INSERT INTO job_match_events (
      session_id, sequence, type, idempotency_key, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const saveResult = database.prepare(`
    INSERT INTO job_match_results (
      id, session_id, posting_id, version, scoring_version, profile_revision,
      expectation_revision, posting_content_hash, stale, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(
      session_id, posting_id, scoring_version, profile_revision,
      expectation_revision, posting_content_hash
    ) DO UPDATE SET
      version = excluded.version,
      stale = excluded.stale,
      payload_json = excluded.payload_json,
      created_at = excluded.created_at
  `);
  const staleResults = database.prepare("UPDATE job_match_results SET stale = 1 WHERE session_id = ? AND stale = 0");
  const confirmExpectationSession = database.prepare(`
    UPDATE job_match_sessions
    SET version = version + 1, state = 'extracting_jobs', expectation_revision = ?, updated_at = ?
    WHERE id = ? AND version = ?
  `);

  const createTransaction = database.transaction((input: CreateJobMatchSessionInput) => {
    const expectationValue = JobExpectationSnapshotSchema.parse(input.expectation);
    const timestamp = input.createdAt ?? new Date().toISOString();
    insertSession.run(
      input.id,
      JobMatchSessionStateSchema.parse(input.state),
      input.entryKind ?? null,
      input.source ?? null,
      input.initialUrl,
      input.adapterVersion ?? null,
      input.profileRevision,
      expectationValue.revision,
      input.executionEpoch ?? 0,
      timestamp,
      timestamp
    );
    insertExpectation.run(
      input.id,
      expectationValue.revision,
      JSON.stringify(expectationValue),
      expectationValue.confirmedAt,
      timestamp
    );
  });

  const confirmExpectationTransaction = database.transaction((
    sessionId: string,
    expectedVersion: number,
    rawExpectation: JobExpectationSnapshot
  ) => {
    const current = fromSessionRow(requireSessionRow(findSession.get(sessionId) as SessionRow | undefined));
    if (current.version !== expectedVersion) throw new Error("job_match_version_conflict");
    if (current.state !== "awaiting_filter_confirmation") throw new Error("job_filter_confirmation_not_allowed");
    const expectationValue = JobExpectationSnapshotSchema.parse(rawExpectation);
    const timestamp = new Date().toISOString();
    const expectationPayload = JSON.stringify(expectationValue);
    const existingExpectation = findExpectation.get(sessionId, expectationValue.revision) as JsonRow | undefined;
    if (existingExpectation === undefined) {
      insertExpectation.run(
        sessionId,
        expectationValue.revision,
        expectationPayload,
        expectationValue.confirmedAt,
        timestamp
      );
    } else if (existingExpectation.payload_json !== expectationPayload) {
      throw new Error("job_match_expectation_conflict");
    }
    if (confirmExpectationSession.run(
      expectationValue.revision,
      timestamp,
      sessionId,
      expectedVersion
    ).changes !== 1) throw new Error("job_match_version_conflict");
  });

  const savePageTransaction = database.transaction((input: SaveExtractionPageInput) => {
    requireSessionRow(findSession.get(input.sessionId) as SessionRow | undefined);
    if (findIdempotentEvent.get(input.sessionId, input.idempotencyKey)) {
      return { replayed: true, newJobs: 0 };
    }
    const timestamp = input.createdAt ?? new Date().toISOString();
    let inserted = 0;
    for (const rawPosting of input.postings) {
      const posting = JobPostingSchema.parse(rawPosting);
      inserted += insertPosting.run(
        posting.id,
        input.sessionId,
        posting.source,
        posting.sourceJobId ?? null,
        posting.canonicalUrl,
        posting.contentHash,
        JSON.stringify(posting),
        posting.extractedAt
      ).changes;
    }
    saveCursor.run(
      input.sessionId,
      JSON.stringify({ value: input.cursor.value }),
      input.cursor.pagesRead,
      input.cursor.elapsedMs,
      input.cursor.newJobs,
      input.cursor.consecutiveNoNewPages,
      input.cursor.continuationToken ?? null,
      input.cursor.stopReason ?? null,
      timestamp
    );
    const sequence = (nextEventSequence.get(input.sessionId) as { sequence: number }).sequence;
    insertEvent.run(
      input.sessionId,
      sequence,
      input.event.type,
      input.idempotencyKey,
      JSON.stringify(input.event.payload),
      timestamp
    );
    return { replayed: false, newJobs: inserted };
  });

  const saveResultsTransaction = database.transaction((sessionId: string, values: JobMatchResult[], createdAt: string) => {
    requireSessionRow(findSession.get(sessionId) as SessionRow | undefined);
    for (const rawResult of values) {
      const result = JobMatchResultSchema.parse(rawResult);
      if (result.sessionId !== sessionId) throw new Error("job_match_result_session_mismatch");
      saveResult.run(
        result.id,
        sessionId,
        result.postingId,
        result.version,
        result.scoringVersion,
        result.profileRevision,
        result.expectationRevision,
        result.postingContentHash,
        result.stale ? 1 : 0,
        JSON.stringify(result),
        createdAt
      );
    }
  });

  function get(sessionId: string): JobMatchAggregate | undefined;
  function get(sessionId: string, options: { required: true }): JobMatchAggregate;
  function get(sessionId: string, options?: { required: true }): JobMatchAggregate | undefined {
    const row = findSession.get(sessionId) as SessionRow | undefined;
    if (!row) {
      if (options?.required) throw new Error("job_match_session_not_found");
      return undefined;
    }
    const session = fromSessionRow(row);
    const expectationRow = findExpectation.get(sessionId, session.expectationRevision) as JsonRow | undefined;
    if (!expectationRow) throw new Error("job_match_expectation_snapshot_missing");
    const cursorRow = findCursor.get(sessionId) as CursorRow | undefined;
    return {
      ...session,
      expectation: JobExpectationSnapshotSchema.parse(JSON.parse(expectationRow.payload_json)),
      postings: (findPostings.all(sessionId) as PostingRow[])
        .map((postingRow) => JobPostingSchema.parse(JSON.parse(postingRow.payload_json))),
      results: (findResults.all(sessionId) as ResultRow[]).map((resultRow) => JobMatchResultSchema.parse({
        ...(JSON.parse(resultRow.payload_json) as Record<string, unknown>),
        stale: resultRow.stale === 1
      })),
      events: (findEvents.all(sessionId) as EventRow[]).map(fromEventRow),
      ...(cursorRow ? { cursor: fromCursorRow(cursorRow) } : {})
    };
  }

  const repository: JobMatchRepository = {
    create(input) {
      createTransaction(input);
      return get(input.id, { required: true });
    },
    get,
    mutate(sessionId, expectedVersion, mutation) {
      const current = fromSessionRow(requireSessionRow(findSession.get(sessionId) as SessionRow | undefined));
      if (current.version !== expectedVersion) throw new Error("job_match_version_conflict");
      const desired = mutation(current);
      if (desired.id !== current.id || desired.version !== current.version) {
        throw new Error("job_match_mutation_identity_changed");
      }
      const nextVersion = current.version + 1;
      const updatedAt = new Date().toISOString();
      const changed = updateSession.run(
        nextVersion,
        JobMatchSessionStateSchema.parse(desired.state),
        desired.entryKind ?? null,
        desired.source ?? null,
        desired.initialUrl,
        desired.adapterVersion ?? null,
        desired.scoringVersion,
        desired.profileRevision,
        desired.expectationRevision,
        desired.executionEpoch,
        desired.selectedResultId ?? null,
        desired.selectedPostingContentHash ?? null,
        desired.conflictSummaryHash ?? null,
        desired.selectionIdempotencyKey ?? null,
        desired.applicationTaskId ?? null,
        desired.conversionIdempotencyKey ?? null,
        desired.stopReason ?? null,
        desired.errorCode ?? null,
        updatedAt,
        sessionId,
        expectedVersion
      ).changes;
      if (changed !== 1) throw new Error("job_match_version_conflict");
      return fromSessionRow(requireSessionRow(findSession.get(sessionId) as SessionRow | undefined));
    },
    confirmExpectation(sessionId, expectedVersion, expectationValue) {
      confirmExpectationTransaction(sessionId, expectedVersion, expectationValue);
      return fromSessionRow(requireSessionRow(findSession.get(sessionId) as SessionRow | undefined));
    },
    saveExtractionPage(input) {
      return savePageTransaction(input);
    },
    saveResults(sessionId, results, createdAt = new Date().toISOString()) {
      saveResultsTransaction(sessionId, results, createdAt);
    },
    markResultsStale(sessionId) {
      requireSessionRow(findSession.get(sessionId) as SessionRow | undefined);
      return staleResults.run(sessionId).changes;
    }
  };

  return repository;
}

function requireSessionRow(row: SessionRow | undefined): SessionRow {
  if (!row) throw new Error("job_match_session_not_found");
  return row;
}

function fromSessionRow(row: SessionRow): StoredJobMatchSession {
  return {
    id: row.id,
    version: row.version,
    state: JobMatchSessionStateSchema.parse(row.state),
    initialUrl: row.initial_url,
    scoringVersion: row.scoring_version,
    profileRevision: row.profile_revision,
    expectationRevision: row.expectation_revision,
    executionEpoch: row.execution_epoch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.entry_kind === null ? {} : { entryKind: row.entry_kind }),
    ...(row.source === null ? {} : { source: row.source }),
    ...(row.adapter_version === null ? {} : { adapterVersion: row.adapter_version }),
    ...(row.selected_result_id === null ? {} : { selectedResultId: row.selected_result_id }),
    ...(row.selected_posting_content_hash === null ? {} : { selectedPostingContentHash: row.selected_posting_content_hash }),
    ...(row.conflict_summary_hash === null ? {} : { conflictSummaryHash: row.conflict_summary_hash }),
    ...(row.selection_idempotency_key === null ? {} : { selectionIdempotencyKey: row.selection_idempotency_key }),
    ...(row.application_task_id === null ? {} : { applicationTaskId: row.application_task_id }),
    ...(row.conversion_idempotency_key === null ? {} : { conversionIdempotencyKey: row.conversion_idempotency_key }),
    ...(row.stop_reason === null ? {} : { stopReason: row.stop_reason }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code })
  };
}

function fromCursorRow(row: CursorRow): StoredExtractionCursor {
  const payload = JSON.parse(row.cursor_json) as { value?: unknown };
  if (typeof payload.value !== "string") throw new Error("job_match_cursor_invalid");
  return {
    value: payload.value,
    pagesRead: row.pages_read,
    elapsedMs: row.elapsed_ms,
    newJobs: row.new_jobs,
    consecutiveNoNewPages: row.consecutive_no_new_pages,
    updatedAt: row.updated_at,
    ...(row.continuation_token === null ? {} : { continuationToken: row.continuation_token }),
    ...(row.stop_reason === null ? {} : { stopReason: row.stop_reason })
  };
}

function fromEventRow(row: EventRow): StoredJobMatchEvent {
  const payload = JSON.parse(row.payload_json) as unknown;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("job_match_event_payload_invalid");
  }
  return {
    id: row.id,
    sequence: row.sequence,
    type: row.type,
    payload: payload as Record<string, unknown>,
    createdAt: row.created_at,
    ...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key })
  };
}
