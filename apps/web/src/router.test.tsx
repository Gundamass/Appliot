import type { ApplicationTask } from "@resume/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRouter } from "./router.js";
import type { ConversationApi } from "./conversation/api.js";

const task: ApplicationTask = {
  id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  applicationUrl: "https://career.example.com/jobs/42",
  state: "waiting_for_login",
  commands: ["cancel", "open_browser", "resume"],
  recoveryCommands: [],
  questions: [],
  taskAnswers: [],
  executionProgress: {
    currentPhase: "waiting_for_form",
    phases: [
      { phase: "waiting_for_form", status: "running" },
      { phase: "deterministic_fill", status: "pending" },
      { phase: "semantic_fill", status: "pending" },
      { phase: "readback_validation", status: "pending" },
      { phase: "final_review", status: "pending" }
    ],
    current: { action: "请在受控浏览器中完成登录", maxAttempts: 2 },
    counts: { exact: 0, semantic: 0, user: 0, missing: 0, failed: 0 }
  }
};

class SilentEventSource extends EventTarget {
  close() {}
}

const recentConversationStorageKey = "resume-application-assistant.recent-conversation-id";

function conversationApi(): ConversationApi {
  const session = { id: "conversation-router", title: "新的求职对话", createdAt: "2026-08-23T01:00:00.000Z", updatedAt: "2026-08-23T01:00:00.000Z" };
  return {
    create: vi.fn().mockResolvedValue(session),
    get: vi.fn(async (id: string) => ({ session: { ...session, id }, messages: [], context: { version: 0, recentPostingIds: [] } })),
    send: vi.fn(),
    confirm: vi.fn()
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.removeItem(recentConversationStorageKey);
  window.history.pushState({}, "", "/");
});

describe("AppRouter", () => {
  it("injects the conversation API into the default chat workspace", async () => {
    const api = conversationApi();
    render(<AppRouter conversationApi={api} applicationApi={{ list: vi.fn(), create: vi.fn(), get: vi.fn(), command: vi.fn(), recover: vi.fn() }} />);

    expect(await screen.findByRole("heading", { name: "和助手聊聊你的求职计划" })).toBeVisible();
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("maps the legacy job workspace query to chat", async () => {
    window.history.pushState({}, "", "/?view=apply");
    const api = conversationApi();
    render(<AppRouter conversationApi={api} applicationApi={{ list: vi.fn(), create: vi.fn(), get: vi.fn(), command: vi.fn(), recover: vi.fn() }} />);

    expect(await screen.findByRole("heading", { name: "和助手聊聊你的求职计划" })).toBeVisible();
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { name: "我的岗位" })).not.toBeInTheDocument();
  });

  it("redirects a legacy job matching session route to its owning conversation", async () => {
    window.history.pushState({}, "", "/job-match-sessions/session-1");
    const jobMatchApi = {
      findOwningConversation: vi.fn().mockResolvedValue({ conversationId: "conversation-owner" })
    };
    const conversation = conversationApi();
    render(<AppRouter conversationApi={conversation} applicationApi={{ list: vi.fn(), create: vi.fn(), get: vi.fn(), command: vi.fn(), recover: vi.fn() }} jobMatchApi={jobMatchApi as never} />);
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(new URL(window.location.href).searchParams.get("conversation")).toBe("conversation-owner");
    expect(jobMatchApi.findOwningConversation).toHaveBeenCalledWith("session-1");
    expect(screen.queryByText("岗位匹配工作台")).not.toBeInTheDocument();
  });

  it("renders the create route and a deep task route", async () => {
    vi.stubGlobal("EventSource", SilentEventSource);
    const api = { list: vi.fn().mockResolvedValue([]), create: vi.fn(), get: vi.fn().mockResolvedValue(task), command: vi.fn(), recover: vi.fn() };
    window.history.pushState({}, "", "/applications/new");
    const view = render(<AppRouter applicationApi={api} />);
    expect(await screen.findByRole("heading", { name: "和助手聊聊你的求职计划" })).toBeVisible();
    expect(window.location.pathname).toBe("/");

    view.unmount();
    window.history.pushState({}, "", `/applications/${task.id}`);
    render(<AppRouter applicationApi={api} />);
    expect(await screen.findByRole("heading", { name: "请在受控浏览器中完成登录" })).toBeVisible();
    const navigation = screen.getByRole("navigation", { name: "候选人工作台" });
    expect(within(navigation).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual([
      "对话首页",
      "投递进度",
      "我的简历"
    ]);
    expect(screen.queryByRole("navigation", { name: "主导航" })).not.toBeInTheDocument();
  });

  it("returns unknown routes to the profile workspace", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));
    window.history.pushState({}, "", "/missing");

    render(<AppRouter applicationApi={{ list: vi.fn().mockResolvedValue([]), create: vi.fn(), get: vi.fn(), command: vi.fn(), recover: vi.fn() }} />);

    expect(await screen.findByRole("heading", { name: "和助手聊聊你的求职计划" })).toBeVisible();
    expect(window.location.pathname).toBe("/");
  });
});
