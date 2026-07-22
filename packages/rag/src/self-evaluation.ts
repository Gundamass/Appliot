import { SelfEvaluationDraftSchema, type Evidence, type ProfileFact, type SelfEvaluationDraft } from "@resume/contracts";
import type { ModelProvider } from "@resume/model-provider";
import { z } from "zod";

const ModelTailoringSchema = z.object({
  draft: z.string().min(1).max(12_000),
  reasons: z.array(z.string().min(1).max(1_000)).min(1).max(12),
  claims: z.array(z.object({
    text: z.string().min(1).max(500),
    kind: z.enum(["emphasis", "evidence"]),
    evidenceFactIds: z.array(z.string().min(1)).min(1).max(12)
  }).strict()).max(50)
}).strict();

export interface TailorSelfEvaluationInput {
  taskId: string;
  original: string;
  jobDescription: string;
  facts: ProfileFact[];
}

type ModelTailoring = z.infer<typeof ModelTailoringSchema>;

export async function tailorSelfEvaluation(input: TailorSelfEvaluationInput, provider: ModelProvider): Promise<SelfEvaluationDraft> {
  const eligibleFacts = input.facts.filter((fact) => eligibleForTask(fact, input.taskId));
  try {
    const raw = await provider.generateStructured({
      system: "Tailor only the supplied self-evaluation. Do not invent facts. Declare every new material claim with evidence fact IDs.",
      user: JSON.stringify({
        original: input.original,
        jobDescription: input.jobDescription,
        evidenceFacts: eligibleFacts.map((fact) => ({ id: fact.id, fieldPath: fact.fieldPath, value: fact.value, evidence: fact.evidence }))
      }),
      schema: ModelTailoringSchema
    });
    const output = ModelTailoringSchema.parse(raw);
    const unsupportedClaims = verifyClaims(input.original, output, eligibleFacts);
    return SelfEvaluationDraftSchema.parse({
      taskId: input.taskId,
      original: input.original,
      draft: output.draft,
      reasons: output.reasons,
      evidence: referencedEvidence(output, eligibleFacts),
      unsupportedClaims,
      status: unsupportedClaims.length === 0 ? "needs_review" : "blocked"
    });
  } catch {
    return SelfEvaluationDraftSchema.parse({
      taskId: input.taskId,
      original: input.original,
      draft: input.original,
      reasons: ["The tailoring response could not be safely verified."],
      evidence: [],
      unsupportedClaims: ["Model output was malformed"],
      status: "blocked"
    });
  }
}

export function validateEditedSelfEvaluation(original: string, draft: string, evidence: Evidence[]): string[] {
  const support = `${original}\n${evidence.map((item) => item.text).join("\n")}`;
  return materialTokens(draft)
    .filter((token) => !containsToken(original, token) && !containsToken(support, token))
    .filter((token, index, tokens) => tokens.indexOf(token) === index);
}

function eligibleForTask(fact: ProfileFact, taskId: string): boolean {
  return (fact.status === "user_confirmed" || fact.status === "user_corrected")
    && (fact.scope === "profile" || (fact.scope === "application" && fact.taskId === taskId));
}

function verifyClaims(original: string, output: ModelTailoring, facts: ProfileFact[]): string[] {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const unsupported = new Set<string>();
  const supportedTokens = new Set<string>();

  for (const claim of output.claims) {
    if (!containsText(output.draft, claim.text)) {
      unsupported.add(claim.text);
      continue;
    }
    const referenced = claim.evidenceFactIds.map((id) => byId.get(id)).filter((fact): fact is ProfileFact => fact !== undefined);
    if (referenced.length !== claim.evidenceFactIds.length) {
      unsupported.add(claim.text);
      continue;
    }
    const source = referenced.map((fact) => `${JSON.stringify(fact.value)}\n${fact.evidence.map((item) => item.text).join("\n")}`).join("\n");
    const claimTokens = materialTokens(claim.text);
    const unsupportedClaimTokens = claimTokens.filter((token) => !containsToken(original, token) && !containsToken(source, token));
    if (unsupportedClaimTokens.length > 0) {
      unsupported.add(claim.text);
      continue;
    }
    claimTokens.forEach((token) => supportedTokens.add(token));
  }

  for (const token of materialTokens(output.draft)) {
    if (!containsToken(original, token) && !supportedTokens.has(token)) unsupported.add(token);
  }
  return [...unsupported];
}

function referencedEvidence(output: ModelTailoring, facts: ProfileFact[]): Evidence[] {
  const ids = new Set(output.claims.flatMap((claim) => claim.evidenceFactIds));
  const seen = new Set<string>();
  return facts.filter((fact) => ids.has(fact.id)).flatMap((fact) => fact.evidence).filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const GENERIC_TOKENS = new Set([
  "and", "with", "the", "for", "from", "that", "this", "focused", "focus", "strong", "experienced", "experience", "developer", "engineer", "delivery", "ability", "skills", "skill", "工作", "经验", "能力", "负责", "具备", "相关", "岗位", "项目", "团队", "开发", "交付", "技术"
]);

function materialTokens(text: string): string[] {
  const metrics = text.match(/\d+(?:\.\d+)?\s*(?:%|years?|个月|年)/giu) ?? [];
  const words = text.match(/[A-Za-z][A-Za-z0-9+#.-]*|[\p{Script=Han}]{2,}/gu) ?? [];
  return [...metrics, ...words]
    .map((token) => normalize(token))
    .filter((token) => token.length > 1 && !GENERIC_TOKENS.has(token));
}

function normalize(text: string): string {
  return text.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function containsText(haystack: string, needle: string): boolean {
  return normalize(haystack).includes(normalize(needle));
}

function containsToken(haystack: string, token: string): boolean {
  return materialTokens(haystack).includes(normalize(token));
}
