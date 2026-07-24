import { describe, expect, it, vi } from "vitest";
import type { Evidence, JsonValue, ProfileFact } from "@resume/contracts";
import {
  applyAnswer,
  EmbeddingSearchUnavailableError,
  createRagService,
  planField,
  retrieveCandidates,
  verifyField,
  buildQuestion,
  type FieldAnswer,
  type FieldRequest,
  type EmbeddingSearchPort,
  type KeywordSearchInput,
  type KeywordSearchPort,
  type ProfileRepositoryPort
} from "./index.js";

const emailRequest: FieldRequest = {
  taskId: "task-1",
  fieldId: "email-control",
  semantic: "basics.email",
  label: "Email address",
  type: "text"
};

describe("RAG field resolution", () => {
  it("returns a confirmed exact field with evidence as verified_auto", async () => {
    const repository = fakeRepository([
      fact({ fieldPath: "basics.email", value: "me@example.com", status: "user_confirmed" })
    ]);

    const decision = await createRagService({ repository }).resolveField(emailRequest);

    expect(decision).toEqual({
      fieldId: "email-control",
      status: "verified_auto",
      value: "me@example.com",
      evidence: [evidence("me@example.com")],
      confidence: 1,
      validators: []
    });
  });

  it("asks instead of inventing a missing certificate", async () => {
    const request: FieldRequest = {
      taskId: "task-1",
      fieldId: "pmp-control",
      semantic: "certificates.pmp",
      label: "PMP certification",
      type: "boolean"
    };

    const decision = await createRagService({ repository: fakeRepository() }).resolveField(request);

    expect(decision).toMatchObject({
      fieldId: "pmp-control",
      status: "needs_question",
      value: undefined,
      evidence: [],
      confidence: 0,
      validators: []
    });
    expect(decision.question).toContain("PMP certification");
    expect(decision.question).toContain("certificates.pmp");
    expect(decision.question).toContain("no supported information was found");
    expect(decision.question).toContain("this application task only");
  });

  it("keeps extracted keyword evidence in needs_review", async () => {
    const extracted = fact({
      id: "extracted-city",
      fieldPath: "preferences.location",
      value: "Shanghai",
      status: "extracted",
      confidence: 0.96,
      evidence: [evidence("Preferred location: Shanghai", "pdf_text")]
    });
    const search = fakeSearch([extracted]);
    const request: FieldRequest = {
      taskId: "task-1",
      fieldId: "city-control",
      semantic: "preferences.city",
      label: "Preferred city",
      type: "text"
    };

    const decision = await createRagService({ repository: fakeRepository(), search }).resolveField(request);

    expect(decision).toMatchObject({
      status: "needs_review",
      value: "Shanghai",
      evidence: extracted.evidence,
      confidence: 0.96
    });
  });

  it("blocks unknown field semantics", async () => {
    const decision = await createRagService({ repository: fakeRepository() }).resolveField({
      ...emailRequest,
      semantic: "mystery.unmapped"
    });

    expect(decision).toMatchObject({
      fieldId: "email-control",
      status: "blocked",
      evidence: [],
      confidence: 0
    });
  });

  it("blocks an exact repository result for a different semantic", async () => {
    const repository = fakeRepository();
    repository.resolveForTask = vi.fn(() => fact({
      fieldPath: "basics.phone",
      value: "13800138000",
      evidence: [evidence("13800138000")]
    }));

    const decision = await createRagService({ repository }).resolveField(emailRequest);

    expect(decision.status).toBe("blocked");
    expect(decision.value).toBeUndefined();
  });

  it("uses exact task answer before corrected and confirmed profile facts", async () => {
    const corrected = fact({ id: "corrected", value: "corrected@example.com", status: "user_corrected" });
    const confirmed = fact({ id: "confirmed", value: "confirmed@example.com", status: "user_confirmed" });
    const taskAnswer = fact({
      id: "task-answer",
      value: "task@example.com",
      status: "user_confirmed",
      scope: "application",
      taskId: "task-1"
    });
    const repository = fakeRepository([confirmed, corrected], [taskAnswer]);
    const search = fakeSearch([confirmed]);

    const taskDecision = await createRagService({ repository, search }).resolveField(emailRequest);
    const otherTaskDecision = await createRagService({ repository, search }).resolveField({
      ...emailRequest,
      taskId: "task-2"
    });

    expect(taskDecision.value).toBe("task@example.com");
    expect(otherTaskDecision.value).toBe("corrected@example.com");
    expect(search.search).not.toHaveBeenCalled();
  });

  it("does not let a task answer leak into another task", async () => {
    const taskAnswer = fact({
      id: "task-answer",
      fieldPath: "preferences.city",
      value: "Shenzhen",
      status: "user_confirmed",
      scope: "application",
      taskId: "task-1"
    });
    const profile = fact({
      id: "profile-city",
      fieldPath: "preferences.city",
      value: "Shanghai",
      status: "user_confirmed"
    });
    const repository = fakeRepository([profile], [taskAnswer]);
    const request: FieldRequest = {
      taskId: "task-2",
      fieldId: "city-control",
      semantic: "preferences.city",
      label: "Preferred city",
      type: "text"
    };

    expect((await createRagService({ repository }).resolveField(request)).value).toBe("Shanghai");
  });

  it("falls back to the injected keyword search without pretending it is FTS", async () => {
    const candidate = fact({
      id: "keyword-result",
      fieldPath: "contact.email",
      value: "keyword@example.com",
      status: "user_confirmed"
    });
    const search = fakeSearch([candidate]);

    const decision = await createRagService({ repository: fakeRepository(), search }).resolveField(emailRequest);

    expect(search.search).toHaveBeenCalledWith({
      query: "Email address basics.email",
      semantic: "basics.email",
      taskId: "task-1",
      limit: 20
    });
    expect(decision).toMatchObject({ status: "needs_review", value: "keyword@example.com" });
  });

  it("does not pass unrelated job context to scalar retrieval", async () => {
    const search = fakeSearch([]);

    await createRagService({ repository: fakeRepository(), search }).resolveField({
      ...emailRequest,
      jobDescription: "Secret unrelated employer context"
    });

    expect(search.search).toHaveBeenCalledWith(expect.not.objectContaining({ jobDescription: expect.anything() }));
  });

  it("uses job description only for a planner-declared job-specific field", async () => {
    const search = fakeSearch([]);
    const request: FieldRequest = {
      taskId: "task-1",
      fieldId: "cover-letter",
      semantic: "application.coverLetter",
      label: "Cover letter",
      type: "textarea",
      jobDescription: "Build reliable distributed systems"
    };

    await createRagService({ repository: fakeRepository(), search }).resolveField(request);

    expect(search.search).toHaveBeenCalledWith(expect.objectContaining({
      jobDescription: "Build reliable distributed systems"
    }));
  });
});

describe("planning and layered retrieval", () => {
  it("keeps keyword candidates when semantic search is absent", async () => {
    const request: FieldRequest = {
      taskId: "task-1",
      fieldId: "cover-letter",
      semantic: "application.coverLetter",
      label: "Cover letter",
      type: "textarea"
    };
    const keyword = fact({ fieldPath: request.semantic, value: "Supported long text.", evidence: [evidence("Supported long text.")] });

    const retrieval = await retrieveCandidates(request, planField(request), {
      repository: fakeRepository(),
      search: fakeSearch([keyword])
    });

    expect(retrieval).toMatchObject({ candidates: [{ fact: { value: "Supported long text." }, source: "keyword" }] });
    expect(retrieval.invalidReason).toBeUndefined();
  });

  it("keeps keyword candidates when semantic search reports unavailability", async () => {
    const request: FieldRequest = {
      taskId: "task-1", fieldId: "cover-letter", semantic: "application.coverLetter", label: "Cover letter", type: "textarea"
    };
    const keyword = fact({ fieldPath: request.semantic, value: "Supported long text.", evidence: [evidence("Supported long text.")] });

    const retrieval = await retrieveCandidates(request, planField(request), {
      repository: fakeRepository(),
      search: fakeSearch([keyword]),
      embeddingSearch: { async search() { throw new EmbeddingSearchUnavailableError(); } }
    });

    expect(retrieval).toMatchObject({ candidates: [{ fact: { value: "Supported long text." }, source: "keyword" }] });
    expect(retrieval.invalidReason).toBeUndefined();
  });

  it("does not suppress unexpected semantic search defects", async () => {
    const defect = new TypeError("programming defect");
    const request: FieldRequest = {
      taskId: "task-1", fieldId: "cover-letter", semantic: "application.coverLetter", label: "Cover letter", type: "textarea"
    };

    await expect(retrieveCandidates(request, planField(request), {
      repository: fakeRepository(),
      search: fakeSearch([]),
      embeddingSearch: { async search() { throw defect; } }
    })).rejects.toBe(defect);
  });

  it("emits a normalized retrieval plan with safety metadata", () => {
    expect(planField({
      taskId: "task-1",
      fieldId: "cover-letter",
      semantic: " application.coverLetter ",
      label: " Cover letter ",
      type: "textarea",
      validators: ["maxLength:2000", "required", "required"],
      jobDescription: "A job"
    })).toEqual({
      semantic: "application.coverLetter",
      requestType: "textarea",
      requiredSources: ["application", "profile"],
      requiredRange: undefined,
      needsJobDescription: true,
      autoFillEligible: true,
      risk: "none",
      validators: ["maxLength:2000", "required"],
      strategy: ["exact", "keyword", "embedding"],
      valid: true
    });
  });

  it("marks sensitive commitments as ineligible for automatic filling", () => {
    expect(planField({
      taskId: "task-1",
      fieldId: "salary",
      semantic: "preferences.expectedSalary",
      label: "Expected salary",
      type: "text"
    })).toMatchObject({ autoFillEligible: false, risk: "sensitive_commitment", valid: true });
  });

  it.each([
    ["unsupported validator", { ...emailRequest, validators: ["sometimes"] }],
    ["invalid regex", { ...emailRequest, validators: ["pattern:["] }],
    ["invalid date boundary", { ...emailRequest, semantic: "basics.birthDate", type: "date" as const, validators: ["dateMin:2025-02-29"] }],
    ["inverted date range", { ...emailRequest, semantic: "basics.birthDate", type: "date" as const, validators: ["dateMin:2025-02-02", "dateMax:2025-02-01"] }]
  ])("blocks a malformed retrieval plan: %s", async (_name, request) => {
    const search = fakeSearch([]);

    const decision = await createRagService({ repository: fakeRepository(), search }).resolveField(request);

    expect(decision.status).toBe("blocked");
    expect(search.search).not.toHaveBeenCalled();
  });

  it("ranks long-text keyword candidates with deterministic cosine similarity", async () => {
    const first = fact({
      id: "first",
      fieldPath: "experience.summary",
      value: "I build reliable frontend systems with TypeScript.",
      status: "user_confirmed",
      evidence: [evidence("I build reliable frontend systems with TypeScript.")]
    });
    const second = fact({
      id: "second",
      fieldPath: "experience.summary",
      value: "I operate distributed storage services.",
      status: "user_confirmed",
      evidence: [evidence("I operate distributed storage services.")]
    });
    const embeddingSearch = fakeEmbeddingSearch([{ fact: first, score: 0.2 }, { fact: second, score: 1 }]);
    const request: FieldRequest = {
      taskId: "task-1",
      fieldId: "cover-letter",
      semantic: "application.coverLetter",
      label: "Cover letter",
      type: "textarea",
      jobDescription: "Distributed storage"
    };

    const plan = planField(request);
    const retrieval = await retrieveCandidates(request, plan, {
      repository: fakeRepository(),
      search: fakeSearch([first, second]),
      embeddingSearch
    });

    expect(embeddingSearch.search).toHaveBeenCalledWith({
      query: "Cover letter application.coverLetter\nDistributed storage",
      taskId: "task-1",
      limit: 20,
      jobDescription: "Distributed storage"
    });
    expect(retrieval.candidates.map(({ fact }) => fact.id)).toEqual(["second", "first"]);
  });

  it("never invokes embeddings for an exact scalar field", async () => {
    const embeddingSearch = fakeEmbeddingSearch([]);
    const repository = fakeRepository([
      fact({ value: "me@example.com", status: "user_confirmed" })
    ]);

    await createRagService({ repository, embeddingSearch }).resolveField(emailRequest);

    expect(embeddingSearch.search).not.toHaveBeenCalled();
  });

  it.each(["non-array", "missing score", "nonfinite score"])("blocks malformed embedding search %s", async (kind) => {
    const candidates = [
      fact({ id: "first", fieldPath: "experience.summary", value: "First supported summary." }),
      fact({ id: "second", fieldPath: "experience.summary", value: "Second supported summary." })
    ];
    const decision = await createRagService({
      repository: fakeRepository(),
      search: fakeSearch(candidates),
      embeddingSearch: fakeEmbeddingSearch(kind === "non-array" ? {} : [kind === "missing score" ? { fact: candidates[0] } : { fact: candidates[0], score: Number.NaN }])
    }).resolveField({
      taskId: "task-1",
      fieldId: "summary",
      semantic: "application.selfIntroduction",
      label: "Self introduction",
      type: "textarea"
    });

    expect(decision).toMatchObject({ status: "blocked", evidence: [], confidence: 0 });
  });

  it("exposes retriever invalid output instead of silently ranking it", async () => {
    const request: FieldRequest = {
      taskId: "task-1",
      fieldId: "summary",
      semantic: "application.selfIntroduction",
      label: "Self introduction",
      type: "textarea"
    };
    const plan = planField(request);
    const result = await retrieveCandidates(request, plan, {
      repository: fakeRepository(),
      search: fakeSearch([fact({ value: "Supported long text." })]),
      embeddingSearch: fakeEmbeddingSearch([{ fact: fact({ value: "Supported long text." }), score: Number.NaN }])
    });

    expect(result).toMatchObject({ candidates: [], invalidReason: "embedding search returned a malformed response" });
  });
});

describe("deterministic verification", () => {
  it("blocks a select value outside the supplied options", async () => {
    const decision = await resolveCandidate(
      { ...emailRequest, type: "select", options: ["Yes", "No"] },
      fact({ value: "Maybe", evidence: [evidence("Maybe")] })
    );

    expect(decision.status).toBe("blocked");
  });

  it.each(["2025-02-29", "2025-2-03", "not-a-date"])("blocks invalid strict date %s", async (value) => {
    const decision = await resolveCandidate(
      { ...emailRequest, semantic: "basics.birthDate", type: "date" },
      fact({ fieldPath: "basics.birthDate", value, evidence: [evidence(value)] })
    );

    expect(decision.status).toBe("blocked");
  });

  it("blocks dates inconsistent with a declared range", async () => {
    const decision = await resolveCandidate(
      {
        ...emailRequest,
        semantic: "basics.birthDate",
        type: "date",
        validators: ["dateMin:2000-01-01", "dateMax:2020-12-31"]
      },
      fact({ fieldPath: "basics.birthDate", value: "1999-12-31", evidence: [evidence("1999-12-31")] })
    );

    expect(decision.status).toBe("blocked");
  });

  it("blocks values with the wrong request type", async () => {
    const decision = await resolveCandidate(
      { ...emailRequest, semantic: "certificates.pmp", type: "boolean" },
      fact({ fieldPath: "certificates.pmp", value: "yes", evidence: [evidence("yes")] })
    );

    expect(decision.status).toBe("blocked");
  });

  it("blocks unsupported claims whose source evidence does not contain the value", async () => {
    const decision = await resolveCandidate(
      { ...emailRequest, semantic: "skills.primary" },
      fact({ fieldPath: "skills.primary", value: "Kubernetes", evidence: [evidence("TypeScript", "pdf_text")] })
    );

    expect(decision.status).toBe("blocked");
  });

  it("asks when eligible evidence-backed candidates conflict", async () => {
    const first = fact({ id: "first", value: "first@example.com", evidence: [evidence("first@example.com")] });
    const second = fact({ id: "second", value: "second@example.com", evidence: [evidence("second@example.com")] });
    const search = fakeSearch([first, second]);

    const decision = await createRagService({ repository: fakeRepository(), search }).resolveField(emailRequest);

    expect(decision.status).toBe("needs_question");
    expect(decision.value).toBeUndefined();
    expect(decision.evidence).toEqual([...first.evidence, ...second.evidence]);
    expect(decision.question).toContain("conflicting values");
    expect(decision.question).toContain("first@example.com");
    expect(decision.question).toContain("second@example.com");
    expect(decision.question).toContain("this application task only");
  });

  it("blocks a candidate with no evidence", async () => {
    const unsafe = { ...fact(), evidence: [] } as ProfileFact;

    const decision = await resolveCandidate(emailRequest, unsafe);

    expect(decision).toMatchObject({ status: "blocked", evidence: [], confidence: 0 });
  });

  it("blocks sensitive commitments even when supported", async () => {
    const decision = await resolveCandidate(
      { ...emailRequest, semantic: "preferences.expectedSalary", label: "Expected salary" },
      fact({ fieldPath: "preferences.expectedSalary", value: "CNY 30000", evidence: [evidence("CNY 30000")] })
    );

    expect(decision.status).toBe("blocked");
  });

  it("applies required, length, and pattern validators deterministically", async () => {
    const request: FieldRequest = {
      ...emailRequest,
      semantic: "basics.phone",
      validators: ["required", "minLength:11", "maxLength:11", "pattern:^1[0-9]{10}$"]
    };

    expect((await resolveCandidate(request, fact({ fieldPath: "basics.phone", value: "123" }))).status).toBe("blocked");
    expect((await resolveCandidate(
      request,
      fact({ fieldPath: "basics.phone", value: "13800138000", evidence: [evidence("13800138000")] })
    )).status).toBe("verified_auto");
  });

  it("returns a complete FieldDecision from the verifier", () => {
    const request = emailRequest;
    const plan = planField(request);
    const candidate = fact({ value: "me@example.com" });

    expect(verifyField(request, plan, { candidates: [{ fact: candidate, source: "exact", score: 1 }] })).toEqual({
      fieldId: "email-control",
      status: "verified_auto",
      value: "me@example.com",
      evidence: candidate.evidence,
      confidence: 1,
      validators: []
    });
  });

  it("builds deterministic aggregate-ready conflict questions", () => {
    expect(buildQuestion(emailRequest, "conflict", ["a@example.com", "b@example.com"]))
      .toBe("Please provide \"Email address\" (basics.email) for this application task only because the retrieved evidence has conflicting values: \"a@example.com\", \"b@example.com\".");
  });
});

describe("answer application and promotion", () => {
  it("stores an answer only for its task by default", () => {
    const repository = fakeRepository([
      fact({ id: "profile-email", value: "profile@example.com", status: "user_confirmed" })
    ]);
    const answer = fieldAnswer({ value: "task@example.com" });

    const stored = applyAnswer(answer, repository);

    expect(repository.putTaskAnswer).toHaveBeenCalledWith(
      "task-1",
      "basics.email",
      "task@example.com",
      answer.evidence
    );
    expect(repository.correct).not.toHaveBeenCalled();
    expect(stored).toMatchObject({ scope: "application", taskId: "task-1", value: "task@example.com" });
    expect(repository.resolveForTask("task-2", "basics.email")?.value).toBe("profile@example.com");
  });

  it("accepts valid user evidence without imposing a document-id naming convention", () => {
    const repository = fakeRepository();
    const answer = fieldAnswer({
      evidence: [evidence("task@example.com", "user", "answer-form")]
    });

    expect(applyAnswer(answer, repository)).toMatchObject({ value: "task@example.com" });
    expect(repository.putTaskAnswer).toHaveBeenCalledOnce();
  });

  it("promotes only with an explicit flag and explicit suitable profile target", () => {
    const target = fact({ id: "profile-email", value: "old@example.com", status: "user_confirmed" });
    const repository = fakeRepository([target]);
    const answer = fieldAnswer({
      value: "new@example.com",
      evidence: [evidence("new@example.com", "user", "user:task-1")],
      promoteToProfile: true,
      profileFactId: target.id
    });

    const stored = applyAnswer(answer, repository);

    expect(repository.correct).toHaveBeenCalledWith(target.id, "new@example.com", answer.evidence);
    expect(repository.putTaskAnswer).not.toHaveBeenCalled();
    expect(stored).toMatchObject({ id: target.id, scope: "profile", status: "user_corrected", value: "new@example.com" });
  });

  it.each([
    { name: "missing explicit flag", changes: { profileFactId: "profile-email" } },
    { name: "missing target", changes: { promoteToProfile: true } },
    { name: "unknown target", changes: { promoteToProfile: true, profileFactId: "missing" } },
    { name: "wrong semantic target", changes: { promoteToProfile: true, profileFactId: "profile-city" } },
    { name: "application target", changes: { promoteToProfile: true, profileFactId: "task-email" } }
  ])("rejects invalid promotion: $name", ({ changes }) => {
    const repository = fakeRepository([
      fact({ id: "profile-email", value: "profile@example.com" }),
      fact({ id: "profile-city", fieldPath: "preferences.city", value: "Shanghai" })
    ], [
      fact({ id: "task-email", scope: "application", taskId: "task-1" })
    ]);

    expect(() => applyAnswer(fieldAnswer(changes), repository)).toThrow();
    expect(repository.correct).not.toHaveBeenCalled();
    expect(repository.putTaskAnswer).not.toHaveBeenCalled();
  });

  it.each([
    { name: "wrong type", changes: { value: true } },
    { name: "empty evidence", changes: { evidence: [] } },
    { name: "non-user evidence", changes: { evidence: [evidence("task@example.com", "pdf_text")] } },
    { name: "profile scope without promotion", changes: { scope: "profile" as const } }
  ])("validates before any repository mutation: $name", ({ changes }) => {
    const repository = fakeRepository([fact({ id: "profile-email" })]);

    expect(() => applyAnswer(fieldAnswer(changes), repository)).toThrow();
    expect(repository.correct).not.toHaveBeenCalled();
    expect(repository.putTaskAnswer).not.toHaveBeenCalled();
  });

  it("offers applyAnswer through the composed service", () => {
    const repository = fakeRepository();
    const service = createRagService({ repository });

    expect(service.applyAnswer(fieldAnswer())).toMatchObject({
      scope: "application",
      taskId: "task-1",
      fieldPath: "basics.email"
    });
  });
});

async function resolveCandidate(request: FieldRequest, candidate: ProfileFact) {
  return createRagService({
    repository: fakeRepository([candidate])
  }).resolveField(request);
}

function fieldAnswer(changes: Partial<FieldAnswer> = {}): FieldAnswer {
  return {
    taskId: "task-1",
    fieldId: "email-control",
    semantic: "basics.email",
    label: "Email address",
    type: "text",
    value: "task@example.com",
    evidence: [evidence("task@example.com", "user", "user:task-1")],
    ...changes
  };
}

function evidence(
  text: string,
  extraction: Evidence["extraction"] = "user",
  documentId = extraction === "user" ? "user:task-1" : "resume-1"
): Evidence {
  return { documentId, page: 1, text, extraction };
}

function fact(changes: Partial<ProfileFact> = {}): ProfileFact {
  const value = changes.value ?? "me@example.com";
  return {
    id: "fact-1",
    fieldPath: "basics.email",
    value,
    status: "user_confirmed",
    confidence: 1,
    scope: "profile",
    evidence: [evidence(typeof value === "string" ? value : JSON.stringify(value))],
    revision: 1,
    ...changes
  };
}

function fakeRepository(
  profileFacts: ProfileFact[] = [],
  taskFacts: ProfileFact[] = []
): ProfileRepositoryPort & {
  putTaskAnswer: ReturnType<typeof vi.fn>;
  correct: ReturnType<typeof vi.fn>;
} {
  const profiles = [...profileFacts];
  const tasks = [...taskFacts];

  const repository = {
    resolveForTask(taskId: string, semantic: string): ProfileFact | undefined {
      const task = tasks.find((candidate) => candidate.taskId === taskId && candidate.fieldPath === semantic);
      if (task) return structuredClone(task);
      return structuredClone(profiles
        .filter((candidate) => candidate.fieldPath === semantic && candidate.scope === "profile")
        .sort((left, right) => statusPriority(left.status) - statusPriority(right.status))[0]);
    },
    listActive(): ProfileFact[] {
      return structuredClone([...profiles, ...tasks]);
    },
    history(): ProfileFact[] {
      return [];
    },
    putTaskAnswer: vi.fn((taskId: string, fieldPath: string, value: JsonValue, answerEvidence: Evidence[]) => {
      const stored = fact({
        id: `answer-${taskId}-${fieldPath}`,
        fieldPath,
        value,
        status: "user_confirmed",
        scope: "application",
        taskId,
        evidence: answerEvidence
      });
      const existing = tasks.findIndex((candidate) => candidate.taskId === taskId && candidate.fieldPath === fieldPath);
      if (existing >= 0) tasks[existing] = stored;
      else tasks.push(stored);
      return structuredClone(stored);
    }),
    correct: vi.fn((factId: string, value: JsonValue, answerEvidence: Evidence[]) => {
      const index = profiles.findIndex((candidate) => candidate.id === factId);
      if (index < 0) throw new Error(`profile fact not found: ${factId}`);
      const current = profiles[index]!;
      const corrected = fact({
        ...current,
        value,
        evidence: answerEvidence,
        status: "user_corrected",
        confidence: 1,
        revision: current.revision + 1
      });
      profiles[index] = corrected;
      return structuredClone(corrected);
    })
  };

  return repository;
}

function statusPriority(status: ProfileFact["status"]): number {
  if (status === "user_corrected") return 0;
  if (status === "user_confirmed") return 1;
  return 2;
}

function fakeSearch(results: ProfileFact[]): KeywordSearchPort & { search: ReturnType<typeof vi.fn> } {
  return {
    search: vi.fn(async (_input: KeywordSearchInput) => structuredClone(results))
  };
}

function fakeEmbeddingSearch(results: unknown): EmbeddingSearchPort & { search: ReturnType<typeof vi.fn> } {
  return {
    search: vi.fn(async () => structuredClone(results))
  } as unknown as EmbeddingSearchPort & { search: ReturnType<typeof vi.fn> };
}
