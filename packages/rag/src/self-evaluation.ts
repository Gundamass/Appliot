import {
  SelfEvaluationDraftSchema,
  SelfEvaluationGeneratedDraftSchema,
  type Evidence,
  type ProfileFact,
  type SelfEvaluationDraft,
  type SelfEvaluationGeneratedDraft
} from "@resume/contracts";
import type { StructuredModelProvider } from "@resume/model-provider";

export interface TailorSelfEvaluationInput { taskId: string; original: string; jobDescription: string; facts: ProfileFact[]; }

const SELF_EVALUATION_JSON_EXAMPLE = {
  draft: "Original facts restated for the role.",
  reasons: ["Emphasized relevant verified experience."],
  claims: [{ text: "verified experience", kind: "evidence", evidenceFactIds: ["fact-id"] }]
};

export async function tailorSelfEvaluation(input: TailorSelfEvaluationInput, provider: StructuredModelProvider): Promise<SelfEvaluationDraft> {
  let eligibleFacts: ProfileFact[];
  try { eligibleFacts = canonicalEligibleFacts(input.facts, input.taskId); }
  catch { return blocked(input.taskId, input.original, "Conflicting eligible evidence fact IDs"); }
  try {
    const output = SelfEvaluationGeneratedDraftSchema.parse(await provider.generateStructured({
      system: "Tailor only the supplied self-evaluation. Do not invent facts. Declare every new material claim with evidence fact IDs. Return the result as json.",
      user: JSON.stringify({ original: input.original, jobDescription: input.jobDescription, evidenceFacts: eligibleFacts.map(toFactInput) }),
      schema: SelfEvaluationGeneratedDraftSchema,
      jsonExample: SELF_EVALUATION_JSON_EXAMPLE
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
  if (!relationshipsAuthorized(original, draft, evidence.map((item) => item.text)).authorized) unsupported.push("Clause relationship could not be established");
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
  const validClaims = output.claims.filter((claim) => {
    if (!containsText(output.draft, claim.text) || new Set(claim.evidenceFactIds).size !== claim.evidenceFactIds.length) return false;
    return claim.evidenceFactIds.every((id) => byId.has(id));
  });
  const relationSources = new Map<string, string[]>();
  for (const claim of validClaims) {
    const claimClauses = clauses(claim.text);
    if (claimClauses.length !== 1) continue;
    const [claimClause] = claimClauses;
    if (!claimClause) continue;
    relationSources.set(claimClause, claim.evidenceFactIds.flatMap((id) => {
      const fact = byId.get(id);
      return fact ? [JSON.stringify(fact.value), ...fact.evidence.map((item) => item.text)] : [];
    }));
  }
  const relationshipResult = relationshipsAuthorized(original, output.draft, [], relationSources, true);
  if (relationshipResult.missingClaim) unsupported.add("Changed clause lacks claim metadata");
  if (!relationshipResult.authorized) unsupported.add("Clause relationship could not be established");
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
const NUMERIC = /(?:[$￥¥]|usd\s*)?\d[\d,]*(?:\.\d+)?\s*(?:%|years?|年|个月|万|k)?/gu;
const QUALIFICATION = new Set(["certified", "certificate", "certification", "qualified", "qualification", "degree", "pmp", "aws", "willing", "travel", "证书", "认证", "学历", "学位", "愿意", "出差"]);

interface MaterialOccurrence { unit: string; start: number; end: number; numeric: boolean; }
interface ClauseRelationship { units: Set<string>; anchors: Set<string>; polarity: Set<string>; }

function materialUnits(text: string): string[] {
  return materialOccurrences(text).map((item) => item.unit).filter((unit, index, all) => all.indexOf(unit) === index);
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

function relationshipsAuthorized(original: string, draft: string, evidence: string[], claimSources?: Map<string, string[]>, requireClaim = false): { authorized: boolean; missingClaim: boolean } {
  const originals = clauses(original);
  const evidenceClauses = evidence.flatMap(clauses);
  let missingClaim = false;
  for (const clause of clauses(draft)) {
    const target = clauseRelationship(clause);
    const sources = claimSources?.get(normalize(clause));
    const identicalOriginal = originals.includes(clause);
    if (requireClaim && !identicalOriginal && !sources) missingClaim = true;
    const matchingOriginal = originals.some((source) => relationshipsEqual(target, clauseRelationship(source)));
    if (matchingOriginal) continue;
    const authorizedSources = sources ? sources.flatMap(clauses) : evidenceClauses;
    if (!originals.some((source) => relationshipSupports(clauseRelationship(source), target))
      && !originals.some((source) => authorizedSources.some((evidenceClause) => relationshipDeltaSupported(clauseRelationship(source), target, clauseRelationship(evidenceClause))))) {
      return { authorized: false, missingClaim };
    }
  }
  return { authorized: true, missingClaim };
}

function clauseRelationship(clause: string): ClauseRelationship {
  const occurrences = materialOccurrences(clause);
  const units = new Set(occurrences.map((item) => item.unit));
  const anchors = new Set<string>();
  for (let index = 0; index < occurrences.length; index += 1) {
    const item = occurrences[index];
    if (!item) continue;
    if (!item.numeric && !QUALIFICATION.has(item.unit)) continue;
    const nearby = occurrences.filter((candidate) => !candidate.numeric && candidate !== item && Math.abs(candidate.start - item.start) <= 48)
      .sort((left, right) => Math.abs(left.start - item.start) - Math.abs(right.start - item.start))
      .slice(0, 2)
      .map((candidate) => candidate.unit);
    if (nearby.length > 0) anchors.add(`${item.numeric ? "number" : "qualification"}:${item.unit}|${nearby.join("|")}`);
  }
  return { units, anchors, polarity: new Set(polarityFingerprints(clause)) };
}

function relationshipsEqual(left: ClauseRelationship, right: ClauseRelationship): boolean {
  return setsEqual(left.units, right.units) && setsEqual(left.anchors, right.anchors) && setsEqual(left.polarity, right.polarity);
}

function relationshipSupports(source: ClauseRelationship, target: ClauseRelationship): boolean {
  return setContains(source.units, target.units) && setContains(source.anchors, target.anchors) && setContains(source.polarity, target.polarity);
}

function relationshipDeltaSupported(original: ClauseRelationship, target: ClauseRelationship, evidence: ClauseRelationship): boolean {
  const units = difference(target.units, original.units);
  const anchors = difference(target.anchors, original.anchors);
  const polarity = difference(target.polarity, original.polarity);
  return (units.size > 0 || anchors.size > 0 || polarity.size > 0)
    && setContains(evidence.units, units)
    && setContains(evidence.anchors, anchors)
    && setContains(evidence.polarity, polarity);
}

function setContains(source: Set<string>, target: Set<string>): boolean { return [...target].every((item) => source.has(item)); }
function setsEqual(left: Set<string>, right: Set<string>): boolean { return left.size === right.size && setContains(left, right); }
function difference(left: Set<string>, right: Set<string>): Set<string> { return new Set([...left].filter((item) => !right.has(item))); }

function materialOccurrences(text: string): MaterialOccurrence[] {
  const normalized = normalize(text);
  const numeric = [...normalized.matchAll(NUMERIC)].map((match) => ({ unit: normalize(match[0]), start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, numeric: true }));
  const words = [...normalized.matchAll(/[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}+#]*/gu)]
    .map((match) => ({ unit: normalize(match[0]), start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, numeric: false }))
    .filter((word) => !numeric.some((number) => word.start < number.end && number.start < word.end));
  return [...numeric, ...words]
    .filter((item) => materialUnit(item.unit))
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function materialUnit(unit: string): boolean {
  return !GENERIC.has(unit) && (unit.length > 1 || /^(?:[b-z]|c|r)$/u.test(unit));
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
