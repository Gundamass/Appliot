import { suggestApplicationTaskName } from "@resume/contracts";
import { RuntimeApplicationStateSchema } from "../agent/runtime/application-state-store.js";
import { extractConversationUrlInput } from "../conversations/conversation-url-input.js";
import type { SqliteDatabase } from "../db/client.js";

export interface StoredApplicationTask {
  id: string;
  name: string;
  applicationUrl: string;
  createdAt: string;
  updatedAt: string;
  orchestrator: ApplicationTaskOrchestrator;
  profileRevisionApplied: number;
  profileSyncStatus: ProfileSyncStatus;
  profileSyncError?: string;
}

export type ProfileSyncStatus = "current" | "pending" | "failed";
/** The Runtime is the sole owner of newly created application tasks. */
export type ApplicationTaskOrchestrator = "agent-runtime";

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
  orchestrator: ApplicationTaskOrchestrator;
  profile_revision_applied: number;
  profile_sync_status: ProfileSyncStatus;
  profile_sync_error: string | null;
}

interface RuntimeApplicationStateRow {
  run_id: string;
  payload_json: string;
}

export function createApplicationTaskRepository(database: SqliteDatabase): ApplicationTaskRepository {
  const insert = database.prepare(`
    INSERT INTO application_tasks (id, name, application_url, created_at, updated_at, orchestrator)
    VALUES (?, ?, ?, ?, ?, 'agent-runtime')
  `);
  const find = database.prepare("SELECT * FROM application_tasks WHERE id = ?");
  const findAll = database.prepare("SELECT * FROM application_tasks ORDER BY created_at DESC, id ASC");
  const updateApplicationUrl = database.prepare(`
    UPDATE application_tasks SET application_url = ? WHERE id = ? AND application_url = ?
  `);
  const findMatchingRuntimeStates = database.prepare(`
    SELECT run_id, payload_json
    FROM agent_runtime_application_states
    WHERE json_extract(payload_json, '$.taskId') = ?
      AND json_extract(payload_json, '$.applicationUrl') = ?
  `);
  const updateRuntimeState = database.prepare(`
    UPDATE agent_runtime_application_states
    SET payload_json = ?
    WHERE run_id = ?
      AND json_extract(payload_json, '$.taskId') = ?
      AND json_extract(payload_json, '$.applicationUrl') = ?
  `);
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
      ...input, name, createdAt: timestamp, updatedAt: timestamp, orchestrator: "agent-runtime",
      profileRevisionApplied: 0, profileSyncStatus: "current"
    };
  };

  const repairHistoricalUrl = database.transaction((row: TaskRow): TaskRow => {
    const extracted = extractConversationUrlInput(row.application_url);
    if (extracted?.boundary !== "recovered_encoded_suffix") return row;

    const runtimeUpdates = (findMatchingRuntimeStates.all(
      row.id,
      row.application_url
    ) as RuntimeApplicationStateRow[]).map((runtimeRow) => ({
      runId: runtimeRow.run_id,
      payload: parseRuntimeApplicationState(runtimeRow.payload_json)
    }));

    for (const runtime of runtimeUpdates) {
      updateRuntimeState.run(
        JSON.stringify({ ...runtime.payload, applicationUrl: extracted.url }),
        runtime.runId,
        row.id,
        row.application_url
      );
    }
    updateApplicationUrl.run(extracted.url, row.id, row.application_url);
    return { ...row, application_url: extracted.url };
  });

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
      return row ? fromRow(repairHistoricalUrl(row)) : undefined;
    },
    list() {
      return (findAll.all() as TaskRow[]).map((row) => fromRow(repairHistoricalUrl(row)));
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

function parseRuntimeApplicationState(payload: string) {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new Error("runtime_application_state_corrupt");
  }
  const parsed = RuntimeApplicationStateSchema.safeParse(value);
  if (!parsed.success) throw new Error("runtime_application_state_corrupt");
  return parsed.data;
}

function fromRow(row: TaskRow): StoredApplicationTask {
  return {
    id: row.id,
    name: row.name ?? suggestApplicationTaskName(row.application_url),
    applicationUrl: row.application_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    orchestrator: row.orchestrator,
    profileRevisionApplied: row.profile_revision_applied,
    profileSyncStatus: row.profile_sync_status,
    ...(row.profile_sync_error === null ? {} : { profileSyncError: row.profile_sync_error })
  };
}
