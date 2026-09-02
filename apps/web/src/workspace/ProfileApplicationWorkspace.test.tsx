import { BrowserRouter } from "react-router-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationTask } from "@resume/contracts";
import type { ConversationApi } from "../conversation/api.js";
import type { ProfileApi } from "../api/client.js";
import { ProfileApplicationWorkspace } from "./ProfileApplicationWorkspace.js";

function profileApi(): ProfileApi {
  return {
    upload: vi.fn(),
    listFacts: vi.fn().mockResolvedValue([]),
    upsert: vi.fn(),
    getCompleteness: vi.fn().mockResolvedValue({ completed: 0, total: 1, sections: [] }),
    confirm: vi.fn(),
    correct: vi.fn()
  } as unknown as ProfileApi;
}

const applicationApi = {
  list: vi.fn().mockResolvedValue([]),
  create: vi.fn(),
  get: vi.fn(),
  command: vi.fn(),
  delete: vi.fn(),
  recover: vi.fn()
};
const jobMatchApi = { create: vi.fn() };
const recentConversationStorageKey = "resume-application-assistant.recent-conversation-id";

function conversationApi(): ConversationApi {
  const session = { id: "conversation-1", title: "新的求职对话", createdAt: "2026-08-23T01:00:00.000Z", updatedAt: "2026-08-23T01:00:00.000Z" };
  return {
    list: vi.fn().mockResolvedValue([session]),
    create: vi.fn().mockResolvedValue(session),
    get: vi.fn(async (id: string) => ({ session: { ...session, id }, messages: [], context: { version: 0, recentPostingIds: [] } })),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteAll: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    send: vi.fn(),
    confirm: vi.fn()
  };
}

function reviewTask(state: ApplicationTask["state"], suffix: string, commands: ApplicationTask["commands"]): ApplicationTask {
  return {
    id: `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`,
    applicationUrl: `https://career.example.com/jobs/${suffix}`,
    state,
    commands,
    recoveryCommands: [],
    questions: [],
    taskAnswers: []
  };
}

afterEach(() => {
  window.history.pushState({}, "", "/");
  window.localStorage.removeItem(recentConversationStorageKey);
  vi.restoreAllMocks();
  applicationApi.list.mockResolvedValue([]);
});

describe("ProfileApplicationWorkspace", () => {
  it("restores the locally remembered conversation and canonicalizes its URL", async () => {
    window.localStorage.setItem(recentConversationStorageKey, "conversation-1");
    const api = conversationApi();
    render(<BrowserRouter><ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={applicationApi} jobMatchApi={jobMatchApi as never} conversationApi={api} /></BrowserRouter>);

    await waitFor(() => expect(api.get).toHaveBeenCalledWith("conversation-1"));
    expect(api.create).not.toHaveBeenCalled();
    expect(new URLSearchParams(window.location.search).get("conversation")).toBe("conversation-1");
  });

  it("prefers a conversation supplied in the URL over the locally remembered one", async () => {
    window.localStorage.setItem(recentConversationStorageKey, "conversation-from-storage");
    window.history.pushState({}, "", "/?conversation=conversation-from-url");
    const api = conversationApi();
    render(<BrowserRouter><ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={applicationApi} jobMatchApi={jobMatchApi as never} conversationApi={api} /></BrowserRouter>);

    await waitFor(() => expect(api.get).toHaveBeenCalledWith("conversation-from-url"));
    expect(api.create).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(recentConversationStorageKey)).toBe("conversation-from-url");
  });

  it("opens chat by default and keeps domain workbenches accessible", async () => {
    render(
      <BrowserRouter>
        <ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={applicationApi} jobMatchApi={jobMatchApi as never} conversationApi={conversationApi()} />
      </BrowserRouter>
    );

    expect(await screen.findByRole("heading", { name: "和助手聊聊你的求职计划" })).toBeVisible();
    const navigation = screen.getByRole("navigation", { name: "候选人工作台" });
    expect(within(navigation).getByRole("button", { name: "对话首页" })).toBeVisible();
    expect(within(navigation).getByRole("button", { name: "投递进度" })).toBeVisible();
    expect(within(navigation).getByRole("button", { name: "我的简历" })).toBeVisible();
    expect(within(navigation).queryByRole("button", { name: "我的岗位" })).not.toBeInTheDocument();
  });

  it("opens the profile view and returns to chat from the shared navigation", async () => {
    window.history.pushState({}, "", "/?view=profile");
    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={applicationApi} jobMatchApi={jobMatchApi as never} conversationApi={conversationApi()} />
      </BrowserRouter>
    );

    expect(await screen.findByRole("heading", { name: "我的简历" })).toBeVisible();
    const navigation = screen.getByRole("navigation", { name: "候选人工作台" });
    await user.click(within(navigation).getByRole("button", { name: "对话首页" }));

    expect(await screen.findByRole("heading", { name: "和助手聊聊你的求职计划" })).toBeVisible();
    expect(new URLSearchParams(window.location.search).get("view")).toBeNull();
  });

  it("maps the legacy reviews view to application progress", async () => {
    window.history.pushState({}, "", "/?view=reviews");
    render(
      <BrowserRouter>
        <ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={applicationApi} jobMatchApi={jobMatchApi as never} conversationApi={conversationApi()} />
      </BrowserRouter>
    );

    expect(await screen.findByRole("heading", { name: "投递审核" })).toBeVisible();
    expect(new URLSearchParams(window.location.search).get("view")).toBe("reviews");
  });

  it("falls back from an unknown view to chat", async () => {
    window.history.pushState({}, "", "/?view=unknown");
    render(
      <BrowserRouter>
        <ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={applicationApi} jobMatchApi={jobMatchApi as never} conversationApi={conversationApi()} />
      </BrowserRouter>
    );

    expect(await screen.findByRole("heading", { name: "和助手聊聊你的求职计划" })).toBeVisible();
  });

  it("maps the legacy apply view to chat", async () => {
    window.history.pushState({}, "", "/?view=apply");
    render(<BrowserRouter><ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={applicationApi} jobMatchApi={jobMatchApi as never} conversationApi={conversationApi()} /></BrowserRouter>);

    expect(await screen.findByRole("heading", { name: "和助手聊聊你的求职计划" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "我的岗位" })).not.toBeInTheDocument();
  });

  it("exposes the review view from the new navigation", async () => {
    const user = userEvent.setup();
    render(<BrowserRouter><ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={applicationApi} jobMatchApi={jobMatchApi as never} conversationApi={conversationApi()} /></BrowserRouter>);
    await screen.findByRole("heading", { name: "和助手聊聊你的求职计划" });
    await user.click(screen.getByRole("button", { name: "投递进度" }));
    expect(screen.getByRole("heading", { name: "投递审核" })).toBeVisible();
    expect(new URLSearchParams(window.location.search).get("view")).toBe("applications");
  });

  it("cancels an active task before deleting it", async () => {
    const calls: string[] = [];
    const activeTask = reviewTask("needs_questions", "active", ["cancel"]);
    const api = {
      ...applicationApi,
      list: vi.fn().mockResolvedValue([activeTask]),
      command: vi.fn(async () => { calls.push("cancel"); return activeTask; }),
      delete: vi.fn(async () => { calls.push("delete"); })
    };
    window.history.pushState({}, "", "/?view=reviews");
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<BrowserRouter><ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={api} jobMatchApi={jobMatchApi as never} conversationApi={conversationApi()} /></BrowserRouter>);
    await screen.findByText(activeTask.applicationUrl);
    await userEvent.setup().click(screen.getByRole("button", { name: "删除任务：career.example.com" }));

    expect(calls).toEqual(["cancel", "delete"]);
    expect(screen.queryByText(activeTask.applicationUrl)).not.toBeInTheDocument();
  });

  it("deletes a terminal task without cancelling it", async () => {
    const calls: string[] = [];
    const failedTask = reviewTask("failed", "failed", []);
    const api = {
      ...applicationApi,
      list: vi.fn().mockResolvedValue([failedTask]),
      delete: vi.fn(async () => { calls.push("delete"); })
    };
    window.history.pushState({}, "", "/?view=reviews");
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<BrowserRouter><ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={api} jobMatchApi={jobMatchApi as never} conversationApi={conversationApi()} /></BrowserRouter>);
    await screen.findByText(failedTask.applicationUrl);
    await userEvent.setup().click(screen.getByRole("button", { name: "删除任务：career.example.com" }));

    expect(calls).toEqual(["delete"]);
    expect(screen.queryByText(failedTask.applicationUrl)).not.toBeInTheDocument();
  });

  it("keeps the task visible when cancellation fails", async () => {
    const activeTask = reviewTask("needs_questions", "cancel-fails", ["cancel"]);
    const api = {
      ...applicationApi,
      list: vi.fn().mockResolvedValue([activeTask]),
      command: vi.fn().mockRejectedValue(new Error("取消失败")),
      delete: vi.fn()
    };
    window.history.pushState({}, "", "/?view=reviews");
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<BrowserRouter><ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={api} jobMatchApi={jobMatchApi as never} conversationApi={conversationApi()} /></BrowserRouter>);
    await screen.findByText(activeTask.applicationUrl);
    await userEvent.setup().click(screen.getByRole("button", { name: "删除任务：career.example.com" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("取消失败");
    expect(screen.getByText(activeTask.applicationUrl)).toBeVisible();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("keeps the task visible when deletion fails", async () => {
    const failedTask = reviewTask("failed", "delete-fails", []);
    const api = {
      ...applicationApi,
      list: vi.fn().mockResolvedValue([failedTask]),
      delete: vi.fn().mockRejectedValue(new Error("删除失败"))
    };
    window.history.pushState({}, "", "/?view=reviews");
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<BrowserRouter><ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={api} jobMatchApi={jobMatchApi as never} conversationApi={conversationApi()} /></BrowserRouter>);
    await screen.findByText(failedTask.applicationUrl);
    await userEvent.setup().click(screen.getByRole("button", { name: "删除任务：career.example.com" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("删除失败");
    expect(screen.getByText(failedTask.applicationUrl)).toBeVisible();
  });

});
