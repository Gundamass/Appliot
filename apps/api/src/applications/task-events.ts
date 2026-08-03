import {
  ApplicationTaskEventSchema,
  ApplicationTaskHistoryResetSchema,
  ApplicationTaskStateChangedEventSchema,
  type ApplicationTaskHistoryReset,
  type ApplicationTaskProgressEvent,
  type ApplicationTaskEvent,
  type ApplicationTaskState
} from "@resume/contracts";
import type { SqliteDatabase } from "../db/client.js";

type EventPayload = ApplicationTaskProgressEvent extends infer Event
  ? Event extends { id: string; taskId: string; createdAt: string }
    ? Omit<Event, "id" | "taskId" | "createdAt">
    : never
  : never;

export interface TaskEventReplay {
  events: ApplicationTaskProgressEvent[];
  reset?: ApplicationTaskHistoryReset;
}

export interface TaskEventBus {
  emit(taskId: string, state: ApplicationTaskState): Extract<ApplicationTaskProgressEvent, { type: "state_changed" }>;
  emitProgress(taskId: string, payload: Exclude<EventPayload, { type: "state_changed" }>): ApplicationTaskProgressEvent;
  history(taskId: string, afterId?: string): ApplicationTaskEvent[];
  replay(taskId: string, afterId?: string): { events: ApplicationTaskEvent[]; reset?: ApplicationTaskHistoryReset };
  replayAll(taskId: string, afterId?: string): TaskEventReplay;
  subscribe(taskId: string, listener: (event: ApplicationTaskEvent) => void): () => void;
  subscribeAll(taskId: string, listener: (event: ApplicationTaskProgressEvent) => void): () => void;
  subscriberCount(taskId: string): number;
}

interface EventRow {
  id: number;
  task_id: string;
  payload_json: string;
  created_at: string;
}

export function createTaskEventBus(
  database?: SqliteDatabase,
  options: { historyLimit?: number } = {}
): TaskEventBus {
  const historyLimit = options.historyLimit ?? 200;
  const subscribers = new Map<string, Set<(event: ApplicationTaskEvent) => void>>();
  const allSubscribers = new Map<string, Set<(event: ApplicationTaskProgressEvent) => void>>();
  let memoryNextId = 1;
  const memoryEvents = new Map<string, ApplicationTaskProgressEvent[]>();
  const memoryDiscardedThrough = new Map<string, number>();

  database?.exec(`
    CREATE TABLE IF NOT EXISTS application_progress_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS application_progress_events_task_id_id_idx
      ON application_progress_events(task_id, id);
    CREATE TABLE IF NOT EXISTS application_progress_event_cursors (
      task_id TEXT PRIMARY KEY,
      discarded_through_id INTEGER NOT NULL CHECK (discarded_through_id > 0)
    );
    CREATE TRIGGER IF NOT EXISTS application_tasks_progress_events_cleanup
    AFTER DELETE ON application_tasks
    BEGIN
      DELETE FROM application_progress_events WHERE task_id = OLD.id;
      DELETE FROM application_progress_event_cursors WHERE task_id = OLD.id;
    END;
  `);

  const insert = database?.prepare(`
    INSERT INTO application_progress_events (task_id, payload_json, created_at)
    VALUES (?, ?, ?)
  `);
  const select = database?.prepare(`
    SELECT id, task_id, payload_json, created_at FROM application_progress_events
    WHERE task_id = ? AND id > ? ORDER BY id ASC
  `);
  const findDiscarded = database?.prepare(`
    SELECT MAX(id) AS id FROM application_progress_events
    WHERE task_id = ? AND id NOT IN (
      SELECT id FROM application_progress_events WHERE task_id = ? ORDER BY id DESC LIMIT ?
    )
  `);
  const saveDiscarded = database?.prepare(`
    INSERT INTO application_progress_event_cursors (task_id, discarded_through_id)
    VALUES (?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      discarded_through_id = MAX(discarded_through_id, excluded.discarded_through_id)
  `);
  const loadDiscarded = database?.prepare(
    "SELECT discarded_through_id FROM application_progress_event_cursors WHERE task_id = ?"
  );
  const findOldest = database?.prepare(
    "SELECT MIN(id) AS id FROM application_progress_events WHERE task_id = ?"
  );
  const trim = database?.prepare(`
    DELETE FROM application_progress_events
    WHERE task_id = ? AND id NOT IN (
      SELECT id FROM application_progress_events WHERE task_id = ? ORDER BY id DESC LIMIT ?
    )
  `);

  const replay = (taskId: string, afterId?: string): TaskEventReplay => {
    const after = afterId === undefined ? 0 : Number(afterId);
    if (!Number.isSafeInteger(after) || after < 0) return { events: [] };
    const events = database
      ? (select!.all(taskId, after) as EventRow[]).map(fromRow)
      : (memoryEvents.get(taskId) ?? []).filter((event) => Number(event.id) > after);
    if (afterId === undefined) return { events };
    const discardedThrough = database
      ? (loadDiscarded!.get(taskId) as { discarded_through_id: number } | undefined)?.discarded_through_id
      : memoryDiscardedThrough.get(taskId);
    if (discardedThrough === undefined || after > discardedThrough) return { events };
    const oldestAvailableId = database
      ? String((findOldest!.get(taskId) as { id: number | null }).id ?? discardedThrough + 1)
      : memoryEvents.get(taskId)?.[0]?.id ?? String(discardedThrough + 1);
    return {
      events,
      reset: ApplicationTaskHistoryResetSchema.parse({
        type: "history_reset",
        taskId,
        reason: "history_gap",
        requestedLastEventId: afterId,
        oldestAvailableId
      })
    };
  };

  const publish = (taskId: string, payload: EventPayload): ApplicationTaskProgressEvent => {
    const createdAt = new Date().toISOString();
    const id = database
      ? String(insert!.run(taskId, JSON.stringify(payload), createdAt).lastInsertRowid)
      : String(memoryNextId++);
    const event = ApplicationTaskEventSchema.parse({ id, taskId, createdAt, ...payload });
    if (database) {
      const discarded = findDiscarded!.get(taskId, taskId, historyLimit) as { id: number | null };
      if (discarded.id !== null) saveDiscarded!.run(taskId, discarded.id);
      trim!.run(taskId, taskId, historyLimit);
    } else {
      const history = memoryEvents.get(taskId) ?? [];
      history.push(event);
      const discarded = history.slice(0, Math.max(0, history.length - historyLimit));
      if (discarded.length > 0) memoryDiscardedThrough.set(taskId, Number(discarded.at(-1)!.id));
      memoryEvents.set(taskId, history.slice(-historyLimit));
    }
    if (isStateEvent(event)) {
      for (const listener of subscribers.get(taskId) ?? []) listener(event);
    }
    for (const listener of allSubscribers.get(taskId) ?? []) listener(event);
    return event;
  };

  return {
    emit(taskId, state) {
      return ApplicationTaskStateChangedEventSchema.parse(publish(taskId, { type: "state_changed", state }));
    },
    emitProgress(taskId, payload) {
      return publish(taskId, payload);
    },
    history(taskId, afterId) {
      return replay(taskId, afterId).events.filter(isStateEvent);
    },
    replay(taskId, afterId) {
      const result = replay(taskId, afterId);
      return { ...result, events: result.events.filter(isStateEvent) };
    },
    replayAll: replay,
    subscribe(taskId, listener) {
      const taskSubscribers = subscribers.get(taskId) ?? new Set();
      taskSubscribers.add(listener);
      subscribers.set(taskId, taskSubscribers);
      return () => {
        taskSubscribers.delete(listener);
        if (taskSubscribers.size === 0) subscribers.delete(taskId);
      };
    },
    subscribeAll(taskId, listener) {
      const taskSubscribers = allSubscribers.get(taskId) ?? new Set();
      taskSubscribers.add(listener);
      allSubscribers.set(taskId, taskSubscribers);
      return () => {
        taskSubscribers.delete(listener);
        if (taskSubscribers.size === 0) allSubscribers.delete(taskId);
      };
    },
    subscriberCount(taskId) {
      return (subscribers.get(taskId)?.size ?? 0) + (allSubscribers.get(taskId)?.size ?? 0);
    }
  };
}

function isStateEvent(event: ApplicationTaskProgressEvent): event is ApplicationTaskEvent {
  return event.type === "state_changed";
}

function fromRow(row: EventRow): ApplicationTaskProgressEvent {
  const payload = JSON.parse(row.payload_json) as EventPayload;
  return ApplicationTaskEventSchema.parse({
    id: String(row.id),
    taskId: row.task_id,
    createdAt: row.created_at,
    ...payload
  });
}
