import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  fingerprint: text("fingerprint").notNull().unique(),
  filename: text("filename").notNull(),
  createdAt: text("created_at").notNull()
});

export const documentChunks = sqliteTable("document_chunks", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull().references(() => documents.id),
  page: integer("page").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [index("document_chunks_document_id_idx").on(table.documentId)]);

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
}, (table) => [index("profile_facts_field_path_idx").on(table.fieldPath)]);

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
}, (table) => [index("fact_revisions_fact_id_revision_idx").on(table.factId, table.revision)]);

export const applicationAnswers = sqliteTable("application_answers", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  fieldPath: text("field_path").notNull(),
  valueJson: text("value_json").notNull(),
  evidenceJson: text("evidence_json").notNull(),
  confidence: real("confidence").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [index("application_answers_task_field_idx").on(table.taskId, table.fieldPath)]);

export const embeddings = sqliteTable("embeddings", {
  id: text("id").primaryKey(),
  documentChunkId: text("document_chunk_id").notNull().references(() => documentChunks.id),
  model: text("model").notNull(),
  vectorJson: text("vector_json").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [index("embeddings_document_chunk_id_idx").on(table.documentChunkId)]);
