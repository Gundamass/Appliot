import type { ProfileFact } from "@resume/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProfileApi } from "../api/client.js";
import { JobMatchApiError, type JobMatchApi } from "./api.js";
import { JobMatchStartPanel } from "./JobMatchStartPanel.js";

function profileFact(
  id: string,
  fieldPath: string,
  value: ProfileFact["value"],
  status: ProfileFact["status"] = "extracted"
): ProfileFact {
  return {
    id,
    fieldPath,
    value,
    status,
    confidence: 1,
    scope: "profile",
    evidence: [{ documentId: "fixture", page: 1, text: String(value), extraction: status === "extracted" ? "pdf_text" : "user" }],
    revision: 1
  };
}

function props(
  profileApi: Record<string, unknown>,
  jobMatchApi: Record<string, unknown>,
  overrides: Partial<{
    onSessionCreated(sessionId: string): void;
    onApplicationForm(applicationUrl: string): void;
    onOpenProfile(): void;
    onBusyChange(busy: boolean): void;
  }> = {}
) {
  return {
    profileApi: profileApi as Pick<ProfileApi, "listFacts" | "confirm" | "upsert">,
    jobMatchApi: jobMatchApi as Pick<JobMatchApi, "create">,
    onSessionCreated: vi.fn(),
    onApplicationForm: vi.fn(),
    onOpenProfile: vi.fn(),
    ...overrides
  };
}

describe("JobMatchStartPanel", () => {
  it("prefills extracted expectations, confirms them, then creates a session", async () => {
    const extracted = profileFact("role", "preferences.targetRole", "Java 技术负责人");
    const profileApi = {
      listFacts: vi.fn().mockResolvedValue([extracted]),
      confirm: vi.fn().mockResolvedValue({ ...extracted, status: "user_confirmed" }),
      upsert: vi.fn()
    };
    const jobMatchApi = { create: vi.fn().mockResolvedValue({ id: "session-1" }) };
    const onSessionCreated = vi.fn();
    render(<JobMatchStartPanel {...props(profileApi, jobMatchApi, { onSessionCreated })} />);

    expect(await screen.findByDisplayValue("Java 技术负责人")).toBeVisible();
    expect(screen.getByText("来自简历，待确认")).toBeVisible();
    await userEvent.type(screen.getByLabelText("招聘链接"), "https://acme.mokahr.com/jobs");
    await userEvent.click(screen.getByRole("button", { name: "确认岗位期望并开始匹配" }));

    expect(profileApi.confirm).toHaveBeenCalledWith("role");
    expect(profileApi.upsert).not.toHaveBeenCalled();
    expect(jobMatchApi.create).toHaveBeenCalledWith("https://acme.mokahr.com/jobs");
    expect(onSessionCreated).toHaveBeenCalledWith("session-1");
  });

  it("retries a failed profile load before enabling creation", async () => {
    const profileApi = {
      listFacts: vi.fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce([profileFact("role", "preferences.targetRole", "Java", "user_confirmed")]),
      confirm: vi.fn(),
      upsert: vi.fn()
    };
    const jobMatchApi = { create: vi.fn() };
    render(<JobMatchStartPanel {...props(profileApi, jobMatchApi)} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("岗位期望加载失败，请重试");
    expect(screen.getByRole("button", { name: "确认岗位期望并开始匹配" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByDisplayValue("Java")).toBeVisible();
    expect(profileApi.listFacts).toHaveBeenCalledTimes(2);
  });

  it("requires one non-empty expectation and focuses the first field", async () => {
    const profileApi = { listFacts: vi.fn().mockResolvedValue([]), confirm: vi.fn(), upsert: vi.fn() };
    const jobMatchApi = { create: vi.fn() };
    render(<JobMatchStartPanel {...props(profileApi, jobMatchApi)} />);

    const targetRole = await screen.findByLabelText("目标岗位");
    await userEvent.type(screen.getByLabelText("招聘链接"), "https://acme.mokahr.com/jobs");
    await userEvent.click(screen.getByRole("button", { name: "确认岗位期望并开始匹配" }));

    expect(screen.getByRole("alert")).toHaveTextContent("请先确认至少一项岗位期望");
    expect(targetRole).toHaveFocus();
    expect(jobMatchApi.create).not.toHaveBeenCalled();
  });

  it("writes modified and legacy extracted values to canonical paths without rewriting reviewed values", async () => {
    const profileApi = {
      listFacts: vi.fn().mockResolvedValue([
        profileFact("role", "preferences.targetRole", "Java", "extracted"),
        profileFact("city", "preferences.location", "上海", "extracted"),
        profileFact("industry", "preferences.industry", "软件", "user_confirmed")
      ]),
      confirm: vi.fn(),
      upsert: vi.fn(async (fieldPath: string, value: string) => profileFact(`saved-${fieldPath}`, fieldPath, value, "user_corrected"))
    };
    const jobMatchApi = { create: vi.fn().mockResolvedValue({ id: "session-1" }) };
    render(<JobMatchStartPanel {...props(profileApi, jobMatchApi)} />);

    const role = await screen.findByLabelText("目标岗位");
    await userEvent.clear(role);
    await userEvent.type(role, "Go");
    await userEvent.type(screen.getByLabelText("招聘链接"), "https://acme.mokahr.com/jobs");
    await userEvent.click(screen.getByRole("button", { name: "确认岗位期望并开始匹配" }));

    expect(profileApi.upsert).toHaveBeenNthCalledWith(1, "preferences.targetRole", "Go");
    expect(profileApi.upsert).toHaveBeenNthCalledWith(2, "preferences.targetCity", "上海");
    expect(profileApi.upsert).toHaveBeenCalledTimes(2);
    expect(profileApi.confirm).not.toHaveBeenCalled();
    expect(jobMatchApi.create).toHaveBeenCalledOnce();
  });

  it("preserves drafts after a save failure and does not replay settled fields", async () => {
    const role = profileFact("role", "preferences.targetRole", "Java");
    const city = profileFact("city", "preferences.targetCity", "上海");
    const profileApi = {
      listFacts: vi.fn().mockResolvedValue([role, city]),
      confirm: vi.fn()
        .mockResolvedValueOnce({ ...role, status: "user_confirmed" })
        .mockRejectedValueOnce(new Error("save failed"))
        .mockResolvedValueOnce({ ...city, status: "user_confirmed" }),
      upsert: vi.fn()
    };
    const jobMatchApi = { create: vi.fn().mockResolvedValue({ id: "session-1" }) };
    render(<JobMatchStartPanel {...props(profileApi, jobMatchApi)} />);
    await screen.findByDisplayValue("Java");
    await userEvent.type(screen.getByLabelText("招聘链接"), "https://acme.mokahr.com/jobs");

    await userEvent.click(screen.getByRole("button", { name: "确认岗位期望并开始匹配" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("岗位期望保存失败，请重试");
    expect(screen.getByLabelText("目标岗位")).toHaveValue("Java");
    expect(screen.getByLabelText("地点")).toHaveValue("上海");
    expect(jobMatchApi.create).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "确认岗位期望并开始匹配" }));
    expect(profileApi.confirm).toHaveBeenCalledTimes(3);
    expect(profileApi.confirm.mock.calls.map(([id]) => id)).toEqual(["role", "city", "city"]);
    expect(jobMatchApi.create).toHaveBeenCalledOnce();
  });

  it("locks duplicate submissions and reports busy state once per operation", async () => {
    let finishConfirm!: (value: ProfileFact) => void;
    const extracted = profileFact("role", "preferences.targetRole", "Java");
    const profileApi = {
      listFacts: vi.fn().mockResolvedValue([extracted]),
      confirm: vi.fn(() => new Promise<ProfileFact>((resolve) => { finishConfirm = resolve; })),
      upsert: vi.fn()
    };
    const jobMatchApi = { create: vi.fn().mockResolvedValue({ id: "session-1" }) };
    const onBusyChange = vi.fn();
    render(<JobMatchStartPanel {...props(profileApi, jobMatchApi, { onBusyChange })} />);
    await screen.findByDisplayValue("Java");
    await userEvent.type(screen.getByLabelText("招聘链接"), "https://acme.mokahr.com/jobs");
    const submit = screen.getByRole("button", { name: "确认岗位期望并开始匹配" });

    await userEvent.click(submit);
    await userEvent.click(submit);
    expect(profileApi.confirm).toHaveBeenCalledOnce();
    expect(jobMatchApi.create).not.toHaveBeenCalled();
    finishConfirm({ ...extracted, status: "user_confirmed" });

    await waitFor(() => expect(jobMatchApi.create).toHaveBeenCalledOnce());
    expect(onBusyChange).toHaveBeenNthCalledWith(1, true);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("routes application redirects and ignores completed requests after unmount", async () => {
    let finishCreate!: (value: { redirect: "application"; applicationUrl: string }) => void;
    const reviewed = profileFact("role", "preferences.targetRole", "Java", "user_confirmed");
    const profileApi = { listFacts: vi.fn().mockResolvedValue([reviewed]), confirm: vi.fn(), upsert: vi.fn() };
    const jobMatchApi = {
      create: vi.fn(() => new Promise<{ redirect: "application"; applicationUrl: string }>((resolve) => { finishCreate = resolve; }))
    };
    const onApplicationForm = vi.fn();
    const onSessionCreated = vi.fn();
    const view = render(<JobMatchStartPanel {...props(profileApi, jobMatchApi, { onApplicationForm, onSessionCreated })} />);
    await screen.findByDisplayValue("Java");
    await userEvent.type(screen.getByLabelText("招聘链接"), "https://acme.mokahr.com/apply");
    await userEvent.click(screen.getByRole("button", { name: "确认岗位期望并开始匹配" }));
    view.unmount();
    finishCreate({ redirect: "application", applicationUrl: "https://acme.mokahr.com/apply" });

    await Promise.resolve();
    expect(onApplicationForm).not.toHaveBeenCalled();
    expect(onSessionCreated).not.toHaveBeenCalled();
  });

  it("explains when a supported source has an unrecognized page structure", async () => {
    const reviewed = profileFact("role", "preferences.targetRole", "Java", "user_confirmed");
    const profileApi = { listFacts: vi.fn().mockResolvedValue([reviewed]), confirm: vi.fn(), upsert: vi.fn() };
    const jobMatchApi = {
      create: vi.fn().mockRejectedValue(new JobMatchApiError("unsupported", "unsupported_job_entry"))
    };
    render(<JobMatchStartPanel {...props(profileApi, jobMatchApi)} />);

    await screen.findByDisplayValue("Java");
    await userEvent.type(screen.getByLabelText("招聘链接"), "https://app.mokahr.com/campus_apply/acme-campus/39595#/jobs");
    await userEvent.click(screen.getByRole("button", { name: "确认岗位期望并开始匹配" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("当前招聘页面结构尚未识别，请确认链接打开的是岗位列表或岗位详情页。");
    expect(alert).not.toHaveTextContent("当前仅支持 Moka/Mokahr");
  });
});
