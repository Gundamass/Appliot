import type {
  ConversationConfirmation,
  ConversationMessage,
  ConversationSession,
  ConversationTurnResponse,
  ConversationView
} from "@resume/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConversationApi } from "./api.js";
import { ChatHome } from "./ChatHome.js";

const session: ConversationSession = {
  id: "conversation-1",
  title: "新的求职对话",
  createdAt: "2026-08-23T01:00:00.000Z",
  updatedAt: "2026-08-23T01:00:00.000Z"
};

function message(role: ConversationMessage["role"], text: string, sequence: number): ConversationMessage {
  return {
    id: `${role}-${sequence}`,
    sessionId: session.id,
    sequence,
    role,
    text,
    cards: [],
    createdAt: `2026-08-23T01:0${sequence}:00.000Z`
  };
}

function view(messages: ConversationMessage[] = [message("assistant", "可以开始岗位匹配", 1)]): ConversationView {
  return { session, messages, context: { version: 0, recentPostingIds: [] } };
}

function turn(text: string, pendingConfirmation?: ConversationConfirmation): ConversationTurnResponse {
  const cards = pendingConfirmation === undefined ? [] : [{
    type: "confirmation" as const,
    action: "start_application" as const,
    target: pendingConfirmation.target
  }];
  return {
    message: { ...message("assistant", text, 3), cards },
    cards,
    context: { version: 1, recentPostingIds: [] },
    ...(pendingConfirmation === undefined ? {} : { pendingConfirmation, confirmationId: pendingConfirmation.confirmationId })
  };
}

function fakeConversationApi(initialView = view()) {
  const api: ConversationApi = {
    create: vi.fn().mockResolvedValue(session),
    get: vi.fn().mockResolvedValue(initialView),
    send: vi.fn().mockResolvedValue(turn("收到")),
    confirm: vi.fn().mockResolvedValue(turn("投递任务已创建"))
  };
  return api;
}

describe("ChatHome", () => {
  it("renders history and sends a bounded message", async () => {
    const api = fakeConversationApi();
    const user = userEvent.setup();
    render(<ChatHome api={api} onOpenJobMatch={vi.fn()} onOpenApplication={vi.fn()} />);

    expect(await screen.findByText("可以开始岗位匹配")).toBeVisible();
    const composer = screen.getByRole("textbox", { name: "输入消息" });
    await user.type(composer, "我投了哪些岗位");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(api.send).toHaveBeenCalledWith(session.id, "我投了哪些岗位"));
    expect(screen.getByText("我投了哪些岗位")).toBeVisible();
  });

  it("asks for explicit approval before confirming a task creation", async () => {
    const confirmation: ConversationConfirmation = {
      confirmationId: "confirmation-1",
      action: "start_application",
      target: { kind: "recommendation", sessionId: "match-1", resultId: "result-1" }
    };
    const api = fakeConversationApi();
    vi.mocked(api.send).mockResolvedValue(turn("开始投递前请确认", confirmation));
    const user = userEvent.setup();
    render(<ChatHome api={api} onOpenJobMatch={vi.fn()} onOpenApplication={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: "输入消息" }), "投递第一份");
    await user.click(screen.getByRole("button", { name: "发送" }));
    const confirmButton = await screen.findByRole("button", { name: "确认进入投递" });
    await user.click(confirmButton);

    expect(api.confirm).toHaveBeenCalledWith(session.id, "confirmation-1", true);
  });

  it("offers quick starts for company recommendations and application progress", async () => {
    const api = fakeConversationApi();
    const user = userEvent.setup();
    render(<ChatHome api={api} onOpenJobMatch={vi.fn()} onOpenApplication={vi.fn()} />);

    await screen.findByText("快速开始");
    await user.click(screen.getByRole("button", { name: /岗位推荐/ }));
    expect(screen.getByPlaceholderText("例如：大疆")).toBeVisible();
    await user.type(screen.getByPlaceholderText("例如：大疆"), "大疆");
    await user.click(screen.getByRole("button", { name: "搜索岗位" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(session.id, "我想投递大疆"));

    await user.click(within(screen.getByLabelText("快速开始")).getByRole("button", { name: /投递进度/ }));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(session.id, "我投了哪些岗位？对应的网站有哪些？"));
  });

  it("shows remaining characters and keeps send disabled for blank input", async () => {
    const api = fakeConversationApi();
    const user = userEvent.setup();
    render(<ChatHome api={api} onOpenJobMatch={vi.fn()} onOpenApplication={vi.fn()} />);
    const composer = screen.getByRole("textbox", { name: "输入消息" });

    expect(screen.getByText("500 字剩余")).toBeVisible();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    await user.type(composer, "岗位");
    expect(screen.getByText("498 字剩余")).toBeVisible();
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });
});
