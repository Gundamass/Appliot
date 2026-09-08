import {
  RuntimeHumanInterruptSchema,
  SupervisorDecisionSchema,
  type CanonicalIntent,
  type PlanState,
  type PlanStep,
  type RuntimeHumanInterrupt,
  type SupervisorDecision
} from "@resume/contracts";
import { randomUUID } from "node:crypto";
export interface SupervisorStateLike {
  readonly runId?: string | undefined;
  readonly intent?: CanonicalIntent | undefined;
  readonly plan?: PlanState | undefined;
  readonly executionEpoch?: number | undefined;
}

export interface SupervisorInput {
  readonly state?: SupervisorStateLike;
  readonly runId?: string | undefined;
  readonly intent?: CanonicalIntent | undefined;
  readonly plan?: PlanState | undefined;
  readonly readyStep?: PlanStep | undefined;
  readonly evidenceRefs?: readonly string[] | undefined;
  readonly executionEpoch?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface Supervisor {
  decide(input: SupervisorInput): Promise<SupervisorDecision>;
}

export interface SupervisorOptions {
  readonly idFactory?: () => string;
  readonly now?: () => string;
  readonly approvalTtlMs?: number;
}

const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1_000;

/**
 * The Supervisor is deliberately a decision-only component. It can select an
 * agent or capability and open a human gate, but it never executes a handler.
 */
export function createSupervisor(options: SupervisorOptions = {}): Supervisor {
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  const approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
  return {
    async decide(input) {
      if (input.signal?.aborted) throw new Error("supervisor_cancelled");
      const step = input.readyStep;
      const intent = input.intent ?? input.state?.intent;
      const plan = input.plan ?? input.state?.plan;
      const runId = input.runId ?? input.state?.runId ?? "run-unknown";
      const executionEpoch = input.executionEpoch ?? input.state?.executionEpoch ?? 0;
      if (step === undefined) {
        return SupervisorDecisionSchema.parse({
          type: "finish",
          outcome: "completed",
          summary: "no pending step"
        });
      }

      const approvalPoint = plan?.approvalPoints.find((point) => point.stepId === step.id);
      if (step.risk === "irreversible" || approvalPoint?.kind === "final_submit") {
        return SupervisorDecisionSchema.parse({
          type: "ask_human",
          interrupt: createInterrupt("final_submit", "Human confirmation is required before final submission.", step, runId, plan, executionEpoch, input.evidenceRefs, idFactory, now, approvalTtlMs)
        });
      }
      if (step.risk === "high" || approvalPoint?.kind === "high_risk_action") {
        return SupervisorDecisionSchema.parse({
          type: "ask_human",
          interrupt: createInterrupt("high_risk_action", "Human confirmation is required for this high-risk action.", step, runId, plan, executionEpoch, input.evidenceRefs, idFactory, now, approvalTtlMs)
        });
      }

      const inputValue = {
        stepId: step.id,
        intentId: intent?.intentId ?? plan?.intentId ?? "unknown",
        planRevision: plan?.revision ?? 1,
        inputRefs: step.inputRefs
      };
      const capability = step.capabilityNames?.[0];
      if (capability !== undefined) {
        return SupervisorDecisionSchema.parse({
          type: "invoke_tool",
          capability,
          input: inputValue,
          reason: `execute capability for ${step.objective}`
        });
      }
      return SupervisorDecisionSchema.parse({
        type: "dispatch_agent",
        agent: `${step.owner}_agent`,
        input: inputValue,
        reason: `dispatch ${step.owner} agent for ${step.objective}`
      });
    }
  };
}

function createInterrupt(
  reason: RuntimeHumanInterrupt["reason"],
  summary: string,
  step: PlanStep,
  runId: string,
  plan: PlanState | undefined,
  executionEpoch: number,
  evidenceRefs: readonly string[] | undefined,
  idFactory: () => string,
  now: () => string,
  approvalTtlMs: number
): RuntimeHumanInterrupt {
  if (!Number.isInteger(approvalTtlMs) || approvalTtlMs <= 0) throw new Error("supervisor_approval_ttl_invalid");
  return RuntimeHumanInterruptSchema.parse({
    interruptId: `interrupt:${idFactory()}`,
    reason,
    summary,
    evidenceRefs: [...new Set(evidenceRefs ?? [])].slice(0, 100),
    proposedAction: {
      kind: reason === "final_submit" ? "final_submit" : "high_risk_action",
      runId,
      stepId: step.id,
      planRevision: plan?.revision ?? 1,
      executionEpoch,
      ...(step.outputRefs.length === 0 ? {} : { outputRefs: step.outputRefs }),
      ...(step.approvalBinding === undefined ? {} : {
        snapshotId: step.approvalBinding.snapshotId,
        targetFingerprint: step.approvalBinding.targetFingerprint,
        payloadHash: step.approvalBinding.payloadHash
      })
    },
    expiresAt: new Date(Date.parse(now()) + approvalTtlMs).toISOString()
  });
}
