import { randomUUID } from "node:crypto";
import {
  ConversationConfirmationSchema,
  ConversationContextSchema,
  ConversationMessageSchema,
  ConversationSessionSchema,
  ConversationTurnResponseSchema,
  type ConversationConfirmation,
  type ConversationContext,
  type ConversationMessage,
  type ConversationSession,
  type ConversationTurnResponse
} from "@resume/contracts";
import type { SqliteDatabase } from "../db/client.js";

export interface ConversationRepository {
  createConversation(): ConversationSession;
  getConversation(id: string): ConversationSession | undefined;
  linkJobMatchSession(conversationId: string, sessionId: string): void;
  getJobMatchSessionLink(sessionId: string): ConversationJobMatchSessionLink | undefined;
  findConversationByJobMatchSession(sessionId: string): ConversationSession | undefined;
  unlinkJobMatchSession(sessionId: string): void;
  listMessages(id: string, afterSequence?: number): ConversationMessage[];
  appendMessage(input: {
    sessionId: string;
    message: ConversationMessage;
    expectedSequence: number;
  }): ConversationMessage;
  getContext(id: string): ConversationContext;
  updateContext(id: string, expectedVersion: number, next: ConversationContext): ConversationContext;
  getTurn(conversationId: string, requestId: string): ConversationTurnRecord | undefined;
  appendTurn(input: {
    conversationId: string;
    requestId: string;
    inputText: string;
    userMessage: ConversationMessage;
    assistantMessage: ConversationMessage;
    expectedSequence: number;
    expectedContextVersion: number;
    context: ConversationContext;
    response: ConversationTurnResponse;
  }): ConversationTurnRecord;
  putConfirmation(conversationId: string, confirmation: ConversationConfirmation): void;
  peekConfirmation(conversationId: string, confirmationId: string): ConversationConfirmation | undefined;
  consumeConfirmation(conversationId: string, confirmationId: string): ConversationConfirmation | undefined;
}

export interface ConversationJobMatchSessionLink {
  conversationId: string;
  sessionId: string;
}

export interface ConversationTurnRecord {
  requestId: string;
  inputText: string;
  response: ConversationTurnResponse;
  createdAt: string;
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

interface TurnRow {
  conversation_id: string;
  request_id: string;
  input_text: string;
  response_json: string;
  created_at: string;
}

interface ConfirmationRow {
  confirmation_id: string;
  conversation_id: string;
  payload_json: string;
  status: "pending" | "consumed";
  created_at: string;
  consumed_at: string | null;
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
  const findJobMatchSession = database.prepare("SELECT id FROM job_match_sessions WHERE id = ?");
  const insertJobMatchSessionLink = database.prepare(`
    INSERT INTO conversation_job_match_sessions
      (conversation_id, job_match_session_id, created_at)
    VALUES (?, ?, ?)
  `);
  const findJobMatchSessionLink = database.prepare(`
    SELECT conversation_id, job_match_session_id
    FROM conversation_job_match_sessions
    WHERE job_match_session_id = ?
  `);
  const findConversationForJobMatchSession = database.prepare(`
    SELECT conversation_sessions.*
    FROM conversation_job_match_sessions
    INNER JOIN conversation_sessions
      ON conversation_sessions.id = conversation_job_match_sessions.conversation_id
    WHERE conversation_job_match_sessions.job_match_session_id = ?
  `);
  const deleteJobMatchSessionLink = database.prepare(`
    DELETE FROM conversation_job_match_sessions
    WHERE job_match_session_id = ?
  `);
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
  const findTurn = database.prepare(`
    SELECT * FROM conversation_turns
    WHERE conversation_id = ? AND request_id = ?
  `);
  const insertTurn = database.prepare(`
    INSERT INTO conversation_turns
      (conversation_id, request_id, input_text, response_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const findConfirmation = database.prepare(`
    SELECT * FROM conversation_confirmations
    WHERE confirmation_id = ?
  `);
  const insertConfirmation = database.prepare(`
    INSERT INTO conversation_confirmations
      (confirmation_id, conversation_id, payload_json, status, created_at, consumed_at)
    VALUES (?, ?, ?, 'pending', ?, NULL)
    ON CONFLICT(confirmation_id) DO NOTHING
  `);
  const consumeConfirmationRow = database.prepare(`
    UPDATE conversation_confirmations
    SET status = 'consumed', consumed_at = ?
    WHERE confirmation_id = ? AND conversation_id = ? AND status = 'pending'
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

  const appendTurnTransaction = database.transaction((input: {
    conversationId: string;
    requestId: string;
    inputText: string;
    userMessage: ConversationMessage;
    assistantMessage: ConversationMessage;
    expectedSequence: number;
    expectedContextVersion: number;
    context: ConversationContext;
    response: ConversationTurnResponse;
  }): ConversationTurnRecord => {
    requireSession(findSession.get(input.conversationId) as SessionRow | undefined);
    validateRequestId(input.requestId);
    const existing = findTurn.get(input.conversationId, input.requestId) as TurnRow | undefined;
    if (existing !== undefined) {
      if (existing.input_text !== input.inputText) throw new Error("conversation_idempotency_conflict");
      return fromTurnRow(existing);
    }
    if (!Number.isSafeInteger(input.expectedSequence) || input.expectedSequence < 0) {
      throw new Error("conversation_sequence_conflict");
    }
    const nextSequence = (nextSequenceStatement.get(input.conversationId) as { sequence: number }).sequence;
    if (nextSequence !== input.expectedSequence + 1) {
      throw new Error("conversation_sequence_conflict");
    }
    if (input.userMessage.sessionId !== input.conversationId
      || input.assistantMessage.sessionId !== input.conversationId
      || input.userMessage.role !== "user"
      || input.assistantMessage.role !== "assistant"
      || input.userMessage.sequence !== nextSequence
      || input.assistantMessage.sequence !== nextSequence + 1) {
      throw new Error("conversation_sequence_conflict");
    }
    const context = ConversationContextSchema.parse(input.context);
    const storedContext = findContext.get(input.conversationId) as ContextRow | undefined;
    if (storedContext === undefined || storedContext.version !== input.expectedContextVersion) {
      throw new Error("conversation_context_conflict");
    }
    if (context.version !== input.expectedContextVersion + 1) {
      throw new Error("conversation_context_version_invalid");
    }
    const response = ConversationTurnResponseSchema.parse(input.response);
    if (response.context.version !== context.version) throw new Error("conversation_context_conflict");
    if (response.message.id !== input.assistantMessage.id) throw new Error("conversation_message_mismatch");
    insertStoredMessage(input.userMessage);
    insertStoredMessage(input.assistantMessage);
    if (updateContextRow.run(
      context.version,
      JSON.stringify(context),
      new Date().toISOString(),
      input.conversationId,
      input.expectedContextVersion
    ).changes !== 1) {
      throw new Error("conversation_context_conflict");
    }
    touchSession.run(new Date().toISOString(), input.conversationId);
    insertTurn.run(input.conversationId, input.requestId, input.inputText, JSON.stringify(response), new Date().toISOString());
    return {
      requestId: input.requestId,
      inputText: input.inputText,
      response,
      createdAt: new Date().toISOString()
    };
  });

  const nextSequenceStatement = nextSequence;

  function insertStoredMessage(message: ConversationMessage): void {
    const parsed = ConversationMessageSchema.parse(message);
    insertMessage.run(
      parsed.id,
      parsed.sessionId,
      parsed.sequence,
      parsed.role,
      parsed.text,
      JSON.stringify(parsed.cards),
      parsed.intent === undefined ? null : JSON.stringify(parsed.intent),
      parsed.createdAt
    );
  }

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

    linkJobMatchSession(conversationId, sessionId) {
      validateLinkIdentifier(conversationId);
      validateLinkIdentifier(sessionId);
      requireSession(findSession.get(conversationId) as SessionRow | undefined);
      if (findJobMatchSession.get(sessionId) === undefined) {
        throw new Error("job_match_session_not_found");
      }
      try {
        insertJobMatchSessionLink.run(conversationId, sessionId, new Date().toISOString());
      } catch (error) {
        if (error instanceof Error && /UNIQUE constraint failed/u.test(error.message)) {
          throw new Error("conversation_job_match_link_conflict");
        }
        throw error;
      }
    },

    getJobMatchSessionLink(sessionId) {
      validateLinkIdentifier(sessionId);
      const row = findJobMatchSessionLink.get(sessionId) as {
        conversation_id: string;
        job_match_session_id: string;
      } | undefined;
      return row === undefined
        ? undefined
        : {
          conversationId: row.conversation_id,
          sessionId: row.job_match_session_id
        };
    },

    findConversationByJobMatchSession(sessionId) {
      validateLinkIdentifier(sessionId);
      const row = findConversationForJobMatchSession.get(sessionId) as SessionRow | undefined;
      return row === undefined ? undefined : fromSessionRow(row);
    },

    unlinkJobMatchSession(sessionId) {
      validateLinkIdentifier(sessionId);
      deleteJobMatchSessionLink.run(sessionId);
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
    },

    getTurn(conversationId, requestId) {
      requireSession(findSession.get(conversationId) as SessionRow | undefined);
      validateRequestId(requestId);
      const row = findTurn.get(conversationId, requestId) as TurnRow | undefined;
      return row === undefined ? undefined : fromTurnRow(row);
    },

    appendTurn(input) {
      return appendTurnTransaction(input);
    },

    putConfirmation(conversationId, confirmation) {
      requireSession(findSession.get(conversationId) as SessionRow | undefined);
      const parsed = ConversationConfirmationSchema.parse(confirmation);
      insertConfirmation.run(
        parsed.confirmationId,
        conversationId,
        JSON.stringify(parsed),
        new Date().toISOString()
      );
      const row = findConfirmation.get(parsed.confirmationId) as ConfirmationRow | undefined;
      if (row === undefined || row.conversation_id !== conversationId) {
        throw new Error("conversation_confirmation_conflict");
      }
      const existing = ConversationConfirmationSchema.parse(parseJson(row.payload_json, "conversation_confirmation_corrupt"));
      if (JSON.stringify(existing) !== JSON.stringify(parsed)) {
        throw new Error("conversation_confirmation_conflict");
      }
    },

    peekConfirmation(conversationId, confirmationId) {
      requireSession(findSession.get(conversationId) as SessionRow | undefined);
      const row = findConfirmation.get(confirmationId) as ConfirmationRow | undefined;
      if (row === undefined || row.conversation_id !== conversationId || row.status !== "pending") return undefined;
      return ConversationConfirmationSchema.parse(parseJson(row.payload_json, "conversation_confirmation_corrupt"));
    },

    consumeConfirmation(conversationId, confirmationId) {
      requireSession(findSession.get(conversationId) as SessionRow | undefined);
      const consumed = database.transaction(() => {
        const row = findConfirmation.get(confirmationId) as ConfirmationRow | undefined;
        if (row === undefined || row.conversation_id !== conversationId || row.status !== "pending") return undefined;
        const confirmation = ConversationConfirmationSchema.parse(parseJson(row.payload_json, "conversation_confirmation_corrupt"));
        if (consumeConfirmationRow.run(new Date().toISOString(), confirmationId, conversationId).changes !== 1) return undefined;
        return confirmation;
      })();
      return consumed;
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

function fromTurnRow(row: TurnRow): ConversationTurnRecord {
  return {
    requestId: row.request_id,
    inputText: row.input_text,
    response: ConversationTurnResponseSchema.parse(parseJson(row.response_json, "conversation_turn_corrupt")),
    createdAt: row.created_at
  };
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

function validateRequestId(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new Error("conversation_request_invalid");
  }
}

function validateLinkIdentifier(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new Error("conversation_job_match_link_invalid");
  }
}
