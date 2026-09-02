import {
  BudgetLimitsSchema,
  BudgetStateSchema,
  type BudgetLimits,
  type BudgetState
} from "@resume/contracts";

export type BudgetMetric = "steps" | "toolCalls" | "retries" | "replans" | "tokens";

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  maxAttemptsPerStep: 2,
  maxRetries: 64,
  maxReplans: 8,
  maxSteps: 32,
  maxToolCalls: 80,
  maxTokens: 100_000,
  maxDurationMs: 15 * 60 * 1_000
};

const LIMIT_BY_METRIC: Record<BudgetMetric, keyof BudgetLimits> = {
  steps: "maxSteps",
  toolCalls: "maxToolCalls",
  retries: "maxRetries",
  replans: "maxReplans",
  tokens: "maxTokens"
};

export class BudgetExceededError extends Error {
  readonly code: string;
  readonly metric: BudgetMetric | "duration";
  readonly limit: number;
  readonly current: number;

  constructor(metric: BudgetMetric | "duration", current: number, limit: number) {
    const suffix = metric === "toolCalls" ? "tool_calls" : metric;
    super(`budget_${suffix}_exceeded`);
    this.name = "BudgetExceededError";
    this.code = `budget_${suffix}_exceeded`;
    this.metric = metric;
    this.current = current;
    this.limit = limit;
  }
}

export interface BudgetManager {
  readonly limits: BudgetLimits;
  snapshot(): BudgetState;
  consume(metric: BudgetMetric, amount?: number): BudgetState;
  updateElapsed(elapsedMs: number): BudgetState;
  assertWithin(): void;
  remaining(metric: BudgetMetric): number;
}

export function createBudgetManager(
  configured: Partial<BudgetLimits> | undefined = undefined,
  initial: Partial<BudgetState> | undefined = undefined
): BudgetManager {
  const limits = BudgetLimitsSchema.parse({ ...DEFAULT_BUDGET_LIMITS, ...configured });
  let state = BudgetStateSchema.parse({
    steps: 0,
    toolCalls: 0,
    retries: 0,
    replans: 0,
    tokens: 0,
    elapsedMs: 0,
    ...initial
  });

  const snapshot = (): BudgetState => ({ ...state });
  const assertMetric = (metric: BudgetMetric): void => {
    const limit = limits[LIMIT_BY_METRIC[metric]];
    if (state[metric] > limit) throw new BudgetExceededError(metric, state[metric], limit);
  };

  return {
    limits,
    snapshot,
    consume(metric, amount = 1) {
      if (!Number.isInteger(amount) || amount <= 0) throw new Error("budget_increment_invalid");
      const limit = limits[LIMIT_BY_METRIC[metric]];
      const next = state[metric] + amount;
      if (next > limit) throw new BudgetExceededError(metric, next, limit);
      state = BudgetStateSchema.parse({ ...state, [metric]: next });
      return snapshot();
    },
    updateElapsed(elapsedMs) {
      if (!Number.isInteger(elapsedMs) || elapsedMs < 0) throw new Error("budget_elapsed_invalid");
      const next = Math.max(state.elapsedMs, elapsedMs);
      if (next > limits.maxDurationMs) {
        throw new BudgetExceededError("duration", next, limits.maxDurationMs);
      }
      state = BudgetStateSchema.parse({ ...state, elapsedMs: next });
      return snapshot();
    },
    assertWithin() {
      (Object.keys(LIMIT_BY_METRIC) as BudgetMetric[]).forEach(assertMetric);
      if (state.elapsedMs > limits.maxDurationMs) {
        throw new BudgetExceededError("duration", state.elapsedMs, limits.maxDurationMs);
      }
    },
    remaining(metric) {
      return Math.max(0, limits[LIMIT_BY_METRIC[metric]] - state[metric]);
    }
  };
}
