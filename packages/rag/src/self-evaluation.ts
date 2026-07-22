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
  let eligibleFacts: ProfileFact[];
  try { eligibleFacts = canonicalEligibleFacts(input.facts, input.taskId); }
  catch { return blocked(input.taskId, input.original, "Conflicting eligible evidence fact IDs"); }
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
  let eligibleFacts: ProfileFact[];
  try { eligibleFacts = canonicalEligibleFacts(facts, taskId); }
  catch { return blocked(taskId, original, "Conflicting eligible evidence fact IDs"); }
  const unsupportedClaims = verifyClaims(original, parsed, eligibleFacts);
  return SelfEvaluationDraftSchema.parse({
    taskId, original, draft: parsed.draft, reasons: parsed.reasons, evidence: referencedEvidence(parsed, eligibleFacts), unsupportedClaims,
    status: unsupportedClaims.length === 0 ? "needs_review" : "blocked"
  });
}

export function validateEditedSelfEvaluation(original: string, draft: string, evidence: Evidence[]): string[] {
  const unsupported = uncoveredMaterial(original, draft, evidence.flatMap((item) => item.text ? [item.text] : []));
  if (!polarityPreserved(original, draft)) unsupported.push("Polarity could not be preserved");
  return [...new Set(unsupported)];
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
  if (hasUnclaimedChangedClause(original, output)) unsupported.add("Changed clause lacks claim metadata");
  if (!polarityPreserved(original, output.draft)) unsupported.add("Polarity could not be preserved");
  return [...unsupported];
}

function uncoveredMaterial(original: string, draft: string, sources: string[]): string[] {
  const baseline = new Set([...materialUnits(original), ...sources.flatMap(materialUnits)]);
  return materialUnits(draft).filter((unit, index, all) => !baseline.has(unit) && all.indexOf(unit) === index).map(display);
}

function eligibleForTask(fact: ProfileFact, taskId: string): boolean {
  return (fact.status === "user_confirmed" || fact.status === "user_corrected") && (fact.scope === "profile" || (fact.scope === "application" && fact.taskId === taskId));
}

function canonicalEligibleFacts(facts: ProfileFact[], taskId: string): ProfileFact[] {
  const canonical = new Map<string, ProfileFact>();
  for (const fact of facts.filter((item) => eligibleForTask(item, taskId))) {
    const existing = canonical.get(fact.id);
    if (existing && stableJson(existing) !== stableJson(fact)) throw new Error("conflicting fact IDs");
    if (!existing) canonical.set(fact.id, fact);
  }
  return [...canonical.values()].sort((left, right) => left.id.localeCompare(right.id));
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

const GENERIC = new Set(["and", "but", "with", "the", "for", "from", "that", "this", "can", "work", "focused", "focus", "strong", "experienced", "experience", "developer", "engineer", "delivery", "ability", "skills", "skill", "工作", "经验", "能力", "负责", "具备", "相关", "岗位", "项目", "团队", "开发", "交付", "技术"]);
const ENGLISH_NEGATION = /\b(?:no|not|never|without|cannot|can't|doesn't|don't|unwilling|unable)\b/gu;
const CHINESE_NEGATION = ["不愿", "不会", "不能", "没有", "無", "无", "未", "否", "拒绝", "避免", "不"];

function materialUnits(text: string): string[] {
  const normalized = normalize(text);
  const numbers = normalized.match(/(?:[$￥¥]|usd\s*)?\d[\d,]*(?:\.\d+)?\s*(?:%|years?|年|个月|万|k)?/gu) ?? [];
  const words = normalized.match(/[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}+#]*/gu) ?? [];
  const commitments = ["willing", "travel", "愿意", "接受"].filter((unit) => normalized.includes(unit));
  return [...numbers, ...words, ...commitments]
    .map(normalize)
    .filter((unit) => (unit.length > 1 || unit === "c" || unit === "r") && !GENERIC.has(unit))
    .filter((unit, index, all) => all.indexOf(unit) === index);
}

function normalize(text: string): string { return text.toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim(); }
function display(unit: string): string { return unit; }
function containsText(haystack: string, needle: string): boolean { return normalize(haystack).includes(normalize(needle)); }

function polarityPreserved(original: string, draft: string): boolean {
  const originalFingerprints = polarityFingerprints(original);
  const draftFingerprints = new Set(polarityFingerprints(draft));
  if (originalFingerprints.length === 0) return draftFingerprints.size === 0;
  return originalFingerprints.every((fingerprint) => draftFingerprints.has(fingerprint));
}

function polarityFingerprints(text: string): string[] {
  return normalize(text).split(/[.!?。！？;；\n]+/u).flatMap((clause) => {
    const fingerprints: string[] = [];
    for (const match of clause.matchAll(ENGLISH_NEGATION)) {
      const after = clause.slice((match.index ?? 0) + match[0].length);
      const subjects = materialUnits(after).slice(0, 3);
      if (subjects.length === 0) return ["negation-without-subject"];
      fingerprints.push(`neg:${subjects.join("|")}`);
    }
    for (const marker of CHINESE_NEGATION) {
      let index = clause.indexOf(marker);
      while (index >= 0) {
        const after = clause.slice(index + marker.length);
        const subject = materialUnits(after)[0];
        if (!subject) return ["negation-without-subject"];
        fingerprints.push(`neg:${subject}`);
        index = clause.indexOf(marker, index + marker.length);
      }
    }
    return fingerprints;
  });
}

function hasUnclaimedChangedClause(original: string, output: SelfEvaluationGeneratedDraft): boolean {
  const originalClauses = new Set(clauses(original));
  const claimClauses = output.claims.map((claim) => normalize(claim.text));
  return clauses(output.draft).some((clause) => !originalClauses.has(clause) && !claimClauses.some((claim) => claim.includes(clause) || clause.includes(claim)));
}

function clauses(text: string): string[] {
  return normalize(text).split(/[.!?。！？;；\n]+/u).map((clause) => clause.trim()).filter(Boolean);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
