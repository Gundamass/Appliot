import { suggestApplicationTaskName } from "@resume/contracts";
import type { SqliteDatabase } from "../db/client.js";

export interface StoredApplicationTask {
  id: string;
  name: string;
  applicationUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationTaskRepository {
  create(input: { id: string; name: string; applicationUrl: string }): StoredApplicationTask;
  get(taskId: string): StoredApplicationTask | undefined;
  list(): StoredApplicationTask[];
  delete(taskId: string): void;
}

interface TaskRow {
  id: string;
  name: string | null;
  application_url: string;
  created_at: string;
  updated_at: string;
}

export function createApplicationTaskRepository(database: SqliteDatabase): ApplicationTaskRepository {
  const insert = database.prepare(`
    INSERT INTO application_tasks (id, name, application_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const find = database.prepare("SELECT * FROM application_tasks WHERE id = ?");
  const findAll = database.prepare("SELECT * FROM application_tasks ORDER BY created_at DESC, id ASC");
  const remove = database.prepare("DELETE FROM application_tasks WHERE id = ?");

  return {
    create(input) {
      const timestamp = new Date().toISOString();
      insert.run(input.id, input.name, input.applicationUrl, timestamp, timestamp);
      return { ...input, createdAt: timestamp, updatedAt: timestamp };
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
    }
  };
}

function fromRow(row: TaskRow): StoredApplicationTask {
  return {
    id: row.id,
    name: row.name ?? suggestApplicationTaskName(row.application_url),
    applicationUrl: row.application_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
