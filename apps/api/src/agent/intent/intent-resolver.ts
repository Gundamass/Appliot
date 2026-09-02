import { randomUUID } from "node:crypto";
import {
  CanonicalIntentSchema,
  IntentResolutionSchema,
  RiskProfileSchema,
  type CanonicalIntent,
  type IntentResolution
} from "@resume/contracts";
import type { IntentContext, IntentDraft, UserMessage } from "./intent-context.js";
import { createAmbiguityDetector, type AmbiguityDetector } from "./ambiguity-detector.js";
import { createClarificationManager, type ClarificationManager } from "./clarification-manager.js";
import { createIntentUnderstanding, type IntentUnderstanding } from "./intent-understanding.js";

export interface IntentResolutionRuntimeContext {
  signal: AbortSignal;
  executionEpoch: number;
}

export interface IntentResolver {
  resolve(
    input: UserMessage,
    context?: IntentContext,
    runtime?: IntentResolutionRuntimeContext
  ): Promise<IntentResolution>;
}

export interface IntentResolverOptions {
  understanding?: IntentUnderstanding;
  ambiguityDetector?: AmbiguityDetector;
  clarificationManager?: ClarificationManager;
  idFactory?: () => string;
  now?: () => string;
}

export function createIntentResolver(options: IntentResolverOptions = {}): IntentResolver {
  const understanding = options.understanding ?? createIntentUnderstanding();
  const ambiguityDetector = options.ambiguityDetector ?? createAmbiguityDetector();
  const clarificationManager = options.clarificationManager ?? createClarificationManager();
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async resolve(input, context = { availableJobs: [], availableResumes: [] }, runtime) {
      let draft: IntentDraft;
      try {
        if (runtime?.signal.aborted) throw new Error("agent_run_cancelled");
        draft = await understanding.extract(input, context, runtime);
        if (runtime?.signal.aborted) throw new Error("agent_run_cancelled");
      } catch {
        return IntentResolutionSchema.parse({ type: "rejected", reason: "intent_extraction_invalid" });
      }
      if (draft.primaryGoal === undefined) {
        return IntentResolutionSchema.parse({ type: "rejected", reason: "intent_goal_unrecognized" });
      }

      const detected = ambiguityDetector.detect(draft, context);
      const intent = buildCanonicalIntent(input, draft, detected, context, idFactory, now);
      const blocking = detected.missing.filter((item) => item.blocking);
      if (blocking.length > 0) {
        const question = clarificationManager.selectQuestion(detected.missing, detected.ambiguities, context);
        return IntentResolutionSchema.parse({ type: "needs_clarification", intent, question });
      }
      return IntentResolutionSchema.parse({ type: "resolved", intent });
    }
  };
}

function buildCanonicalIntent(
  input: UserMessage,
  draft: IntentDraft,
  detected: ReturnType<AmbiguityDetector["detect"]>,
  context: IntentContext,
  idFactory: () => string,
  now: () => string
): CanonicalIntent {
  const applicationTask = ["prepare_application", "fill_application", "submit_application"].includes(draft.primaryGoal!);
  const requiresHumanApproval = applicationTask || draft.constraints.some((constraint) =>
    constraint.type === "submit_requires_approval" && constraint.value === true
  );
  const level = draft.primaryGoal === "submit_application" ? "irreversible" : requiresHumanApproval ? "high" : "low";
  const riskProfile = RiskProfileSchema.parse({
    level,
    requiresHumanApproval,
    reasons: requiresHumanApproval ? ["external application actions require human approval"] : []
  });
  const timestamp = now();
  return CanonicalIntentSchema.parse({
    intentId: idFactory(),
    schemaVersion: "1.0.0",
    revision: 1,
    rawInputRef: input.messageId ?? idFactory(),
    primaryGoal: draft.primaryGoal,
    subGoals: draft.subGoals,
    entities: draft.entities,
    constraints: draft.constraints,
    preferences: draft.preferences,
    successCriteria: draft.successCriteria,
    riskProfile,
    confidence: draft.confidence,
    ambiguities: detected.ambiguities,
    missingInformation: detected.missing,
    autonomyLevel: draft.autonomyLevel ?? (applicationTask ? "execute_with_approval" : "prepare"),
    evidenceRefs: context.evidenceRefs ?? draft.evidenceRefs ?? [],
    createdAt: timestamp
  });
}
