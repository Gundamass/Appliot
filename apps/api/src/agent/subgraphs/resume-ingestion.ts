import { createHash } from "node:crypto";
import {
  JsonValueSchema,
  ProfileFactSchema,
  type AgentGraphState,
  type Evidence,
  type HumanInterrupt,
  type JsonValue,
  type ProfileFact,
  type ResumeIngestionState
} from "@resume/contracts";
import { isAllowedExtractedFieldPath, semanticLookupPaths } from "@resume/form-semantics";
import type { ExtractedDocument } from "@resume/profile-domain/src/pdf/types.js";
import { z } from "zod";
import type { ProfileRepository } from "../../profile/profile-repository.js";
import type { SubgraphPort, SubgraphPortInput, SubgraphPortResult } from "../main-graph.js";
import type { TraceSink } from "../trace-sink.js";

const ConfirmationValuesSchema = z.object({
  factIds: z.array(z.string().uuid()).min(1).max(50)
}).strict();

export interface ResumeIngestionDocument {
  documentId: string;
  bytes: Uint8Array;
}

export interface ResumeIngestionDependencies {
  loadDocument(input: { taskId: string; documentId?: string }): Promise<ResumeIngestionDocument>;
  extractPdf(bytes: Uint8Array): Promise<ExtractedDocument>;
  extractFacts(document: ExtractedDocument): Promise<ProfileFact[]>;
  profileRepository: ProfileRepository;
  traceSink: TraceSink;
  requiredFactPaths?: readonly string[] | ((input: {
    state: AgentGraphState;
    candidateFactIds: readonly string[];
  }) => readonly string[]);
  now?: () => Date;
}

interface ValidatedCandidates {
  facts: ProfileFact[];
  invalidFieldPaths: string[];
}

interface CandidateConflict {
  candidateId: string;
}

export function createResumeIngestionSubgraph(dependencies: ResumeIngestionDependencies): SubgraphPort {
  return async (input) => {
    if (input.resume !== undefined) return resumeIngestion(dependencies, input);

    if (input.state.resumeIngestion?.candidateFactIds !== undefined) {
      return evaluateCompleteness(dependencies, input.state, input.state.resumeIngestion);
    }

    return ingestDocument(dependencies, input);
  };
}

async function ingestDocument(
  dependencies: ResumeIngestionDependencies,
  input: SubgraphPortInput
): Promise<SubgraphPortResult> {
  const persisted = input.state.resumeIngestion;
  let retained: ResumeIngestionDocument;
  let document: ExtractedDocument;

  try {
    retained = await dependencies.loadDocument({
      taskId: input.state.taskId,
      ...(persisted?.documentId === undefined ? {} : { documentId: persisted.documentId })
    });
    if (retained.documentId.length === 0) return failed(input.state, "resume_document_missing", "fingerprint_document");
    document = await dependencies.extractPdf(Uint8Array.from(retained.bytes));
  } catch {
    return failed(input.state, "resume_page_extraction_failed", "extract_pages");
  }

  const documentError = validateDocument(input.state, persisted, retained, document);
  if (documentError !== undefined) return failed(input.state, documentError, "fingerprint_document");

  record(dependencies, input.state, "extract_pages", "node", "completed", "resume_pages_extracted", {
    contentHash: document.fingerprint,
    counts: {
      pages: document.pages.length,
      pdfPages: document.pages.filter((page) => page.source === "pdf_text").length,
      ocrPages: document.pages.filter((page) => page.source === "ocr").length
    }
  });

  let extracted: ProfileFact[];
  try {
    extracted = await dependencies.extractFacts(document);
  } catch {
    return failed(input.state, "resume_fact_extraction_failed", "extract_fact_candidates");
  }

  const candidates = validateCandidates(document, extracted);
  const resumeIngestion = createResumeState(retained.documentId, document, candidates.facts);
  if (candidates.invalidFieldPaths.length > 0) {
    record(dependencies, input.state, "validate_evidence", "safety_block", "interrupted", "resume_evidence_invalid", {
      contentHash: document.fingerprint,
      counts: { invalidCandidates: candidates.invalidFieldPaths.length }
    });
    return interruptResult(
      dependencies,
      input.state,
      resumeIngestion,
      "validate_evidence",
      "missing_fact",
      "resume_evidence_invalid",
      candidates.invalidFieldPaths.map(fieldQuestionId)
    );
  }

  try {
    persistCandidates(dependencies.profileRepository, candidates.facts);
  } catch {
    return failed(input.state, "resume_candidate_persistence_failed", "extract_fact_candidates", resumeIngestion);
  }

  record(dependencies, input.state, "extract_fact_candidates", "model_decision", "accepted", "resume_candidates_validated", {
    contentHash: document.fingerprint,
    candidateIds: candidates.facts.map((fact) => fact.id),
    counts: { candidates: candidates.facts.length }
  });

  return evaluateCompleteness(dependencies, input.state, resumeIngestion);
}

function resumeIngestion(
  dependencies: ResumeIngestionDependencies,
  input: SubgraphPortInput
): SubgraphPortResult {
  const resumeIngestion = input.state.resumeIngestion;
  const pendingInterrupt = input.state.pendingInterrupt;
  const resume = input.resume;
  if (resumeIngestion === undefined || pendingInterrupt === undefined || resume === undefined) {
    return failed(input.state, "resume_ingestion_not_pending", "apply_resume", resumeIngestion);
  }
  if (pendingInterrupt.id !== resume.interruptId) {
    return failed(input.state, "resume_ingestion_interrupt_mismatch", "apply_resume", resumeIngestion);
  }
  if (resume.action === "cancel") {
    return {
      status: "cancelled",
      currentNode: "cancelled",
      resumeIngestion
    };
  }

  let acceptedFactIds: string[];
  try {
    acceptedFactIds = resume.action === "confirm"
      ? confirmCandidates(dependencies.profileRepository, resumeIngestion, pendingInterrupt, resume.values)
      : resume.action === "correct"
        ? correctQuestions(dependencies.profileRepository, pendingInterrupt, resume.values)
        : unsupportedResumeAction(resume.action);
  } catch (error) {
    return failed(
      input.state,
      error instanceof ResumeIngestionError ? error.code : "resume_ingestion_resume_invalid",
      "apply_resume",
      resumeIngestion
    );
  }

  const nextState: ResumeIngestionState = {
    ...resumeIngestion,
    acceptedFactIds: uniqueIds([...(resumeIngestion.acceptedFactIds ?? []), ...acceptedFactIds])
  };
  record(dependencies, input.state, "apply_resume", "node", "completed", "resume_values_applied", {
    ...(resumeIngestion.documentFingerprint === undefined ? {} : { contentHash: resumeIngestion.documentFingerprint }),
    candidateIds: acceptedFactIds,
    counts: { acceptedFacts: acceptedFactIds.length }
  });
  return evaluateCompleteness(dependencies, input.state, nextState);
}

function evaluateCompleteness(
  dependencies: ResumeIngestionDependencies,
  state: AgentGraphState,
  resumeIngestion: ResumeIngestionState
): SubgraphPortResult {
  const conflicts = findCandidateConflicts(dependencies.profileRepository, state.taskId, resumeIngestion.candidateFactIds ?? []);
  if (conflicts.length > 0) {
    return interruptResult(
      dependencies,
      state,
      resumeIngestion,
      "validate_evidence",
      "fact_conflict",
      "resume_fact_conflict",
      conflicts.map((conflict) => factQuestionId(conflict.candidateId))
    );
  }

  let requiredFactPaths: string[];
  try {
    requiredFactPaths = requiredPaths(dependencies, state, resumeIngestion.candidateFactIds ?? []);
  } catch (error) {
    return failed(
      state,
      error instanceof ResumeIngestionError ? error.code : "resume_required_fields_invalid",
      "check_completeness",
      resumeIngestion
    );
  }

  const missingQuestions = requiredFactPaths.flatMap((fieldPath) => {
    if (dependencies.profileRepository.resolveForTask(state.taskId, fieldPath) !== undefined) return [];
    const candidateId = candidateForField(dependencies.profileRepository, resumeIngestion.candidateFactIds ?? [], fieldPath);
    return [candidateId === undefined ? fieldQuestionId(fieldPath) : factQuestionId(candidateId)];
  });
  if (missingQuestions.length > 0) {
    return interruptResult(
      dependencies,
      state,
      resumeIngestion,
      "check_completeness",
      "missing_fact",
      "profile_fact_required",
      missingQuestions
    );
  }

  const revision = dependencies.profileRepository.currentRevision();
  const completed: ResumeIngestionState = {
    ...resumeIngestion,
    ...(revision === 0 || revision === state.profileRevision ? {} : { publishedProfileRevision: revision })
  };
  record(dependencies, state, "check_completeness", "node", "completed", "resume_complete", {
    ...(completed.documentFingerprint === undefined ? {} : { contentHash: completed.documentFingerprint }),
    counts: {
      candidateFacts: completed.candidateFactIds?.length ?? 0,
      acceptedFacts: completed.acceptedFactIds?.length ?? 0
    }
  });
  return {
    status: "completed",
    currentNode: "check_completeness",
    resumeIngestion: completed
  };
}

function validateDocument(
  state: AgentGraphState,
  persisted: ResumeIngestionState | undefined,
  retained: ResumeIngestionDocument,
  document: ExtractedDocument
): string | undefined {
  if (!/^[a-f0-9]{64}$/u.test(document.fingerprint)) return "resume_document_fingerprint_invalid";
  if (createHash("sha256").update(retained.bytes).digest("hex") !== document.fingerprint) {
    return "resume_document_fingerprint_mismatch";
  }
  if (persisted?.documentId !== undefined && persisted.documentId !== retained.documentId) {
    return "resume_document_id_mismatch";
  }
  if (persisted?.documentFingerprint !== undefined && persisted.documentFingerprint !== document.fingerprint) {
    return "resume_document_fingerprint_mismatch";
  }
  if (document.pages.length === 0) return "resume_pages_missing";

  const pages = new Set<number>();
  for (const page of document.pages) {
    if (!Number.isInteger(page.page) || page.page <= 0 || pages.has(page.page) || page.text.length === 0) {
      return "resume_pages_invalid";
    }
    if (page.source !== "pdf_text" && page.source !== "ocr") return "resume_pages_invalid";
    pages.add(page.page);
  }
  if (state.currentSubgraph !== "resume_ingestion") return "resume_subgraph_mismatch";
  return undefined;
}

function validateCandidates(document: ExtractedDocument, candidates: readonly unknown[]): ValidatedCandidates {
  const facts: ProfileFact[] = [];
  const invalidFieldPaths = new Set<string>();
  const ids = new Set<string>();
  const values = new Map<string, string>();
  const pages = new Map(document.pages.map((page) => [page.page, page]));

  for (const candidate of candidates) {
    const parsed = ProfileFactSchema.safeParse(candidate);
    const fieldPath = candidateFieldPath(candidate);
    if (!parsed.success || parsed.data.status !== "extracted" || parsed.data.scope !== "profile" || parsed.data.revision !== 1) {
      invalidFieldPaths.add(fieldPath);
      continue;
    }
    const fact = parsed.data;
    if (!isAllowedExtractedFieldPath(fact.fieldPath) || ids.has(fact.id)) {
      invalidFieldPaths.add(fact.fieldPath);
      continue;
    }
    const value = JSON.stringify(fact.value);
    const previousValue = values.get(fact.fieldPath);
    if (previousValue !== undefined && previousValue !== value) {
      invalidFieldPaths.add(fact.fieldPath);
      continue;
    }
    if (!hasValidEvidence(fact, document.fingerprint, pages)) {
      invalidFieldPaths.add(fact.fieldPath);
      continue;
    }
    ids.add(fact.id);
    values.set(fact.fieldPath, value);
    facts.push(fact);
  }

  return { facts, invalidFieldPaths: [...invalidFieldPaths].sort() };
}

function hasValidEvidence(
  fact: ProfileFact,
  documentFingerprint: string,
  pages: ReadonlyMap<number, ExtractedDocument["pages"][number]>
): boolean {
  return fact.evidence.length > 0 && fact.evidence.every((evidence) => {
    const page = pages.get(evidence.page);
    return evidence.documentId === documentFingerprint
      && page !== undefined
      && page.source === evidence.extraction
      && evidence.text.length > 0
      && page.text.includes(evidence.text);
  });
}

function persistCandidates(profileRepository: ProfileRepository, facts: ProfileFact[]): void {
  for (const fact of facts) {
    const existing = profileRepository.getById(fact.id);
    if (existing === undefined) {
      profileRepository.createExtracted(fact);
      continue;
    }
    if (
      existing.status !== "extracted"
      || existing.fieldPath !== fact.fieldPath
      || JSON.stringify(existing.value) !== JSON.stringify(fact.value)
      || JSON.stringify(existing.evidence) !== JSON.stringify(fact.evidence)
    ) {
      throw new ResumeIngestionError("resume_candidate_id_conflict");
    }
  }
}

function findCandidateConflicts(
  profileRepository: ProfileRepository,
  taskId: string,
  candidateFactIds: readonly string[]
): CandidateConflict[] {
  const conflicts: CandidateConflict[] = [];
  for (const candidateId of candidateFactIds) {
    const candidate = profileRepository.getById(candidateId);
    if (candidate?.status !== "extracted") continue;
    const reviewed = profileRepository.resolveForTask(taskId, candidate.fieldPath);
    if (reviewed !== undefined && reviewed.id !== candidate.id && JSON.stringify(reviewed.value) !== JSON.stringify(candidate.value)) {
      conflicts.push({ candidateId });
    }
  }
  return conflicts;
}

function requiredPaths(
  dependencies: ResumeIngestionDependencies,
  state: AgentGraphState,
  candidateFactIds: readonly string[]
): string[] {
  const configured = typeof dependencies.requiredFactPaths === "function"
    ? dependencies.requiredFactPaths({ state, candidateFactIds })
    : dependencies.requiredFactPaths ?? [];
  const paths = uniqueIds([...configured]);
  if (paths.some((path) => !isAllowedExtractedFieldPath(path))) {
    throw new ResumeIngestionError("resume_required_field_invalid");
  }
  return paths;
}

function candidateForField(
  profileRepository: ProfileRepository,
  candidateFactIds: readonly string[],
  fieldPath: string
): string | undefined {
  const equivalentPaths = new Set(semanticLookupPaths(fieldPath));
  return candidateFactIds.find((candidateId) => {
    const candidate = profileRepository.getById(candidateId);
    return candidate?.status === "extracted" && equivalentPaths.has(candidate.fieldPath);
  });
}

function confirmCandidates(
  profileRepository: ProfileRepository,
  resumeIngestion: ResumeIngestionState,
  pendingInterrupt: HumanInterrupt,
  values: Record<string, unknown>
): string[] {
  const selected = ConfirmationValuesSchema.parse(values).factIds;
  const allowed = new Set(
    pendingInterrupt.questionIds
      .map(parseQuestion)
      .flatMap((question) => question?.kind === "fact" ? [question.value] : [])
  );
  if (allowed.size === 0 || selected.some((factId) => !allowed.has(factId))) {
    throw new ResumeIngestionError("resume_confirmation_invalid");
  }
  const candidateIds = new Set(resumeIngestion.candidateFactIds ?? []);
  const confirmed: string[] = [];
  for (const factId of uniqueIds(selected)) {
    if (!candidateIds.has(factId)) throw new ResumeIngestionError("resume_confirmation_invalid");
    const fact = profileRepository.getById(factId);
    if (fact === undefined || fact.status !== "extracted") throw new ResumeIngestionError("resume_confirmation_invalid");
    confirmed.push(profileRepository.confirm(factId).id);
  }
  return confirmed;
}

function correctQuestions(
  profileRepository: ProfileRepository,
  pendingInterrupt: HumanInterrupt,
  values: Record<string, unknown>
): string[] {
  const questions = pendingInterrupt.questionIds.map(parseQuestion);
  if (questions.some((question) => question === undefined)) {
    throw new ResumeIngestionError("resume_correction_invalid");
  }
  const corrections = questions.map((question) => {
    const key = question!.value;
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      throw new ResumeIngestionError("resume_correction_missing_value");
    }
    return { question: question!, value: JsonValueSchema.parse(values[key]) };
  });

  return corrections.map(({ question, value }) => {
    if (question.kind === "fact") {
      return profileRepository.correct(question.value, value, userEvidence(value)).id;
    }
    return profileRepository.upsertUserFact({ fieldPath: question.value, value }).id;
  });
}

function unsupportedResumeAction(_action: string): never {
  throw new ResumeIngestionError("resume_action_unsupported");
}

function interruptResult(
  dependencies: ResumeIngestionDependencies,
  state: AgentGraphState,
  resumeIngestion: ResumeIngestionState,
  currentNode: string,
  kind: HumanInterrupt["kind"],
  reasonCode: string,
  questions: readonly string[]
): SubgraphPortResult {
  const questionIds = uniqueIds([...questions]);
  const pendingInterrupt = createInterrupt(state, resumeIngestion, kind, reasonCode, questionIds, dependencies.now);
  return {
    status: "interrupted",
    currentNode,
    pendingInterrupt,
    resumeIngestion
  };
}

function createInterrupt(
  state: AgentGraphState,
  resumeIngestion: ResumeIngestionState,
  kind: HumanInterrupt["kind"],
  reasonCode: string,
  questionIds: string[],
  now: (() => Date) | undefined
): HumanInterrupt {
  const seed = [state.runId, state.taskId, resumeIngestion.documentFingerprint ?? "", kind, reasonCode, ...questionIds].join("|");
  return {
    id: `interrupt_${createHash("sha256").update(seed).digest("hex")}`,
    kind,
    reasonCode,
    questionIds,
    evidenceIds: [],
    createdAt: (now ?? (() => new Date()))().toISOString()
  };
}

function createResumeState(
  documentId: string,
  document: ExtractedDocument,
  facts: readonly ProfileFact[]
): ResumeIngestionState {
  return {
    documentId,
    documentFingerprint: document.fingerprint,
    pageSources: document.pages.map((page) => page.source === "pdf_text" ? "pdf" : "ocr"),
    candidateFactIds: facts.map((fact) => fact.id)
  };
}

function failed(
  state: AgentGraphState,
  code: string,
  node: string,
  resumeIngestion?: ResumeIngestionState
): SubgraphPortResult {
  return {
    status: "failed",
    currentNode: node,
    error: { code, retryable: false, node },
    ...(resumeIngestion === undefined ? {} : { resumeIngestion })
  };
}

function record(
  dependencies: ResumeIngestionDependencies,
  state: AgentGraphState,
  node: string,
  kind: "node" | "model_decision" | "safety_block",
  outcome: string,
  reasonCode: string,
  extra: {
    contentHash?: string;
    candidateIds?: string[];
    counts?: Record<string, number>;
  }
): void {
  dependencies.traceSink.record({
    runId: state.runId,
    taskId: state.taskId,
    node,
    kind,
    outcome,
    reasonCode,
    ...extra
  });
}

function candidateFieldPath(candidate: unknown): string {
  if (typeof candidate !== "object" || candidate === null || !("fieldPath" in candidate)) return "unknown";
  const fieldPath = candidate.fieldPath;
  return typeof fieldPath === "string" && isAllowedExtractedFieldPath(fieldPath) ? fieldPath : "unknown";
}

function fieldQuestionId(fieldPath: string): string {
  return `field:${fieldPath}`;
}

function factQuestionId(factId: string): string {
  return `fact:${factId}`;
}

function parseQuestion(questionId: string): { kind: "fact" | "field"; value: string } | undefined {
  if (questionId.startsWith("fact:")) {
    const value = questionId.slice("fact:".length);
    return z.string().uuid().safeParse(value).success ? { kind: "fact", value } : undefined;
  }
  if (questionId.startsWith("field:")) {
    const value = questionId.slice("field:".length);
    return isAllowedExtractedFieldPath(value) ? { kind: "field", value } : undefined;
  }
  return undefined;
}

function userEvidence(value: JsonValue): Evidence[] {
  return [{
    documentId: "user",
    page: 1,
    text: `Corrected value: ${JSON.stringify(value)}`,
    extraction: "user"
  }];
}

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values)];
}

class ResumeIngestionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
