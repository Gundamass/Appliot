import { createHash } from "node:crypto";
import { Annotation } from "@langchain/langgraph";
import { z, type ZodTypeAny } from "zod";
import type { SqliteDatabase } from "../../db/client.js";
import {
  AgentRunInputSchema,
  AgentRunStatusSchema,
  BudgetLimitsSchema,
  BudgetStateSchema,
  CanonicalIntentSchema,
  EvidenceRefSchema,
  MemoryRefSchema,
  PlanStateSchema,
  RuntimeErrorSchema,
  RuntimeHumanInterruptSchema,
  RuntimeHumanResumeSchema,
  SupervisorDecisionSchema,
  type AgentRunInput,
  type AgentRunStatus,
  type BudgetLimits,
  type BudgetState,
  type CanonicalIntent,
  type EvidenceRef,
  type MemoryRef,
  type PlanState,
  type RuntimeError,
  type RuntimeHumanInterrupt,
  type SupervisorDecision
} from "@resume/contracts";

/* Small local schema helpers keep the state declaration readable while still
 * making RuntimeStateSchema a strict Zod object. */
const zEnum = <T extends [string, ...string[]]>(values: T) => z.enum(values);
const objectSchema = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const stringSchema = () => z.string().min(1).max(256);
const zStringMax = (max: number) => z.string().max(max);
const nonNegativeIntegerSchema = () => z.number().int().nonnegative();
const datetimeSchema = () => z.string().datetime();
const hashSchema = () => z.string().regex(/^[a-f0-9]{64}$/iu);
const arraySchema = (schema: ZodTypeAny, max: number) => z.array(schema).max(max);
const enumSchema = <T extends [string, ...string[]]>(schema: z.ZodEnum<T>) => schema;
type Infer<T extends ZodTypeAny> = z.infer<T>;

export const RuntimePhaseSchema = zEnum([
  "intent", "plan", "dispatch", "wait", "inspect", "human_gate", "complete", "blocked", "fail", "cancelled"
]);
export type RuntimePhase = z.infer<typeof RuntimePhaseSchema>;

export const RuntimeStateSchema = objectSchema({
  runId: stringSchema(),
  requestedBy: stringSchema(),
  status: AgentRunStatusSchema,
  phase: enumSchema(RuntimePhaseSchema),
  executionEpoch: nonNegativeIntegerSchema(),
  input: AgentRunInputSchema.optional(),
  intent: CanonicalIntentSchema.optional(),
  plan: PlanStateSchema.optional(),
  currentStepId: stringSchema().optional(),
  pendingInterrupt: RuntimeHumanInterruptSchema.optional(),
  transientHumanResume: RuntimeHumanResumeSchema.optional(),
  budget: BudgetStateSchema,
  budgetLimits: BudgetLimitsSchema,
  memoryRefs: arraySchema(MemoryRefSchema, 200),
  evidenceRefs: arraySchema(EvidenceRefSchema, 500),
  completedActionIds: arraySchema(stringSchema(), 500),
  intentRef: stringSchema().optional(),
  planRef: stringSchema().optional(),
  summary: zStringMax(4_000).optional(),
  error: RuntimeErrorSchema.optional(),
  stateHash: hashSchema(),
  createdAt: datetimeSchema(),
  updatedAt: datetimeSchema()
});

export type RuntimeState = {
  runId: string;
  requestedBy: string;
  status: AgentRunStatus;
  phase: RuntimePhase;
  executionEpoch: number;
  input?: AgentRunInput | undefined;
  intent?: CanonicalIntent | undefined;
  plan?: PlanState | undefined;
  currentStepId?: string | undefined;
  pendingInterrupt?: RuntimeHumanInterrupt | undefined;
  transientHumanResume?: z.infer<typeof RuntimeHumanResumeSchema> | undefined;
  budget: BudgetState;
  budgetLimits: BudgetLimits;
  memoryRefs: MemoryRef[];
  evidenceRefs: EvidenceRef[];
  completedActionIds: string[];
  intentRef?: string | undefined;
  planRef?: string | undefined;
  lastDecision?: SupervisorDecision | undefined;
  summary?: string | undefined;
  error?: RuntimeError | undefined;
  stateHash: string;
  createdAt: string;
  updatedAt: string;
};

export const RuntimeGraphStateSchema = objectSchema({
  runId: stringSchema(),
  status: AgentRunStatusSchema,
  phase: enumSchema(RuntimePhaseSchema),
  executionEpoch: nonNegativeIntegerSchema(),
  currentStepId: stringSchema().optional(),
  intentRef: stringSchema().optional(),
  planRef: stringSchema().optional(),
  pendingInterrupt: RuntimeHumanInterruptSchema.optional(),
  budget: BudgetStateSchema,
  memoryRefs: arraySchema(MemoryRefSchema, 200),
  evidenceRefs: arraySchema(EvidenceRefSchema, 500),
  completedActionIds: arraySchema(stringSchema(), 500),
  stateHash: hashSchema()
});

export type RuntimeGraphState = Infer<typeof RuntimeGraphStateSchema>;

function replace<T>(_left: T | undefined, right: T | undefined): T | undefined {
  return right;
}

function appendUnique(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])];
}

export const RuntimeGraphStateAnnotation = Annotation.Root({
  runId: Annotation<string>,
  status: Annotation<AgentRunStatus>,
  phase: Annotation<RuntimePhase>,
  executionEpoch: Annotation<number>,
  currentStepId: Annotation<string | undefined>({ reducer: replace, default: () => undefined }),
  intentRef: Annotation<string | undefined>({ reducer: replace, default: () => undefined }),
  planRef: Annotation<string | undefined>({ reducer: replace, default: () => undefined }),
  pendingInterrupt: Annotation<RuntimeHumanInterrupt | undefined>({ reducer: replace, default: () => undefined }),
  budget: Annotation<BudgetState>,
  memoryRefs: Annotation<MemoryRef[]>({ reducer: (_left, right) => right, default: () => [] }),
  evidenceRefs: Annotation<EvidenceRef[]>({ reducer: (_left, right) => right, default: () => [] }),
  completedActionIds: Annotation<string[]>({ reducer: appendUnique, default: () => [] }),
  stateHash: Annotation<string>
});

export type RuntimeGraphStateUpdate = typeof RuntimeGraphStateAnnotation.Update;

export interface RuntimeArtifactStore {
  saveIntent(intent: CanonicalIntent): string;
  getIntent(ref: string): CanonicalIntent | undefined;
  savePlan(plan: PlanState): string;
  getPlan(ref: string): PlanState | undefined;
}

export function createInMemoryArtifactStore(): RuntimeArtifactStore {
  const intents = new Map<string, CanonicalIntent>();
  const plans = new Map<string, PlanState>();
  return {
    saveIntent(intent) {
      const parsed = CanonicalIntentSchema.parse(intent);
      const ref = `intent:${parsed.intentId}:${parsed.revision}`;
      intents.set(ref, clone(parsed));
      return ref;
    },
    getIntent(ref) {
      const value = intents.get(ref);
      return value === undefined ? undefined : clone(value);
    },
    savePlan(plan) {
      const parsed = PlanStateSchema.parse(plan);
      const ref = `plan:${parsed.planId}:${parsed.revision}`;
      plans.set(ref, clone(parsed));
      return ref;
    },
    getPlan(ref) {
      const value = plans.get(ref);
      return value === undefined ? undefined : clone(value);
    }
  };
}

export function createSqliteRuntimeArtifactStore(database: SqliteDatabase): RuntimeArtifactStore {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_runtime_artifacts (
      ref TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('intent', 'plan')),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      created_at TEXT NOT NULL
    );
  `);
  const upsert = database.prepare(`
    INSERT INTO agent_runtime_artifacts (ref, kind, payload_json, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(ref) DO UPDATE SET payload_json = excluded.payload_json, created_at = excluded.created_at
  `);
  const find = database.prepare("SELECT kind, payload_json FROM agent_runtime_artifacts WHERE ref = ?");
  const save = database.transaction((ref: string, kind: "intent" | "plan", payload: string, createdAt: string) => {
    upsert.run(ref, kind, payload, createdAt);
  });

  return {
    saveIntent(intent) {
      const parsed = CanonicalIntentSchema.parse(intent);
      const ref = `intent:${parsed.intentId}:${parsed.revision}`;
      save(ref, "intent", JSON.stringify(parsed), new Date().toISOString());
      return ref;
    },
    getIntent(ref) {
      const row = find.get(ref) as { kind: string; payload_json: string } | undefined;
      if (row === undefined || row.kind !== "intent") return undefined;
      return CanonicalIntentSchema.parse(JSON.parse(row.payload_json));
    },
    savePlan(plan) {
      const parsed = PlanStateSchema.parse(plan);
      const ref = `plan:${parsed.planId}:${parsed.revision}`;
      save(ref, "plan", JSON.stringify(parsed), new Date().toISOString());
      return ref;
    },
    getPlan(ref) {
      const row = find.get(ref) as { kind: string; payload_json: string } | undefined;
      if (row === undefined || row.kind !== "plan") return undefined;
      return PlanStateSchema.parse(JSON.parse(row.payload_json));
    }
  };
}

export function createInitialRuntimeState(
  runId: string,
  input: AgentRunInput,
  limits: BudgetLimits,
  now: string
): RuntimeState {
  return RuntimeStateSchema.parse({
    runId,
    requestedBy: input.requestedBy,
    status: "running",
    phase: "intent",
    executionEpoch: 0,
    input: AgentRunInputSchema.parse(input),
    budget: { steps: 0, toolCalls: 0, retries: 0, replans: 0, tokens: 0, elapsedMs: 0 },
    budgetLimits: BudgetLimitsSchema.parse(limits),
    memoryRefs: [],
    evidenceRefs: [],
    completedActionIds: [],
    stateHash: "0".repeat(64),
    createdAt: now,
    updatedAt: now
  });
}

export function toRuntimeGraphState(state: RuntimeState): RuntimeGraphState {
  return RuntimeGraphStateSchema.parse({
    runId: state.runId,
    status: state.status,
    phase: state.phase,
    executionEpoch: state.executionEpoch,
    currentStepId: state.currentStepId,
    intentRef: state.intentRef,
    planRef: state.planRef,
    pendingInterrupt: state.pendingInterrupt,
    budget: state.budget,
    memoryRefs: state.memoryRefs,
    evidenceRefs: state.evidenceRefs,
    completedActionIds: state.completedActionIds,
    stateHash: state.stateHash
  });
}

export function stateHash(state: RuntimeState): string {
  const graph = {
    ...toRuntimeGraphState(state),
    budgetLimits: state.budgetLimits,
    createdAt: state.createdAt,
    stateHash: "0".repeat(64)
  };
  return createHash("sha256").update(JSON.stringify(graph)).digest("hex");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
