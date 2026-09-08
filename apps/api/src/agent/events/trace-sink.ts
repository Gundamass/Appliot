import { createHash } from "node:crypto";
import {
  AgentEventSchema,
  type AgentEvent
} from "@resume/contracts";
import type { SqliteDatabase } from "../../db/client.js";
import {
  AgentEventDraftSchema,
  EventCursorSchema,
  type AgentEventDraft,
  type AgentEventReplay
} from "./event-types.js";

export interface AgentEventTraceSink {
  record(input: AgentEventDraft): AgentEvent;
  list(runId: string, afterCursor?: string): AgentEvent[];
  replay(runId: string, afterCursor?: string): AgentEventReplay;
  subscribe(runId: string, listener: (event: AgentEvent) => void): () => void;
}

export interface AgentEventTraceSinkOptions {
  now?: () => string;
}

interface EventRow {
  event_id: string;
  run_id: string;
  sequence: number;
  payload_json: string;
  created_at: string;
}

const sensitiveReferencePattern = /(?:password|passwd|secret|cookie|authorization|credential|private[_-]?key|prompt)/iu;
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const phonePattern = /(?:^|\D)(?:\+?86[- ]?)?1[3-9]\d{9}(?:$|\D)/;
const markupPattern = /<\/?[a-z][^>]*>/i;

export function createInMemoryAgentEventTraceSink(
  options: AgentEventTraceSinkOptions = {}
): AgentEventTraceSink {
  const now = options.now ?? (() => new Date().toISOString());
  const events = new Map<string, AgentEvent[]>();
  const subscribers = new Map<string, Set<(event: AgentEvent) => void>>();
  return createSink({
    now,
    append(input) {
      const history = events.get(input.runId) ?? [];
      const event = buildEvent(input, history.length + 1, now);
      history.push(event);
      events.set(input.runId, history);
      publish(subscribers, event);
      return event;
    },
    list(runId, afterCursor) {
      const history = events.get(runId) ?? [];
      return afterIndex(history, afterCursor);
    },
    subscribe(runId, listener) {
      const listeners = subscribers.get(runId) ?? new Set();
      listeners.add(listener);
      subscribers.set(runId, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) subscribers.delete(runId);
      };
    }
  });
}

export function createSqliteAgentEventTraceSink(
  database: SqliteDatabase,
  options: AgentEventTraceSinkOptions = {}
): AgentEventTraceSink {
  const now = options.now ?? (() => new Date().toISOString());
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_events (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      created_at TEXT NOT NULL,
      UNIQUE (run_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS agent_events_run_sequence_idx
      ON agent_events(run_id, sequence);
  `);
  const nextSequence = database.prepare(
    "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM agent_events WHERE run_id = ?"
  );
  const insert = database.prepare(
    "INSERT INTO agent_events (event_id, run_id, sequence, payload_json, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  const select = database.prepare(
    "SELECT event_id, run_id, sequence, payload_json, created_at FROM agent_events WHERE run_id = ? ORDER BY sequence ASC"
  );
  const selectAfter = database.prepare(
    "SELECT event_id, run_id, sequence, payload_json, created_at FROM agent_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC"
  );
  const sequenceForCursor = database.prepare(
    "SELECT sequence FROM agent_events WHERE run_id = ? AND event_id = ?"
  );
  const subscribers = new Map<string, Set<(event: AgentEvent) => void>>();
  const write = database.transaction((input: AgentEventDraft) => {
    const sequence = (nextSequence.get(input.runId) as { sequence: number }).sequence;
    const event = buildEvent(input, sequence, now);
    insert.run(event.eventId, event.runId, sequence, JSON.stringify(event), event.timestamp);
    publish(subscribers, event);
    return event;
  });
  return createSink({
    now,
    append: write,
    list(runId, afterCursor) {
      const after = cursorSequence(runId, afterCursor, (cursor) =>
        (sequenceForCursor.get(runId, cursor) as { sequence: number } | undefined)?.sequence
      );
      const rows = after === 0
        ? select.all(runId)
        : after === undefined ? [] : selectAfter.all(runId, after);
      return (rows as EventRow[]).map(fromRow);
    },
    subscribe(runId, listener) {
      const listeners = subscribers.get(runId) ?? new Set();
      listeners.add(listener);
      subscribers.set(runId, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) subscribers.delete(runId);
      };
    }
  });
}

export const createAgentEventTraceSink = createSqliteAgentEventTraceSink;

interface SinkParts {
  now: () => string;
  append(input: AgentEventDraft): AgentEvent;
  list(runId: string, afterCursor?: string): AgentEvent[];
  subscribe(runId: string, listener: (event: AgentEvent) => void): () => void;
}

function createSink(parts: SinkParts): AgentEventTraceSink {
  return {
    record(input) {
      const parsed = AgentEventDraftSchema.parse(input);
      assertEventSafe(parsed);
      return AgentEventSchema.parse(parts.append(parsed));
    },
    list(runId, afterCursor) {
      if (runId.length === 0) return [];
      return parts.list(runId, afterCursor).map((event) => AgentEventSchema.parse(event));
    },
    replay(runId, afterCursor) {
      const events = parts.list(runId, afterCursor).map((event) => AgentEventSchema.parse(event));
      return {
        events,
        ...(events.at(-1) === undefined ? {} : { nextCursor: events.at(-1)!.eventId })
      };
    },
    subscribe: parts.subscribe
  };
}

function buildEvent(input: AgentEventDraft, sequence: number, now: () => string): AgentEvent {
  return AgentEventSchema.parse({
    ...input,
    eventId: `event_${createHash("sha256").update(`${input.runId}:${sequence}`, "utf8").digest("hex")}`,
    timestamp: now()
  });
}

function fromRow(row: EventRow): AgentEvent {
  const parsed = AgentEventSchema.parse(JSON.parse(row.payload_json));
  if (parsed.eventId !== row.event_id || parsed.runId !== row.run_id || parsed.timestamp !== row.created_at) {
    throw new Error("agent_event_integrity_invalid");
  }
  return parsed;
}

function afterIndex(events: readonly AgentEvent[], cursor: string | undefined): AgentEvent[] {
  if (cursor === undefined) return [...events];
  const parsed = EventCursorSchema.safeParse(cursor);
  if (!parsed.success) return [];
  const index = events.findIndex((event) => event.eventId === parsed.data || event.eventId === cursor);
  if (/^\d+$/u.test(cursor)) return events.slice(Number(cursor));
  return index < 0 ? [] : events.slice(index + 1);
}

function cursorSequence(
  runId: string,
  cursor: string | undefined,
  resolveId: (cursor: string) => number | undefined
): number | undefined {
  if (cursor === undefined) return 0;
  if (!EventCursorSchema.safeParse(cursor).success) return undefined;
  if (/^\d+$/u.test(cursor)) return Number(cursor);
  return resolveId(cursor);
}

function publish(
  subscribers: Map<string, Set<(event: AgentEvent) => void>>,
  event: AgentEvent
): void {
  for (const listener of subscribers.get(event.runId) ?? []) {
    try {
      listener(event);
    } catch {
      // A live subscriber must not affect the authoritative append.
    }
  }
}

function assertEventSafe(input: AgentEventDraft): void {
  const values = [input.runId, input.payloadRef ?? ""];
  if (values.some((value) => sensitiveReferencePattern.test(value)
    || emailPattern.test(value) || phonePattern.test(value) || markupPattern.test(value))) {
    throw new Error("agent_event_pii_rejected");
  }
}
