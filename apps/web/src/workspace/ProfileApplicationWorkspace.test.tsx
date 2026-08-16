import { BrowserRouter } from "react-router-dom";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationTask } from "@resume/contracts";
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
  vi.restoreAllMocks();
  applicationApi.list.mockResolvedValue([]);
});

describe("ProfileApplicationWorkspace", () => {
  it("keeps the workspace shell focused on profile, application, and review", async () => {
    render(
      <BrowserRouter>
        <ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={applicationApi} jobMatchApi={jobMatchApi as never} />
      </BrowserRouter>
    );

    await screen.findByRole("heading", { name: "候选人档案" });
    const navigation = screen.getByRole("navigation", { name: "候选人工作台" });
    expect(within(navigation).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual([
      "候选人档案",
      "新建投递",
      "投递审核"
    ]);
    expect(screen.queryByRole("button", { name: "自我评价审核" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "字段检索" })).not.toBeInTheDocument();
  });

  it("opens the candidate profile at the root and moves to the apply view", async () => {
    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={applicationApi} jobMatchApi={jobMatchApi as never} />
      </BrowserRouter>
    );

    expect(await screen.findByRole("heading", { name: "候选人档案" })).toBeVisible();
    const navigation = screen.getByRole("navigation", { name: "候选人工作台" });
    await user.click(within(navigation).getByRole("button", { name: "新建投递" }));

    expect(screen.getByRole("heading", { name: "新建投递" })).toBeVisible();
    expect(new URLSearchParams(window.location.search).get("view")).toBe("apply");
  });

  it("falls back from an unknown view to profile and exposes the review view", async () => {
    window.history.pushState({}, "", "/?view=unknown");
    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={applicationApi} jobMatchApi={jobMatchApi as never} />
      </BrowserRouter>
    );

    expect(await screen.findByRole("heading", { name: "候选人档案" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "投递审核" }));
    expect(screen.getByRole("heading", { name: "投递审核" })).toBeVisible();
    expect(new URLSearchParams(window.location.search).get("view")).toBe("reviews");
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

    render(<BrowserRouter><ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={api} jobMatchApi={jobMatchApi as never} /></BrowserRouter>);
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

    render(<BrowserRouter><ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={api} jobMatchApi={jobMatchApi as never} /></BrowserRouter>);
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

    render(<BrowserRouter><ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={api} jobMatchApi={jobMatchApi as never} /></BrowserRouter>);
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

    render(<BrowserRouter><ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={api} jobMatchApi={jobMatchApi as never} /></BrowserRouter>);
    await screen.findByText(failedTask.applicationUrl);
    await userEvent.setup().click(screen.getByRole("button", { name: "删除任务：career.example.com" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("删除失败");
    expect(screen.getByText(failedTask.applicationUrl)).toBeVisible();
  });

  it("defaults to job matching and can switch to direct application", async () => {
    window.history.pushState({}, "", "/?view=apply");
    render(<BrowserRouter><ProfileApplicationWorkspace
      profileApi={profileApi()}
      applicationApi={applicationApi}
      jobMatchApi={jobMatchApi as never}
    /></BrowserRouter>);

    const matchMode = await screen.findByRole("button", { name: "岗位匹配" });
    expect(matchMode).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "直接投递" }));

    expect(screen.getByLabelText("任务名称")).toBeVisible();
    expect(screen.getByRole("button", { name: "直接投递" })).toHaveAttribute("aria-pressed", "true");
  });

  it("navigates to a created job match session", async () => {
    window.history.pushState({}, "", "/?view=apply");
    const api = profileApi();
    api.listFacts = vi.fn().mockResolvedValue([{
      id: "role",
      fieldPath: "preferences.targetRole",
      value: "Java",
      status: "user_confirmed",
      confidence: 1,
      scope: "profile",
      evidence: [{ documentId: "fixture", page: 1, text: "Java", extraction: "user" }],
      revision: 1
    }]);
    const matching = { create: vi.fn().mockResolvedValue({ id: "session-1" }) };
    render(<BrowserRouter><ProfileApplicationWorkspace
      profileApi={api}
      applicationApi={applicationApi}
      jobMatchApi={matching as never}
    /></BrowserRouter>);

    await screen.findByDisplayValue("Java");
    await userEvent.type(screen.getByLabelText("招聘链接"), "https://acme.mokahr.com/jobs");
    await userEvent.click(screen.getByRole("button", { name: "确认岗位期望并开始匹配" }));

    expect(window.location.pathname).toBe("/job-match-sessions/session-1");
  });

  it("switches to direct application and prefills an application redirect", async () => {
    window.history.pushState({}, "", "/?view=apply");
    const api = profileApi();
    api.listFacts = vi.fn().mockResolvedValue([{
      id: "role",
      fieldPath: "preferences.targetRole",
      value: "Java",
      status: "user_confirmed",
      confidence: 1,
      scope: "profile",
      evidence: [{ documentId: "fixture", page: 1, text: "Java", extraction: "user" }],
      revision: 1
    }]);
    const matching = { create: vi.fn().mockResolvedValue({
      redirect: "application",
      applicationUrl: "https://acme.mokahr.com/apply"
    }) };
    render(<BrowserRouter><ProfileApplicationWorkspace
      profileApi={api}
      applicationApi={applicationApi}
      jobMatchApi={matching as never}
    /></BrowserRouter>);

    await screen.findByDisplayValue("Java");
    await userEvent.type(screen.getByLabelText("招聘链接"), "https://acme.mokahr.com/apply");
    await userEvent.click(screen.getByRole("button", { name: "确认岗位期望并开始匹配" }));

    expect(await screen.findByLabelText("投递官网链接")).toHaveValue("https://acme.mokahr.com/apply");
    expect(applicationApi.create).not.toHaveBeenCalled();
  });
});
