import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { createProductionDependencies } from "../production-dependencies.js";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

describe("LightRAG production wiring", () => {
  it("registers retrieval as a graph-only, schema-validating production tool", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({
      provider: "lightrag",
      retrievalVersion: "profile-r3",
      scope: { kind: "profile", tenantScope: "tenant-a", profileRevision: 3 },
      evidence: [{
        evidenceId: "evidence-a",
        documentId: "resume-a",
        page: 1,
        quoteHash: "a".repeat(64),
        score: 0.9
      }]
    }));
    const dependencies = createProductionDependencies(loadConfig({
      DATABASE_FILE: ":memory:",
      LIGHTRAG_RETRIEVAL_API_TOKEN: "worker-token",
      LIGHTRAG_RETRIEVAL_BASE_URL: "http://127.0.0.1:43122",
      LIGHTRAG_RETRIEVAL_TENANT_SCOPE: "tenant-a"
    }), { fetch });

    await expect(dependencies.agentToolRegistry.invoke("retrieve_job_evidence", {}, {
      caller: "graph", runId: "run-1", taskId: "task-1"
    })).rejects.toMatchObject({ code: "retrieval_invalid_response" });
    expect(fetch).not.toHaveBeenCalled();

    await expect(dependencies.agentToolRegistry.invoke("retrieve_job_evidence", {
      query: "distributed systems",
      scope: "profile",
      profileRevision: 3,
      topK: 3
    }, { caller: "model", runId: "run-1", taskId: "task-1" })).rejects.toThrow("tool_not_allowed");

    await expect(dependencies.agentToolRegistry.invoke("retrieve_job_evidence", {
      query: "distributed systems",
      scope: "profile",
      profileRevision: 3,
      topK: 3
    }, { caller: "graph", runId: "run-1", taskId: "task-1" })).resolves.toMatchObject({
      provider: "lightrag",
      evidence: [{ evidenceId: "evidence-a" }]
    });
    await dependencies.close?.();
  });
});
