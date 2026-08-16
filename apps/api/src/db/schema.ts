import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

const factStatuses = sql`('extracted', 'user_confirmed', 'user_corrected', 'superseded')`;
const factScopes = sql`('profile', 'application')`;

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  fingerprint: text("fingerprint").notNull().unique(),
  filename: text("filename").notNull(),
  sourcePath: text("source_path").notNull(),
  importStatus: text("import_status", { enum: ["retained", "importing", "completed"] }).notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  check("documents_import_status_valid", sql`${table.importStatus} IN ('retained', 'importing', 'completed')`)
]);

export const documentChunks = sqliteTable("document_chunks", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull().references(() => documents.id),
  page: integer("page").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  index("document_chunks_document_id_idx").on(table.documentId),
  check("document_chunks_page_positive", sql`${table.page} > 0`)
]);

export const profileFacts = sqliteTable("profile_facts", {
  id: text("id").primaryKey(),
  fieldPath: text("field_path").notNull(),
  valueJson: text("value_json").notNull(),
  status: text("status").notNull(),
  confidence: real("confidence").notNull(),
  scope: text("scope").notNull(),
  taskId: text("task_id"),
  evidenceJson: text("evidence_json").notNull(),
  revision: integer("revision").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  index("profile_facts_field_path_idx").on(table.fieldPath),
  check("profile_facts_status_valid", sql`${table.status} IN ${factStatuses}`),
  check("profile_facts_confidence_valid", sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`),
  check("profile_facts_scope_valid", sql`${table.scope} IN ${factScopes}`),
  check("profile_facts_revision_positive", sql`${table.revision} > 0`),
  check("profile_facts_scope_task_consistent", sql`(${table.scope} = 'profile' AND ${table.taskId} IS NULL) OR (${table.scope} = 'application' AND ${table.taskId} IS NOT NULL)`),
  check("profile_facts_value_json_valid", sql`json_valid(${table.valueJson})`),
  check("profile_facts_evidence_json_valid", sql`json_valid(${table.evidenceJson}) AND json_type(${table.evidenceJson}) = 'array' AND json_array_length(${table.evidenceJson}) > 0`)
]);

export const factRevisions = sqliteTable("fact_revisions", {
  id: text("id").primaryKey(),
  factId: text("fact_id").notNull().references(() => profileFacts.id, { onDelete: "cascade" }),
  fieldPath: text("field_path").notNull(),
  valueJson: text("value_json").notNull(),
  status: text("status").notNull(),
  confidence: real("confidence").notNull(),
  scope: text("scope").notNull(),
  taskId: text("task_id"),
  evidenceJson: text("evidence_json").notNull(),
  revision: integer("revision").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  index("fact_revisions_fact_id_revision_idx").on(table.factId, table.revision),
  unique("fact_revisions_fact_id_revision_unique").on(table.factId, table.revision),
  check("fact_revisions_status_valid", sql`${table.status} IN ${factStatuses}`),
  check("fact_revisions_confidence_valid", sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`),
  check("fact_revisions_scope_valid", sql`${table.scope} IN ${factScopes}`),
  check("fact_revisions_revision_positive", sql`${table.revision} > 0`),
  check("fact_revisions_scope_task_consistent", sql`(${table.scope} = 'profile' AND ${table.taskId} IS NULL) OR (${table.scope} = 'application' AND ${table.taskId} IS NOT NULL)`),
  check("fact_revisions_value_json_valid", sql`json_valid(${table.valueJson})`),
  check("fact_revisions_evidence_json_valid", sql`json_valid(${table.evidenceJson}) AND json_type(${table.evidenceJson}) = 'array' AND json_array_length(${table.evidenceJson}) > 0`)
]);

export const applicationAnswers = sqliteTable("application_answers", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  fieldPath: text("field_path").notNull(),
  valueJson: text("value_json").notNull(),
  evidenceJson: text("evidence_json").notNull(),
  confidence: real("confidence").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  index("application_answers_task_field_idx").on(table.taskId, table.fieldPath),
  unique("application_answers_task_field_unique").on(table.taskId, table.fieldPath),
  check("application_answers_confidence_valid", sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`),
  check("application_answers_value_json_valid", sql`json_valid(${table.valueJson})`),
  check("application_answers_evidence_json_valid", sql`json_valid(${table.evidenceJson}) AND json_type(${table.evidenceJson}) = 'array' AND json_array_length(${table.evidenceJson}) > 0`)
]);

export const profileMetadata = sqliteTable("profile_metadata", {
  id: integer("id").primaryKey(),
  revision: integer("revision").notNull().default(0)
}, (table) => [
  check("profile_metadata_singleton", sql`${table.id} = 1`),
  check("profile_metadata_revision_nonnegative", sql`${table.revision} >= 0`)
]);

export const applicationTasks = sqliteTable("application_tasks", {
  id: text("id").primaryKey(),
  name: text("name"),
  applicationUrl: text("application_url").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  profileRevisionApplied: integer("profile_revision_applied").notNull().default(0),
  profileSyncStatus: text("profile_sync_status", { enum: ["current", "pending", "failed"] }).notNull().default("current"),
  profileSyncError: text("profile_sync_error")
}, (table) => [
  check("application_tasks_profile_revision_nonnegative", sql`${table.profileRevisionApplied} >= 0`),
  check("application_tasks_profile_sync_status_valid", sql`${table.profileSyncStatus} IN ('current', 'pending', 'failed')`)
]);

export const jobMatchSessions = sqliteTable("job_match_sessions", {
  id: text("id").primaryKey(),
  version: integer("version").notNull().default(0),
  state: text("state").notNull(),
  entryKind: text("entry_kind", { enum: ["job_list", "job_detail", "application_form"] }),
  source: text("source", { enum: ["moka", "dji"] }),
  initialUrl: text("initial_url").notNull(),
  adapterVersion: text("adapter_version"),
  scoringVersion: text("scoring_version").notNull().default("job-match-v1"),
  profileRevision: integer("profile_revision").notNull(),
  expectationRevision: integer("expectation_revision").notNull(),
  executionEpoch: integer("execution_epoch").notNull().default(0),
  selectedResultId: text("selected_result_id"),
  selectedPostingContentHash: text("selected_posting_content_hash"),
  conflictSummaryHash: text("conflict_summary_hash"),
  selectionIdempotencyKey: text("selection_idempotency_key"),
  applicationTaskId: text("application_task_id").references(() => applicationTasks.id),
  conversionIdempotencyKey: text("conversion_idempotency_key"),
  stopReason: text("stop_reason"),
  errorCode: text("error_code"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  unique("job_match_sessions_selection_idempotency_unique").on(table.selectionIdempotencyKey),
  unique("job_match_sessions_conversion_idempotency_unique").on(table.conversionIdempotencyKey),
  check("job_match_sessions_version_nonnegative", sql`${table.version} >= 0`),
  check("job_match_sessions_profile_revision_nonnegative", sql`${table.profileRevision} >= 0`),
  check("job_match_sessions_expectation_revision_nonnegative", sql`${table.expectationRevision} >= 0`),
  check("job_match_sessions_execution_epoch_nonnegative", sql`${table.executionEpoch} >= 0`),
  check("job_match_sessions_scoring_version_valid", sql`${table.scoringVersion} = 'job-match-v1'`)
]);

export const jobMatchExpectationSnapshots = sqliteTable("job_match_expectation_snapshots", {
  sessionId: text("session_id").notNull().references(() => jobMatchSessions.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  payloadJson: text("payload_json").notNull(),
  confirmedAt: text("confirmed_at").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  primaryKey({ columns: [table.sessionId, table.revision] }),
  check("job_match_expectation_revision_nonnegative", sql`${table.revision} >= 0`),
  check("job_match_expectation_payload_valid", sql`json_valid(${table.payloadJson})`)
]);

export const jobPostings = sqliteTable("job_postings", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => jobMatchSessions.id, { onDelete: "cascade" }),
  source: text("source", { enum: ["moka", "dji"] }).notNull(),
  sourceJobId: text("source_job_id"),
  canonicalUrl: text("canonical_url").notNull(),
  contentHash: text("content_hash").notNull(),
  payloadJson: text("payload_json").notNull(),
  extractedAt: text("extracted_at").notNull()
}, (table) => [
  unique("job_postings_session_url_hash_unique").on(table.sessionId, table.source, table.canonicalUrl, table.contentHash),
  index("job_postings_session_id_idx").on(table.sessionId, table.id),
  check("job_postings_source_valid", sql`${table.source} IN ('moka', 'dji')`),
  check("job_postings_payload_valid", sql`json_valid(${table.payloadJson})`)
]);

export const jobMatchResults = sqliteTable("job_match_results", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => jobMatchSessions.id, { onDelete: "cascade" }),
  postingId: text("posting_id").notNull().references(() => jobPostings.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  scoringVersion: text("scoring_version").notNull(),
  profileRevision: integer("profile_revision").notNull(),
  expectationRevision: integer("expectation_revision").notNull(),
  postingContentHash: text("posting_content_hash").notNull(),
  stale: integer("stale", { mode: "boolean" }).notNull().default(false),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  unique("job_match_results_identity_unique").on(
    table.sessionId,
    table.postingId,
    table.scoringVersion,
    table.profileRevision,
    table.expectationRevision,
    table.postingContentHash
  ),
  index("job_match_results_session_ranking_idx").on(table.sessionId, table.stale, table.id),
  check("job_match_results_version_nonnegative", sql`${table.version} >= 0`),
  check("job_match_results_scoring_version_valid", sql`${table.scoringVersion} = 'job-match-v1'`),
  check("job_match_results_profile_revision_nonnegative", sql`${table.profileRevision} >= 0`),
  check("job_match_results_expectation_revision_nonnegative", sql`${table.expectationRevision} >= 0`),
  check("job_match_results_payload_valid", sql`json_valid(${table.payloadJson})`)
]);

export const jobExtractionCursors = sqliteTable("job_extraction_cursors", {
  sessionId: text("session_id").primaryKey().references(() => jobMatchSessions.id, { onDelete: "cascade" }),
  cursorJson: text("cursor_json").notNull(),
  pagesRead: integer("pages_read").notNull().default(0),
  elapsedMs: integer("elapsed_ms").notNull().default(0),
  newJobs: integer("new_jobs").notNull().default(0),
  consecutiveNoNewPages: integer("consecutive_no_new_pages").notNull().default(0),
  continuationToken: text("continuation_token"),
  stopReason: text("stop_reason"),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  check("job_extraction_cursor_json_valid", sql`json_valid(${table.cursorJson})`),
  check("job_extraction_pages_nonnegative", sql`${table.pagesRead} >= 0`),
  check("job_extraction_elapsed_nonnegative", sql`${table.elapsedMs} >= 0`),
  check("job_extraction_new_jobs_nonnegative", sql`${table.newJobs} >= 0`),
  check("job_extraction_no_new_nonnegative", sql`${table.consecutiveNoNewPages} >= 0`)
]);

export const jobMatchEvents = sqliteTable("job_match_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull().references(() => jobMatchSessions.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  type: text("type").notNull(),
  idempotencyKey: text("idempotency_key"),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  unique("job_match_events_session_sequence_unique").on(table.sessionId, table.sequence),
  unique("job_match_events_session_idempotency_unique").on(table.sessionId, table.idempotencyKey),
  check("job_match_events_sequence_positive", sql`${table.sequence} > 0`),
  check("job_match_events_payload_valid", sql`json_valid(${table.payloadJson})`)
]);

export const embeddings = sqliteTable("embeddings", {
  id: text("id").primaryKey(),
  documentChunkId: text("document_chunk_id").notNull().references(() => documentChunks.id),
  model: text("model").notNull(),
  vectorJson: text("vector_json").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [index("embeddings_document_chunk_id_idx").on(table.documentChunkId)]);

export const embeddingIndexes = sqliteTable("embedding_indexes", {
  id: text("id").primaryKey(),
  model: text("model").notNull(),
  modelRevision: text("model_revision").notNull(),
  dimensions: integer("dimensions").notNull(),
  normalization: text("normalization").notNull(),
  instructionVersion: text("instruction_version").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  activatedAt: text("activated_at")
}, (table) => [
  check("embedding_indexes_dimensions_positive", sql`${table.dimensions} > 0`),
  check("embedding_indexes_normalization_valid", sql`${table.normalization} = 'l2'`),
  check("embedding_indexes_status_valid", sql`${table.status} IN ('building', 'active', 'retired')`)
]);

export const factEmbeddings = sqliteTable("fact_embeddings", {
  indexId: text("index_id").notNull().references(() => embeddingIndexes.id),
  factId: text("fact_id").notNull().references(() => profileFacts.id, { onDelete: "cascade" }),
  factRevision: integer("fact_revision").notNull(),
  contentHash: text("content_hash").notNull(),
  vectorJson: text("vector_json").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  primaryKey({ columns: [table.indexId, table.factId] }),
  check("fact_embeddings_fact_revision_positive", sql`${table.factRevision} > 0`),
  check("fact_embeddings_vector_json_valid", sql`json_valid(${table.vectorJson})`)
]);
