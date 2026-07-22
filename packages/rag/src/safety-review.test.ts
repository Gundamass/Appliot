import { describe, expect, it, vi } from "vitest";
import type { Evidence, JsonValue, ProfileFact } from "@resume/contracts";
import type { ModelProvider } from "@resume/model-provider";
import {
  applyAnswer,
  createRagService,
  evidenceSupportsValue,
  planField,
  retrieveCandidates,
  type FieldAnswer,
  type FieldRequest,
  type KeywordSearchPort,
  type ProfileRepositoryPort
} from "./index.js";

const pmpRequest: FieldRequest = {
  taskId: "task-1",
  fieldId: "pmp",
  semantic: "certificates.pmp",
  label: "PMP certification",
  type: "text"
};

describe("review fix: evidence support", () => {
  it("accepts a focused user answer without incidental text", () => {
    expect(evidenceSupportsValue("task@example.com", [userEvidence("task@example.com")])).toBe(true);
  });

  it("accepts the profile correction audit format with exact JSON", () => {
    expect(evidenceSupportsValue({ city: "上海", remote: true }, [
      userEvidence('Corrected value: {"city":"上海","remote":true}')
    ])).toBe(true);
  });

  it("rejects user evidence that only contains the submitted value incidentally", () => {
    expect(evidenceSupportsValue("task@example.com", [
      userEvidence("Previous task@example.com address was rejected")
    ])).toBe(false);
  });

  it.each([
    ["case", "Ada", "ada"],
    ["string whitespace", "Ada  Lovelace", "Ada Lovelace"],
    ["audit JSON whitespace", "Ada  Lovelace", 'Corrected value: "Ada Lovelace"']
  ])("requires exact focused user encoding across %s", (_name, value, text) => {
    expect(evidenceSupportsValue(value, [userEvidence(text)])).toBe(false);
  });

  it("requires one evidence item to support the complete value", () => {
    expect(evidenceSupportsValue("project management", [
      pdfEvidence("project "),
      pdfEvidence("management")
    ])).toBe(false);
  });

  it.each([
    ["ASCII case and punctuation", "PMP", "Credentials: pMp, AWS.", true],
    ["ASCII token boundary", "PMP", "Built PMProject tooling.", false],
    ["ASCII exact email punctuation", "ada@example.com", "Email: ADA@EXAMPLE.COM.", true],
    ["Chinese phrase punctuation", "项目管理", "擅长项目管理，负责跨团队交付。", true],
    ["Chinese with ASCII term", "TypeScript", "熟练使用TypeScript，负责前端架构。", true],
    ["OCR punctuation", "PMP", "Credentials（PMP）；verified", true]
  ])("handles %s deterministically", (_name, value, text, supported) => {
    const item = _name === "OCR punctuation" ? ocrEvidence(text) : pdfEvidence(text);
    expect(evidenceSupportsValue(value, [item])).toBe(supported);
  });

  it.each([
    "does not hold PMP",
    "PMP certification: no",
    "The candidate lacks PMP certification.",
    "未持有PMP证书",
    "没有 PMP 认证"
  ])("rejects clear negation or contradiction near a term: %s", (text) => {
    expect(evidenceSupportsValue("PMP", [pdfEvidence(text)])).toBe(false);
  });

  it.each([
    [true, "The document says true."],
    [42, "Employee 42 delivered projects."],
    [null, "The optional field is null."],
    [["TypeScript"], "Skills include TypeScript."],
    [{ certified: true }, "Certified is true."]
  ] as Array<[JsonValue, string]>)
  ("rejects incidental PDF/OCR support for structured value %#", (value, text) => {
    expect(evidenceSupportsValue(value, [pdfEvidence(text)])).toBe(false);
  });

  it("never auto-verifies a negated exact fact", async () => {
    const candidate = fact({
      value: "PMP",
      evidence: [pdfEvidence("Candidate does not hold PMP certification.")]
    });

    const decision = await createRagService({ repository: repositoryWithExact(candidate) }).resolveField(pmpRequest);

    expect(decision.status).toBe("blocked");
    expect(decision.value).toBeUndefined();
  });

  it("never auto-verifies a structured PDF scalar substring", async () => {
    const request: FieldRequest = { ...pmpRequest, type: "boolean" };
    const candidate = fact({ value: true, evidence: [pdfEvidence("PMP: true")] });

    const decision = await createRagService({ repository: repositoryWithExact(candidate) }).resolveField(request);

    expect(decision.status).toBe("blocked");
    expect(decision.value).toBeUndefined();
  });

  it("applies an answer using exact correction audit evidence", () => {
    const repository = writableRepository();
    const answer: FieldAnswer = {
      taskId: "task-1",
      fieldId: "pmp",
      semantic: "certificates.pmp",
      label: "PMP certification",
      type: "boolean",
      value: false,
      evidence: [userEvidence("Corrected value: false")]
    };

    expect(applyAnswer(answer, repository)).toMatchObject({ value: false, scope: "application" });
    expect(repository.putTaskAnswer).toHaveBeenCalledOnce();
  });
});

describe("review fix: retrieval visibility and precedence", () => {
  it("blocks an exact profile fact carrying a taskId", async () => {
    const malformed = fact({ scope: "profile", taskId: "task-2" });

    const decision = await createRagService({ repository: repositoryWithExact(malformed) }).resolveField(pmpRequest);

    expect(decision.status).toBe("blocked");
  });

  it("blocks an exact application fact for another task", async () => {
    const otherTask = fact({ scope: "application", taskId: "task-2" });

    const decision = await createRagService({ repository: repositoryWithExact(otherTask) }).resolveField(pmpRequest);

    expect(decision.status).toBe("blocked");
  });

  it("invalidates malformed profile scope from keyword retrieval", async () => {
    const malformed = fact({ scope: "profile", taskId: "task-2" });

    const decision = await createRagService({
      repository: emptyRepository(),
      search: fakeSearch([malformed])
    }).resolveField(pmpRequest);

    expect(decision.status).toBe("blocked");
    expect(decision.value).toBeUndefined();
  });

  it("does not leak a keyword application fact from another task", async () => {
    const otherTask = fact({ scope: "application", taskId: "task-2" });

    const decision = await createRagService({
      repository: emptyRepository(),
      search: fakeSearch([otherTask])
    }).resolveField(pmpRequest);

    expect(decision.status).toBe("needs_question");
    expect(decision.value).toBeUndefined();
    expect(decision.evidence).toEqual([]);
  });

  it("uses matching-task keyword answers ahead of every profile lifecycle", async () => {
    const task = fact({ id: "task", value: "Task PMP", scope: "application", taskId: "task-1", evidence: [pdfEvidence("Task PMP")] });
    const corrected = fact({ id: "corrected", value: "Corrected PMP", status: "user_corrected", evidence: [pdfEvidence("Corrected PMP")] });
    const confirmed = fact({ id: "confirmed", value: "Confirmed PMP", status: "user_confirmed", evidence: [pdfEvidence("Confirmed PMP")] });

    const decision = await createRagService({
      repository: emptyRepository(),
      search: fakeSearch([confirmed, corrected, task])
    }).resolveField(pmpRequest);

    expect(decision).toMatchObject({ status: "needs_review", value: "Task PMP" });
    expect(decision.question).toBeUndefined();
  });

  it("uses corrected keyword facts without conflicting with stale confirmed or extracted facts", async () => {
    const corrected = fact({ id: "corrected", value: "Corrected PMP", status: "user_corrected", evidence: [pdfEvidence("Corrected PMP")] });
    const confirmed = fact({ id: "confirmed", value: "Confirmed PMP", status: "user_confirmed", evidence: [pdfEvidence("Confirmed PMP")] });
    const extracted = fact({ id: "extracted", value: "Extracted PMP", status: "extracted", evidence: [pdfEvidence("Extracted PMP")] });

    const decision = await createRagService({
      repository: emptyRepository(),
      search: fakeSearch([extracted, confirmed, corrected])
    }).resolveField(pmpRequest);

    expect(decision).toMatchObject({ status: "needs_review", value: "Corrected PMP" });
    expect(decision.question).toBeUndefined();
  });

  it("keeps distinct same-priority keyword values as a conflict", async () => {
    const first = fact({ id: "first", value: "PMP A", status: "user_corrected", evidence: [pdfEvidence("PMP A")] });
    const second = fact({ id: "second", value: "PMP B", status: "user_corrected", evidence: [pdfEvidence("PMP B")] });

    const decision = await createRagService({
      repository: emptyRepository(),
      search: fakeSearch([first, second])
    }).resolveField(pmpRequest);

    expect(decision.status).toBe("needs_question");
    expect(decision.question).toContain("conflicting values");
  });

  it("does not let embeddings erase same-priority long-text conflicts", async () => {
    const request: FieldRequest = {
      taskId: "task-1",
      fieldId: "intro",
      semantic: "application.selfIntroduction",
      label: "Self introduction",
      type: "textarea"
    };
    const first = fact({ id: "first", fieldPath: request.semantic, value: "Reliable TypeScript systems", evidence: [pdfEvidence("Reliable TypeScript systems")] });
    const second = fact({ id: "second", fieldPath: request.semantic, value: "Distributed storage systems", evidence: [pdfEvidence("Distributed storage systems")] });

    const decision = await createRagService({
      repository: emptyRepository(),
      search: fakeSearch([first, second]),
      modelProvider: fakeProvider([[1, 0], [1, 0], [0, 1]])
    }).resolveField(request);

    expect(decision.status).toBe("needs_question");
  });
});

describe("review fix: duplicate identities", () => {
  it("deduplicates canonically identical facts", async () => {
    const candidate = fact({ id: "duplicate", value: "PMP", evidence: [pdfEvidence("PMP")] });

    const decision = await createRagService({
      repository: emptyRepository(),
      search: fakeSearch([candidate, structuredClone(candidate)])
    }).resolveField(pmpRequest);

    expect(decision).toMatchObject({ status: "needs_review", value: "PMP" });
  });

  it.each(["forward", "reverse"])("invalidates a duplicate ID with different payload in %s order", async (order) => {
    const first = fact({ id: "duplicate", value: "PMP", evidence: [pdfEvidence("PMP")] });
    const second = fact({ id: "duplicate", value: "AWS", evidence: [pdfEvidence("AWS")] });
    const results = order === "forward" ? [first, second] : [second, first];

    const decision = await createRagService({
      repository: emptyRepository(),
      search: fakeSearch(results)
    }).resolveField(pmpRequest);

    expect(decision.status).toBe("blocked");
    expect(decision.value).toBeUndefined();
  });

  it("invalidates a duplicate ID whose evidence differs", async () => {
    const first = fact({ id: "duplicate", evidence: [pdfEvidence("PMP")] });
    const second = fact({ id: "duplicate", evidence: [pdfEvidence("PMP certification") ] });

    const decision = await createRagService({
      repository: emptyRepository(),
      search: fakeSearch([first, second])
    }).resolveField(pmpRequest);

    expect(decision.status).toBe("blocked");
  });
});

describe("review fix: numerically stable embeddings", () => {
  const request: FieldRequest = {
    taskId: "task-1",
    fieldId: "intro",
    semantic: "application.selfIntroduction",
    label: "Self introduction",
    type: "textarea"
  };

  it.each([
    ["huge", [[1e308, 1e308], [1e308, 1e308], [1e308, -1e308]]],
    ["tiny", [[1e-308, 1e-308], [1e-308, 1e-308], [1e-308, -1e-308]]]
  ])("returns finite in-range scores for %s finite components", async (_name, vectors) => {
    const first = fact({ id: "first", fieldPath: request.semantic, value: "First summary", evidence: [pdfEvidence("First summary")] });
    const second = fact({ id: "second", fieldPath: request.semantic, value: "Second summary", evidence: [pdfEvidence("Second summary")] });

    const retrieval = await retrieveCandidates(request, planField(request), {
      repository: emptyRepository(),
      search: fakeSearch([first, second]),
      modelProvider: fakeProvider(vectors)
    });

    expect(retrieval.invalidReason).toBeUndefined();
    expect(retrieval.candidates.map(({ fact }) => fact.id)).toEqual(["first", "second"]);
    for (const candidate of retrieval.candidates) {
      expect(Number.isFinite(candidate.score)).toBe(true);
      expect(candidate.score).toBeGreaterThanOrEqual(-1);
      expect(candidate.score).toBeLessThanOrEqual(1);
    }
  });

  it("preserves source order for equal cosine scores", async () => {
    const first = fact({ id: "z-first", fieldPath: request.semantic, value: "First summary", evidence: [pdfEvidence("First summary")] });
    const second = fact({ id: "a-second", fieldPath: request.semantic, value: "Second summary", evidence: [pdfEvidence("Second summary")] });

    const retrieval = await retrieveCandidates(request, planField(request), {
      repository: emptyRepository(),
      search: fakeSearch([first, second]),
      modelProvider: fakeProvider([[1, 0], [2, 0], [3, 0]])
    });

    expect(retrieval.candidates.map(({ fact }) => fact.id)).toEqual(["z-first", "a-second"]);
    expect(retrieval.candidates[0]?.score).toBe(retrieval.candidates[1]?.score);
  });

  it.each([
    ["dimensions", [[1, 0], [1], [1, 0]]],
    ["nonfinite", [[1, 0], [Number.POSITIVE_INFINITY, 0], [1, 0]]]
  ])("rejects malformed embedding %s", async (_name, vectors) => {
    const first = fact({ id: "first", fieldPath: request.semantic, value: "First summary", evidence: [pdfEvidence("First summary")] });
    const second = fact({ id: "second", fieldPath: request.semantic, value: "Second summary", evidence: [pdfEvidence("Second summary")] });

    const retrieval = await retrieveCandidates(request, planField(request), {
      repository: emptyRepository(),
      search: fakeSearch([first, second]),
      modelProvider: fakeProvider(vectors)
    });

    expect(retrieval.candidates).toEqual([]);
    expect(retrieval.invalidReason).toContain("embedding");
  });
});

function userEvidence(text: string): Evidence {
  return { documentId: "user", page: 1, text, extraction: "user" };
}

function pdfEvidence(text: string): Evidence {
  return { documentId: "resume", page: 1, text, extraction: "pdf_text" };
}

function ocrEvidence(text: string): Evidence {
  return { documentId: "resume", page: 1, text, extraction: "ocr" };
}

function fact(changes: Partial<ProfileFact> = {}): ProfileFact {
  return {
    id: "fact-1",
    fieldPath: "certificates.pmp",
    value: "PMP",
    status: "user_confirmed",
    confidence: 1,
    scope: "profile",
    evidence: [pdfEvidence("PMP")],
    revision: 1,
    ...changes
  };
}

function repositoryWithExact(exact: ProfileFact): ProfileRepositoryPort {
  return {
    resolveForTask: () => structuredClone(exact),
    listActive: () => [structuredClone(exact)],
    putTaskAnswer: vi.fn(),
    correct: vi.fn()
  };
}

function emptyRepository(): ProfileRepositoryPort {
  return {
    resolveForTask: () => undefined,
    listActive: () => [],
    putTaskAnswer: vi.fn(),
    correct: vi.fn()
  };
}

function writableRepository(): ProfileRepositoryPort & { putTaskAnswer: ReturnType<typeof vi.fn> } {
  return {
    resolveForTask: () => undefined,
    listActive: () => [],
    putTaskAnswer: vi.fn((taskId: string, fieldPath: string, value: JsonValue, evidence: Evidence[]) => fact({
      id: "answer-1",
      fieldPath,
      value,
      status: "user_confirmed",
      scope: "application",
      taskId,
      evidence
    })),
    correct: vi.fn()
  };
}

function fakeSearch(results: ProfileFact[]): KeywordSearchPort {
  return { search: vi.fn(async () => structuredClone(results)) };
}

function fakeProvider(vectors: number[][]): ModelProvider {
  return {
    embed: vi.fn(async () => structuredClone(vectors)),
    generateStructured: vi.fn(async () => {
      throw new Error("generation must not be used");
    })
  };
}
