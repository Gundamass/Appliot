import { mkdtemp } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ConversationConfirmationSchema } from "@resume/contracts";
import { createApplicationTaskRepository } from "../applications/application-task-repository.js";
import { migrateDatabase } from "../db/migrate.js";
import { createProfileRepository } from "../profile/profile-repository.js";
import { createGraphApplicationReviewRepository } from "../applications/graph-application-review-repository.js";
import { createConversationProcessEventBus } from "./conversation-events.js";
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
  it("creates new conversations with a stable title and lists newest sessions first", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createConversationRepository(database);
    const oldest = repository.createConversation();
    const newest = repository.createConversation();
    database.prepare("UPDATE conversation_sessions SET updated_at = ? WHERE id = ?")
      .run("2026-09-02T00:01:00.000Z", newest.id);
    database.prepare("UPDATE conversation_sessions SET updated_at = ? WHERE id = ?")
      .run("2026-09-02T00:00:00.000Z", oldest.id);

    expect(newest.title).toBe("新会话");
    expect(repository.listConversations().map(({ id }) => id)).toEqual([newest.id, oldest.id]);
    database.close();
  });

  it("sets the first-message title atomically and keeps it across idempotent turns", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createConversationRepository(database);
    const session = repository.createConversation();

    repository.appendTurn(turnInput(session.id, {
      requestId: "request-1",
      inputText: "帮我 投递百度校园招聘",
      userText: "  帮我   投递百度校园招聘  "
    }));
    const titled = repository.getConversation(session.id);
    expect(titled?.title).toBe("帮我 投递百度校园招聘");

    expect(repository.appendTurn(turnInput(session.id, {
      requestId: "request-1",
      inputText: "帮我 投递百度校园招聘",
      userText: "  帮我   投递百度校园招聘  "
    }))).toMatchObject({ requestId: "request-1" });

    repository.appendTurn(turnInput(session.id, {
      requestId: "request-2",
      expectedSequence: 2,
      expectedContextVersion: 1,
      inputText: "继续",
      userText: "继续",
      assistantText: "好的"
    }));
    expect(repository.getConversation(session.id)?.title).toBe("帮我 投递百度校园招聘");
    database.close();
  });

  it("deletes conversation-owned data while retaining job matches, tasks, reviews, and profile facts", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createConversationRepository(database);
    const conversation = repository.createConversation();
    insertJobMatchSession(database, "match-retained");
    repository.linkJobMatchSession(conversation.id, "match-retained");
    repository.appendMessage({
      sessionId: conversation.id,
      expectedSequence: 0,
      message: userMessage(conversation.id, "需要删除的消息")
    });
    createConversationProcessEventBus(database).emit({
      conversationId: conversation.id,
      turnSequence: 1,
      stepId: "delete-test",
      stage: "completed",
      status: "completed",
      summary: "删除测试事件"
    });
    createApplicationTaskRepository(database).create({
      id: "task-retained",
      applicationUrl: "https://jobs.example.test/apply"
    });
    createGraphApplicationReviewRepository(database).save({
      id: "review-retained",
      interruptId: "interrupt-retained",
      taskId: "task-retained",
      fieldId: "self-evaluation",
      fieldLabel: "自我评价",
      original: "原始内容",
      draft: "待审核内容",
      reasons: ["投递前需要人工审核"],
      evidence: [{ documentId: "resume-1", page: 1, text: "原始内容", extraction: "pdf_text" }],
      unsupportedClaims: [],
      status: "needs_review"
    });
    createProfileRepository(database).upsertUserFact({
      fieldPath: "basics.name",
      value: "候选人"
    });

    expect(repository.deleteConversation("missing")).toBe(false);
    expect(repository.deleteConversation(conversation.id)).toBe(true);
    expect(repository.getConversation(conversation.id)).toBeUndefined();
    expect(database.prepare("SELECT * FROM conversation_messages WHERE session_id = ?").all(conversation.id)).toEqual([]);
    expect(database.prepare("SELECT * FROM conversation_process_events WHERE conversation_id = ?").all(conversation.id)).toEqual([]);
    expect(database.prepare("SELECT * FROM conversation_job_match_sessions WHERE conversation_id = ?").all(conversation.id)).toEqual([]);
    expect(database.prepare("SELECT id FROM job_match_sessions WHERE id = ?").get("match-retained"))
      .toEqual({ id: "match-retained" });
    expect(database.prepare("SELECT id FROM application_tasks WHERE id = ?").get("task-retained"))
      .toEqual({ id: "task-retained" });
    expect(database.prepare("SELECT id FROM agent_application_reviews WHERE id = ?").get("review-retained"))
      .toEqual({ id: "review-retained" });
    expect(database.prepare("SELECT field_path FROM profile_facts WHERE field_path = ?").get("basics.name"))
      .toEqual({ field_path: "basics.name" });
    database.close();
  });

  it("clears all conversations and reports the number removed", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createConversationRepository(database);
    repository.createConversation();
    repository.createConversation();

    expect(repository.deleteAllConversations()).toBe(2);
    expect(repository.listConversations()).toEqual([]);
    expect(repository.deleteAllConversations()).toBe(0);
    database.close();
  });

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

function turnInput(
  conversationId: string,
  overrides: Partial<{
    requestId: string;
    inputText: string;
    userText: string;
    assistantText: string;
    expectedSequence: number;
    expectedContextVersion: number;
  }> = {}
) {
  const expectedSequence = overrides.expectedSequence ?? 0;
  const expectedContextVersion = overrides.expectedContextVersion ?? 0;
  const userText = overrides.userText ?? "第一条消息";
  const assistantText = overrides.assistantText ?? "已处理";
  const assistantMessage = {
    id: `assistant-${expectedSequence + 2}`,
    sessionId: conversationId,
    sequence: expectedSequence + 2,
    role: "assistant" as const,
    text: assistantText,
    cards: [],
    createdAt: "2026-08-22T00:00:00.000Z"
  };
  const context = {
    version: expectedContextVersion + 1,
    recentPostingIds: []
  };
  return {
    conversationId,
    requestId: overrides.requestId ?? `request-${expectedSequence + 1}`,
    inputText: overrides.inputText ?? userText,
    userMessage: {
      id: `user-${expectedSequence + 1}`,
      sessionId: conversationId,
      sequence: expectedSequence + 1,
      role: "user" as const,
      text: userText,
      cards: [],
      createdAt: "2026-08-22T00:00:00.000Z"
    },
    assistantMessage,
    expectedSequence,
    expectedContextVersion,
    context,
    response: {
      message: assistantMessage,
      cards: [],
      context
    }
  };
}
