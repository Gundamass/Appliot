import type { ApplicationTask } from "@resume/contracts";
import { render, screen, within } from "@testing-library/react";
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

function conversationApi(): ConversationApi {
  const session = { id: "conversation-router", title: "新的求职对话", createdAt: "2026-08-23T01:00:00.000Z", updatedAt: "2026-08-23T01:00:00.000Z" };
  return {
    create: vi.fn().mockResolvedValue(session),
    get: vi.fn().mockResolvedValue({ session, messages: [], context: { version: 0, recentPostingIds: [] } }),
    send: vi.fn(),
    confirm: vi.fn()
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

describe("AppRouter", () => {
  it("injects the conversation API into the default chat workspace", async () => {
    const api = conversationApi();
    render(<AppRouter conversationApi={api} applicationApi={{ list: vi.fn(), create: vi.fn(), get: vi.fn(), command: vi.fn(), recover: vi.fn() }} />);

    expect(await screen.findByRole("heading", { name: "和助手聊聊你的求职计划" })).toBeVisible();
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("injects the job matching API into the root workspace", async () => {
    window.history.pushState({}, "", "/?view=apply");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.endsWith("/api/profile/facts") ? [{
        id: "role",
        fieldPath: "preferences.targetRole",
        value: "Java",
        status: "user_confirmed",
        confidence: 1,
        scope: "profile",
        evidence: [{ documentId: "fixture", page: 1, text: "Java", extraction: "user" }],
        revision: 1
      }] : { completed: 0, total: 1, sections: [] };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }));
    const create = vi.fn().mockResolvedValue({
      redirect: "application",
      applicationUrl: "https://acme.mokahr.com/apply"
    });
    const applicationApi = {
      list: vi.fn().mockResolvedValue([]), create: vi.fn(), get: vi.fn(), command: vi.fn(), recover: vi.fn()
    };
    const user = userEvent.setup();
    render(<AppRouter applicationApi={applicationApi} jobMatchApi={{ create } as never} />);

    await screen.findByDisplayValue("Java");
    await user.type(screen.getByLabelText("招聘链接"), "https://acme.mokahr.com/jobs");
    await user.click(screen.getByRole("button", { name: "确认岗位期望并开始匹配" }));

    expect(create).toHaveBeenCalledWith("https://acme.mokahr.com/jobs");
  });

  it("renders a job matching session route", async () => {
    window.history.pushState({}, "", "/job-match-sessions/session-1");
    const expectation = {
      revision: 2,
      confirmedAt: "2026-08-16T00:00:00.000Z",
      criteria: [{ kind: "location", values: ["深圳"], strength: "required" }]
    } as const;
    const jobMatchApi = {
      get: vi.fn().mockResolvedValue({
        id: "session-1",
        version: 0,
        state: "awaiting_filter_confirmation",
        expectation,
        postings: [],
        results: []
      }),
      confirmFilters: vi.fn().mockResolvedValue(undefined)
    };
    render(<AppRouter applicationApi={{ list: vi.fn(), create: vi.fn(), get: vi.fn(), command: vi.fn(), recover: vi.fn() }} jobMatchApi={jobMatchApi as never} />);
    expect(await screen.findByText("岗位匹配工作台")).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: /确认筛选/u }));
    expect(jobMatchApi.confirmFilters).toHaveBeenCalledWith(
      "session-1",
      expectation,
      expect.objectContaining({ sessionVersion: 0, idempotencyKey: expect.any(String) })
    );
  });

  it("renders the create route and a deep task route", async () => {
    vi.stubGlobal("EventSource", SilentEventSource);
    const api = { list: vi.fn().mockResolvedValue([]), create: vi.fn(), get: vi.fn().mockResolvedValue(task), command: vi.fn(), recover: vi.fn() };
    window.history.pushState({}, "", "/applications/new");
    const view = render(<AppRouter applicationApi={api} />);
    expect(screen.getByRole("heading", { name: "我的岗位" })).toBeVisible();

    view.unmount();
    window.history.pushState({}, "", `/applications/${task.id}`);
    render(<AppRouter applicationApi={api} />);
    expect(await screen.findByRole("heading", { name: "请在受控浏览器中完成登录" })).toBeVisible();
    const navigation = screen.getByRole("navigation", { name: "候选人工作台" });
    expect(within(navigation).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual([
      "对话首页",
      "我的岗位",
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
