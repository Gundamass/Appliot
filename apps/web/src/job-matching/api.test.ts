import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobMatchApi } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("JobMatchApi", () => {
  it("uses GET for session reads and typed mutation paths", async () => {
    const session = { id: "session-1", version: 3 };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(session), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createJobMatchApi();

    await api.get("session-1");
    await api.continueExtraction("session-1", { sessionVersion: 3, idempotencyKey: "continue-1" });

    expect(fetchMock.mock.calls[0]).toEqual(["/api/job-match-sessions/session-1", { method: "GET" }]);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/job-match-sessions/session-1/continue-extraction");
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      sessionVersion: 3,
      idempotencyKey: "continue-1"
    });
  });

  it("posts conflict selection with the current conflict hash", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "session-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await createJobMatchApi().selectConflict("session-1", {
      sessionVersion: 4,
      idempotencyKey: "select-1",
      resultId: "result-1",
      resultVersion: 2,
      postingContentHash: "sha256:posting",
      conflictSummaryHash: "sha256:conflict"
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/job-match-sessions/session-1/conflict-selection", expect.objectContaining({ method: "POST" }));
  });

  it("confirms edited filters with PUT", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "session-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const expectation = { revision: 2, confirmedAt: "2026-08-16T00:00:00.000Z", criteria: [{ kind: "target_role" as const, values: ["Java"], strength: "required" as const }] };
    await createJobMatchApi().confirmFilters("session-1", expectation, { sessionVersion: 1, idempotencyKey: "filters-1" });
    expect(fetchMock).toHaveBeenCalledWith("/api/job-match-sessions/session-1/filter-confirmation", expect.objectContaining({ method: "PUT" }));
  });
});
