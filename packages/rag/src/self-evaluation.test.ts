import { describe, expect, it, vi } from "vitest";
import type { ProfileFact } from "@resume/contracts";
import type { ModelProvider } from "@resume/model-provider";
import { tailorSelfEvaluation, validateEditedSelfEvaluation } from "./self-evaluation.js";

const original = "Experienced TypeScript developer with React delivery experience.";

function fact(overrides: Partial<ProfileFact> = {}): ProfileFact {
  return {
    id: "react-fact",
    fieldPath: "skills",
    value: "React and TypeScript",
    status: "user_confirmed",
    confidence: 1,
    scope: "profile",
    evidence: [{ documentId: "user", page: 1, text: "Confirmed skills: React and TypeScript", extraction: "user" }],
    revision: 1,
    ...overrides
  };
}

function providerReturning(value: unknown): ModelProvider & { generateStructured: ReturnType<typeof vi.fn> } {
  const generateStructured = vi.fn(async () => value);
  return {
    generateStructured,
    embed: vi.fn(async () => [])
  } as unknown as ModelProvider & { generateStructured: ReturnType<typeof vi.fn> };
}

describe("self-evaluation tailoring", () => {
  it("keeps evidence-backed emphasis reviewable without changing the original", async () => {
    const provider = providerReturning({
      draft: "TypeScript developer with React delivery experience.",
      reasons: ["The role prioritizes React delivery."],
      claims: [{ text: "TypeScript developer with React delivery experience.", kind: "emphasis", evidenceFactIds: ["react-fact"] }]
    });

    const result = await tailorSelfEvaluation({
      taskId: "task-1",
      original,
      jobDescription: "React engineer role",
      facts: [fact()]
    }, provider);

    expect(result.unsupportedClaims).toEqual([]);
    expect(result.status).toBe("needs_review");
    expect(result.original).toBe(original);
    expect(result.unsupportedClaims).toEqual([]);
    expect(result.evidence).toEqual([fact().evidence[0]]);
    expect(provider.generateStructured.mock.calls[0]?.[0].schema).toBeDefined();
    expect(provider.generateStructured.mock.calls[0]?.[0].user).not.toContain("extracted-only");
  });

  it.each([
    ["Rust", "Rust developer"],
    ["5 years", "5 years of TypeScript experience"],
    ["40%", "Improved delivery by 40%"],
    ["PMP", "PMP certified developer"]
  ])("blocks an unsupported %s claim", async (unsupported, draft) => {
    const result = await tailorSelfEvaluation({ taskId: "task-1", original, jobDescription: "React role", facts: [fact()] }, providerReturning({
      draft,
      reasons: ["Match the job."],
      claims: [{ text: unsupported, kind: "evidence", evidenceFactIds: ["react-fact"] }]
    }));

    expect(result.status).toBe("blocked");
    expect(result.unsupportedClaims).toContain(unsupported);
  });

  it("excludes extracted and other-task facts from provider context and claim support", async () => {
    const extracted = fact({ id: "extracted-only", value: "Rust", status: "extracted" });
    const otherTask = fact({
      id: "other-task", value: "Rust", scope: "application", taskId: "task-2", status: "user_confirmed"
    });
    const provider = providerReturning({
      draft: "Rust developer",
      reasons: ["Match the job."],
      claims: [{ text: "Rust", kind: "evidence", evidenceFactIds: ["extracted-only", "other-task"] }]
    });

    const result = await tailorSelfEvaluation({ taskId: "task-1", original, jobDescription: "Rust role", facts: [extracted, otherTask] }, provider);

    expect(result.status).toBe("blocked");
    expect(result.unsupportedClaims).toContain("Rust");
    expect(JSON.parse(provider.generateStructured.mock.calls[0]?.[0].user ?? "{}").evidenceFacts).toEqual([]);
  });

  it("does not create an adoptable draft when the provider violates the strict output contract", async () => {
    const result = await tailorSelfEvaluation({ taskId: "task-1", original, jobDescription: "React role", facts: [fact()] }, providerReturning({ draft: 12 }));

    expect(result.status).toBe("blocked");
    expect(result.draft).toBe(original);
    expect(result.unsupportedClaims).toContain("Model output was malformed");
  });

  it("blocks claims whose evidence references are missing or do not cover the declared claim", async () => {
    const result = await tailorSelfEvaluation({ taskId: "task-1", original, jobDescription: "React role", facts: [fact()] }, providerReturning({
      draft: "Rust developer",
      reasons: ["Match the job."],
      claims: [{ text: "Rust", kind: "evidence", evidenceFactIds: ["missing"] }]
    }));

    expect(result.status).toBe("blocked");
    expect(result.unsupportedClaims).toContain("Rust");
  });

  it.each([
    ["C++ engineer", "C++"],
    ["R developer", "R"],
    ["拥有5年经验", "5年"],
    ["愿意出差", "愿意"],
    ["willing to travel", "willing"]
  ])("blocks an uncovered short, numeric, or commitment change: %s", async (draft, finding) => {
    const result = await tailorSelfEvaluation({ taskId: "task-1", original: "不愿意出差 and not willing to travel. Budget was $10,000 with 3 years experience.", jobDescription: "role", facts: [fact()] }, providerReturning({
      draft,
      reasons: ["Match the role."],
      claims: []
    }));

    expect(result.status).toBe("blocked");
    expect(result.unsupportedClaims.map((item) => item.toLowerCase()).some((item) => item.includes(finding.toLowerCase()) || item === "polarity could not be preserved")).toBe(true);
  });

  it("blocks a currency change as one material numeric claim", async () => {
    const result = await tailorSelfEvaluation({ taskId: "task-1", original: "Budget was USD 10,000.", jobDescription: "role", facts: [fact()] }, providerReturning({ draft: "Budget was USD 100,000.", reasons: ["Match."], claims: [] }));

    expect(result.status).toBe("blocked");
    expect(result.unsupportedClaims).toContain("usd 100,000");
  });

  it("blocks a material difference when claims are empty and rejects duplicate claim references", async () => {
    const emptyClaims = await tailorSelfEvaluation({ taskId: "task-1", original, jobDescription: "Go role", facts: [fact()] }, providerReturning({
      draft: "Go developer", reasons: ["Match the role."], claims: []
    }));
    const duplicateReferences = await tailorSelfEvaluation({ taskId: "task-1", original, jobDescription: "React role", facts: [fact()] }, providerReturning({
      draft: "React developer", reasons: ["Match the role."], claims: [{ text: "React", kind: "evidence", evidenceFactIds: ["react-fact", "react-fact"] }]
    }));

    expect(emptyClaims.status).toBe("blocked");
    expect(emptyClaims.unsupportedClaims.map((item) => item.toLowerCase())).toContain("go");
    expect(duplicateReferences.status).toBe("blocked");
    expect(duplicateReferences.unsupportedClaims).toContain("React");
  });

  it("requires a claim declaration for a changed clause even when its tokens already exist", async () => {
    const result = await tailorSelfEvaluation({ taskId: "task-1", original: "Experienced TypeScript developer with React delivery experience.", jobDescription: "role", facts: [fact()] }, providerReturning({
      draft: "TypeScript developer with React delivery experience.", reasons: ["Match."], claims: []
    }));

    expect(result.status).toBe("blocked");
    expect(result.unsupportedClaims).toContain("Changed clause lacks claim metadata");
  });

  it.each([
    ["Not PMP certified.", "PMP certified."],
    ["Not certified for production work.", "Certified for production work."],
    ["No degree requirement has been met.", "Degree requirement has been met."],
    ["Cannot travel for this role.", "Can travel for this role."],
    ["不持有证书。", "持有证书。"],
    ["无相关经验。", "有相关经验。"]
  ])("blocks a material polarity reversal from %s to %s", async (source, draft) => {
    const result = await tailorSelfEvaluation({ taskId: "task-1", original: source, jobDescription: "role", facts: [fact()] }, providerReturning({
      draft, reasons: ["Match the role."], claims: []
    }));

    expect(result.status).toBe("blocked");
    expect(result.unsupportedClaims).toContain("Polarity could not be preserved");
  });

  it("blocks adding a material negation that was absent from the original", async () => {
    const result = await tailorSelfEvaluation({ taskId: "task-1", original: "PMP certified.", jobDescription: "role", facts: [fact()] }, providerReturning({
      draft: "Not PMP certified.", reasons: ["Match the role."], claims: []
    }));

    expect(result.status).toBe("blocked");
    expect(result.unsupportedClaims).toContain("Polarity could not be preserved");
  });

  it("allows reordering that preserves a material negation", async () => {
    const result = await tailorSelfEvaluation({ taskId: "task-1", original: "Cannot travel, but delivery experience.", jobDescription: "role", facts: [fact()] }, providerReturning({
      draft: "Delivery experience, but cannot travel.", reasons: ["Reordered for clarity."], claims: [{ text: "Delivery experience, but cannot travel.", kind: "emphasis", evidenceFactIds: ["react-fact"] }]
    }));

    expect(result.unsupportedClaims).toEqual([]);
    expect(result.status).toBe("needs_review");
  });

  it.each(["Rust开发者", "Разработчик Rust", "러스트 개발자", "ラスト開発者", "مطور Rust"])("blocks an uncovered Unicode invention: %s", async (draft) => {
    const result = await tailorSelfEvaluation({ taskId: "task-1", original: "TypeScript developer", jobDescription: "role", facts: [fact()] }, providerReturning({
      draft, reasons: ["Match the role."], claims: []
    }));

    expect(result.status).toBe("blocked");
  });

  it("blocks conflicting duplicate eligible fact IDs before calling the provider", async () => {
    const provider = providerReturning({ draft: "React developer", reasons: ["Match."], claims: [] });
    const first = fact({ id: "duplicate", value: "React" });
    const conflicting = fact({ id: "duplicate", value: "Rust" });

    const result = await tailorSelfEvaluation({ taskId: "task-1", original, jobDescription: "role", facts: [first, conflicting] }, provider);

    expect(result.status).toBe("blocked");
    expect(result.unsupportedClaims).toContain("Conflicting eligible evidence fact IDs");
    expect(provider.generateStructured).not.toHaveBeenCalled();
  });

  it("deduplicates identical eligible facts independent of order", async () => {
    const output = { draft: "TypeScript developer with React delivery experience.", reasons: ["React emphasis."], claims: [{ text: "TypeScript developer with React delivery experience.", kind: "evidence" as const, evidenceFactIds: ["duplicate"] }] };
    const duplicate = fact({ id: "duplicate" });

    const forward = await tailorSelfEvaluation({ taskId: "task-1", original, jobDescription: "role", facts: [duplicate, { ...duplicate }] }, providerReturning(output));
    const reverse = await tailorSelfEvaluation({ taskId: "task-1", original, jobDescription: "role", facts: [{ ...duplicate }, duplicate] }, providerReturning(output));

    expect(forward).toMatchObject({ status: "needs_review", evidence: duplicate.evidence });
    expect(reverse).toEqual(forward);
  });

  it.each([
    ["3 years React. 5 years Java.", "5 years React. 3 years Java."],
    ["5 years React. 3 years Java.", "3 years React. 5 years Java."],
    ["20% project A. 40% project B.", "40% project A. 20% project B."],
    ["$10,000 responsibility A. $100,000 responsibility B.", "$100,000 responsibility A. $10,000 responsibility B."],
    ["PMP certified for React. AWS certified for Java.", "PMP certified for Java. AWS certified for React."]
  ])("blocks an association swap from %s to %s even with a broad draft claim", async (source, draft) => {
    const result = await tailorSelfEvaluation({ taskId: "task-1", original: source, jobDescription: "role", facts: [fact()] }, providerReturning({
      draft, reasons: ["Match."], claims: [{ text: draft, kind: "evidence", evidenceFactIds: ["react-fact"] }]
    }));

    expect(result.status).toBe("blocked");
    expect(result.unsupportedClaims).toContain("Clause relationship could not be established");
  });

  it("does not combine split evidence facts to authorize one relationship", async () => {
    const result = await tailorSelfEvaluation({ taskId: "task-1", original: "Experienced developer.", jobDescription: "role", facts: [
      fact({ id: "years", value: "5 years", evidence: [{ documentId: "user", page: 1, text: "5 years", extraction: "user" }] }),
      fact({ id: "react", value: "React", evidence: [{ documentId: "user", page: 1, text: "React", extraction: "user" }] })
    ] }, providerReturning({
      draft: "5 years React.", reasons: ["Match."], claims: [{ text: "5 years React", kind: "evidence", evidenceFactIds: ["years", "react"] }]
    }));

    expect(result.status).toBe("blocked");
    expect(result.unsupportedClaims).toContain("Clause relationship could not be established");
  });

  it("accepts a relationship when one referenced fact contains the whole relation", async () => {
    const relation = fact({ id: "react-years", value: "5 years React", evidence: [{ documentId: "user", page: 1, text: "5 years React", extraction: "user" }] });
    const result = await tailorSelfEvaluation({ taskId: "task-1", original: "Experienced developer.", jobDescription: "role", facts: [relation] }, providerReturning({
      draft: "5 years React.", reasons: ["Match."], claims: [{ text: "5 years React", kind: "evidence", evidenceFactIds: ["react-years"] }]
    }));

    expect(result.unsupportedClaims).toEqual([]);
    expect(result.status).toBe("needs_review");
  });

  it("accepts safe sentence reordering when each relationship is retained", async () => {
    const source = "3 years React. 5 years Java.";
    const result = await tailorSelfEvaluation({ taskId: "task-1", original: source, jobDescription: "role", facts: [fact()] }, providerReturning({
      draft: "5 years Java. 3 years React.", reasons: ["Reordered."], claims: [
        { text: "5 years Java", kind: "emphasis", evidenceFactIds: ["react-fact"] },
        { text: "3 years React", kind: "emphasis", evidenceFactIds: ["react-fact"] }
      ]
    }));

    expect(result.unsupportedClaims).toEqual([]);
    expect(result.status).toBe("needs_review");
  });

  it("rejects an edited association swap without claim metadata", () => {
    const unsupported = validateEditedSelfEvaluation("3 years React. 5 years Java.", "5 years React. 3 years Java.", [{ documentId: "resume", page: 1, text: "3 years React. 5 years Java.", extraction: "pdf_text" }]);

    expect(unsupported).toContain("Clause relationship could not be established");
  });
});
