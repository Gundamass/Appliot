import { describe, expect, it } from "vitest";
import { createBudgetManager } from "./budget-manager.js";

describe("BudgetManager", () => {
  it("enforces configured counters and reports the exceeded budget", () => {
    const budget = createBudgetManager({
      maxSteps: 2,
      maxToolCalls: 1,
      maxTokens: 10
    });

    budget.consume("steps");
    budget.consume("steps");
    expect(() => budget.consume("steps")).toThrow("budget_steps_exceeded");

    budget.consume("toolCalls");
    expect(() => budget.consume("toolCalls")).toThrow("budget_tool_calls_exceeded");
    expect(budget.snapshot()).toMatchObject({ steps: 2, toolCalls: 1 });
  });

  it("tracks elapsed time without allowing a negative duration", () => {
    const budget = createBudgetManager({ maxDurationMs: 100 });
    budget.updateElapsed(40);
    budget.updateElapsed(10);
    expect(budget.snapshot().elapsedMs).toBe(40);
    expect(() => budget.updateElapsed(101)).toThrow("budget_duration_exceeded");
  });

  it("keeps total retry budget separate from per-step attempt limits", () => {
    const budget = createBudgetManager({ maxAttemptsPerStep: 1, maxRetries: 2 });
    budget.consume("retries");
    budget.consume("retries");
    expect(() => budget.consume("retries")).toThrow("budget_retries_exceeded");
  });
});
