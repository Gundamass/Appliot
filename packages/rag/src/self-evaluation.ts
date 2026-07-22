import {
  SelfEvaluationDraftSchema,
  SelfEvaluationGeneratedDraftSchema,
  type Evidence,
  type ProfileFact,
  type SelfEvaluationDraft,
  type SelfEvaluationGeneratedDraft
} from "@resume/contracts";
import type { ModelProvider } from "@resume/model-provider";

export interface TailorSelfEvaluationInput { taskId: string; original: string; jobDescription: string; facts: ProfileFact[]; }

export async function tailorSelfEvaluation(input: TailorSelfEvaluationInput, provider: ModelProvider): Promise<SelfEvaluationDraft> {
  const eligibleFacts = input.facts.filter((fact) => eligibleForTask(fact, input.taskId));
  try {
    const output = SelfEvaluationGeneratedDraftSchema.parse(await provider.generateStructured({
      system: "Tailor only the supplied self-evaluation. Do not invent facts. Declare every new material claim with evidence fact IDs.",
      user: JSON.stringify({ original: input.original, jobDescription: input.jobDescription, evidenceFacts: eligibleFacts.map(toFactInput) }),
      schema: SelfEvaluationGeneratedDraftSchema
    }));
    return buildSelfEvaluationDraft(input.taskId, input.original, output, eligibleFacts);
  } catch {
    return blocked(input.taskId, input.original, "Model output was malformed");
  }
}

export function buildSelfEvaluationDraft(taskId: string, original: string, output: SelfEvaluationGeneratedDraft, facts: ProfileFact[]): SelfEvaluationDraft {
  const parsed = SelfEvaluationGeneratedDraftSchema.parse(output);
  const eligibleFacts = facts.filter((fact) => eligibleForTask(fact, taskId));
  const unsupportedClaims = verifyClaims(original, parsed, eligibleFacts);
  return SelfEvaluationDraftSchema.parse({
    taskId, original, draft: parsed.draft, reasons: parsed.reasons, evidence: referencedEvidence(parsed, eligibleFacts), unsupportedClaims,
    status: unsupportedClaims.length === 0 ? "needs_review" : "blocked"
  });
}

export function validateEditedSelfEvaluation(original: string, draft: string, evidence: Evidence[]): string[] {
  return uncoveredMaterial(original, draft, evidence.flatMap((item) => item.text ? [item.text] : []));
}

function verifyClaims(original: string, output: SelfEvaluationGeneratedDraft, facts: ProfileFact[]): string[] {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const supported = new Set<string>();
  const unsupported = new Set<string>();
  for (const claim of output.claims) {
    if (!containsText(output.draft, claim.text) || new Set(claim.evidenceFactIds).size !== claim.evidenceFactIds.length) { unsupported.add(claim.text); continue; }
    const referenced = claim.evidenceFactIds.map((id) => byId.get(id));
    if (referenced.some((fact) => fact === undefined)) { unsupported.add(claim.text); continue; }
    const sources = referenced.flatMap((fact) => fact ? [JSON.stringify(fact.value), ...fact.evidence.map((item) => item.text)] : []);
    const claimGaps = uncoveredMaterial(original, claim.text, sources);
    if (claimGaps.length > 0) { unsupported.add(claim.text); continue; }
    materialUnits(claim.text).forEach((unit) => supported.add(unit));
  }
  for (const unit of materialUnits(output.draft)) {
    if (!materialUnits(original).includes(unit) && !supported.has(unit)) unsupported.add(display(unit));
  }
  return [...unsupported];
}

function uncoveredMaterial(original: string, draft: string, sources: string[]): string[] {
  const baseline = new Set([...materialUnits(original), ...sources.flatMap(materialUnits)]);
  return materialUnits(draft).filter((unit, index, all) => !baseline.has(unit) && all.indexOf(unit) === index).map(display);
}

function eligibleForTask(fact: ProfileFact, taskId: string): boolean {
  return (fact.status === "user_confirmed" || fact.status === "user_corrected") && (fact.scope === "profile" || (fact.scope === "application" && fact.taskId === taskId));
}

function toFactInput(fact: ProfileFact) { return { id: fact.id, fieldPath: fact.fieldPath, value: fact.value, evidence: fact.evidence }; }

function referencedEvidence(output: SelfEvaluationGeneratedDraft, facts: ProfileFact[]): Evidence[] {
  const ids = new Set(output.claims.flatMap((claim) => claim.evidenceFactIds));
  const seen = new Set<string>();
  return facts.filter((fact) => ids.has(fact.id)).flatMap((fact) => fact.evidence).filter((item) => {
    const key = JSON.stringify(item); if (seen.has(key)) return false; seen.add(key); return true;
  });
}

function blocked(taskId: string, original: string, finding: string): SelfEvaluationDraft {
  return SelfEvaluationDraftSchema.parse({ taskId, original, draft: original, reasons: ["The tailoring response could not be safely verified."], evidence: [], unsupportedClaims: [finding], status: "blocked" });
}

const GENERIC = new Set(["and", "with", "the", "for", "from", "that", "this", "focused", "focus", "strong", "experienced", "experience", "developer", "engineer", "delivery", "ability", "skills", "skill", "工作", "经验", "能力", "负责", "具备", "相关", "岗位", "项目", "团队", "开发", "交付", "技术"]);
const POLARITIES: Array<[string, string]> = [["not willing", "neg:not_willing"], ["willing", "pos:willing"], ["no travel", "neg:travel"], ["travel", "pos:travel"], ["不愿意", "neg:愿意"], ["愿意", "pos:愿意"], ["不接受", "neg:接受"], ["接受", "pos:接受"]];

function materialUnits(text: string): string[] {
  const normalized = normalize(text);
  const numbers = normalized.match(/(?:[$￥¥]|usd\s*)?\d[\d,]*(?:\.\d+)?\s*(?:%|years?|年|个月|万|k)?/gu) ?? [];
  const technical = normalized.match(/\b(?:c\+\+|c#|go|[cr])\b/gu) ?? [];
  const words = normalized.match(/[a-z][a-z0-9+#.-]*|[\p{Script=Han}]{2,}/gu) ?? [];
  const polarity = POLARITIES.filter(([phrase, unit]) => normalized.includes(phrase) && !coveredByNegative(normalized, unit)).map(([, unit]) => unit);
  const polarityWords = new Set(["willing", "travel", "愿意", "接受"]);
  return [...numbers, ...technical, ...words.filter((word) => !polarityWords.has(word)), ...polarity]
    .map(normalize)
    .filter((unit) => unit.length > 0 && !GENERIC.has(unit))
    .filter((unit, index, all) => all.indexOf(unit) === index);
}

function normalize(text: string): string { return text.toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim(); }
function display(unit: string): string { return unit.replace(/^pos:/, "").replace(/^neg:/, "not "); }
function containsText(haystack: string, needle: string): boolean { return normalize(haystack).includes(normalize(needle)); }
function coveredByNegative(text: string, unit: string): boolean {
  return (unit === "pos:willing" && text.includes("not willing"))
    || (unit === "pos:travel" && text.includes("no travel"))
    || (unit === "pos:愿意" && text.includes("不愿意"))
    || (unit === "pos:接受" && text.includes("不接受"));
}
