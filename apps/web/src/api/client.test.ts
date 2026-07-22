import { ProfileFactSchema, SelfEvaluationReviewSchema } from "@resume/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProfileApi, createSelfEvaluationReviewApi } from "./client.js";

const fact = ProfileFactSchema.parse({
  id: "fact-1",
  fieldPath: "basics.email",
  value: "ada@example.com",
  status: "extracted",
  confidence: 0.9,
  scope: "profile",
  evidence: [{ documentId: "fingerprint", page: 1, text: "ada@example.com", extraction: "pdf_text" }],
  revision: 1
});

afterEach(() => vi.unstubAllGlobals());

describe("ProfileApi HTTP contract", () => {
  it("sends confirmation with no body and parses the returned fact", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ...fact, status: "user_confirmed" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createProfileApi().confirm("fact/with space");

    expect(fetchMock).toHaveBeenCalledWith("/api/profile/facts/fact%2Fwith%20space/confirm", expect.objectContaining({
      method: "POST"
    }));
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("body");
  });

  it("sends correction with exactly the value key", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ...fact, value: 9, status: "user_corrected" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createProfileApi().correct("fact-1", 9);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ value: 9 });
    expect(Object.keys(JSON.parse(String(init.body)))).toEqual(["value"]);
  });

  it("uploads under the file multipart field and accepts the strict Task 5 response", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      documentId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      fingerprint: "a".repeat(64)
    }), { status: 202, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["%PDF"], "resume.pdf", { type: "application/pdf" });

    await expect(createProfileApi().upload(file)).resolves.toEqual({ documentId: "0f8fad5b-d9cb-469f-a165-70867728950e" });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("file")).toBe(file);
    expect((init.headers as Record<string, string> | undefined)?.["Content-Type"]).toBeUndefined();
  });

  it("parses list and mutation responses through the shared contract", async () => {
    const invalid = { ...fact, confidence: 4 };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(invalid), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));

    await expect(createProfileApi().confirm("fact-1")).rejects.toThrow();
  });

  it("surfaces API error messages without trusting malformed responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Document already imported" }), {
      status: 409,
      headers: { "Content-Type": "application/json" }
    })));

    await expect(createProfileApi().upload(new File(["%PDF"], "resume.pdf", { type: "application/pdf" })))
      .rejects.toThrow("Document already imported");
  });
});

describe("SelfEvaluationReviewApi HTTP contract", () => {
  const review = SelfEvaluationReviewSchema.parse({
    taskId: "task-1", original: "Original", draft: "Tailored", reasons: ["React emphasis"],
    evidence: [{ documentId: "user", page: 1, text: "Confirmed React", extraction: "user" }], unsupportedClaims: [], status: "needs_review",
    base: { factId: "self", revision: 1, original: "Original", evidence: [{ documentId: "user", page: 1, text: "Confirmed React", extraction: "user" }] }
  });

  it("creates and approves a stored review with strict request bodies", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => new Response(JSON.stringify({ ...review, status: "approved" }), {
      status: 200, headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createSelfEvaluationReviewApi();

    await api.create("task-1", "React role", { draft: "Tailored", reasons: ["React emphasis"], claims: [{ text: "React", kind: "evidence", evidenceFactIds: ["react"] }] });
    await api.approve("task-1", "Edited");

    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ jobDescription: "React role", draft: { draft: "Tailored", reasons: ["React emphasis"], claims: [{ text: "React", kind: "evidence", evidenceFactIds: ["react"] }] } });
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({ editedDraft: "Edited" });
  });

  it("parses review responses and keeps promotion separate", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ...review, status: "approved" }), {
      status: 200, headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createSelfEvaluationReviewApi().promote("task/1");

    expect(fetchMock).toHaveBeenCalledWith("/api/reviews/self-evaluations/task%2F1/promote", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({});
  });
});
