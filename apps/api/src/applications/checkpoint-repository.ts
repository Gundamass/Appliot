import {
  ApplicationQuestionSchema,
  type ApplicationContentReview,
  type ApplicationQuestion,
  type FormSnapshot
} from "@resume/contracts";
import { z } from "zod";
import type { SqliteDatabase } from "../db/client.js";
import type { ApplicationStateValue } from "./application-machine.js";
import type { ApplicationProgressSnapshot } from "./application-progress.js";

export interface ApplicationCheckpointInput {
  taskId: string;
  state: ApplicationStateValue;
  url: string;
  stage: FormSnapshot["stage"];
  snapshotId: string;
  fieldIds: string[];
  questions: ApplicationQuestion[];
  snapshot?: FormSnapshot;
  contentReview?: StoredContentReview;
}

export interface StoredContentReview {
  id: string;
  taskId: string;
  fieldId: string;
  draft: string;
  fieldLabel: string;
  original: string;
  reasons: ApplicationContentReview["reasons"];
  evidence: ApplicationContentReview["evidence"];
  unsupportedClaims: ApplicationContentReview["unsupportedClaims"];
  status: ApplicationContentReview["status"];
}

export interface ApplicationCheckpoint extends ApplicationCheckpointInput {
  sequence: number;
  createdAt: string;
}

interface CheckpointRow {
  task_id: string;
  sequence: number;
  state: ApplicationStateValue;
  url: string;
  stage: FormSnapshot["stage"];
  snapshot_id: string;
  field_ids_json: string;
  questions_json: string;
  snapshot_json: string | null;
  content_review_json: string | null;
  created_at: string;
}

export interface CheckpointRepository {
  save(checkpoint: ApplicationCheckpointInput): ApplicationCheckpoint;
  latest(taskId: string): ApplicationCheckpoint | undefined;
  list(taskId: string): ApplicationCheckpoint[];
  saveProgress(taskId: string, progress: ApplicationProgressSnapshot): void;
  latestProgress(taskId: string): ApplicationProgressSnapshot | undefined;
}

export function createCheckpointRepository(database: SqliteDatabase): CheckpointRepository {
  database.exec(`
    CREATE TABLE IF NOT EXISTS application_progress_checkpoints (
      task_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      updated_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS application_tasks_progress_cleanup
    AFTER DELETE ON application_tasks
    BEGIN
      DELETE FROM application_progress_checkpoints WHERE task_id = OLD.id;
    END;
  `);
  const insert = database.prepare(`
    INSERT INTO application_checkpoints (
      task_id, sequence, state, url, stage, snapshot_id, field_ids_json, questions_json,
      snapshot_json, content_review_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const nextSequence = database.prepare(`
    SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
    FROM application_checkpoints WHERE task_id = ?
  `);
  const findLatest = database.prepare(`
    SELECT * FROM application_checkpoints WHERE task_id = ? ORDER BY sequence DESC LIMIT 1
  `);
  const findAll = database.prepare(`
    SELECT * FROM application_checkpoints WHERE task_id = ? ORDER BY sequence ASC
  `);
  const saveTransaction = database.transaction((checkpoint: ApplicationCheckpointInput) => {
    const { sequence } = nextSequence.get(checkpoint.taskId) as { sequence: number };
    const createdAt = new Date().toISOString();
    insert.run(
      checkpoint.taskId,
      sequence,
      checkpoint.state,
      checkpoint.url,
      checkpoint.stage,
      checkpoint.snapshotId,
      JSON.stringify(checkpoint.fieldIds),
      JSON.stringify(checkpoint.questions),
      checkpoint.snapshot === undefined ? null : JSON.stringify(checkpoint.snapshot),
      checkpoint.contentReview === undefined ? null : JSON.stringify(checkpoint.contentReview),
      createdAt
    );
    return { ...checkpoint, sequence, createdAt };
  });
  const saveProgress = database.prepare(`
    INSERT INTO application_progress_checkpoints (task_id, payload_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);
  const findProgress = database.prepare(
    "SELECT payload_json FROM application_progress_checkpoints WHERE task_id = ?"
  );

  return {
    save: (checkpoint) => saveTransaction(checkpoint),
    latest: (taskId) => {
      const row = findLatest.get(taskId) as CheckpointRow | undefined;
      return row ? fromRow(row) : undefined;
    },
    list: (taskId) => (findAll.all(taskId) as CheckpointRow[]).map(fromRow),
    saveProgress(taskId, progress) {
      saveProgress.run(taskId, JSON.stringify(progress), new Date().toISOString());
    },
    latestProgress(taskId) {
      const row = findProgress.get(taskId) as { payload_json: string } | undefined;
      return row === undefined
        ? undefined
        : JSON.parse(row.payload_json) as ApplicationProgressSnapshot;
    }
  };
}

function fromRow(row: CheckpointRow): ApplicationCheckpoint {
  return {
    taskId: row.task_id,
    sequence: row.sequence,
    state: row.state,
    url: row.url,
    stage: row.stage,
    snapshotId: row.snapshot_id,
    fieldIds: JSON.parse(row.field_ids_json) as string[],
    questions: z.array(ApplicationQuestionSchema).parse(JSON.parse(row.questions_json)),
    ...(row.snapshot_json === null ? {} : { snapshot: JSON.parse(row.snapshot_json) as FormSnapshot }),
    ...(row.content_review_json === null
      ? {}
      : { contentReview: JSON.parse(row.content_review_json) as StoredContentReview }),
    createdAt: row.created_at
  };
}
