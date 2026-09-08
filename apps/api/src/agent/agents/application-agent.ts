import { createHash } from "node:crypto";
import type { EvidenceRef } from "@resume/contracts";
import type { EvidenceStore } from "../observations/evidence-store.js";
import {
  createApplicationAgent as createRuntimeApplicationAgent,
  type ApplicationAgentOptions as RuntimeApplicationAgentOptions
} from "../specialists/application-agent.js";
import type { RuntimeExecutor } from "../runtime/execution-loop.js";
import {
  ApplicationActionProposalSchema,
  BrowserObservationSchema,
  emptySpecialistResult,
  interruptForSpecialist,
  parseSpecialistAgentResult,
  publicEvidenceRef,
  type ApplicationActionProposal,
  type BrowserObservation,
  type SpecialistAgent,
  type SpecialistAgentInput,
  type SpecialistAgentResult,
  validateSpecialistInput
} from "./specialist-agent.js";
import { createBrowserObserver, type BrowserObserver, type BrowserObservationValidation } from "../observations/browser-observer.js";

export interface ApplicationActionResult {
  readonly confirmed: boolean;
  readonly outputRef?: string;
  readonly observation?: BrowserObservation;
}

export interface ApplicationAgentOptions {
  readonly observe?: (taskId: string, executionEpoch: number) => Promise<BrowserObservation>;
  readonly propose?: (input: SpecialistAgentInput, observation: BrowserObservation) => Promise<ApplicationActionProposal | undefined>;
  readonly authorize?: (proposal: ApplicationActionProposal, observation: BrowserObservation, input: SpecialistAgentInput) => Promise<ApplicationActionProposal>;
  readonly execute?: (proposal: ApplicationActionProposal, input: SpecialistAgentInput) => Promise<ApplicationActionResult>;
  readonly readback?: (input: SpecialistAgentInput, proposal: ApplicationActionProposal) => Promise<ApplicationActionResult>;
  readonly observer?: BrowserObserver;
  readonly evidenceStore?: EvidenceStore;
  readonly now?: () => string;
  readonly version?: string;
}

export function createApplicationAgent(options: RuntimeApplicationAgentOptions): RuntimeExecutor;
export function createApplicationAgent(options?: ApplicationAgentOptions): SpecialistAgent;
export function createApplicationAgent(
  options: RuntimeApplicationAgentOptions | ApplicationAgentOptions = {}
): RuntimeExecutor | SpecialistAgent {
  if ("tools" in options && "evidenceStore" in options) {
    return createRuntimeApplicationAgent(options);
  }
  const now = options.now ?? (() => new Date().toISOString());
  const observer = options.observer ?? (options.observe === undefined ? undefined : createBrowserObserver({ observe: options.observe }, { now }));
  return {
    name: "application_agent",
    version: options.version ?? "1.0.0",
    async execute(input: SpecialistAgentInput): Promise<SpecialistAgentResult> {
      try {
        validateSpecialistInput(input);
        if (input.signal.aborted) return parseSpecialistAgentResult({ status: "failed", errorCode: "application_execution_cancelled", evidenceRefs: [] });
        if (observer === undefined && input.observation === undefined) return emptySpecialistResult("blocked", { blockReason: "application_observer_unconfigured" });
        const observation = input.observation ?? await observer!.observe(input.taskId, input.executionEpoch);
        const evidenceRefs = registerObservation(options.evidenceStore, input, observation, observer);
        const proposal = options.propose === undefined ? undefined : ApplicationActionProposalSchema.parse(await options.propose(input, observation));
        if (proposal === undefined) return emptySpecialistResult("blocked", { blockReason: "application_action_not_proposed", evidenceRefs });
        const validation = observer === undefined
          ? validateWithoutObserver(observation, proposal)
          : observer.validate(observation, proposal);
        if (!validation.valid) return blockedForObservation(validation, evidenceRefs);
        if (proposal.operation === "final_submit") {
          return parseSpecialistAgentResult({
            status: "interrupted",
            pendingInterrupt: interruptForSpecialist(input, "final_submit", "Final submission requires human approval.", [], now),
            evidenceRefs,
            submitted: false
          });
        }
        const authorized = options.authorize === undefined ? proposal : await options.authorize(proposal, observation, input);
        const execution = options.execute === undefined
          ? { confirmed: true, outputRef: `application:${input.taskId}:${input.step.id}` }
          : await options.execute(authorized, input);
        if (!execution.confirmed) return parseSpecialistAgentResult({ status: "blocked", blockReason: "application_execution_unconfirmed", evidenceRefs });
        if (options.readback !== undefined) {
          const readback = await options.readback(input, authorized);
          if (!readback.confirmed) return parseSpecialistAgentResult({ status: "blocked", blockReason: "readback_mismatch", evidenceRefs });
        }
        return parseSpecialistAgentResult({
          status: "completed",
          outputRef: execution.outputRef ?? `application:${input.taskId}:${input.step.id}`,
          evidenceRefs,
          submitted: false
        });
      } catch (error) {
        return parseSpecialistAgentResult({
          status: "failed",
          errorCode: error instanceof Error && /^[a-z0-9_:-]+$/u.test(error.message) ? error.message : "application_agent_failed",
          evidenceRefs: []
        });
      }
    }
  };
}

function blockedForObservation(
  validation: Extract<BrowserObservationValidation, { readonly valid: false }>,
  evidenceRefs: EvidenceRef[]
): SpecialistAgentResult {
  const reason = validation.reason === "target_fingerprint_mismatch"
    ? "target_fingerprint_mismatch"
    : validation.reason === "stale_execution_epoch"
      ? "stale_execution_epoch"
      : "stale_observation";
  return emptySpecialistResult("blocked", { blockReason: reason, evidenceRefs });
}

function validateWithoutObserver(observation: BrowserObservation, proposal: ApplicationActionProposal): BrowserObservationValidation {
  const parsed = BrowserObservationSchema.parse(observation);
  if (parsed.executionEpoch !== proposal.executionEpoch) return { valid: false, reason: "stale_execution_epoch" };
  if (parsed.snapshotId !== proposal.snapshotId) return { valid: false, reason: "stale_observation" };
  if (parsed.targetFingerprint !== proposal.targetFingerprint) return { valid: false, reason: "target_fingerprint_mismatch" };
  if (!parsed.nodeRefs.some((node) => JSON.stringify(node) === JSON.stringify(proposal.nodeRef))) return { valid: false, reason: "stale_node_ref" };
  return { valid: true };
}

function registerObservation(
  store: EvidenceStore | undefined,
  input: SpecialistAgentInput,
  observation: BrowserObservation,
  observer: BrowserObserver | undefined
): EvidenceRef[] {
  if (store === undefined) return [];
  const hash = createHash("sha256").update(JSON.stringify({
    runId: input.runId,
    stepId: input.step.id,
    snapshotId: observation.snapshotId,
    executionEpoch: observation.executionEpoch,
    targetFingerprint: observation.targetFingerprint
  })).digest("hex");
  try {
    const record = store.register({
      runId: input.runId,
      stepId: input.step.id,
      invocationId: input.step.attemptToken ?? `${input.runId}:${input.step.id}:${input.step.attempt}`,
      kind: "observation",
      sourceRef: observer?.observationRef(observation, input.taskId).sourceRef ?? `browser:${input.taskId}:snapshot:${observation.snapshotId}`,
      contentHash: hash
    });
    return [publicEvidenceRef(record)];
  } catch {
    return [];
  }
}
