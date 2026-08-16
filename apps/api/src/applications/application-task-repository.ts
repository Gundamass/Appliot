import { suggestApplicationTaskName } from "@resume/contracts";
import type { SqliteDatabase } from "../db/client.js";

export interface StoredApplicationTask {
  id: string;
  name: string;
  applicationUrl: string;
  createdAt: string;
  updatedAt: string;
  profileRevisionApplied: number;
  profileSyncStatus: ProfileSyncStatus;
  profileSyncError?: string;
}

export type ProfileSyncStatus = "current" | "pending" | "failed";

export interface ApplicationTaskRepository {
  create(input: { id: string; name?: string; applicationUrl: string }): StoredApplicationTask;
  createFromJob(input: { id: string; name?: string; applicationUrl: string }): StoredApplicationTask;
  get(taskId: string): StoredApplicationTask | undefined;
  list(): StoredApplicationTask[];
  delete(taskId: string): void;
  markProfileSyncPending(taskId: string): void;
  markProfileSyncFailed(taskId: string, errorCode: string): void;
  markProfileSyncSucceeded(taskId: string, revision: number): void;
}

interface TaskRow {
  id: string;
  name: string | null;
  application_url: string;
  created_at: string;
  updated_at: string;
  profile_revision_applied: number;
  profile_sync_status: ProfileSyncStatus;
  profile_sync_error: string | null;
}

export function createApplicationTaskRepository(database: SqliteDatabase): ApplicationTaskRepository {
  const insert = database.prepare(`
    INSERT INTO application_tasks (id, name, application_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const find = database.prepare("SELECT * FROM application_tasks WHERE id = ?");
  const findAll = database.prepare("SELECT * FROM application_tasks ORDER BY created_at DESC, id ASC");
  const remove = database.prepare("DELETE FROM application_tasks WHERE id = ?");
  const markPending = database.prepare("UPDATE application_tasks SET profile_sync_status = 'pending', profile_sync_error = NULL, updated_at = ? WHERE id = ?");
  const markFailed = database.prepare("UPDATE application_tasks SET profile_sync_status = 'failed', profile_sync_error = ?, updated_at = ? WHERE id = ?");
  const findRevision = database.prepare("SELECT profile_revision_applied FROM application_tasks WHERE id = ?");
  const markSucceeded = database.prepare(`
    UPDATE application_tasks
    SET profile_revision_applied = CASE WHEN profile_revision_applied < ? THEN ? ELSE profile_revision_applied END,
        profile_sync_status = 'current', profile_sync_error = NULL, updated_at = ?
    WHERE id = ?
  `);

  const createTask = (input: { id: string; name?: string; applicationUrl: string }): StoredApplicationTask => {
    const timestamp = new Date().toISOString();
    const name = input.name ?? suggestApplicationTaskName(input.applicationUrl);
    insert.run(input.id, name, input.applicationUrl, timestamp, timestamp);
    return {
      ...input, name, createdAt: timestamp, updatedAt: timestamp,
      profileRevisionApplied: 0, profileSyncStatus: "current"
    };
  };

  return {
    create(input) {
      return createTask(input);
    },
    createFromJob(input) {
      const row = find.get(input.id) as TaskRow | undefined;
      if (row !== undefined) {
        const existing = fromRow(row);
        if (existing.applicationUrl !== input.applicationUrl) {
          throw new Error("application_task_idempotency_conflict");
        }
        return existing;
      }
      return createTask(input);
    },
    get(taskId) {
      const row = find.get(taskId) as TaskRow | undefined;
      return row ? fromRow(row) : undefined;
    },
    list() {
      return (findAll.all() as TaskRow[]).map(fromRow);
    },
    delete(taskId) {
      remove.run(taskId);
    },
    markProfileSyncPending(taskId) {
      markPending.run(new Date().toISOString(), taskId);
    },
    markProfileSyncFailed(taskId, errorCode) {
      markFailed.run(errorCode, new Date().toISOString(), taskId);
    },
    markProfileSyncSucceeded(taskId, revision) {
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("invalid profile revision");
      const current = findRevision.get(taskId) as { profile_revision_applied: number } | undefined;
      if (!current) throw new Error(`application task not found: ${taskId}`);
      markSucceeded.run(revision, revision, new Date().toISOString(), taskId);
    }
  };
}

function fromRow(row: TaskRow): StoredApplicationTask {
  return {
    id: row.id,
    name: row.name ?? suggestApplicationTaskName(row.application_url),
    applicationUrl: row.application_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    profileRevisionApplied: row.profile_revision_applied,
    profileSyncStatus: row.profile_sync_status,
    ...(row.profile_sync_error === null ? {} : { profileSyncError: row.profile_sync_error })
  };
}
