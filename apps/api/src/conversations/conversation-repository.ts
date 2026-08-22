import { randomUUID } from "node:crypto";
import {
  ConversationContextSchema,
  ConversationMessageSchema,
  ConversationSessionSchema,
  type ConversationContext,
  type ConversationMessage,
  type ConversationSession
} from "@resume/contracts";
import type { SqliteDatabase } from "../db/client.js";

export interface ConversationRepository {
  createConversation(): ConversationSession;
  getConversation(id: string): ConversationSession | undefined;
  listMessages(id: string, afterSequence?: number): ConversationMessage[];
  appendMessage(input: {
    sessionId: string;
    message: ConversationMessage;
    expectedSequence: number;
  }): ConversationMessage;
  getContext(id: string): ConversationContext;
  updateContext(id: string, expectedVersion: number, next: ConversationContext): ConversationContext;
}

interface SessionRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  sequence: number;
  role: "user" | "assistant";
  text: string;
  cards_json: string;
  intent_json: string | null;
  created_at: string;
}

interface ContextRow {
  session_id: string;
  version: number;
  context_json: string;
  updated_at: string;
}

const DEFAULT_CONVERSATION_TITLE = "New conversation";

export function createConversationRepository(database: SqliteDatabase): ConversationRepository {
  const insertSession = database.prepare(`
    INSERT INTO conversation_sessions (id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  const insertContext = database.prepare(`
    INSERT INTO conversation_contexts (session_id, version, context_json, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  const findSession = database.prepare("SELECT * FROM conversation_sessions WHERE id = ?");
  const findMessages = database.prepare(`
    SELECT * FROM conversation_messages
    WHERE session_id = ? AND sequence > ?
    ORDER BY sequence ASC
  `);
  const findContext = database.prepare("SELECT * FROM conversation_contexts WHERE session_id = ?");
  const nextSequence = database.prepare(`
    SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
    FROM conversation_messages WHERE session_id = ?
  `);
  const insertMessage = database.prepare(`
    INSERT INTO conversation_messages
      (id, session_id, sequence, role, text, cards_json, intent_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const touchSession = database.prepare("UPDATE conversation_sessions SET updated_at = ? WHERE id = ?");
  const updateContextRow = database.prepare(`
    UPDATE conversation_contexts
    SET version = ?, context_json = ?, updated_at = ?
    WHERE session_id = ? AND version = ?
  `);

  const createTransaction = database.transaction((session: ConversationSession, context: ConversationContext) => {
    insertSession.run(session.id, session.title, session.createdAt, session.updatedAt);
    insertContext.run(session.id, context.version, JSON.stringify(context), session.updatedAt);
  });

  const appendTransaction = database.transaction((input: {
    sessionId: string;
    message: ConversationMessage;
    expectedSequence: number;
  }): ConversationMessage => {
    requireSession(findSession.get(input.sessionId) as SessionRow | undefined);
    if (!Number.isSafeInteger(input.expectedSequence) || input.expectedSequence < 0) {
      throw new Error("conversation_sequence_conflict");
    }

    const next = (nextSequence.get(input.sessionId) as { sequence: number }).sequence;
    if (next !== input.expectedSequence + 1) {
      throw new Error("conversation_sequence_conflict");
    }
    if (input.message.sessionId !== input.sessionId) {
      throw new Error("conversation_session_mismatch");
    }

    const message = ConversationMessageSchema.parse({
      ...input.message,
      sequence: next
    });
    insertMessage.run(
      message.id,
      message.sessionId,
      message.sequence,
      message.role,
      message.text,
      JSON.stringify(message.cards),
      message.intent === undefined ? null : JSON.stringify(message.intent),
      message.createdAt
    );
    touchSession.run(new Date().toISOString(), input.sessionId);
    return message;
  });

  const updateContextTransaction = database.transaction((
    id: string,
    expectedVersion: number,
    next: ConversationContext
  ): ConversationContext => {
    requireSession(findSession.get(id) as SessionRow | undefined);
    const row = findContext.get(id) as ContextRow | undefined;
    if (!row || row.version !== expectedVersion) {
      throw new Error("conversation_context_conflict");
    }
    const context = ConversationContextSchema.parse(next);
    if (context.version !== expectedVersion + 1) {
      throw new Error("conversation_context_version_invalid");
    }
    const updatedAt = new Date().toISOString();
    if (updateContextRow.run(
      context.version,
      JSON.stringify(context),
      updatedAt,
      id,
      expectedVersion
    ).changes !== 1) {
      throw new Error("conversation_context_conflict");
    }
    touchSession.run(updatedAt, id);
    return context;
  });

  return {
    createConversation() {
      const timestamp = new Date().toISOString();
      const session = ConversationSessionSchema.parse({
        id: randomUUID(),
        title: DEFAULT_CONVERSATION_TITLE,
        createdAt: timestamp,
        updatedAt: timestamp
      });
      const context = ConversationContextSchema.parse({ version: 0 });
      createTransaction(session, context);
      return session;
    },

    getConversation(id) {
      const row = findSession.get(id) as SessionRow | undefined;
      return row ? fromSessionRow(row) : undefined;
    },

    listMessages(id, afterSequence = 0) {
      requireSession(findSession.get(id) as SessionRow | undefined);
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        throw new Error("conversation_sequence_invalid");
      }
      return (findMessages.all(id, afterSequence) as MessageRow[]).map(fromMessageRow);
    },

    appendMessage(input) {
      return appendTransaction(input);
    },

    getContext(id) {
      requireSession(findSession.get(id) as SessionRow | undefined);
      const row = findContext.get(id) as ContextRow | undefined;
      if (!row) throw new Error("conversation_context_not_found");
      return fromContextRow(row);
    },

    updateContext(id, expectedVersion, next) {
      return updateContextTransaction(id, expectedVersion, next);
    }
  };
}

function fromSessionRow(row: SessionRow): ConversationSession {
  return ConversationSessionSchema.parse({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function fromMessageRow(row: MessageRow): ConversationMessage {
  const cards = parseJson(row.cards_json, "conversation_cards_corrupt");
  const intent = row.intent_json === null
    ? undefined
    : parseJson(row.intent_json, "conversation_intent_corrupt");
  return ConversationMessageSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    sequence: row.sequence,
    role: row.role,
    text: row.text,
    cards,
    ...(intent === undefined ? {} : { intent }),
    createdAt: row.created_at
  });
}

function fromContextRow(row: ContextRow): ConversationContext {
  const context = ConversationContextSchema.parse(parseJson(row.context_json, "conversation_context_corrupt"));
  if (context.version !== row.version) throw new Error("conversation_context_corrupt");
  return context;
}

function parseJson(value: string, errorCode: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(errorCode);
  }
}

function requireSession(row: SessionRow | undefined): SessionRow {
  if (!row) throw new Error("conversation_not_found");
  return row;
}
