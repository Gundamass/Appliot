import Fastify from "fastify";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobExpectationSnapshot } from "@resume/contracts";
import { registerJobMatchRoutes } from "./routes.js";
import type { createJobMatchService } from "./job-match-service.js";
import { createApp } from "../app.js";
import { migrateDatabase } from "../db/migrate.js";
import { createProfileRepository } from "../profile/profile-repository.js";

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

const expectation: JobExpectationSnapshot = {
  revision: 1,
  criteria: [{ kind: "target_role", values: ["Java 技术负责人"], strength: "required" }],
  confirmedAt: "2026-08-16T00:00:00.000Z"
};

function session(version = 0) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    version,
    state: "awaiting_filter_confirmation",
    expectation,
    postings: [],
    results: [],
    events: []
  };
}

function harness() {
  const value = session();
  const service = {
    create: vi.fn().mockResolvedValue(value),
    get: vi.fn(() => value),
    confirmFilters: vi.fn().mockResolvedValue({ ...value, version: 1, state: "extracting_jobs" }),
    pause: vi.fn().mockResolvedValue(value),
    resume: vi.fn().mockResolvedValue(value),
    continueExtraction: vi.fn().mockResolvedValue(value),
    rematch: vi.fn().mockResolvedValue(value),
    select: vi.fn(() => value),
    selectConflict: vi.fn(() => value),
    convert: vi.fn().mockResolvedValue({ id: "application-1" }),
    cancel: vi.fn().mockResolvedValue(value)
  };
  const app = Fastify({ logger: false });
  apps.push(app);
  registerJobMatchRoutes(app, { service: service as unknown as ReturnType<typeof createJobMatchService> });
  return { app, service, value };
}

describe("job match routes", () => {
  it("is registered by the application composition", async () => {
    const { service } = harness();
    const database = new Database(":memory:");
    migrateDatabase(database);
    const app = await createApp({
      database,
      profileRepository: createProfileRepository(database),
      originalDocumentStore: {} as never,
      extractPdf: vi.fn(),
      extractFacts: vi.fn(),
      jobMatchService: service as unknown as ReturnType<typeof createJobMatchService>,
      close: () => {
        database.close();
      }
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/job-match-sessions",
      payload: { url: "https://acme.mokahr.com/jobs" }
    });
    expect(response.statusCode).toBe(201);
  });

  it("creates a session and keeps GET read-only", async () => {
    const { app, service, value } = harness();
    const created = await app.inject({
      method: "POST",
      url: "/api/job-match-sessions",
      payload: { url: "https://acme.mokahr.com/jobs" }
    });
    const loaded = await app.inject({
      method: "GET",
      url: `/api/job-match-sessions/${value.id}`
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: value.id, version: 0 });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().version).toBe(0);
    expect(service.get).toHaveBeenCalledWith(value.id);
    for (const operation of [
      service.confirmFilters,
      service.pause,
      service.resume,
      service.continueExtraction,
      service.rematch,
      service.select,
      service.selectConflict,
      service.convert,
      service.cancel
    ]) expect(operation).not.toHaveBeenCalled();
  });

  it("validates request contracts before dispatch", async () => {
    const { app, service, value } = harness();
    const invalidCreate = await app.inject({
      method: "POST",
      url: "/api/job-match-sessions",
      payload: { url: "file:///private/resume.pdf" }
    });
    const missingConflictHash = await app.inject({
      method: "POST",
      url: `/api/job-match-sessions/${value.id}/conflict-selection`,
      payload: selectionInput()
    });

    expect(invalidCreate.statusCode).toBe(400);
    expect(invalidCreate.json()).toMatchObject({ code: "invalid_job_match_create_input" });
    expect(missingConflictHash.statusCode).toBe(400);
    expect(missingConflictHash.json()).toMatchObject({ code: "invalid_job_conflict_selection_input" });
    expect(service.create).not.toHaveBeenCalled();
    expect(service.selectConflict).not.toHaveBeenCalled();
  });

  it("dispatches every mutation subresource with the parsed payload", async () => {
    const { app, service, value } = harness();
    const guard = { sessionVersion: 0, idempotencyKey: "operation-1" };
    const requests = [
      ["PUT", "filter-confirmation", { ...guard, expectation }],
      ["POST", "pause", guard],
      ["POST", "resume", guard],
      ["POST", "continue-extraction", guard],
      ["POST", "rematch", guard],
      ["POST", "selection", selectionInput()],
      ["POST", "conflict-selection", { ...selectionInput(), conflictSummaryHash: "hash-conflict" }],
      ["POST", "application", selectionInput()],
      ["POST", "cancel", guard]
    ] as const;

    for (const [method, resource, payload] of requests) {
      const response = await app.inject({
        method,
        url: `/api/job-match-sessions/${value.id}/${resource}`,
        payload
      });
      expect(response.statusCode, resource).toBe(200);
    }
    expect(service.confirmFilters).toHaveBeenCalledWith(value.id, expectation, guard);
    expect(service.pause).toHaveBeenCalledWith(value.id, guard);
    expect(service.resume).toHaveBeenCalledWith(value.id, guard);
    expect(service.continueExtraction).toHaveBeenCalledWith(value.id, guard);
    expect(service.rematch).toHaveBeenCalledWith(value.id, guard);
    expect(service.select).toHaveBeenCalledWith(value.id, selectionInput());
    expect(service.selectConflict).toHaveBeenCalledWith(value.id, { ...selectionInput(), conflictSummaryHash: "hash-conflict" });
    expect(service.convert).toHaveBeenCalledWith(value.id, selectionInput());
    expect(service.cancel).toHaveBeenCalledWith(value.id, guard);
  });

  it("preserves the conflict summary guard when converting a confirmed conflict", async () => {
    const { app, service, value } = harness();
    const input = { ...selectionInput(), conflictSummaryHash: "hash-conflict" };
    const response = await app.inject({
      method: "POST",
      url: `/api/job-match-sessions/${value.id}/application`,
      payload: input
    });

    expect(response.statusCode).toBe(200);
    expect(service.convert).toHaveBeenCalledWith(value.id, input);
  });

  it.each([
    ["job_match_version_conflict", 409],
    ["job_match_session_not_found", 404],
    ["unsupported_job_entry", 422]
  ] as const)("maps %s to HTTP %s", async (code, statusCode) => {
    const { app, service } = harness();
    service.create.mockRejectedValueOnce(new Error(code));
    const response = await app.inject({
      method: "POST",
      url: "/api/job-match-sessions",
      payload: { url: "https://acme.mokahr.com/jobs" }
    });
    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toMatchObject({ code });
  });

  it("maps a missing job expectation to a recoverable 422 response", async () => {
    const { app, service } = harness();
    service.create.mockRejectedValueOnce(new Error("job_expectation_required"));

    const response = await app.inject({
      method: "POST",
      url: "/api/job-match-sessions",
      payload: { url: "https://acme.mokahr.com/jobs" }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: "Job expectation is required",
      code: "job_expectation_required"
    });
  });
});

function selectionInput() {
  return {
    sessionVersion: 0,
    idempotencyKey: "selection-1",
    resultId: "result-1",
    resultVersion: 0,
    postingContentHash: "hash-posting"
  };
}
