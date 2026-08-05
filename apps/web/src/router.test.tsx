import type { ApplicationTask } from "@resume/contracts";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRouter } from "./router.js";

const task: ApplicationTask = {
  id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  applicationUrl: "https://career.example.com/jobs/42",
  state: "waiting_for_login",
  commands: ["cancel", "open_browser", "resume"],
  recoveryCommands: [],
  questions: [],
  taskAnswers: []
};

class SilentEventSource extends EventTarget {
  close() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

describe("AppRouter", () => {
  it("renders the create route and a deep task route", async () => {
    vi.stubGlobal("EventSource", SilentEventSource);
    const api = { list: vi.fn().mockResolvedValue([]), create: vi.fn(), get: vi.fn().mockResolvedValue(task), command: vi.fn(), recover: vi.fn() };
    window.history.pushState({}, "", "/applications/new");
    const view = render(<AppRouter applicationApi={api} />);
    expect(screen.getByRole("heading", { name: "新建投递" })).toBeVisible();

    view.unmount();
    window.history.pushState({}, "", `/applications/${task.id}`);
    render(<AppRouter applicationApi={api} />);
    expect(await screen.findByRole("heading", { name: "请在受控浏览器中完成登录" })).toBeVisible();
    const navigation = screen.getByRole("navigation", { name: "候选人工作台" });
    expect(within(navigation).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual([
      "候选人档案",
      "新建投递",
      "投递审核"
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

    expect(await screen.findByRole("heading", { name: "简历资料" })).toBeVisible();
    expect(window.location.pathname).toBe("/");
  });
});
