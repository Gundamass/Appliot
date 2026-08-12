import { ProfileFactSchema, RagFieldInspectionSchema, SelfEvaluationReviewSchema } from "@resume/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProfileApi, createRagApi, createSelfEvaluationReviewApi, ProfileApiError } from "./client.js";

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
  it("uploads an avatar through a separate image multipart endpoint", async () => {
    const fileId = "avatar-0f8fad5b-d9cb-469f-a165-70867728950e.webp";
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ fileId }), {
      status: 201,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createProfileApi().uploadAvatar(new File(["image"], "头像.webp", { type: "image/webp" })))
      .resolves.toEqual({ fileId });

    expect(fetchMock).toHaveBeenCalledWith("/api/profile/avatar", expect.objectContaining({ method: "POST", body: expect.any(FormData) }));
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(body.get("file")).toBeInstanceOf(File);
  });

  it("upserts a profile field with the strict profile input contract", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      ...fact,
      fieldPath: "awards[0].level",
      value: "国家级",
      status: "user_corrected",
      confidence: 1
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await createProfileApi().upsert("awards[0].level", "国家级");

    expect(fetchMock).toHaveBeenCalledWith("/api/profile/facts", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fieldPath: "awards[0].level", value: "国家级" })
    }));
  });

  it("removes profile fields in one strict batch request", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ removed: 2 }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createProfileApi().remove(["work[0].position", "work[0].title"]);

    expect(fetchMock).toHaveBeenCalledWith("/api/profile/facts", expect.objectContaining({
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fieldPaths: ["work[0].position", "work[0].title"] })
    }));
  });

  it("loads and validates the profile completeness projection", async () => {
    const completeness = {
      completed: 2,
      total: 3,
      sections: [{ id: "preferences", label: "求职偏好", completed: 2, total: 3, missing: ["preferences.targetCity"] }]
    };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(completeness), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createProfileApi().getCompleteness()).resolves.toEqual(completeness);
    expect(fetchMock).toHaveBeenCalledWith("/api/profile/completeness", { method: "GET" });
  });

  it("loads the latest imported resume summary", async () => {
    const document = {
      documentId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      filename: "何庆-简历.pdf",
      importedAt: "2026-08-04T06:32:00.000Z",
      extractedFactCount: 46
    };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ document }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createProfileApi().getLatestDocument()).resolves.toEqual(document);
    expect(fetchMock).toHaveBeenCalledWith("/api/profile/documents/latest", { method: "GET" });
  });

  it("returns undefined when no resume has been imported", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ document: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));

    await expect(createProfileApi().getLatestDocument()).resolves.toBeUndefined();
  });

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

  it("preserves the API error code and status for upload diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "Document already imported",
      code: "document_already_imported"
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" }
    })));

    await expect(createProfileApi().upload(new File(["%PDF"], "resume.pdf", { type: "application/pdf" })))
      .rejects.toMatchObject({
        name: "ProfileApiError",
        code: "document_already_imported",
        statusCode: 409
      } satisfies Partial<ProfileApiError>);
  });
});

describe("SelfEvaluationReviewApi HTTP contract", () => {
  const review = SelfEvaluationReviewSchema.parse({
    taskId: "task-1", jobDescription: "React role", original: "Original", draft: "Tailored", reasons: ["React emphasis"],
    evidence: [{ documentId: "user", page: 1, text: "Confirmed React", extraction: "user" }], unsupportedClaims: [], status: "needs_review",
    base: { factId: "self", revision: 1, original: "Original", evidence: [{ documentId: "user", page: 1, text: "Confirmed React", extraction: "user" }] }
  });

  it("creates and approves a stored review with strict request bodies", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => new Response(JSON.stringify({ ...review, status: "approved" }), {
      status: 200, headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createSelfEvaluationReviewApi();

    await api.create("task-1", "React role");
    await api.approve("task-1", "Edited");

    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ jobDescription: "React role" });
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

describe("RagApi HTTP contract", () => {
  const request = { taskId: "task-1", fieldId: "city", semantic: "preferences.city", label: "Preferred city", type: "text" as const };
  const inspection = RagFieldInspectionSchema.parse({
    request,
    plan: { semantic: "preferences.city", requestType: "text", requiredSources: ["application", "profile"], needsJobDescription: false, autoFillEligible: true, risk: "none", validators: [], strategy: ["exact", "keyword"], valid: true },
    decision: { fieldId: "city", status: "needs_question", evidence: [], confidence: 0, question: "Which city?", validators: [] }
  });

  it("resolves and corrects fields with strict server-owned evidence bodies", async () => {
    const correction = { ...fact, id: "answer", fieldPath: "preferences.city", value: "Shenzhen", status: "user_confirmed", scope: "application", taskId: "task-1" };
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => new Response(JSON.stringify(
      String((init as RequestInit).body).includes("Shenzhen")
        ? { correction, inspection: { ...inspection, decision: { ...inspection.decision, status: "verified_auto", value: "Shenzhen", question: undefined } } }
        : inspection
    ), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createRagApi();

    await api.resolve(request);
    await api.answer({ ...request, value: "Shenzhen" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/rag/fields/resolve");
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual(request);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/rag/fields/answer");
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({ ...request, value: "Shenzhen" });
  });
});
