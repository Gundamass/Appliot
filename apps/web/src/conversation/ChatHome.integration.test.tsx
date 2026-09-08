import type {
  ConversationCard,
  ConversationMessage,
  ConversationSession,
  ConversationTurnResponse,
  ConversationView
} from "@resume/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConversationApiError, type ConversationApi } from "./api.js";
import { ChatHome } from "./ChatHome.js";

const session: ConversationSession = {
  id: "conversation-integration",
  title: "求职对话",
  createdAt: "2026-08-23T01:00:00.000Z",
  updatedAt: "2026-08-23T01:00:00.000Z"
};

function message(cards: ConversationCard[]): ConversationMessage {
  return {
    id: "assistant-1",
    sessionId: session.id,
    sequence: 1,
    role: "assistant",
    text: "这是当前结果",
    cards,
    createdAt: "2026-08-23T01:01:00.000Z"
  };
}

function view(cards: ConversationCard[]): ConversationView {
  return {
    session,
    messages: [message(cards)],
    context: { version: 0, recentPostingIds: [] }
  };
}

function response(text: string): ConversationTurnResponse {
  return {
    message: { ...message([]), id: "assistant-2", sequence: 2, text },
    cards: [],
    context: { version: 1, recentPostingIds: [] }
  };
}

function api(initialView: ConversationView, send: ConversationApi["send"] = vi.fn(async () => response("收到"))): ConversationApi {
  return {
    list: vi.fn().mockResolvedValue([session]),
    create: vi.fn(async () => session),
    get: vi.fn(async () => initialView),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteAll: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    send,
    confirm: vi.fn(async () => response("收到"))
  };
}

describe("ChatHome integration", () => {
  it("keeps recommendation cards inline and navigates application task cards to their deep links", async () => {
    const recommendation: ConversationCard = {
      type: "recommendation",
      sessionId: "match-1",
      resultId: "result-1",
      title: "Frontend Engineer",
      company: "Example Labs",
      score: 90,
      evidenceCount: 2,
      postingContentHash: "hash-1"
    };
    const application: ConversationCard = {
      type: "application_task",
      taskId: "task-1",
      title: "Frontend Engineer",
      state: "observing",
      applicationUrl: "https://jobs.example.test/apply/frontend"
    };
    const onOpenApplication = vi.fn();
    const user = userEvent.setup();
    render(<ChatHome api={api(view([recommendation, application]))} onOpenApplication={onOpenApplication} />);

    expect((await screen.findAllByText("Frontend Engineer")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /查看匹配依据/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /打开投递任务/ }));

    expect(onOpenApplication).toHaveBeenCalledWith("task-1");
  });

  it("maps a server error to a bounded recovery message instead of exposing the raw model error", async () => {
    const send = vi.fn(async () => {
      throw new ConversationApiError("raw_model_error: private prompt", "policy_rejected", 409);
    });
    const user = userEvent.setup();
    render(<ChatHome api={api(view([]), send)} onOpenApplication={vi.fn()} />);

    await user.type(await screen.findByRole("textbox", { name: "输入消息" }), "投递第一份");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("提交已锁定"));
    expect(screen.getByRole("alert")).not.toHaveTextContent("raw_model_error");
    expect(screen.getByRole("alert")).not.toHaveTextContent("private prompt");
  });
});
