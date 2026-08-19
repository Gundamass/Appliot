import type { ApplicationTask, HintPackDefinition } from "@resume/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplicationApi } from "./api.js";

const task: ApplicationTask = {
  id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  applicationUrl: "https://career.example.com/jobs/42",
  state: "waiting_for_login",
  commands: ["cancel", "open_browser", "resume"],
  recoveryCommands: [],
  questions: [],
  taskAnswers: []
};

afterEach(() => vi.unstubAllGlobals());

describe("ApplicationApi", () => {
  it("lists application tasks through the array contract", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify([task]), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createApplicationApi().list()).resolves.toEqual([task]);
    expect(fetchMock).toHaveBeenCalledWith("/api/applications", { method: "GET" });
  });

  it("creates tasks and sends typed commands to encoded task paths", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(task), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createApplicationApi();

    await api.create({ name: "示例后端岗位", applicationUrl: task.applicationUrl });
    await api.command(task.id, { type: "resume" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/applications");
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      name: "示例后端岗位",
      applicationUrl: task.applicationUrl
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/applications/${task.id}/commands`);
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({ type: "resume" });
  });

  it("sends only typed recovery commands to the recovery endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(task), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createApplicationApi().recover(task.id, "manual_done");

    expect(fetchMock).toHaveBeenCalledWith(`/api/applications/${task.id}/recovery`, expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ type: "manual_done" })
    }));
  });

  it("accepts an empty 204 response when deleting a task", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createApplicationApi().delete?.(task.id)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(`/api/applications/${task.id}`, { method: "DELETE" });
  });

  it("rejects malformed task responses instead of rendering untrusted commands", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...task, commands: ["submit"] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));

    await expect(createApplicationApi().get(task.id)).rejects.toThrow();
  });

  it("uses only structured ATS review endpoints and parses their sanitized summaries", async () => {
    const review = { replayReports: [], lifecycleStatus: "candidate", aiReviewUnavailable: true, writeBlocked: true };
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => new Response(
      init?.method === "POST" && String(_input).endsWith("/retire") ? null : JSON.stringify(review),
      { status: init?.method === "POST" && String(_input).endsWith("/retire") ? 204 : 200, headers: { "Content-Type": "application/json" } }
    ));
    vi.stubGlobal("fetch", fetchMock);
    const adapterReview = createApplicationApi().adapterReview!;
    const pack = hintPackDefinition();

    await adapterReview.get("proposal/1");
    await adapterReview.replay("proposal/1");
    await adapterReview.requestAiReview("proposal/1");
    await adapterReview.revise("proposal/1", pack);
    await adapterReview.decide("proposal/1", { decision: "reject", aiReviewUnavailable: false, acknowledgedAiUnavailable: false });
    await adapterReview.retire("example-ats", "1.0.0", "synthetic drift");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/ats-adapters/proposals/proposal%2F1",
      "/api/ats-adapters/proposals/proposal%2F1/replay",
      "/api/ats-adapters/proposals/proposal%2F1/ai-review",
      "/api/ats-adapters/proposals/proposal%2F1/revise",
      "/api/ats-adapters/proposals/proposal%2F1/decision",
      "/api/ats-adapters/packs/example-ats/1.0.0/retire"
    ]);
    expect(JSON.parse(String((fetchMock.mock.calls[4]?.[1] as RequestInit).body))).toEqual({
      decision: "reject", aiReviewUnavailable: false, acknowledgedAiUnavailable: false
    });
    expect(JSON.parse(String((fetchMock.mock.calls[5]?.[1] as RequestInit).body))).toEqual({ reason: "synthetic drift" });
  });
});

function hintPackDefinition(): HintPackDefinition {
  return {
    schemaVersion: 1,
    packId: "example-ats",
    version: "1.0.0",
    match: { sites: [{ hostSuffix: "jobs.example.test", pathPrefixes: ["/apply"] }], stages: ["application_form"], requiredTextSignals: [], pageFingerprintHashes: [] },
    sectionRules: [],
    fieldRules: [{ ruleId: "name", profilePath: "basics.name", labelAliases: ["ats:sha256:24:fixture"], sections: ["basics"], controlTypes: ["text"], confidence: 1 }],
    actionRules: [],
    fixtures: [{ fixtureId: "fixture-basic", expectedProfilePaths: ["basics.name"] }]
  };
}
