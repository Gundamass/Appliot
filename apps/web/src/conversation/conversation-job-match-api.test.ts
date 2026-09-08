import {
  ConversationJobMatchActionResultSchema,
  ConversationMessageSchema,
  type ConversationJobMatchAction
} from "@resume/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationJobMatchApiError, createConversationJobMatchApi } from "./conversation-job-match-api.js";

afterEach(() => vi.unstubAllGlobals());

const validSelectAction: ConversationJobMatchAction = {
  conversationId: "conversation-1",
  sessionId: "session-1",
  action: "select_result",
  sessionVersion: 3,
  idempotencyKey: "select-1",
  resultId: "result-1",
  resultVersion: 1,
  postingContentHash: "sha256:posting"
};

const actionResult = ConversationJobMatchActionResultSchema.parse({
  sessionId: "session-1",
  state: "selected",
  version: 4,
  turnSequence: 3,
  message: ConversationMessageSchema.parse({
    id: "message-4",
    sessionId: "conversation-1",
    sequence: 4,
    role: "assistant",
    text: "已选择岗位。",
    cards: [],
    createdAt: "2026-09-02T00:00:00.000Z"
  }),
  cards: [],
  context: { version: 2, recentPostingIds: [], activeJobMatchSessionId: "session-1" }
});

describe("ConversationJobMatchApi", () => {
  it("posts a typed action and returns the guarded action result", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(actionResult), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const api = createConversationJobMatchApi("http://api.test");
    await expect(api.execute(validSelectAction)).resolves.toEqual(actionResult);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/api/conversations/conversation-1/job-match-actions",
      expect.objectContaining({ method: "POST" })
    );
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual(validSelectAction);
  });

  it("does not rebuild IDs from labels after a version conflict", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: "Job match operation conflicts with current state",
      code: "job_match_version_conflict"
    }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);

    const api = createConversationJobMatchApi();
    await expect(api.execute(validSelectAction)).rejects.toMatchObject({
      name: "ConversationJobMatchApiError",
      code: "job_match_version_conflict"
    } satisfies Partial<ConversationJobMatchApiError>);
    expect(JSON.stringify(fetchMock.mock.calls[0]?.[1])).toContain("result-1");
    expect(JSON.stringify(fetchMock.mock.calls[0]?.[1])).not.toContain("岗位标题");
  });
});
