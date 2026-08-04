import { BrowserRouter } from "react-router-dom";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  recover: vi.fn()
};

afterEach(() => {
  window.history.pushState({}, "", "/");
});

describe("ProfileApplicationWorkspace", () => {
  it("keeps the workspace shell focused on profile, application, and review", async () => {
    render(
      <BrowserRouter>
        <ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={applicationApi} />
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
        <ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={applicationApi} />
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
        <ProfileApplicationWorkspace profileApi={profileApi()} applicationApi={applicationApi} />
      </BrowserRouter>
    );

    expect(await screen.findByRole("heading", { name: "候选人档案" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "投递审核" }));
    expect(screen.getByRole("heading", { name: "投递审核" })).toBeVisible();
    expect(new URLSearchParams(window.location.search).get("view")).toBe("reviews");
  });
});
