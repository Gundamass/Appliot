import type { ApplicationTask } from "@resume/contracts";
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
});
