import { createHash } from "node:crypto";
import { AgentEventSchema, type AgentEvent } from "@resume/contracts";

const terminalEventTypes = new Set<AgentEvent["type"]>([
  "run_completed",
  "run_failed",
  "run_cancelled",
  "run_blocked",
  "run_expired"
]);

export interface AgentTraceReplayInput {
  readonly schemaVersion: string;
  readonly events: readonly AgentEvent[];
}

export interface AgentTraceReplay {
  readonly schemaVersion: string;
  readonly runId: string;
  readonly eventTypes: AgentEvent["type"][];
  readonly terminalEventType?: AgentEvent["type"];
  readonly nextCursor?: string;
}

export function replayAgentTrace(input: AgentTraceReplayInput): AgentTraceReplay {
  if (input.schemaVersion.length === 0 || input.events.length === 0) throw new Error("agent_replay_input_invalid");
  const events = input.events.map((event) => AgentEventSchema.parse(event));
  const runId = events[0]!.runId;
  if (events.some((event) => event.runId !== runId)) throw new Error("agent_replay_run_mismatch");
  const terminal = [...events].reverse().find((event) => terminalEventTypes.has(event.type));
  return {
    schemaVersion: input.schemaVersion,
    runId,
    eventTypes: events.map((event) => event.type),
    ...(terminal === undefined ? {} : { terminalEventType: terminal.type }),
    nextCursor: events.at(-1)!.eventId
  };
}

export interface ReplayDecisionComparison {
  readonly schemaVersion: string;
  readonly equal: boolean;
  readonly expectedHash: string;
  readonly actualHash: string;
  readonly inputHash?: string;
}

export function compareReplayDecisions(input: {
  readonly schemaVersion: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly inputHash?: string;
}): ReplayDecisionComparison {
  if (input.schemaVersion.length === 0) throw new Error("agent_replay_schema_version_invalid");
  const expectedHash = hashValue(input.expected);
  const actualHash = hashValue(input.actual);
  return {
    schemaVersion: input.schemaVersion,
    equal: expectedHash === actualHash,
    expectedHash,
    actualHash,
    ...(input.inputHash === undefined ? {} : { inputHash: input.inputHash })
  };
}

export async function replayStage<T>(input: {
  readonly schemaVersion: string;
  readonly stage: "intent" | "plan" | "agent";
  readonly events: readonly AgentEvent[];
  readonly rerun: (context: {
    readonly schemaVersion: string;
    readonly stage: "intent" | "plan" | "agent";
    readonly runId: string;
    readonly eventTypes: readonly AgentEvent["type"][];
    readonly events: readonly AgentEvent[];
  }) => Promise<T> | T;
  readonly expected: T;
}): Promise<ReplayDecisionComparison> {
  const replay = replayAgentTrace({ schemaVersion: input.schemaVersion, events: input.events });
  const replayInput = {
    schemaVersion: input.schemaVersion,
    stage: input.stage,
    runId: replay.runId,
    eventTypes: replay.eventTypes,
    events: input.events.map((event) => AgentEventSchema.parse(event))
  } as const;
  const actual = await input.rerun(replayInput);
  return compareReplayDecisions({
    schemaVersion: input.schemaVersion,
    expected: input.expected,
    actual,
    inputHash: hashValue(replayInput)
  });
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}
