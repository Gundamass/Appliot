import { describe, expect, it, vi } from "vitest";
import {
  LightRagRetrievalError,
  createLightRagEvidenceRetrievalClient,
  type EvidenceRetrievalPort
} from "./lightrag-retrieval-client.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function fallback(): EvidenceRetrievalPort {
  return {
    retrieve: vi.fn(async () => ({
      provider: "deterministic_fallback" as const,
      retrievalVersion: "deterministic-v1",
      evidence: [{
        evidenceId: "fallback-evidence",
        documentId: "resume-a",
        page: 1,
        quoteHash: "b".repeat(64),
        score: 0.5
      }]
    }))
  };
}

function client(options: {
  fetch?: typeof globalThis.fetch;
  fallback?: EvidenceRetrievalPort;
}) {
  return createLightRagEvidenceRetrievalClient({
    apiToken: "worker-token",
    baseUrl: "http://127.0.0.1:43122",
    tenantScope: "tenant-a",
    timeoutMs: 100
  }, {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
    sleep: async () => undefined
  });
}

describe("LightRAG evidence retrieval client", () => {
  it("requires an explicit posting identity for job-index results", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({
      provider: "lightrag",
      retrievalVersion: "job-r4",
      scope: { kind: "job", tenantScope: "tenant-a" },
      evidence: [{
        evidenceId: "job-evidence-a",
        documentId: "job-document-a",
        postingId: "posting-a",
        quoteHash: "a".repeat(64),
        score: 0.82
      }]
    }));

    await expect(client({ fetch }).retrieve({
      query: "Kubernetes platform engineering",
      scope: "job",
      topK: 3
    })).resolves.toEqual({
      provider: "lightrag",
      retrievalVersion: "job-r4",
      evidence: [{
        evidenceId: "job-evidence-a",
        documentId: "job-document-a",
        postingId: "posting-a",
        quoteHash: "a".repeat(64),
        score: 0.82
      }]
    });
  });

  it("rejects job-index evidence without an explicit posting identity", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({
      provider: "lightrag",
      retrievalVersion: "job-r4",
      scope: { kind: "job", tenantScope: "tenant-a" },
      evidence: [{
        evidenceId: "job-evidence-a",
        documentId: "job-document-a",
        quoteHash: "a".repeat(64),
        score: 0.82
      }]
    }));

    await expect(client({ fetch }).retrieve({
      query: "Kubernetes platform engineering",
      scope: "job",
      topK: 3
    })).rejects.toMatchObject({ code: "retrieval_invalid_response" });
  });

  it("rejects a Worker scope that adds a cross-index filter", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({
      provider: "lightrag",
      retrievalVersion: "job-r4",
      scope: { kind: "job", tenantScope: "tenant-a", profileRevision: 3 },
      evidence: [{
        evidenceId: "job-evidence-a",
        documentId: "job-document-a",
        postingId: "posting-a",
        quoteHash: "a".repeat(64),
        score: 0.82
      }]
    }));

    await expect(client({ fetch }).retrieve({
      query: "Kubernetes platform engineering",
      scope: "job",
      topK: 3
    })).rejects.toMatchObject({ code: "retrieval_scope_mismatch" });
  });

  it("returns only versioned evidence references from LightRAG", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({
      provider: "lightrag",
      retrievalVersion: "profile-r3",
      scope: { kind: "profile", tenantScope: "tenant-a", profileRevision: 3 },
      evidence: [{
        evidenceId: "evidence-a",
        documentId: "resume-a",
        page: 2,
        blockId: "skills",
        quoteHash: "a".repeat(64),
        score: 0.82
      }]
    }));

    const result = await client({ fetch }).retrieve({
      query: "distributed systems project experience",
      scope: "profile",
      profileRevision: 3,
      topK: 5
    });

    expect(result).toEqual({
      provider: "lightrag",
      retrievalVersion: "profile-r3",
      evidence: [{
        evidenceId: "evidence-a",
        documentId: "resume-a",
        page: 2,
        blockId: "skills",
        quoteHash: "a".repeat(64),
        score: 0.82
      }]
    });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:43122/v1/retrieve", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer worker-token" })
    }));
  });

  it("rejects cross-index filters before sending a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();

    await expect(client({ fetch }).retrieve({
      query: "requirements",
      scope: "profile",
      profileRevision: 3,
      postingId: "job-1",
      topK: 5
    })).rejects.toMatchObject({ code: "retrieval_invalid_response" });
    await expect(client({ fetch }).retrieve({
      query: "profile summary",
      scope: "job",
      profileRevision: 3,
      topK: 5
    })).rejects.toMatchObject({ code: "retrieval_invalid_response" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries one transient failure then falls back when LightRAG is unavailable", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("connection refused"));
    const deterministicFallback = fallback();

    const result = await client({ fetch, fallback: deterministicFallback }).retrieve({
      query: "python",
      scope: "profile",
      profileRevision: 3,
      topK: 5
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.provider).toBe("deterministic_fallback");
    expect(deterministicFallback.retrieve).toHaveBeenCalledOnce();
  });

  it("retries one HTTP timeout response before accepting a recovered Worker", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ code: "retrieval_timeout" }, 408))
      .mockResolvedValueOnce(response({
        provider: "lightrag",
        retrievalVersion: "profile-r3",
        scope: { kind: "profile", tenantScope: "tenant-a", profileRevision: 3 },
        evidence: [{
          evidenceId: "evidence-a",
          documentId: "resume-a",
          quoteHash: "a".repeat(64),
          score: 0.8
        }]
      }));

    const result = await client({ fetch }).retrieve({
      query: "python",
      scope: "profile",
      profileRevision: 3,
      topK: 5
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.provider).toBe("lightrag");
  });

  it("rejects malformed or duplicate evidence instead of using it as a fact", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({
      provider: "lightrag",
      retrievalVersion: "profile-r3",
      scope: { kind: "profile", tenantScope: "tenant-a", profileRevision: 3 },
      evidence: [{
        evidenceId: "evidence-a",
        documentId: "resume-a",
        quoteHash: "a".repeat(64),
        score: 0.8
      }, {
        evidenceId: "evidence-a",
        documentId: "resume-a",
        quoteHash: "b".repeat(64),
        score: 0.7
      }]
    }));

    await expect(client({ fetch }).retrieve({
      query: "python",
      scope: "profile",
      profileRevision: 3,
      topK: 5
    })).rejects.toMatchObject({
      code: "retrieval_invalid_response"
    });
  });
});
