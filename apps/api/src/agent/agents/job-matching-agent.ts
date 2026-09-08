import { createHash } from "node:crypto";
import { z } from "zod";
import { EvidenceRefSchema, type EvidenceRef } from "@resume/contracts";
import type { SubgraphPort, SubgraphPortResult } from "../main-graph.js";
import { createJobMatchingSubgraph, type JobMatchingSubgraphDependencies } from "../subgraphs/job-matching.js";
import type { EvidenceStore } from "../observations/evidence-store.js";
import {
  emptySpecialistResult,
  interruptForSpecialist,
  parseSpecialistAgentResult,
  publicEvidenceRef,
  type RequirementAdvisory,
  type SpecialistAgent,
  type SpecialistAgentInput,
  type SpecialistAgentResult,
  validateSpecialistInput
} from "./specialist-agent.js";

const JobMatchingOutputSchema = z.object({
  outputRef: z.string().min(1).max(256),
  requirements: z.array(z.object({
    requirementId: z.string().min(1).max(128),
    outcome: z.enum(["satisfied", "unknown", "conflict"]),
    confidence: z.number().min(0).max(1),
    evidenceRefs: z.array(z.string().min(1).max(128)).max(100).optional()
  }).strict()).max(100),
  evidenceRefs: z.array(EvidenceRefSchema).max(500).optional(),
  missingInformation: z.array(z.string().min(1).max(128)).max(50).optional()
}).strict();

export interface JobMatchingOutput {
  readonly outputRef: string;
  readonly requirements: readonly RequirementAdvisory[];
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly missingInformation?: readonly string[];
}

export interface JobMatchingAgentOptions {
  readonly match?: (input: SpecialistAgentInput) => Promise<JobMatchingOutput>;
  readonly subgraph?: SubgraphPort;
  readonly matching?: JobMatchingSubgraphDependencies;
  readonly state?: (input: SpecialistAgentInput) => import("@resume/contracts").AgentGraphState;
  readonly evidenceStore?: EvidenceStore;
  readonly now?: () => string;
  readonly version?: string;
}

export function createJobMatchingAgent(options: JobMatchingAgentOptions = {}): SpecialistAgent {
  const now = options.now ?? (() => new Date().toISOString());
  const subgraph = options.subgraph ?? (options.matching === undefined ? undefined : createJobMatchingSubgraph(options.matching));
  return {
    name: "job_matching_agent",
    version: options.version ?? "1.0.0",
    async execute(input): Promise<SpecialistAgentResult> {
      try {
        validateSpecialistInput(input);
        if (input.signal.aborted) return parseSpecialistAgentResult({ status: "failed", errorCode: "job_matching_execution_cancelled", evidenceRefs: [] });
        if (options.match !== undefined) {
          const output = JobMatchingOutputSchema.parse(await options.match(input));
          const advisories = output.requirements.map((requirement) => ({ ...requirement, evidenceRefs: requirement.evidenceRefs === undefined ? undefined : [...requirement.evidenceRefs] }));
          const evidenceRefs = [...(output.evidenceRefs ?? [])];
          const missing = [...(output.missingInformation ?? [])];
          if (missing.length > 0) {
            return parseSpecialistAgentResult({
              status: "interrupted",
              pendingInterrupt: interruptForSpecialist(input, "ambiguous_fact", "Job matching needs clarification.", missing, now),
              evidenceRefs,
              advisories
            });
          }
          return parseSpecialistAgentResult({ status: "completed", outputRef: output.outputRef, evidenceRefs, advisories });
        }
        if (subgraph !== undefined) return fromSubgraph(options, input, await subgraph({ state: options.state?.(input) ?? defaultState(input) }), now);
        return emptySpecialistResult("blocked", { blockReason: "job_matching_agent_unconfigured" });
      } catch (error) {
        return parseSpecialistAgentResult({
          status: "failed",
          errorCode: error instanceof Error && /^[a-z0-9_:-]+$/u.test(error.message) ? error.message : "job_matching_agent_failed",
          evidenceRefs: []
        });
      }
    }
  };
}

function fromSubgraph(
  options: JobMatchingAgentOptions,
  input: SpecialistAgentInput,
  result: SubgraphPortResult,
  now: () => string
): SpecialistAgentResult {
  const evidenceRefs: EvidenceRef[] = [];
  const contentHash = createHash("sha256").update(JSON.stringify({
    runId: input.runId,
    stepId: input.step.id,
    sessionId: result.jobMatching?.sessionId ?? "unknown"
  })).digest("hex");
  const registered = options.evidenceStore?.register({
    runId: input.runId,
    stepId: input.step.id,
    invocationId: input.step.attemptToken ?? `${input.runId}:${input.step.id}:${input.step.attempt}`,
    kind: "observation",
    sourceRef: `job-matching:${result.jobMatching?.sessionId ?? input.taskId}`,
    contentHash
  });
  if (registered !== undefined) evidenceRefs.push(publicEvidenceRef(registered));
  if (result.status === "completed") return parseSpecialistAgentResult({ status: "completed", outputRef: `job-match:${result.jobMatching?.sessionId ?? input.taskId}`, evidenceRefs });
  if (result.status === "interrupted" && result.pendingInterrupt !== undefined) {
    return parseSpecialistAgentResult({
      status: "interrupted",
      pendingInterrupt: interruptForSpecialist(input, "ambiguous_fact", result.pendingInterrupt.reasonCode, result.pendingInterrupt.questionIds, now),
      evidenceRefs
    });
  }
  if (result.status === "failed") return parseSpecialistAgentResult({ status: "failed", errorCode: result.error?.code ?? "job_matching_agent_failed", evidenceRefs });
  return parseSpecialistAgentResult({ status: "blocked", blockReason: "job_matching_agent_cancelled", evidenceRefs });
}

function defaultState(input: SpecialistAgentInput): import("@resume/contracts").AgentGraphState {
  return {
    threadId: `runtime:${input.runId}`,
    runId: input.runId,
    taskId: input.taskId,
    graphVersion: "agent-v1",
    status: "running",
    profileRevision: 0,
    currentSubgraph: "job_matching",
    jobMatching: { sessionId: input.taskId },
    auditEventIds: []
  };
}
