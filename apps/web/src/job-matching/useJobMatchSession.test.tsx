import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useJobMatchSession } from "./useJobMatchSession.js";
import type { JobMatchApi, JobMatchSession } from "./api.js";

const session = { id: "session-1", version: 1, state: "extracting_jobs" } as JobMatchSession;

afterEach(() => { vi.useRealTimers(); });

describe("useJobMatchSession", () => {
  it("polls through GET and pauses in stable user-action states", async () => {
    vi.useFakeTimers();
    const get = vi.fn(async () => session);
    const api = { get } as unknown as JobMatchApi;
    function Probe() {
      const result = useJobMatchSession("session-1", api, { intervalMs: 1000 });
      return <span>{result.session?.state ?? result.status}</span>;
    }
    render(<Probe />);
    await act(async () => { await Promise.resolve(); });
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.getByText("extracting_jobs")).toBeVisible();
  });

  it("does not poll terminal sessions", async () => {
    vi.useFakeTimers();
    const get = vi.fn(async () => ({ ...session, state: "selected" })) as JobMatchApi["get"];
    render(<Probe api={{ get } as unknown as JobMatchApi} />);
    await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(5000); });
    expect(get).toHaveBeenCalledOnce();
  });

  it("continues polling while a created session is still transitioning", async () => {
    vi.useFakeTimers();
    const get = vi.fn(async () => ({ ...session, state: "created" })) as JobMatchApi["get"];
    render(<Probe api={{ get } as unknown as JobMatchApi} />);
    await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(1000); });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not overlap slow polling reads", async () => {
    vi.useFakeTimers();
    const get = vi.fn(() => new Promise<JobMatchSession>(() => undefined));
    render(<Probe api={{ get } as unknown as JobMatchApi} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(get).toHaveBeenCalledOnce();
  });

  it("loads a new session while the previous read is pending and ignores the stale response", async () => {
    let resolveFirst: ((value: JobMatchSession) => void) | undefined;
    const get = vi.fn((sessionId: string) => {
      if (sessionId === "session-1") {
        return new Promise<JobMatchSession>((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve({ ...session, id: sessionId, state: "awaiting_job_selection" });
    });
    const api = { get } as unknown as JobMatchApi;
    function SwitchingProbe({ sessionId }: { sessionId: string }) {
      const result = useJobMatchSession(sessionId, api, { intervalMs: 1000 });
      return <span>{result.session?.id ?? result.status}</span>;
    }

    const view = render(<SwitchingProbe sessionId="session-1" />);
    view.rerender(<SwitchingProbe sessionId="session-2" />);
    await act(async () => { await Promise.resolve(); });

    expect(get).toHaveBeenCalledWith("session-2");
    expect(screen.getByText("session-2")).toBeVisible();

    await act(async () => {
      resolveFirst?.({ ...session, id: "session-1" });
      await Promise.resolve();
    });
    expect(screen.getByText("session-2")).toBeVisible();
  });
});

function Probe({ api }: { api: JobMatchApi }) {
  const result = useJobMatchSession("session-1", api, { intervalMs: 1000 });
  return <span>{result.session?.state ?? result.status}</span>;
}
