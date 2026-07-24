import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AdapterStatus } from "@resume/contracts";
import type { ProfileApi } from "../api/client.js";
import type { HealthApi } from "../api/health-client.js";
import { ProfilePage } from "../profile/ProfilePage.js";
import { ServiceStatus } from "./ServiceStatus.js";

const statuses: AdapterStatus[] = [
  { id: "deepseek", state: "configured", model: "deepseek-v4-flash", code: "not_checked" },
  { id: "embedding", state: "unavailable", code: "offline" },
  { id: "ocr", state: "unavailable", code: "offline" }
];

const profileApi: ProfileApi = {
  upload: vi.fn(), listFacts: vi.fn(async () => []), confirm: vi.fn(), correct: vi.fn()
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("ServiceStatus", () => {
  it("renders compact safe operational states", () => {
    render(<ServiceStatus statuses={statuses} />);

    expect(screen.getByText("DeepSeek 已配置")).toBeVisible();
    expect(screen.getByText("语义检索 离线")).toBeVisible();
    expect(screen.getByText("OCR 离线")).toBeVisible();
    expect(document.body.textContent).not.toMatch(/token|127\.0\.0\.1|deepseek-v4-flash/iu);
  });

  it("keeps native PDF import available while marking OCR offline beside import", async () => {
    const healthApi: HealthApi = { getStatuses: vi.fn(async () => statuses) };
    const { container } = render(<ProfilePage api={profileApi} healthApi={healthApi} />);

    const offline = await screen.findByText("OCR 离线");
    const uploadBand = container.querySelector(".upload-band");
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(uploadBand).not.toBeNull();
    expect(within(uploadBand as HTMLElement).getByText("OCR 离线")).toBe(offline);
    expect(fileInput).toBeEnabled();
  });

  it("allows self-evaluation while DeepSeek is configured", async () => {
    const healthApi: HealthApi = { getStatuses: vi.fn(async () => statuses) };
    const reviewApi = { create: vi.fn(), get: vi.fn(), approve: vi.fn(), promote: vi.fn() };
    const user = userEvent.setup();
    render(<ProfilePage api={profileApi} healthApi={healthApi} reviewApi={reviewApi} />);

    await waitFor(() => expect(healthApi.getStatuses).toHaveBeenCalled());
    const viewButtons = screen.getByRole("navigation").querySelectorAll("button");
    await user.click(viewButtons[1]!);
    await user.type(screen.getByLabelText("Job description"), "React role");

    expect(screen.getByRole("button", { name: "Create review" })).toBeEnabled();
  });

  it("disables new self-evaluation creation when DeepSeek is unavailable", async () => {
    const healthApi: HealthApi = {
      getStatuses: vi.fn(async () => statuses.map((status) => status.id === "deepseek"
        ? { ...status, state: "unavailable" as const, code: "offline" as const }
        : status))
    };
    const reviewApi = { create: vi.fn(), get: vi.fn(), approve: vi.fn(), promote: vi.fn() };
    const user = userEvent.setup();
    render(<ProfilePage api={profileApi} healthApi={healthApi} reviewApi={reviewApi} />);

    await waitFor(() => expect(healthApi.getStatuses).toHaveBeenCalled());
    const viewButtons = screen.getByRole("navigation").querySelectorAll("button");
    await user.click(viewButtons[1]!);
    await screen.findByText("DeepSeek 离线");
    await user.type(screen.getByLabelText("Job description"), "React role");

    expect(screen.getByRole("button", { name: "Create review" })).toBeDisabled();
  });

  it("keeps the newest health refresh when responses resolve out of order", async () => {
    const first = deferred<AdapterStatus[]>();
    const second = deferred<AdapterStatus[]>();
    const healthApi: HealthApi = {
      getStatuses: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    };
    const user = userEvent.setup();
    render(<ProfilePage api={profileApi} healthApi={healthApi} />);

    await waitFor(() => expect(healthApi.getStatuses).toHaveBeenCalledOnce());
    await user.click(await screen.findByRole("button", { name: "刷新资料" }));
    expect(healthApi.getStatuses).toHaveBeenCalledTimes(2);

    second.resolve(statuses.map((status) => status.id === "ocr"
      ? { id: "ocr", state: "ready", model: "ocr", modelRevision: "revision" }
      : status));
    expect(await screen.findByText("OCR 可用")).toBeVisible();
    first.resolve(statuses);
    await waitFor(() => expect(screen.getByText("OCR 可用")).toBeVisible());
    expect(screen.queryByText("OCR 离线")).not.toBeInTheDocument();
  });

  it("aborts health refresh and ignores its late response after unmount", async () => {
    const pending = deferred<AdapterStatus[]>();
    let signal: AbortSignal | undefined;
    const healthApi: HealthApi = {
      getStatuses: vi.fn((requestSignal?: AbortSignal) => {
        signal = requestSignal;
        return pending.promise;
      })
    };
    const { unmount } = render(<ProfilePage api={profileApi} healthApi={healthApi} />);

    await waitFor(() => expect(healthApi.getStatuses).toHaveBeenCalledOnce());
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
    await expect(Promise.resolve().then(() => pending.resolve(statuses))).resolves.toBeUndefined();
  });
});
