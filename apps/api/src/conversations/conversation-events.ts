import {
  ConversationProcessEventSchema,
  ConversationProcessHistoryResetSchema,
  type ConversationProcessEvent,
  type ConversationProcessHistoryReset,
} from "@resume/contracts";
import type { SqliteDatabase } from "../db/client.js";

export interface ConversationProcessEventReplay {
  events: ConversationProcessEvent[];
  reset?: ConversationProcessHistoryReset;
}

export interface ConversationProcessEventBus {
  emit(input: ConversationProcessEventInput): ConversationProcessEvent;
  replay(conversationId: string, afterId?: string): ConversationProcessEventReplay;
  subscribe(conversationId: string, listener: (event: ConversationProcessEvent) => void): () => void;
  subscriberCount(conversationId: string): number;
  clearConversation(conversationId: string): void;
  clearAll(): void;
}

export type ConversationProcessEventInput = Omit<
  ConversationProcessEvent,
  "id" | "type" | "createdAt"
>;

interface EventRow {
  id: number;
  conversation_id: string;
  turn_sequence: number;
  step_id: string;
  type: "process_changed";
  stage: ConversationProcessEvent["stage"];
  status: ConversationProcessEvent["status"];
  summary: string;
  details_json: string;
  created_at: string;
}

export function createConversationProcessEventBus(
  database?: SqliteDatabase,
  options: { historyLimit?: number } = {}
): ConversationProcessEventBus {
  const historyLimit = options.historyLimit ?? 200;
  if (!Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > 10_000) {
    throw new Error("conversation_process_history_limit_invalid");
  }
  const subscribers = new Map<string, Set<(event: ConversationProcessEvent) => void>>();
  let memoryNextId = 1;
  const memoryEvents = new Map<string, ConversationProcessEvent[]>();
  const memoryDiscardedThrough = new Map<string, number>();

  database?.exec(`
    CREATE TABLE IF NOT EXISTS conversation_process_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      turn_sequence INTEGER NOT NULL CHECK (turn_sequence > 0),
      step_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type = 'process_changed'),
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS conversation_process_events_conversation_id_idx
      ON conversation_process_events(conversation_id, id);
    CREATE TABLE IF NOT EXISTS conversation_process_event_cursors (
      conversation_id TEXT PRIMARY KEY,
      discarded_through_id INTEGER NOT NULL CHECK (discarded_through_id > 0)
    );
  `);

  const insert = database?.prepare(`
    INSERT INTO conversation_process_events
      (conversation_id, turn_sequence, step_id, type, stage, status, summary, details_json, created_at)
    VALUES (?, ?, ?, 'process_changed', ?, ?, ?, ?, ?)
  `);
  const deleteConversationEvents = database?.prepare(
    "DELETE FROM conversation_process_events WHERE conversation_id = ?"
  );
  const deleteConversationCursor = database?.prepare(
    "DELETE FROM conversation_process_event_cursors WHERE conversation_id = ?"
  );
  const deleteAllEvents = database?.prepare("DELETE FROM conversation_process_events");
  const deleteAllCursors = database?.prepare("DELETE FROM conversation_process_event_cursors");
  const select = database?.prepare(`
    SELECT id, conversation_id, turn_sequence, step_id, type, stage, status, summary, details_json, created_at
    FROM conversation_process_events
    WHERE conversation_id = ? AND id > ?
    ORDER BY id ASC
  `);
  const findDiscarded = database?.prepare(`
    SELECT MAX(id) AS id FROM conversation_process_events
    WHERE conversation_id = ? AND id NOT IN (
      SELECT id FROM conversation_process_events
      WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
    )
  `);
  const saveDiscarded = database?.prepare(`
    INSERT INTO conversation_process_event_cursors (conversation_id, discarded_through_id)
    VALUES (?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      discarded_through_id = MAX(discarded_through_id, excluded.discarded_through_id)
  `);
  const loadDiscarded = database?.prepare(
    "SELECT discarded_through_id FROM conversation_process_event_cursors WHERE conversation_id = ?"
  );
  const findOldest = database?.prepare(
    "SELECT MIN(id) AS id FROM conversation_process_events WHERE conversation_id = ?"
  );
  const trim = database?.prepare(`
    DELETE FROM conversation_process_events
    WHERE conversation_id = ? AND id NOT IN (
      SELECT id FROM conversation_process_events
      WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
    )
  `);

  const replay = (conversationId: string, afterId?: string): ConversationProcessEventReplay => {
    const after = afterId === undefined ? 0 : Number(afterId);
    if (!Number.isSafeInteger(after) || after < 0) return { events: [] };
    const events = database
      ? (select!.all(conversationId, after) as EventRow[]).map(fromRow)
      : (memoryEvents.get(conversationId) ?? []).filter((event) => Number(event.id) > after);
    if (afterId === undefined) return { events };
    const discardedThrough = database
      ? (loadDiscarded!.get(conversationId) as { discarded_through_id: number } | undefined)?.discarded_through_id
      : memoryDiscardedThrough.get(conversationId);
    if (discardedThrough === undefined || after > discardedThrough) return { events };
    const oldestAvailableId = database
      ? String((findOldest!.get(conversationId) as { id: number | null }).id ?? discardedThrough + 1)
      : memoryEvents.get(conversationId)?.[0]?.id ?? String(discardedThrough + 1);
    return {
      events,
      reset: ConversationProcessHistoryResetSchema.parse({
        type: "history_reset",
        conversationId,
        reason: "history_gap",
        requestedLastEventId: afterId,
        oldestAvailableId
      })
    };
  };

  const publish = (input: ConversationProcessEventInput): ConversationProcessEvent => {
    const createdAt = new Date().toISOString();
    const parsed = ConversationProcessEventSchema.parse({
      ...input,
      id: "0",
      type: "process_changed",
      createdAt
    });
    const details = JSON.stringify({
      ...(parsed.tool === undefined ? {} : { tool: parsed.tool }),
      ...(parsed.durationMs === undefined ? {} : { durationMs: parsed.durationMs }),
      ...(parsed.failure === undefined ? {} : { failure: parsed.failure })
    });
    const id = database
      ? String(insert!.run(
        parsed.conversationId,
        parsed.turnSequence,
        parsed.stepId,
        parsed.stage,
        parsed.status,
        parsed.summary,
        details,
        createdAt
      ).lastInsertRowid)
      : String(memoryNextId++);
    const event = ConversationProcessEventSchema.parse({ ...parsed, id });
    if (database) {
      const discarded = findDiscarded!.get(parsed.conversationId, parsed.conversationId, historyLimit) as { id: number | null };
      if (discarded.id !== null) saveDiscarded!.run(parsed.conversationId, discarded.id);
      trim!.run(parsed.conversationId, parsed.conversationId, historyLimit);
    } else {
      const history = memoryEvents.get(parsed.conversationId) ?? [];
      history.push(event);
      const discarded = history.slice(0, Math.max(0, history.length - historyLimit));
      if (discarded.length > 0) memoryDiscardedThrough.set(parsed.conversationId, Number(discarded.at(-1)!.id));
      memoryEvents.set(parsed.conversationId, history.slice(-historyLimit));
    }
    for (const listener of subscribers.get(parsed.conversationId) ?? []) listener(event);
    return event;
  };

  const clearConversation = (conversationId: string): void => {
    memoryEvents.delete(conversationId);
    memoryDiscardedThrough.delete(conversationId);
    subscribers.delete(conversationId);
    deleteConversationEvents?.run(conversationId);
    deleteConversationCursor?.run(conversationId);
  };

  return {
    emit: publish,
    replay,
    subscribe(conversationId, listener) {
      const conversationSubscribers = subscribers.get(conversationId) ?? new Set();
      conversationSubscribers.add(listener);
      subscribers.set(conversationId, conversationSubscribers);
      return () => {
        conversationSubscribers.delete(listener);
        if (conversationSubscribers.size === 0) subscribers.delete(conversationId);
      };
    },
    subscriberCount(conversationId) {
      return subscribers.get(conversationId)?.size ?? 0;
    },
    clearConversation,
    clearAll() {
      memoryEvents.clear();
      memoryDiscardedThrough.clear();
      subscribers.clear();
      deleteAllEvents?.run();
      deleteAllCursors?.run();
    }
  };
}

function fromRow(row: EventRow): ConversationProcessEvent {
  const details = JSON.parse(row.details_json) as {
    tool?: ConversationProcessEvent["tool"];
    durationMs?: number;
    failure?: ConversationProcessEvent["failure"];
  };
  return ConversationProcessEventSchema.parse({
    id: String(row.id),
    conversationId: row.conversation_id,
    turnSequence: row.turn_sequence,
    stepId: row.step_id,
    type: row.type,
    stage: row.stage,
    status: row.status,
    summary: row.summary,
    ...(details.tool === undefined ? {} : { tool: details.tool }),
    ...(details.durationMs === undefined ? {} : { durationMs: details.durationMs }),
    ...(details.failure === undefined ? {} : { failure: details.failure }),
    createdAt: row.created_at
  });
}
