import { describe, expect, it, vi } from "vitest";
import type { ProfileFact } from "@resume/contracts";
import type { ModelProvider } from "@resume/model-provider";
import { tailorSelfEvaluation } from "./self-evaluation.js";

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
      claims: [{ text: "React", kind: "emphasis", evidenceFactIds: ["react-fact"] }]
    });

    const result = await tailorSelfEvaluation({
      taskId: "task-1",
      original,
      jobDescription: "React engineer role",
      facts: [fact()]
    }, provider);

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
    expect(result.unsupportedClaims.map((item) => item.toLowerCase())).toContain(finding.toLowerCase());
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
});
