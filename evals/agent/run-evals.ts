import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface RecallCase {
  expected?: readonly string[];
  expectedPostingIds?: readonly string[];
  ranked?: readonly string[];
  rankedPostingIds?: readonly string[];
}

export interface FactAccuracyCase {
  labeled?: number;
  correct?: number;
  expectedFacts?: readonly { correct?: boolean; normalizedMatch?: boolean }[];
}

export interface EvidenceGroundingCase {
  acceptedFacts?: number;
  groundedFacts?: number;
}

export interface RetrievalCase {
  provider: "lightrag" | "deterministic_fallback";
}

export interface ReadbackCase {
  attempted: number;
  stableFirstPass: number;
}

export interface OcrAccuracyCase {
  referenceCharacters: number;
  editDistance: number;
}

export interface OcrParityCase {
  referenceCharacters: number;
  candidateEditDistance: number;
  baselineEditDistance: number;
}

export interface ReviewTraceInput {
  runId?: string;
  runIdHash?: string;
  parentRunId?: string;
  parentRunIdHash?: string;
  sequence: number;
  node: string;
  graphVersion: string;
  modelVersion: string;
  toolVersion: string;
  retrievalVersion: string;
  outcome: string;
  terminalOutcome?: string;
}

export interface ProjectedReviewTrace {
  runIdHash: string;
  parentRunIdHash?: string;
  sequence: number;
  node: string;
  graphVersion: string;
  modelVersion: string;
  toolVersion: string;
  retrievalVersion: string;
  outcome: string;
  terminalOutcome?: string;
}

export interface MetricResult {
  numerator: number;
  denominator: number;
  value: number;
  confidenceInterval: { low: number; high: number };
}

export interface EvaluationReport {
  schemaVersion: "agent-eval-v1";
  datasetHash: string;
  generatedAt: string;
  gitCommit: string;
  graphVersion: string;
  adapterVersions: Record<string, string>;
  modelVersions: Record<string, string>;
  ocrRuntime: string;
  metrics: Record<string, MetricResult>;
  caseCounts: Record<string, number>;
  failures: string[];
  retrievalProvider: "lightrag" | "deterministic_fallback" | "mixed";
  retrievalVersion: string;
  fallbackCount: number;
  langsmithEnabled: boolean;
  langsmith: {
    sent: number;
    retried: number;
    deadLetter: number;
    privacyRejections: number;
    correlationMismatches: number;
  };
  misSubmissionCount: number;
  reportDirectory: string;
}

const SUITE_FILES = [
  "resume-extraction.jsonl",
  "job-matching.jsonl",
  "form-readback.jsonl",
  "ocr-parity.jsonl",
  "langsmith-review.jsonl"
] as const;

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const phonePattern = /(?:^|\D)(?:\+?86[- ]?)?1[3-9]\d{9}(?:$|\D)/;
const markupPattern = /<\/?[a-z][^>]*>/i;
const sensitiveKeyPattern = /(?:email|phone|address|prompt|dom|html|resume.?text|raw.?text|evidence.?quote|secret|token|form.?value)/i;

export function computeRecallAtK(cases: readonly RecallCase[], k = 3): number {
  if (!Number.isInteger(k) || k < 1) throw new Error("evaluation_k_invalid");
  if (cases.length === 0) throw new Error("evaluation_suite_empty");
  const numerator = cases.filter((item) => {
    const expected = item.expectedPostingIds ?? item.expected ?? [];
    const ranked = item.rankedPostingIds ?? item.ranked ?? [];
    const topK = new Set(ranked.slice(0, k));
    return expected.some((postingId) => topK.has(postingId));
  }).length;
  return numerator / cases.length;
}

export function computeFactAccuracy(cases: readonly FactAccuracyCase[]): number {
  const totals = cases.reduce((result, item) => {
    if (item.expectedFacts !== undefined) {
      result.denominator += item.expectedFacts.length;
      result.numerator += item.expectedFacts.filter((fact) => fact.correct === true || fact.normalizedMatch === true).length;
    } else {
      result.denominator += item.labeled ?? 0;
      result.numerator += item.correct ?? 0;
    }
    return result;
  }, { numerator: 0, denominator: 0 });
  return ratio(totals.numerator, totals.denominator);
}

export function computeEvidenceGrounding(cases: readonly EvidenceGroundingCase[]): number {
  const totals = cases.reduce((result, item) => {
    result.denominator += item.acceptedFacts ?? 0;
    result.numerator += item.groundedFacts ?? 0;
    return result;
  }, { numerator: 0, denominator: 0 });
  return ratio(totals.numerator, totals.denominator);
}

export function computeFallbackRate(cases: readonly RetrievalCase[]): number {
  if (cases.length === 0) throw new Error("evaluation_suite_empty");
  return cases.filter((item) => item.provider === "deterministic_fallback").length / cases.length;
}

export function computeFirstPassReadback(cases: readonly ReadbackCase[]): number {
  const totals = cases.reduce((result, item) => {
    result.denominator += item.attempted;
    result.numerator += item.stableFirstPass;
    return result;
  }, { numerator: 0, denominator: 0 });
  return ratio(totals.numerator, totals.denominator);
}

export function computeOcrCharacterAccuracy(cases: readonly OcrAccuracyCase[]): number {
  const totals = cases.reduce((result, item) => {
    result.denominator += item.referenceCharacters;
    result.numerator += Math.max(0, item.referenceCharacters - item.editDistance);
    return result;
  }, { numerator: 0, denominator: 0 });
  return ratio(totals.numerator, totals.denominator);
}

export function computeOcrParityRegression(cases: readonly OcrParityCase[]): number {
  const candidateAccuracy = computeOcrCharacterAccuracy(cases.map((item) => ({
    referenceCharacters: item.referenceCharacters,
    editDistance: item.candidateEditDistance
  })));
  const baselineAccuracy = computeOcrCharacterAccuracy(cases.map((item) => ({
    referenceCharacters: item.referenceCharacters,
    editDistance: item.baselineEditDistance
  })));
  return candidateAccuracy - baselineAccuracy;
}

export function wilsonInterval(numerator: number, denominator: number): MetricResult["confidenceInterval"] & { denominator: number } {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator < 0 || denominator < 0 || numerator > denominator) {
    throw new Error("evaluation_counts_invalid");
  }
  if (denominator === 0) return { low: 0, high: 0, denominator: 0 };
  const p = numerator / denominator;
  const z = 1.959963984540054;
  const denominatorWithZ = 1 + (z ** 2 / denominator);
  const center = (p + (z ** 2 / (2 * denominator))) / denominatorWithZ;
  const spread = z * Math.sqrt((p * (1 - p) / denominator) + (z ** 2 / (4 * denominator ** 2))) / denominatorWithZ;
  return { low: Math.max(0, center - spread), high: Math.min(1, center + spread), denominator };
}

export function assertNoAutomaticSubmit(commands: readonly unknown[]): void {
  const observed = commands.some((command) => {
    if (typeof command !== "object" || command === null) return false;
    const record = command as Record<string, unknown>;
    const commandType = typeof record.commandType === "string" ? record.commandType.toLowerCase() : "";
    return record.submitObserved === true
      || record.sideEffect === "submit"
      || commandType === "submit"
      || commandType === "final_submit"
      || commandType === "submit_application"
      || commandType === "click_submit";
  });
  if (observed) throw new Error("automatic_submit_observed");
}

export function assertPrivacySafe(value: unknown, path = "root"): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      emailPattern.test(value)
      || phonePattern.test(value)
      || markupPattern.test(value)
      || /^[\u4e00-\u9fff]{2,4}$/.test(trimmed)
      || /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(trimmed)
    ) {
      throw new Error("trace_pii_rejected");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPrivacySafe(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      if (sensitiveKeyPattern.test(key)) throw new Error("trace_pii_rejected");
      assertPrivacySafe(nested, `${path}.${key}`);
    }
  }
}

export function projectReviewTrace(input: ReviewTraceInput | ProjectedReviewTrace): ProjectedReviewTrace {
  const runIdHash = "runIdHash" in input && input.runIdHash !== undefined
    ? input.runIdHash
    : hashIdentity(input.runId!);
  const parentRunIdHash = "parentRunIdHash" in input && input.parentRunIdHash !== undefined
    ? input.parentRunIdHash
    : input.parentRunId === undefined ? undefined : hashIdentity(input.parentRunId);
  const projected: ProjectedReviewTrace = {
    runIdHash,
    sequence: input.sequence,
    node: input.node,
    graphVersion: input.graphVersion,
    modelVersion: input.modelVersion,
    toolVersion: input.toolVersion,
    retrievalVersion: input.retrievalVersion,
    outcome: input.outcome,
    ...(parentRunIdHash === undefined ? {} : { parentRunIdHash }),
    ...(input.terminalOutcome === undefined ? {} : { terminalOutcome: input.terminalOutcome })
  };
  assertPrivacySafe(projected);
  return projected;
}

export function assertTraceProjectionCorrelation(
  local: readonly (ReviewTraceInput | ProjectedReviewTrace)[],
  projected: readonly ProjectedReviewTrace[]
): void {
  if (local.length !== projected.length) throw new Error("trace_correlation_mismatch");
  const expected = local.map(projectReviewTrace);
  expected.forEach((event, index) => {
    const actual = projected[index];
    if (
      actual === undefined
      || event.runIdHash !== actual.runIdHash
      || event.parentRunIdHash !== actual.parentRunIdHash
      || event.sequence !== actual.sequence
      || event.node !== actual.node
      || event.graphVersion !== actual.graphVersion
      || event.modelVersion !== actual.modelVersion
      || event.toolVersion !== actual.toolVersion
      || event.retrievalVersion !== actual.retrievalVersion
      || event.outcome !== actual.outcome
      || event.terminalOutcome !== actual.terminalOutcome
    ) {
      throw new Error("trace_correlation_mismatch");
    }
  });
}

export function hashDataset(files: readonly { name: string; contents: string }[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.name.localeCompare(right.name))) {
    hash.update(file.name);
    hash.update("\0");
    hash.update(file.contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function runEvaluation(options: {
  rootDir?: string;
  outputRoot?: string;
  now?: Date;
} = {}): EvaluationReport {
  const rootDir = options.rootDir ?? fileURLToPath(new URL("../../", import.meta.url));
  const evalDir = join(rootDir, "evals", "agent");
  const files = SUITE_FILES.map((name) => ({ name, contents: readFileSync(join(evalDir, name), "utf8") }));
  const datasetHash = hashDataset(files);
  const rows = Object.fromEntries(files.map((file) => [file.name, parseJsonl(file.contents, file.name)]));
  for (const [name, suite] of Object.entries(rows)) {
    suite.forEach((item, index) => validateCase(item, `${name}:${index}`));
  }

  const resumeRows = rows["resume-extraction.jsonl"] as Array<Record<string, unknown>>;
  const jobRows = rows["job-matching.jsonl"] as Array<Record<string, unknown>>;
  const formRows = rows["form-readback.jsonl"] as Array<Record<string, unknown>>;
  const ocrRows = rows["ocr-parity.jsonl"] as Array<Record<string, unknown>>;
  const langsmithRows = rows["langsmith-review.jsonl"] as Array<Record<string, unknown>>;

  const factCases = resumeRows.map((row) => ({
    expectedFacts: asArray(row.expectedFacts).map((fact) => ({
      correct: isRecord(fact) && fact.correct === true,
      normalizedMatch: isRecord(fact) && fact.normalizedMatch === true
    }))
  }));
  const recallCases = jobRows.map((row) => ({
    expectedPostingIds: asStringArray(row.expectedPostingIds),
    rankedPostingIds: asStringArray(row.rankedPostingIds)
  }));
  const groundingCases = jobRows
    .filter((row) => row.semanticEvidenceRequired === true)
    .map((row) => ({
      acceptedFacts: row.accepted === true ? 1 : 0,
      groundedFacts: row.accepted === true && row.evidenceValidated === true ? 1 : 0
    }));
  const retrievalCases = jobRows.map((row) => ({ provider: row.retrievalProvider as RetrievalCase["provider"] }));
  const readbackCases = formRows.map((row) => ({
    attempted: numberField(row, "attemptedFields"),
    stableFirstPass: numberField(row, "stableFirstPassFields")
  }));
  const ocrCases = ocrRows.map((row) => ({
    referenceCharacters: numberField(row, "referenceCharacters"),
    editDistance: numberField(row, "candidateEditDistance")
  }));
  const parityCases = ocrRows.map((row) => ({
    referenceCharacters: numberField(row, "referenceCharacters"),
    candidateEditDistance: numberField(row, "candidateEditDistance"),
    baselineEditDistance: numberField(row, "baselineEditDistance")
  }));

  const commandRows = formRows.flatMap((row) => asArray(row.commands));
  let misSubmissionCount = 0;
  try {
    assertNoAutomaticSubmit(commandRows);
  } catch (error) {
    if (error instanceof Error && error.message === "automatic_submit_observed") misSubmissionCount = 1;
    else throw error;
  }

  const factAccuracy = metricFromExplicit(
    factCases.reduce((result, item) => {
      result.denominator += item.expectedFacts.length;
      result.numerator += item.expectedFacts.filter((fact) => fact.correct || fact.normalizedMatch).length;
      return result;
    }, { numerator: 0, denominator: 0 })
  );
  const recallNumerator = recallCases.filter((item) => {
    const top = new Set(item.rankedPostingIds.slice(0, 3));
    return item.expectedPostingIds.some((id) => top.has(id));
  }).length;
  const recallAt3 = metricFromExplicit({ numerator: recallNumerator, denominator: recallCases.length });
  const groundingNumerator = groundingCases.reduce((sum, item) => sum + item.groundedFacts, 0);
  const groundingDenominator = groundingCases.reduce((sum, item) => sum + item.acceptedFacts, 0);
  const evidenceGrounding = metricFromExplicit({ numerator: groundingNumerator, denominator: groundingDenominator });
  const fallbackCount = retrievalCases.filter((item) => item.provider === "deterministic_fallback").length;
  const fallback = metricFromExplicit({ numerator: fallbackCount, denominator: retrievalCases.length });
  const readback = metricFromExplicit({
    numerator: readbackCases.reduce((sum, item) => sum + item.stableFirstPass, 0),
    denominator: readbackCases.reduce((sum, item) => sum + item.attempted, 0)
  });
  const ocr = metricFromExplicit({
    numerator: ocrCases.reduce((sum, item) => sum + Math.max(0, item.referenceCharacters - item.editDistance), 0),
    denominator: ocrCases.reduce((sum, item) => sum + item.referenceCharacters, 0)
  });
  const parityMetric = computeOcrParityMetric(parityCases);
  const reportRoot = options.outputRoot ?? join(rootDir, "docs", "superpowers", "evaluations");
  const reportDirectory = join(reportRoot, datasetHash);
  const report: EvaluationReport = {
    schemaVersion: "agent-eval-v1",
    datasetHash,
    generatedAt: (options.now ?? new Date()).toISOString(),
    gitCommit: gitCommit(rootDir),
    graphVersion: "agent-v1",
    adapterVersions: { ats: "ats-adapter-v1", scoring: "job-match-v1" },
    modelVersions: { advisor: "deepseek-advisor-v1", retrieval: "lightrag-v1" },
    ocrRuntime: String(ocrRows[0]?.runtime ?? "pytorch"),
    metrics: {
      coreFactAccuracy: factAccuracy,
      evidenceGrounding,
      recallAt3: recallAt3,
      evidenceHitRate: evidenceGrounding,
      retrievalFallbackRate: fallback,
      firstPassReadback: readback,
      ocrCharacterAccuracy: ocr,
      ocrParityRegression: parityMetric
    },
    caseCounts: {
      resumeExtraction: resumeRows.length,
      jobMatching: jobRows.length,
      formReadback: formRows.length,
      ocrParity: ocrRows.length,
      langsmithReview: langsmithRows.length
    },
    failures: misSubmissionCount === 0 ? [] : ["automatic_submit_observed"],
    retrievalProvider: uniqueRetrievalProvider(retrievalCases),
    retrievalVersion: String(jobRows[0]?.retrievalVersion ?? "deterministic-v1"),
    fallbackCount,
    langsmithEnabled: process.env.LANGSMITH_TRACING_ENABLED === "true",
    langsmith: {
      sent: 0,
      retried: 0,
      deadLetter: 0,
      privacyRejections: 0,
      correlationMismatches: 0
    },
    misSubmissionCount,
    reportDirectory
  };
  if (misSubmissionCount !== 0) throw new Error("automatic_submit_observed");
  writeImmutableReport(reportDirectory, report);
  return report;
}

export function writeImmutableReport(directory: string, report: EvaluationReport): void {
  if (existsSync(directory)) {
    const existingPath = join(directory, "report.json");
    if (!existsSync(existingPath)) throw new Error("evaluation_report_exists");
    const existing = JSON.parse(readFileSync(existingPath, "utf8")) as { datasetHash?: string };
    if (existing.datasetHash !== report.datasetHash) throw new Error("evaluation_report_hash_mismatch");
    return;
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(join(directory, "report.md"), renderReport(report), "utf8");
}

function metricFromExplicit(input: { numerator: number; denominator: number }): MetricResult {
  if (input.denominator <= 0) throw new Error("evaluation_suite_empty");
  const numerator = Math.max(0, Math.min(input.denominator, input.numerator));
  return {
    numerator,
    denominator: input.denominator,
    value: numerator / input.denominator,
    confidenceInterval: (() => {
      const interval = wilsonInterval(numerator, input.denominator);
      return { low: interval.low, high: interval.high };
    })()
  };
}

function computeOcrParityMetric(cases: readonly OcrParityCase[]): MetricResult {
  if (cases.length === 0) throw new Error("evaluation_suite_empty");
  const candidateCorrect = cases.reduce(
    (sum, item) => sum + Math.max(0, item.referenceCharacters - item.candidateEditDistance),
    0
  );
  const baselineCorrect = cases.reduce(
    (sum, item) => sum + Math.max(0, item.referenceCharacters - item.baselineEditDistance),
    0
  );
  const denominator = cases.reduce((sum, item) => sum + item.referenceCharacters, 0);
  if (denominator <= 0) throw new Error("evaluation_suite_empty");
  const numerator = candidateCorrect - baselineCorrect;
  const candidateInterval = wilsonInterval(candidateCorrect, denominator);
  const baselineInterval = wilsonInterval(baselineCorrect, denominator);
  return {
    numerator,
    denominator,
    value: numerator / denominator,
    confidenceInterval: {
      low: candidateInterval.low - baselineInterval.high,
      high: candidateInterval.high - baselineInterval.low
    }
  };
}

function ratio(numerator: number, denominator: number): number {
  return metricFromExplicit({ numerator, denominator }).value;
}

function parseJsonl(contents: string, fileName: string): Array<Record<string, unknown>> {
  const rows = contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new Error(`evaluation_json_invalid:${fileName}:${index + 1}`);
      }
      if (!isRecord(value)) throw new Error(`evaluation_case_invalid:${fileName}:${index + 1}`);
      return value;
    });
  const ids = new Set<string>();
  for (const row of rows) {
    const caseId = row.caseId;
    if (typeof caseId !== "string" || caseId.length === 0 || ids.has(caseId)) {
      throw new Error(`evaluation_case_id_invalid:${fileName}`);
    }
    ids.add(caseId);
  }
  if (rows.length === 0) throw new Error(`evaluation_suite_empty:${fileName}`);
  return rows;
}

function validateCase(row: Record<string, unknown>, location: string): void {
  if (typeof row.caseId !== "string" || typeof row.suiteVersion !== "string") {
    throw new Error(`evaluation_manifest_invalid:${location}`);
  }
  if (row.privacy !== "synthetic" && row.privacy !== "hashed_reference" && row.privacy !== "local_only") {
    throw new Error(`evaluation_privacy_classification_invalid:${location}`);
  }
  assertPrivacySafe(row, location);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string");
}

function numberField(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`evaluation_number_invalid:${key}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueRetrievalProvider(cases: readonly RetrievalCase[]): EvaluationReport["retrievalProvider"] {
  const providers = new Set(cases.map((item) => item.provider));
  if (providers.size === 1) return [...providers][0]!;
  return "mixed";
}

function hashIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function gitCommit(rootDir: string): string {
  try {
    return execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() || "unknown";
  } catch {
    return process.env.GIT_COMMIT ?? "unknown";
  }
}

function renderReport(report: EvaluationReport): string {
  const lines = [
    "# Agent Evaluation Report",
    "",
    `- Dataset SHA-256: \`${report.datasetHash}\``,
    `- Git commit: \`${report.gitCommit}\``,
    `- Graph version: \`${report.graphVersion}\``,
    `- OCR runtime: \`${report.ocrRuntime}\``,
    `- Retrieval: \`${report.retrievalProvider}\` / \`${report.retrievalVersion}\``,
    `- LangSmith enabled: \`${report.langsmithEnabled}\``,
    "",
    "## Metrics",
    "",
    "| Metric | Value | Numerator | Denominator | 95% interval |",
    "| --- | ---: | ---: | ---: | ---: |"
  ];
  for (const [name, metric] of Object.entries(report.metrics)) {
    lines.push(`| ${name} | ${metric.value.toFixed(4)} | ${metric.numerator} | ${metric.denominator} | ${metric.confidenceInterval.low.toFixed(4)}-${metric.confidenceInterval.high.toFixed(4)} |`);
  }
  lines.push(
    "",
    "## Safety",
    "",
    `- Mis-submission count: **${report.misSubmissionCount}**`,
    `- Retrieval fallback count: ${report.fallbackCount}`,
    `- Failures: ${report.failures.length === 0 ? "none" : report.failures.join(", ")}`,
    ""
  );
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const report = runEvaluation();
    process.stdout.write(`${JSON.stringify({ datasetHash: report.datasetHash, reportDirectory: report.reportDirectory })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
