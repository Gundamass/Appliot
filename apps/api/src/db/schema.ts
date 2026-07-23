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
  factId: text("fact_id").notNull().references(() => profileFacts.id),
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
  factId: text("fact_id").notNull().references(() => profileFacts.id),
  factRevision: integer("fact_revision").notNull(),
  contentHash: text("content_hash").notNull(),
  vectorJson: text("vector_json").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  primaryKey({ columns: [table.indexId, table.factId] }),
  check("fact_embeddings_fact_revision_positive", sql`${table.factRevision} > 0`),
  check("fact_embeddings_vector_json_valid", sql`json_valid(${table.vectorJson})`)
]);
