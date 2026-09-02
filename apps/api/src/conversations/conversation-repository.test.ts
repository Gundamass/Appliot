import { mkdtemp } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ConversationConfirmationSchema } from "@resume/contracts";
import { migrateDatabase } from "../db/migrate.js";
import { createConversationRepository } from "./conversation-repository.js";

function userMessage(sessionId: string, text: string, sequence = 1) {
  return {
    id: `message-${sequence}`,
    sessionId,
    sequence,
    role: "user" as const,
    text,
    cards: [],
    createdAt: "2026-08-22T00:00:00.000Z"
  };
}

function insertJobMatchSession(database: Database.Database, id: string): void {
  database.prepare(`
    INSERT INTO job_match_sessions
      (id, state, initial_url, profile_revision, expectation_revision, created_at, updated_at)
    VALUES (?, 'created', 'https://jobs.example.test/list', 0, 0, ?, ?)
  `).run(id, "2026-08-22T00:00:00.000Z", "2026-08-22T00:00:00.000Z");
}

describe("conversation repository", () => {
  it("links each job-match session to one conversation and cascades only the link", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createConversationRepository(database);
    const firstConversation = repository.createConversation();
    const secondConversation = repository.createConversation();
    insertJobMatchSession(database, "match-1");
    insertJobMatchSession(database, "match-2");

    repository.linkJobMatchSession(firstConversation.id, "match-1");
    expect(repository.getJobMatchSessionLink("match-1")).toEqual({
      conversationId: firstConversation.id,
      sessionId: "match-1"
    });
    expect(repository.findConversationByJobMatchSession("match-1")?.id).toBe(firstConversation.id);
    expect(() => repository.linkJobMatchSession(secondConversation.id, "match-1"))
      .toThrow("conversation_job_match_link_conflict");

    database.prepare("DELETE FROM job_match_sessions WHERE id = ?").run("match-1");
    expect(repository.getJobMatchSessionLink("match-1")).toBeUndefined();
    expect(repository.getConversation(firstConversation.id)).toBeDefined();

    repository.linkJobMatchSession(secondConversation.id, "match-2");
    database.prepare("DELETE FROM conversation_sessions WHERE id = ?").run(secondConversation.id);
    expect(repository.getJobMatchSessionLink("match-2")).toBeUndefined();
    expect(database.prepare("SELECT id FROM job_match_sessions WHERE id = ?").get("match-2"))
      .toEqual({ id: "match-2" });
    database.close();
  });

  it("rejects empty link identifiers and can explicitly unlink a session", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createConversationRepository(database);
    const conversation = repository.createConversation();
    insertJobMatchSession(database, "match-1");

    expect(() => repository.linkJobMatchSession("", "match-1")).toThrow("conversation_job_match_link_invalid");
    expect(() => repository.linkJobMatchSession(conversation.id, "")).toThrow("conversation_job_match_link_invalid");
    repository.linkJobMatchSession(conversation.id, "match-1");
    repository.unlinkJobMatchSession("match-1");
    expect(repository.findConversationByJobMatchSession("match-1")).toBeUndefined();
    database.close();
  });

  it("appends messages in sequence and rejects stale writers", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createConversationRepository(database);
    const session = repository.createConversation();

    repository.appendMessage({
      sessionId: session.id,
      expectedSequence: 0,
      message: userMessage(session.id, "first")
    });

    expect(() => repository.appendMessage({
      sessionId: session.id,
      expectedSequence: 0,
      message: userMessage(session.id, "stale write")
    })).toThrow("conversation_sequence_conflict");
    expect(repository.listMessages(session.id)).toHaveLength(1);
    expect(repository.listMessages(session.id, 1)).toEqual([]);
    database.close();
  });

  it("updates structured context with optimistic versioning", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createConversationRepository(database);
    const session = repository.createConversation();

    const context = repository.updateContext(session.id, 0, {
      version: 1,
      recentPostingIds: ["posting-1"]
    });

    expect(context.recentPostingIds).toEqual(["posting-1"]);
    expect(context.version).toBe(1);
    expect(() => repository.updateContext(session.id, 0, context))
      .toThrow("conversation_context_conflict");
    database.close();
  });

  it("restores messages and context after reopening the same SQLite file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "resume-conversation-"));
    const filename = join(directory, "conversation.sqlite");
    const openDatabases: Array<{ close(): void }> = [];
    try {
      const firstDatabase = new Database(filename);
      openDatabases.push(firstDatabase);
      migrateDatabase(firstDatabase);
      const firstRepository = createConversationRepository(firstDatabase);
      const session = firstRepository.createConversation();
      firstRepository.appendMessage({
        sessionId: session.id,
        expectedSequence: 0,
        message: userMessage(session.id, "persisted")
      });
      firstRepository.updateContext(session.id, 0, {
        version: 1,
        activeJobMatchSessionId: "match-1",
        recentPostingIds: ["posting-1"]
      });
      firstDatabase.close();

      const reopenedDatabase = new Database(filename);
      openDatabases.push(reopenedDatabase);
      migrateDatabase(reopenedDatabase);
      const reopenedRepository = createConversationRepository(reopenedDatabase);
      expect(reopenedRepository.getConversation(session.id)).toMatchObject({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt
      });
      expect(reopenedRepository.listMessages(session.id)[0]?.text).toBe("persisted");
      expect(reopenedRepository.getContext(session.id)).toMatchObject({
        version: 1,
        activeJobMatchSessionId: "match-1"
      });
      const next = reopenedRepository.appendMessage({
        sessionId: session.id,
        expectedSequence: 1,
        message: userMessage(session.id, "continued", 2)
      });
      expect(next.sequence).toBe(2);
      reopenedDatabase.close();
    } finally {
      for (const database of openDatabases) {
        try {
          database.close();
        } catch {
          // The database may already be closed by the assertions above.
        }
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("rejects messages and contexts from unknown sessions", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createConversationRepository(database);

    expect(() => repository.appendMessage({
      sessionId: "missing-session",
      expectedSequence: 0,
      message: userMessage("missing-session", "orphan")
    })).toThrow("conversation_not_found");
    expect(() => repository.getContext("missing-session")).toThrow("conversation_not_found");
    database.close();
  });

  it("persists confirmation tokens and consumes each token once", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createConversationRepository(database);
    const session = repository.createConversation();
    const confirmation = ConversationConfirmationSchema.parse({
      confirmationId: "confirmation-1",
      action: "start_application",
      target: {
        kind: "recommendation",
        sessionId: "match-1",
        resultId: "result-1",
        postingContentHash: "hash-1"
      }
    });

    repository.putConfirmation(session.id, confirmation);
    expect(repository.peekConfirmation(session.id, confirmation.confirmationId)).toEqual(confirmation);
    expect(repository.consumeConfirmation(session.id, confirmation.confirmationId)).toEqual(confirmation);
    expect(repository.consumeConfirmation(session.id, confirmation.confirmationId)).toBeUndefined();
    database.close();
  });
});
