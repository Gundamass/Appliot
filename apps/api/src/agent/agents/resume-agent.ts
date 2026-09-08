import { z } from "zod";
import type { AgentGraphState, HumanResume } from "@resume/contracts";
import { EvidenceRefSchema, type EvidenceRef } from "@resume/contracts";
import type { EvidenceStore } from "../observations/evidence-store.js";
import type { SubgraphPort, SubgraphPortResult } from "../main-graph.js";
import { createResumeIngestionSubgraph, type ResumeIngestionDependencies } from "../subgraphs/resume-ingestion.js";
import {
  emptySpecialistResult,
  interruptForSpecialist,
  parseSpecialistAgentResult,
  publicEvidenceRef,
  type SpecialistAgent,
  type SpecialistAgentInput,
  type SpecialistAgentResult,
  validateSpecialistInput
} from "./specialist-agent.js";

export interface ResumeFactCandidate {
  readonly fieldPath: string;
  readonly confidence: number;
  readonly evidenceRefs?: readonly string[] | undefined;
}

const ResumeFactCandidateSchema = z.object({
  fieldPath: z.string().min(1).max(256),
  confidence: z.number().min(0).max(1),
  evidenceRefs: z.array(z.string().min(1).max(128)).max(100).optional()
}).strict();

const ResumeIngestOutputSchema = z.object({
  documentRef: z.string().min(1).max(256),
  documentHash: z.string().regex(/^[a-f0-9]{64}$/iu),
  facts: z.array(ResumeFactCandidateSchema).max(100),
  evidenceRefs: z.array(EvidenceRefSchema).max(500).optional(),
  missingFields: z.array(z.string().min(1).max(128)).max(50).optional(),
  conflicts: z.array(z.string().min(1).max(128)).max(50).optional()
}).strict();

export interface ResumeIngestOutput {
  readonly documentRef: string;
  readonly documentHash: string;
  readonly facts: readonly ResumeFactCandidate[];
  readonly evidenceRefs?: readonly EvidenceRef[] | undefined;
  readonly missingFields?: readonly string[] | undefined;
  readonly conflicts?: readonly string[] | undefined;
}

export interface ResumeAgentOptions {
  readonly ingest?: (input: SpecialistAgentInput) => Promise<ResumeIngestOutput>;
  readonly subgraph?: SubgraphPort;
  readonly ingestion?: ResumeIngestionDependencies;
  readonly state?: (input: SpecialistAgentInput) => AgentGraphState;
  readonly resume?: (input: SpecialistAgentInput) => HumanResume | undefined;
  readonly evidenceStore?: EvidenceStore;
  readonly now?: () => string;
  readonly version?: string;
}

export function createResumeAgent(options: ResumeAgentOptions = {}): SpecialistAgent {
  const now = options.now ?? (() => new Date().toISOString());
  const subgraph = options.subgraph ?? (options.ingestion === undefined ? undefined : createResumeIngestionSubgraph(options.ingestion));
  return {
    name: "resume_agent",
    version: options.version ?? "1.0.0",
    async execute(input): Promise<SpecialistAgentResult> {
      try {
        validateSpecialistInput(input);
        if (input.signal.aborted) return parseSpecialistAgentResult({ status: "failed", errorCode: "resume_execution_cancelled", evidenceRefs: [] });
        if (options.ingest !== undefined) {
          const output = ResumeIngestOutputSchema.parse(await options.ingest(input));
          return fromIngest(options, input, output, now);
        }
        if (subgraph !== undefined) {
          const resume = options.resume?.(input);
          return fromSubgraph(options, input, await subgraph({
            state: options.state?.(input) ?? defaultState(input),
            ...(resume === undefined ? {} : { resume })
          }), now);
        }
        return emptySpecialistResult("blocked", { blockReason: "resume_agent_unconfigured" });
      } catch (error) {
        return parseSpecialistAgentResult({
          status: "failed",
          errorCode: error instanceof Error && /^[a-z0-9_:-]+$/u.test(error.message) ? error.message : "resume_agent_failed",
          evidenceRefs: []
        });
      }
    }
  };
}

function fromIngest(
  options: ResumeAgentOptions,
  input: SpecialistAgentInput,
  output: ResumeIngestOutput,
  now: () => string
): SpecialistAgentResult {
  if (!/^[a-f0-9]{64}$/u.test(output.documentHash)) {
    return emptySpecialistResult("blocked", { blockReason: "resume_document_hash_invalid" });
  }
  const evidenceRefs = [...(output.evidenceRefs ?? [])];
  const documentEvidence = registerEvidence(options.evidenceStore, input, "document", output.documentRef, output.documentHash);
  if (documentEvidence !== undefined) evidenceRefs.push(documentEvidence);
  const missing = [...(output.missingFields ?? []), ...(output.conflicts ?? [])].filter((field) => field.length > 0);
  if (missing.length > 0) {
    const interrupt = interruptForSpecialist(input, "ambiguous_fact", "Resume evidence needs human review.", missing, now);
    return parseSpecialistAgentResult({ status: "interrupted", pendingInterrupt: interrupt, evidenceRefs });
  }
  return parseSpecialistAgentResult({
    status: "completed",
    outputRef: output.documentRef,
    evidenceRefs
  });
}

function fromSubgraph(
  options: ResumeAgentOptions,
  input: SpecialistAgentInput,
  result: SubgraphPortResult,
  now: () => string
): SpecialistAgentResult {
  const evidenceRefs: EvidenceRef[] = [];
  const documentHash = result.resumeIngestion?.documentFingerprint;
  if (documentHash !== undefined && /^[a-f0-9]{64}$/u.test(documentHash)) {
    const reference = registerEvidence(options.evidenceStore, input, "document", `document:${result.resumeIngestion?.documentId ?? "resume"}`, documentHash);
    if (reference !== undefined) evidenceRefs.push(reference);
  }
  if (result.status === "completed") {
    return parseSpecialistAgentResult({
      status: "completed",
      outputRef: `resume:${input.taskId}:${result.resumeIngestion?.documentId ?? input.step.id}`,
      evidenceRefs
    });
  }
  if (result.status === "interrupted" && result.pendingInterrupt !== undefined) {
    const interrupt = interruptForSpecialist(input, "ambiguous_fact", result.pendingInterrupt.reasonCode, result.pendingInterrupt.questionIds, now);
    return parseSpecialistAgentResult({ status: "interrupted", pendingInterrupt: interrupt, evidenceRefs });
  }
  if (result.status === "failed") return parseSpecialistAgentResult({ status: "failed", errorCode: result.error?.code ?? "resume_agent_failed", evidenceRefs });
  return parseSpecialistAgentResult({ status: "blocked", blockReason: "resume_agent_cancelled", evidenceRefs });
}

function registerEvidence(
  store: EvidenceStore | undefined,
  input: SpecialistAgentInput,
  kind: EvidenceRef["kind"],
  sourceRef: string,
  contentHash: string
): EvidenceRef | undefined {
  if (store === undefined) return undefined;
  try {
    return publicEvidenceRef(store.register({
      runId: input.runId,
      stepId: input.step.id,
      invocationId: input.step.attemptToken ?? `${input.runId}:${input.step.id}:${input.step.attempt}`,
      kind,
      sourceRef: sourceRef.slice(0, 256),
      contentHash
    }));
  } catch {
    return undefined;
  }
}

function defaultState(input: SpecialistAgentInput): AgentGraphState {
  return {
    threadId: `runtime:${input.runId}`,
    runId: input.runId,
    taskId: input.taskId,
    graphVersion: "agent-v1",
    status: "running",
    profileRevision: 0,
    currentSubgraph: "resume_ingestion",
    auditEventIds: []
  };
}
