import { mkdtemp } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
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

describe("conversation repository", () => {
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
});
