# LangGraph Agent Architecture Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fragmented XState/service orchestration with one auditable LangGraph runtime while preserving resume parsing, evidence grounding, ATS matching, controlled Playwright filling, challenge handoff, and the permanent ban on automatic submission.

**Architecture:** The API owns a typed LangGraph main graph and three bounded subgraphs: resume ingestion, job matching, and application execution. Existing deterministic domain services remain behind restricted ports; graph state stores references and decisions, SQLite stores checkpoints, business records, traces, and a LangSmith export outbox, and every model or side-effect boundary emits a redacted audit event. LangSmith is an optional observation/evaluation sink; local TraceSink remains authoritative and the OCR HTTP contract stays runtime-neutral so PyTorch remains the production baseline while a MindSpore Lite backend is evaluated behind an explicit rollout gate.

**Tech Stack:** TypeScript 5.8.3, Node.js >=24.14.1, `@langchain/langgraph` 1.4.12, `@langchain/langgraph-checkpoint` 1.1.5, `@langchain/core` 1.2.9, `langsmith` 0.9.0, Zod 3.25.76, SQLite/better-sqlite3 11.10.0, Vitest 3.2.4, Python 3.12, FastAPI, PyTorch 2.6, optional externally packaged MindSpore Lite runtime, Playwright 1.53.1.

## Global Constraints

- LangGraph is the only state-transition authority for every new graph-owned task; XState may finish pre-cutover tasks only during the bounded migration window.
- Model code may classify, rank, and draft, but it never receives browser write, navigation, approval-token, execution-epoch, or submission capabilities.
- No layer may automatically submit an application. `submit`, `final_submit`, and equivalent controls must remain denied by graph routing, Action Policy, and Browser Worker.
- Every model result must pass a strict Zod schema and may reference only candidate IDs and evidence IDs supplied in its request.
- Objective facts without confirmed evidence cause an interrupt; they are never guessed or silently defaulted.
- Challenge detection invalidates the execution epoch before the graph records an interrupt.
- Checkpoint payloads contain small state and object IDs, not PDF bytes, page images, full resume text, access tokens, or raw secrets.
- Audit records contain hashes, IDs, counts, confidence, bounded reasons, and error codes; direct phone, email, ID-number, address, resume text, and model prompts are rejected before persistence.
- LangSmith is disabled by default and receives only a versioned allowlist projection; raw resume text, prompts, DOM, evidence quotes, form values, secrets, and internal database primary keys never leave the local runtime.
- Trace and LangSmith outbox rows are committed in one SQLite transaction; LangSmith outages, rate limits, and authentication failures never block graph execution or checkpoint recovery.
- PyTorch OCR remains production default until the MindSpore Lite candidate passes the same golden corpus and deployment-manifest checks.
- Extraction accuracy, Recall@3, field readback success, latency, and mis-submission metrics are published only from versioned evaluation output.

---

## Delivery Map

| Phase | Independently testable result | Rollback boundary |
|---|---|---|
| 1. Foundation | Typed state, restricted tools, redacted traces, LangSmith outbox, persistent LangGraph checkpoints | No production route uses the graph |
| 2. Read-only subgraphs | Resume ingestion and job matching run through LangGraph with existing domain services | Route calls return to existing coordinators |
| 3. Controlled application graph | New tasks use LangGraph for observe/fill/readback/interrupt/final review | New-task routing flag returns to XState before task creation |
| 4. Single-authority cutover | XState is removed after legacy-task drain and parity tests | Deploy previous release; graph checkpoints remain append-only |
| 5. OCR backend evaluation | Runtime-neutral OCR protocol and gated MindSpore Lite candidate | Keep `OCR_RUNTIME=pytorch` |
| 6. Reproducible evaluation | Metrics are generated from fixed manifests and stored reports | Reports do not alter runtime behavior |

## File Structure

### Foundation

- Create `packages/contracts/src/agent-graph.ts`: graph state, interrupt, error, tool decision, and trace schemas.
- Modify `packages/contracts/src/index.ts`: export graph contracts.
- Create `apps/api/src/agent/trace-sink.ts`: redaction-enforcing `TraceSink` and SQLite implementation.
- Create `apps/api/src/agent/tool-registry.ts`: closed registry of read/model/side-effect tools.
- Create `apps/api/src/agent/langsmith-outbox.ts`: allowlist projection, retry state, and dead-letter handling.
- Create `apps/api/src/agent/langsmith-exporter.ts`: injected LangSmith client adapter with no-network default.
- Create `apps/api/src/agent/sqlite-checkpointer.ts`: LangGraph `BaseCheckpointSaver` implementation over the existing SQLite connection.
- Create `apps/api/src/agent/state.ts`: LangGraph annotations and reducers.
- Create `apps/api/src/agent/main-graph.ts`: main graph routing and shared interrupt handling.

### Subgraphs

- Create `apps/api/src/agent/subgraphs/resume-ingestion.ts`: text-first/OCR-fallback extraction orchestration.
- Create `apps/api/src/agent/subgraphs/job-matching.ts`: ATS extraction, deterministic filtering, hybrid retrieval, and evidence-constrained advisory.
- Create `apps/api/src/agent/subgraphs/application-execution.ts`: observe, resolve, authorize, execute, double-readback, audit, and final-review routing.
- Create `apps/api/src/agent/application-tools.ts`: deterministic application ports extracted from the current service.
- Create `apps/api/src/agent/graph-service.ts`: stable facade used by HTTP routes and task events.

### Cutover

- Modify `apps/api/src/production-dependencies.ts`: compose graph, tools, checkpointer, and TraceSink.
- Modify `apps/api/src/applications/application-service.ts`: preserve the public `ApplicationService` interface while delegating graph-owned tasks.
- Modify `apps/api/src/applications/routes.ts`: pass resume commands through graph resume inputs.
- Modify `apps/api/src/db/migrate.ts`: create graph/checkpoint/trace tables and task ownership marker.
- Delete `apps/api/src/applications/application-machine.ts` and its test only after the legacy-task drain gate.
- Modify `apps/api/package.json`: remove XState at final cutover, not during coexistence.

### OCR and Evaluation

- Modify `services/ocr-worker/src/resume_ocr_worker/types.py`: runtime-neutral result and backend protocol.
- Create `services/ocr-worker/src/resume_ocr_worker/backends/pytorch_backend.py`.
- Create `services/ocr-worker/src/resume_ocr_worker/backends/mindspore_lite_backend.py`.
- Create `services/ocr-worker/src/resume_ocr_worker/backend_factory.py`.
- Modify `services/ocr-worker/src/resume_ocr_worker/config.py`, `app.py`, and `model.py`.
- Modify `packages/profile-domain/src/pdf/remote-ocr-engine.ts`: validate runtime and optional block geometry.
- Create `evals/agent/manifest.schema.json`, `evals/agent/run-evals.ts`, and fixed fixture manifests.
- Create `evals/agent/langsmith-review.test.ts`: privacy, correlation, failure-isolation, and local/remote event parity tests.

---

### Task 1: Add LangGraph Dependencies and Typed Graph Contracts

**Files:**
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `packages/contracts/src/agent-graph.ts`
- Create: `packages/contracts/src/agent-graph.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Produces: `AgentGraphState`, `AgentGraphStateSchema`, `HumanInterrupt`, `HumanResume`, `GraphError`, `AuditTraceInput`, and their Zod schemas.
- Consumes: existing `ApplicationQuestionSchema`, `JobSourceSchema`, and JSON-compatible contract conventions.

- [ ] **Step 1: Write failing contract tests**

```ts
import { describe, expect, it } from "vitest";
import { AgentGraphStateSchema, AuditTraceInputSchema, HumanResumeSchema } from "./agent-graph.js";

describe("agent graph contracts", () => {
  it("accepts reference-only graph state", () => {
    expect(AgentGraphStateSchema.parse({
      threadId: "thread-1", runId: "run-1", taskId: "task-1", graphVersion: "agent-v1",
      status: "running", profileRevision: 3, currentSubgraph: "application", auditEventIds: []
    }).status).toBe("running");
  });

  it("rejects unbounded sensitive trace payloads", () => {
    expect(() => AuditTraceInputSchema.parse({
      runId: "run-1", taskId: "task-1", node: "resolve", kind: "model_decision",
      outcome: "accepted", reasonCode: "candidate_supported", email: "person@example.com"
    })).toThrow();
  });

  it("requires the interrupt id when work resumes", () => {
    expect(HumanResumeSchema.parse({ interruptId: "int-1", action: "confirm", values: {} }).action)
      .toBe("confirm");
  });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails because the module is absent**

Run: `rtk corepack pnpm --filter @resume/contracts test -- agent-graph.test.ts`

Expected: FAIL with module resolution error for `./agent-graph.js`.

- [ ] **Step 3: Add pinned dependencies and contracts**

Add API dependencies:

```json
"@langchain/core": "1.2.9",
"@langchain/langgraph": "1.4.12",
"@langchain/langgraph-checkpoint": "1.1.5",
"zod": "3.25.76"
```

Define the state discriminators exactly as follows:

```ts
export const GraphStatusSchema = z.enum(["running", "interrupted", "completed", "failed", "cancelled"]);
export const SubgraphNameSchema = z.enum(["resume_ingestion", "job_matching", "application"]);
export const HumanInterruptSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["missing_fact", "fact_conflict", "field_semantics", "content_review", "login", "challenge", "final_review"]),
  reasonCode: z.string().min(1).max(80),
  questionIds: z.array(z.string().min(1)).max(50),
  evidenceIds: z.array(z.string().min(1)).max(100),
  createdAt: z.string().datetime()
}).strict();
export const HumanResumeSchema = z.object({
  interruptId: z.string().min(1),
  action: z.enum(["confirm", "correct", "approve", "reject", "cancel"]),
  values: z.record(z.unknown())
}).strict();
export const GraphErrorSchema = z.object({
  code: z.string().min(1).max(80), retryable: z.boolean(), node: z.string().min(1), detailHash: z.string().optional()
}).strict();
export const ResumeIngestionStateSchema = z.object({
  documentId: z.string().optional(), documentFingerprint: z.string().length(64).optional(),
  pageSources: z.array(z.enum(["pdf", "ocr"])).optional(), candidateFactIds: z.array(z.string()).optional(),
  acceptedFactIds: z.array(z.string()).optional(), publishedProfileRevision: z.number().int().positive().optional()
}).strict();
export const JobMatchingStateSchema = z.object({
  sessionId: z.string(), postingIds: z.array(z.string()).optional(),
  recommendedResultIds: z.array(z.string()).optional(), conflictResultIds: z.array(z.string()).optional(),
  adapterVersion: z.string().optional(), scoringVersion: z.literal("job-match-v1").optional(),
  embeddingHealthy: z.boolean().optional()
}).strict();
export const ApplicationExecutionStateSchema = z.object({
  applicationUrl: z.string().url(), snapshotId: z.string().optional(), executionEpoch: z.number().int().nonnegative(),
  fieldIds: z.array(z.string()).optional(), plannedCommandIds: z.array(z.string()).optional(),
  completedCommandIds: z.array(z.string()).optional(), retryCount: z.number().int().min(0).max(1),
  finalReviewLocked: z.boolean()
}).strict();
export const AgentGraphStateSchema = z.object({
  threadId: z.string().min(1), runId: z.string().min(1), taskId: z.string().min(1),
  graphVersion: z.literal("agent-v1"), status: GraphStatusSchema,
  profileRevision: z.number().int().nonnegative(), expectationRevision: z.number().int().nonnegative().optional(),
  selectedJobId: z.string().optional(), currentSubgraph: SubgraphNameSchema,
  currentNode: z.string().optional(), pendingInterrupt: HumanInterruptSchema.optional(),
  resumeIngestion: ResumeIngestionStateSchema.optional(), jobMatching: JobMatchingStateSchema.optional(),
  application: ApplicationExecutionStateSchema.optional(), error: GraphErrorSchema.optional(),
  auditEventIds: z.array(z.string())
}).strict();
export const AuditTraceInputSchema = z.object({
  runId: z.string(), taskId: z.string(), node: z.string(),
  kind: z.enum(["node", "tool_call", "model_decision", "interrupt", "checkpoint", "safety_block"]),
  outcome: z.string().max(80), reasonCode: z.string().max(80),
  confidence: z.number().min(0).max(1).optional(), candidateIds: z.array(z.string()).max(100).optional(),
  evidenceIds: z.array(z.string()).max(100).optional(), durationMs: z.number().nonnegative().optional(),
  counts: z.record(z.number().int().nonnegative()).optional(), contentHash: z.string().optional()
}).strict();
```

Export inferred TypeScript types from these schemas and export the module from `packages/contracts/src/index.ts`.

- [ ] **Step 4: Install and verify contracts**

Run: `rtk corepack pnpm install`

Expected: exit 0 with the three pinned LangChain packages in `pnpm-lock.yaml` and no `@langchain/langgraph-checkpoint-sqlite` dependency.

Run: `rtk corepack pnpm --filter @resume/contracts test -- agent-graph.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/api/package.json pnpm-lock.yaml packages/contracts/src/agent-graph.ts packages/contracts/src/agent-graph.test.ts packages/contracts/src/index.ts
rtk git commit -m "feat: add typed LangGraph contracts"
```

### Task 2: Implement Redacted TraceSink and Restricted Tool Registry

**Files:**
- Create: `apps/api/src/agent/trace-sink.ts`
- Create: `apps/api/src/agent/trace-sink.test.ts`
- Create: `apps/api/src/agent/tool-registry.ts`
- Create: `apps/api/src/agent/tool-registry.test.ts`
- Modify: `apps/api/src/db/migrate.ts`
- Modify: `apps/api/src/db/migrate.test.ts`

**Interfaces:**
- Consumes: `AuditTraceInputSchema` from Task 1 and `SqliteDatabase`.
- Produces: `TraceSink.record(input): string`, `TraceSink.list(runId)`, `RestrictedToolRegistry.invoke(name, input, context)`, and `ToolContext`.

- [ ] **Step 1: Write failing tests for redaction and closed tool access**

```ts
it("persists only schema-approved trace fields", () => {
  const sink = createSqliteTraceSink(database);
  const id = sink.record({ runId: "r", taskId: "t", node: "judge", kind: "model_decision",
    outcome: "accepted", reasonCode: "grounded", evidenceIds: ["fact-1"] });
  expect(sink.list("r")).toEqual([expect.objectContaining({ id, evidenceIds: ["fact-1"] })]);
  expect(JSON.stringify(sink.list("r"))).not.toContain("person@example.com");
});

it("does not expose browser writes to model callers", async () => {
  const registry = createRestrictedToolRegistry({ read_profile: async () => ({ revision: 1 }) });
  await expect(registry.invoke("execute_browser_command", {}, { caller: "model", runId: "r", taskId: "t" }))
    .rejects.toThrow("tool_not_allowed");
});
```

- [ ] **Step 2: Run tests and confirm missing implementations**

Run: `rtk corepack pnpm --filter @resume/api test -- src/agent/trace-sink.test.ts src/agent/tool-registry.test.ts`

Expected: FAIL because both modules are absent.

- [ ] **Step 3: Add audit storage and strict registry**

Add these tables in `migrateDatabase`:

```sql
CREATE TABLE IF NOT EXISTS agent_trace_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  node TEXT NOT NULL,
  kind TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, sequence)
);
CREATE INDEX IF NOT EXISTS agent_trace_events_run_sequence_idx ON agent_trace_events(run_id, sequence);
```

Implement `TraceSink` so `record` first calls `AuditTraceInputSchema.parse`, allocates the next per-run sequence in one SQLite transaction, stores only the parsed value, and returns `trace_<sha256(runId + sequence)>`. Implement the registry with immutable definitions carrying `allowedCallers: Array<"graph" | "model">`; reject unknown names and caller mismatches before invoking the handler. Register browser write tools with `allowedCallers: ["graph"]` only.

- [ ] **Step 4: Verify focused tests and migration idempotency**

Run: `rtk corepack pnpm --filter @resume/api test -- src/agent/trace-sink.test.ts src/agent/tool-registry.test.ts src/db/migrate.test.ts`

Expected: PASS and a second `migrateDatabase(database)` call changes no schema or data.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/api/src/agent/trace-sink.ts apps/api/src/agent/trace-sink.test.ts apps/api/src/agent/tool-registry.ts apps/api/src/agent/tool-registry.test.ts apps/api/src/db/migrate.ts apps/api/src/db/migrate.test.ts
rtk git commit -m "feat: add redacted agent audit and restricted tools"
```

### Task 2A: Add the Optional LangSmith Review Outbox

**Files:**
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/api/src/agent/langsmith-outbox.ts`
- Create: `apps/api/src/agent/langsmith-outbox.test.ts`
- Create: `apps/api/src/agent/langsmith-exporter.ts`
- Create: `apps/api/src/agent/langsmith-exporter.test.ts`
- Modify: `apps/api/src/agent/trace-sink.ts`
- Modify: `apps/api/src/agent/trace-sink.test.ts`
- Modify: `apps/api/src/db/migrate.ts`
- Modify: `apps/api/src/db/migrate.test.ts`
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/config.test.ts`

**Interfaces:**
- Consumes: the parsed `AuditTraceInput` and SQLite transaction helper from Task 2.
- Produces: `projectLangSmithEvent(input): LangSmithReviewEvent`, `LangSmithOutbox.enqueue`, `LangSmithOutbox.claim`, `LangSmithOutbox.markSent`, `LangSmithOutbox.markFailed`, and `LangSmithExporter.flushOnce`.

- [ ] **Step 1: Write failing privacy, transaction, and failure-isolation tests**

```ts
it("writes the local trace and allowlisted outbox projection in one transaction", () => {
  const sink = createSqliteTraceSink(database, { langSmithEnabled: true });
  const id = sink.record({
    runId: "run-1", taskId: "task-1", node: "judge", kind: "model_decision",
    outcome: "accepted", reasonCode: "grounded", evidenceIds: ["evidence-1"],
    contentHash: "a".repeat(64)
  });
  expect(sink.list("run-1")).toHaveLength(1);
  expect(listOutbox(database, "run-1")).toEqual([
    expect.objectContaining({ traceId: id, status: "pending" })
  ]);
});

it.each(["张三", "13800138000", "person@example.com", "<div>resume</div>"])(
  "rejects sensitive export value %s", (value) => {
    expect(() => projectLangSmithEvent({
      runId: "run-1", taskId: "task-1", node: "judge", kind: "model_decision",
      outcome: "accepted", reasonCode: "grounded", summary: value
    })).toThrow("trace_pii_rejected");
  }
);

it("keeps graph execution independent from LangSmith outage", async () => {
  const exporter = createLangSmithExporter({
    client: { createRun: vi.fn().mockRejectedValue(new Error("timeout")) },
    outbox: createOutbox(database)
  });
  await expect(exporter.flushOnce()).resolves.toMatchObject({ sent: 0, retried: 1 });
});
```

- [ ] **Step 2: Run focused tests and confirm the modules and migration are absent**

Run: `rtk corepack pnpm --filter @resume/api test -- src/agent/langsmith-outbox.test.ts src/agent/langsmith-exporter.test.ts src/agent/trace-sink.test.ts`

Expected: FAIL because the exporter/outbox modules and their tables are absent.

- [ ] **Step 3: Add the outbox schema and allowlist projection**

Add this idempotent schema in `migrateDatabase`:

```sql
CREATE TABLE IF NOT EXISTS langsmith_trace_outbox (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL UNIQUE,
  run_id_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'sent', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL,
  remote_run_id TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS langsmith_trace_outbox_ready_idx
  ON langsmith_trace_outbox(status, next_attempt_at);
```

Extend `TraceSink.record` so the parsed local trace row and its `LangSmithReviewEvent` projection are inserted by the same SQLite transaction. The projection may contain only `runIdHash`, `parentRunIdHash`, `graphVersion`, `nodeName`, `nodeVersion`, `eventType`, `toolName`, `outcome`, `reasonCode`, `confidence`, `candidateCount`, `evidenceCount`, `durationMs`, `errorCode`, and `createdAt`. It must not copy arbitrary `outputSummary`, prompts, evidence quotes, browser payloads, or business primary keys.

- [ ] **Step 4: Implement disabled-by-default configuration and injected exporter**

Add to `apps/api/src/config.ts`:

```ts
langsmith: {
  enabled: boolean;
  apiKey?: string;
  endpoint?: string;
  project: string;
  maxAttempts: number;
}
```

Parse `LANGSMITH_TRACING_ENABLED` as `false` unless it is exactly `"true"`; require a non-empty API key and endpoint only when enabled. `createLangSmithExporter` must accept an injected client implementing `createRun(event)` and `updateRun(remoteRunId, event)`, so unit tests never call the network. The production adapter may use `langsmith` 0.9.0, but the graph depends only on the injected interface.

- [ ] **Step 5: Implement bounded retry and deletion behavior**

`flushOnce` claims a bounded batch using a transaction, sends only pending projections, and marks each item `sent` with its remote run ID on success. On timeout, rate limit, or authentication failure it increments `attempts`, stores a bounded error code, and schedules exponential backoff. After `maxAttempts`, mark the row `dead_letter`; do not retry forever and do not block graph execution. Replays use `traceId` as the idempotency key and never reload raw business objects. Deleting a local task removes unsent outbox rows and calls the injected remote-delete port only for stored remote IDs.

- [ ] **Step 6: Verify privacy, migration, and failure isolation**

Run: `rtk corepack pnpm --filter @resume/api test -- src/agent/langsmith-outbox.test.ts src/agent/langsmith-exporter.test.ts src/agent/trace-sink.test.ts src/db/migrate.test.ts src/config.test.ts`

Expected: PASS for atomic trace/outbox writes, strict PII rejection, disabled-by-default startup, idempotent migrations, bounded retry, dead-letter transition, and graph independence from LangSmith failure.

- [ ] **Step 7: Commit**

```bash
rtk git add apps/api/package.json pnpm-lock.yaml apps/api/src/agent apps/api/src/db/migrate.ts apps/api/src/db/migrate.test.ts apps/api/src/config.ts apps/api/src/config.test.ts
rtk git commit -m "feat: add optional LangSmith review outbox"
```

### Task 3: Add the Persistent SQLite LangGraph Checkpointer

**Files:**
- Create: `apps/api/src/agent/sqlite-checkpointer.ts`
- Create: `apps/api/src/agent/sqlite-checkpointer.test.ts`
- Modify: `apps/api/src/db/migrate.ts`
- Modify: `apps/api/src/db/migrate.test.ts`

**Interfaces:**
- Consumes: `BaseCheckpointSaver`, `Checkpoint`, `CheckpointMetadata`, `CheckpointTuple`, `PendingWrite`, `RunnableConfig`, and existing `SqliteDatabase`.
- Produces: `SqliteAgentCheckpointer extends BaseCheckpointSaver` with `getTuple`, `list`, `put`, `putWrites`, and `deleteThread`.

- [ ] **Step 1: Write a failing round-trip and thread-isolation test**

```ts
it("round-trips checkpoints and pending writes by thread and namespace", async () => {
  const saver = new SqliteAgentCheckpointer(database);
  const config = { configurable: { thread_id: "thread-a", checkpoint_ns: "application" } };
  const checkpoint = { v: 1, id: "cp-1", ts: "2026-08-21T00:00:00.000Z",
    channel_values: { status: "running" }, channel_versions: {}, versions_seen: {}, pending_sends: [] };
  const saved = await saver.put(config, checkpoint, { source: "update", step: 1, parents: {} }, {});
  await saver.putWrites(saved, [["auditEventIds", ["trace-1"]]], "node-1");
  const tuple = await saver.getTuple(saved);
  expect(tuple?.checkpoint.id).toBe("cp-1");
  expect(tuple?.pendingWrites).toEqual([["node-1", "auditEventIds", ["trace-1"]]]);
  expect(await saver.getTuple({ configurable: { thread_id: "thread-b" } })).toBeUndefined();
});
```

- [ ] **Step 2: Run the test and confirm the saver is missing**

Run: `rtk corepack pnpm --filter @resume/api test -- src/agent/sqlite-checkpointer.test.ts`

Expected: FAIL with missing `SqliteAgentCheckpointer`.

- [ ] **Step 3: Add checkpoint tables and implement the saver**

Add tables keyed exactly like LangGraph configuration:

```sql
CREATE TABLE IF NOT EXISTS agent_checkpoints (
  thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT, type TEXT NOT NULL, checkpoint_blob BLOB NOT NULL,
  metadata_blob BLOB NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);
CREATE TABLE IF NOT EXISTS agent_checkpoint_writes (
  thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL, write_index INTEGER NOT NULL, channel TEXT NOT NULL,
  type TEXT NOT NULL, value_blob BLOB NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, write_index),
  FOREIGN KEY (thread_id, checkpoint_ns, checkpoint_id)
    REFERENCES agent_checkpoints(thread_id, checkpoint_ns, checkpoint_id) ON DELETE CASCADE
);
```

Use `this.serde.dumpsTyped`/`loadsTyped` for all checkpoint, metadata, and write values. `put` must return `{ configurable: { thread_id, checkpoint_ns, checkpoint_id: checkpoint.id } }`; `getTuple` must select the requested ID or latest ID; `list` must yield newest first and honor `limit`, `before`, and metadata filter options; `putWrites` must preserve input order through `write_index`; `deleteThread` must delete all namespaces in one transaction. Reject missing `thread_id` with `agent_thread_id_required`.

- [ ] **Step 4: Run round-trip, migration, and type checks**

Run: `rtk corepack pnpm --filter @resume/api test -- src/agent/sqlite-checkpointer.test.ts src/db/migrate.test.ts`

Expected: PASS, including restart with a second saver over the same temporary database.

Run: `rtk corepack pnpm --filter @resume/api typecheck`

Expected: exit 0 against the pinned checkpoint interfaces.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/api/src/agent/sqlite-checkpointer.ts apps/api/src/agent/sqlite-checkpointer.test.ts apps/api/src/db/migrate.ts apps/api/src/db/migrate.test.ts
rtk git commit -m "feat: persist LangGraph checkpoints in SQLite"
```

### Task 4: Build the Main Graph and Unified Human Interrupt Protocol

**Files:**
- Create: `apps/api/src/agent/state.ts`
- Create: `apps/api/src/agent/main-graph.ts`
- Create: `apps/api/src/agent/main-graph.test.ts`
- Create: `apps/api/src/agent/graph-service.ts`
- Create: `apps/api/src/agent/graph-service.test.ts`

**Interfaces:**
- Consumes: contracts, `SqliteAgentCheckpointer`, `TraceSink`, and subgraph ports supplied as constructor dependencies.
- Produces: `createMainGraph(deps)`, `GraphService.start(input)`, `GraphService.resume(threadId, resume)`, `GraphService.state(threadId)`, and `GraphService.cancel(threadId)`.

- [ ] **Step 1: Write failing routing, interrupt, restart, and cancellation tests**

```ts
it("routes one request to one subgraph and resumes the same checkpoint", async () => {
  const resume = vi.fn(async () => ({ status: "interrupted", pendingInterrupt: interruptFixture }));
  const service = createTestGraphService({ resumeIngestion: resume });
  const first = await service.start({ threadId: "th-1", runId: "run-1", taskId: "doc-1",
    subgraph: "resume_ingestion", profileRevision: 0 });
  expect(first.status).toBe("interrupted");
  const second = await service.resume("th-1", { interruptId: interruptFixture.id, action: "confirm", values: { name: "何青" } });
  expect(second.threadId).toBe("th-1");
  expect(resume).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run tests and confirm graph modules are absent**

Run: `rtk corepack pnpm --filter @resume/api test -- src/agent/main-graph.test.ts src/agent/graph-service.test.ts`

Expected: FAIL with missing graph modules.

- [ ] **Step 3: Implement annotations, routing, and facade**

Define reducers so `auditEventIds` appends unique IDs and nested subgraph state uses explicit replacement. Compile the graph with the SQLite checkpointer and route from `START` to exactly one of `resume_ingestion`, `job_matching`, or `application`. The service must invoke with:

```ts
const config = { configurable: { thread_id: input.threadId, checkpoint_ns: input.subgraph } };
await graph.invoke(initialState, config);
await graph.invoke(new Command({ resume: HumanResumeSchema.parse(resume) }), config);
```

At every interrupt, persist `status: "interrupted"`, a structured `pendingInterrupt`, and an `interrupt` trace. Reject a resume whose ID differs from the checkpoint's pending interrupt. Cancellation writes `status: "cancelled"`; application cancellation first calls the execution-invalidation port.

- [ ] **Step 4: Verify main graph behavior**

Run: `rtk corepack pnpm --filter @resume/api test -- src/agent/main-graph.test.ts src/agent/graph-service.test.ts src/agent/sqlite-checkpointer.test.ts`

Expected: PASS for restart, duplicate resume rejection, cancellation, and per-thread isolation.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/api/src/agent/state.ts apps/api/src/agent/main-graph.ts apps/api/src/agent/main-graph.test.ts apps/api/src/agent/graph-service.ts apps/api/src/agent/graph-service.test.ts
rtk git commit -m "feat: add persistent LangGraph runtime"
```

### Task 5: Migrate Resume Ingestion into a LangGraph Subgraph

**Files:**
- Create: `apps/api/src/agent/subgraphs/resume-ingestion.ts`
- Create: `apps/api/src/agent/subgraphs/resume-ingestion.test.ts`
- Modify: `apps/api/src/profile/production-extraction.ts`
- Modify: `packages/profile-domain/src/extraction/extract-facts.ts`
- Modify: `packages/profile-domain/src/extraction/extract-facts.test.ts`

**Interfaces:**
- Consumes: existing PDF extraction, `RemoteOcrEngine`, fact extraction, profile repository, document repository, and `TraceSink`.
- Produces: `createResumeIngestionSubgraph({ extractPdf, extractFacts, saveFacts, completeness, traceSink })` and reference-only `ResumeIngestionState`.

- [ ] **Step 1: Write failing tests for text-first routing, OCR fallback, evidence validation, and missing-fact interrupt**

```ts
it("uses OCR only for pages whose text layer fails quality checks", async () => {
  const extractPdf = vi.fn(async () => ({ fingerprint: "a".repeat(64), pages: [
    { page: 1, text: "何青 软件工程师", extraction: "pdf" },
    { page: 2, text: "项目经历", extraction: "ocr" }
  ] }));
  const graph = createResumeIngestionTestGraph({ extractPdf });
  const result = await graph.invoke(resumeInputFixture);
  expect(result.documentFingerprint).toBe("a".repeat(64));
  expect(extractPdf).toHaveBeenCalledTimes(1);
  expect(result.pageSources).toEqual(["pdf", "ocr"]);
});

it("interrupts instead of publishing an unsupported objective fact", async () => {
  const result = await createResumeIngestionTestGraph({ extractedFacts: [unsupportedFact] })
    .invoke(resumeInputFixture);
  expect(result.pendingInterrupt?.kind).toBe("missing_fact");
  expect(result.publishedProfileRevision).toBeUndefined();
});
```

- [ ] **Step 2: Run focused tests and confirm the subgraph is absent**

Run: `rtk corepack pnpm --filter @resume/api test -- src/agent/subgraphs/resume-ingestion.test.ts`

Expected: FAIL with missing subgraph module.

- [ ] **Step 3: Implement deterministic nodes around existing extraction**

Use nodes `fingerprint_document -> extract_pages -> extract_fact_candidates -> validate_evidence -> check_completeness`. Preserve the current page-quality decision inside `extractPdf`; do not duplicate it in the graph. Change fact extraction output to include `candidateId`, `fieldPath`, `value`, `confidence`, and evidence with `documentId`, `page`, `text`, `extraction`, and optional `blockId`. `validate_evidence` must reject out-of-range pages, missing quotes, unknown block IDs, invalid field paths, and conflicting values. `check_completeness` interrupts only for facts required by the requested downstream scope. Confirmed resume values are written through the existing profile repository and return only `publishedProfileRevision` plus fact IDs to graph state.

- [ ] **Step 4: Verify extraction regression and subgraph tests**

Run: `rtk corepack pnpm --filter @resume/profile-domain test -- src/extraction/extract-facts.test.ts src/pdf/extract-pdf.test.ts src/pdf/remote-ocr-engine.test.ts`

Expected: PASS with existing text/OCR evidence behavior unchanged.

Run: `rtk corepack pnpm --filter @resume/api test -- src/agent/subgraphs/resume-ingestion.test.ts`

Expected: PASS for text-only, mixed OCR, malformed model output, evidence conflict, and human correction.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/api/src/agent/subgraphs/resume-ingestion.ts apps/api/src/agent/subgraphs/resume-ingestion.test.ts apps/api/src/profile/production-extraction.ts packages/profile-domain/src/extraction/extract-facts.ts packages/profile-domain/src/extraction/extract-facts.test.ts
rtk git commit -m "feat: orchestrate resume ingestion with LangGraph"
```

### Task 6: Migrate ATS Job Matching into a LangGraph Subgraph

**Files:**
- Create: `apps/api/src/agent/subgraphs/job-matching.ts`
- Create: `apps/api/src/agent/subgraphs/job-matching.test.ts`
- Modify: `apps/api/src/job-matching/match-coordinator.ts`
- Modify: `apps/api/src/job-matching/match-coordinator.test.ts`
- Modify: `apps/api/src/job-matching/job-match-service.ts`
- Modify: `apps/api/src/observability/job-match-trace.ts`

**Interfaces:**
- Consumes: existing ATS adapters, filter/extraction coordinators, repository, Trigram retrieval, embedding search, `scoreJobMatch`, and restricted advisor.
- Produces: `createJobMatchingSubgraph(deps)` and `JobRequirementAdvisory` restricted to supplied requirement/evidence IDs.

- [ ] **Step 1: Write failing tests for adapter boundaries, tri-state constraints, hybrid fallback, and constrained reranking**

```ts
it("never asks the model to parse unsupported ATS HTML", async () => {
  const advisor = { advise: vi.fn() };
  const result = await createJobMatchingTestGraph({ adapterSupports: false, advisor }).invoke(jobInputFixture);
  expect(result.error?.code).toBe("adapter_contract_mismatch");
  expect(advisor.advise).not.toHaveBeenCalled();
});

it("keeps unknown hard constraints rankable and conflict constraints separate", async () => {
  const result = await createJobMatchingTestGraph({ postings: [unknownPosting, conflictPosting] }).invoke(jobInputFixture);
  expect(result.recommended.map((item) => item.postingId)).toContain(unknownPosting.id);
  expect(result.conflicts.map((item) => item.postingId)).toContain(conflictPosting.id);
});
```

- [ ] **Step 2: Run focused tests and confirm missing subgraph**

Run: `rtk corepack pnpm --filter @resume/api test -- src/agent/subgraphs/job-matching.test.ts`

Expected: FAIL with missing job-matching subgraph.

- [ ] **Step 3: Implement nodes and constrain advisor inputs**

Use nodes `observe_ats -> select_adapter -> apply_filter_plan -> extract_postings -> match_candidates -> persist_results`. ATS adapters alone may convert site snapshots to `JobPosting`; unsupported snapshots end with `adapter_contract_mismatch`. Keep education, major, and years outcomes as `satisfied | conflict | unknown`. Run Trigram and Dense retrieval independently, merge deterministically, and score with `scoreJobMatch`. Call DeepSeek only for unknown outcomes with at most three supplied evidence IDs. In this migration phase parse the result through `validateAdvisory` and keep it advisory-only; malformed or unavailable responses become `UNKNOWN_ADVISORY` without changing deterministic ranking. A later Top-K semantic rerank is allowed only as a separately versioned experiment after the evaluation gate proves it improves ranking without overriding hard conflicts. Emit counts and version IDs through the unified `TraceSink`, while retaining `BoundedJobMatchTraceBuffer` as a compatibility view during this phase.

- [ ] **Step 4: Run matching regressions**

Run: `rtk corepack pnpm --filter @resume/job-matching test`

Expected: PASS for adapter fixtures, deterministic scoring, advisory validation, and expectation snapshots.

Run: `rtk corepack pnpm --filter @resume/api test -- src/job-matching/match-coordinator.test.ts src/job-matching/job-match-service.test.ts src/agent/subgraphs/job-matching.test.ts`

Expected: PASS with Dense failure degrading to deterministic results and no model call for conflict outcomes.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/api/src/agent/subgraphs/job-matching.ts apps/api/src/agent/subgraphs/job-matching.test.ts apps/api/src/job-matching/match-coordinator.ts apps/api/src/job-matching/match-coordinator.test.ts apps/api/src/job-matching/job-match-service.ts apps/api/src/observability/job-match-trace.ts
rtk git commit -m "feat: orchestrate job matching with LangGraph"
```

### Task 7: Build the Controlled Application-Execution Subgraph

**Files:**
- Create: `apps/api/src/agent/application-tools.ts`
- Create: `apps/api/src/agent/application-tools.test.ts`
- Create: `apps/api/src/agent/subgraphs/application-execution.ts`
- Create: `apps/api/src/agent/subgraphs/application-execution.test.ts`
- Modify: `apps/api/src/applications/challenge-coordinator.ts`
- Modify: `apps/api/src/applications/field-semantic-resolver.ts`
- Modify: `apps/api/src/applications/full-page-audit.ts`

**Interfaces:**
- Consumes: BrowserPort, Action Policy approval callback, NodeRef snapshots, field resolver, RAG service, progress coordinator, challenge coordinator, and TraceSink.
- Produces: `ApplicationTools` and application nodes with deterministic browser side effects.

```ts
export interface ApplicationTools {
  observe(taskId: string): Promise<FormSnapshot>;
  resolveFields(input: { taskId: string; snapshot: FormSnapshot; profileRevision: number }): Promise<FieldResolutionBatch>;
  buildPlan(input: { taskId: string; snapshot: FormSnapshot; resolutions: FieldResolutionBatch; executionEpoch: number }): Promise<ExecutableCommand[]>;
  authorize(command: ExecutableCommand, snapshot: FormSnapshot): Promise<ExecutableCommand>;
  execute(command: ExecutableCommand): Promise<ExecutionResult>;
  readback(taskId: string, expected: ExecutableCommand[]): Promise<ReadbackResult>;
  invalidate(taskId: string): Promise<number>;
  release(taskId: string): Promise<void>;
}
```

- [ ] **Step 1: Write failing safety and lifecycle tests**

Cover these exact cases in table-driven tests: NodeRef mismatch, stale snapshot, stale execution epoch, unapproved command, controlled-component false write, first readback mismatch, second readback mismatch, challenge before write, challenge during readback, login interrupt, content review, missing objective fact, non-final navigation, final review, cancellation, and duplicate resume.

```ts
it("invalidates execution before recording a challenge interrupt", async () => {
  const events: string[] = [];
  const graph = createApplicationTestGraph({
    observe: async () => challengeSnapshot,
    invalidate: async () => { events.push("invalidate"); return 4; },
    onInterrupt: () => events.push("interrupt")
  });
  const result = await graph.invoke(applicationInputFixture);
  expect(events).toEqual(["invalidate", "interrupt"]);
  expect(result.pendingInterrupt?.kind).toBe("challenge");
});

it("never registers or executes a submit command", async () => {
  const tools = createApplicationTools(applicationToolDeps);
  await expect(tools.buildPlan(finalReviewPlanFixture))
    .resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "submit" })]));
});
```

- [ ] **Step 2: Run focused tests and verify they fail before extraction**

Run: `rtk corepack pnpm --filter @resume/api test -- src/agent/application-tools.test.ts src/agent/subgraphs/application-execution.test.ts`

Expected: FAIL because the application graph and tool adapter do not exist.

- [ ] **Step 3: Extract deterministic tools and implement graph nodes**

Move browser coordination out of the monolithic service without changing Browser Worker or Action Policy behavior. Implement nodes in this fixed order:

```text
observe_page -> classify_page -> normalize_fields -> deterministic_semantics
-> retrieve_semantic_candidates -> judge_field_semantics -> retrieve_profile_facts
-> compose_values -> verify_evidence_and_risk -> build_fill_plan -> authorize_plan
-> execute_plan -> double_readback -> full_page_audit -> route_next
```

The semantic judge receives field metadata plus a bounded candidate set and returns only `{ candidateId, confidence, reasonCode, evidenceIds }`. Confidence below the configured threshold or tied candidates interrupt as `field_semantics`. Generated content interrupts as `content_review`. `execute_plan` accepts only commands produced by `build_fill_plan`, signed by `authorize`, tied to current NodeRef/snapshot/epoch, and absent from the final-submit deny set. `double_readback` requires two stable observations; a mismatch may retry once after re-observation, then interrupts or fails with `READBACK_MISMATCH`. `route_next` sends review/success pages to `final_review` and never invokes a submit tool.

- [ ] **Step 4: Run safety regressions across API and Browser Worker**

Run: `rtk corepack pnpm --filter @resume/api test -- src/agent/application-tools.test.ts src/agent/subgraphs/application-execution.test.ts src/applications/challenge-coordinator.test.ts src/applications/full-page-audit.test.ts src/applications/field-semantic-resolver.test.ts`

Expected: PASS for all lifecycle and challenge cases.

Run: `rtk corepack pnpm --filter @resume/browser-worker test`

Expected: PASS with submit denial, NodeRef identity binding, approval token, epoch, and readback tests unchanged.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/api/src/agent/application-tools.ts apps/api/src/agent/application-tools.test.ts apps/api/src/agent/subgraphs/application-execution.ts apps/api/src/agent/subgraphs/application-execution.test.ts apps/api/src/applications/challenge-coordinator.ts apps/api/src/applications/field-semantic-resolver.ts apps/api/src/applications/full-page-audit.ts
rtk git commit -m "feat: add controlled LangGraph application execution"
```

### Task 8: Cut Production Composition from XState to LangGraph

**Files:**
- Modify: `apps/api/src/db/migrate.ts`
- Modify: `apps/api/src/applications/application-task-repository.ts`
- Modify: `apps/api/src/applications/application-task-repository.test.ts`
- Modify: `apps/api/src/applications/application-service.ts`
- Modify: `apps/api/src/applications/routes.ts`
- Modify: `apps/api/src/applications/routes.test.ts`
- Modify: `apps/api/src/production-dependencies.ts`
- Modify: `apps/api/src/production-dependencies.test.ts`
- Delete: `apps/api/src/applications/application-machine.ts`
- Delete: `apps/api/src/applications/application-machine.test.ts`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `GraphService`, all three compiled subgraphs, existing route contracts, event bus, repositories, Browser Ownership Lease, and shutdown hooks.
- Produces: the existing `ApplicationService` public methods backed by graph commands for graph-owned tasks.

- [ ] **Step 1: Add failing ownership and route compatibility tests**

```ts
it("marks every new application task as langgraph-owned", () => {
  const task = repository.create({ id: "task-1", applicationUrl: "https://example.test/apply" });
  expect(task.orchestrator).toBe("langgraph-v1");
});

it("restores a graph-owned task after creating fresh production dependencies", async () => {
  const first = createProductionDependencies(config, adapters);
  await first.applicationService.openBrowser("task-1");
  await first.close();
  const second = createProductionDependencies(config, adapters);
  expect(second.applicationService.state("task-1").status).not.toBe("created");
  await second.close();
});
```

- [ ] **Step 2: Run focused tests and confirm ownership/restart failures**

Run: `rtk corepack pnpm --filter @resume/api test -- src/applications/application-task-repository.test.ts src/applications/routes.test.ts src/production-dependencies.test.ts`

Expected: FAIL because `orchestrator` and graph production composition are absent.

- [ ] **Step 3: Add task ownership and graph-backed facade**

Add `orchestrator TEXT NOT NULL DEFAULT 'xstate-v1' CHECK (orchestrator IN ('xstate-v1','langgraph-v1'))` to existing rows, while repository creation explicitly writes `langgraph-v1`. Compose one `SqliteAgentCheckpointer`, one `TraceSink`, restricted tool registry, and compiled main graph per production dependency container. Preserve the `ApplicationService` method names used by routes; translate each method to a typed graph start/resume/cancel command and translate graph state back to existing API display states. Keep Browser Ownership Lease acquisition and release around graph-owned application runs. Close graph resources before closing SQLite.

During one release window, restore `xstate-v1` rows through the legacy service and route `langgraph-v1` rows only through `GraphService`. Add an operational query and require it to return zero before removing XState:

```sql
SELECT COUNT(*) AS remaining
FROM application_tasks
WHERE orchestrator = 'xstate-v1'
  AND id IN (SELECT DISTINCT task_id FROM application_checkpoints)
  AND id NOT IN (
    SELECT task_id FROM application_task_events
    WHERE state IN ('review_locked', 'cancelled', 'failed')
  );
```

- [ ] **Step 4: Remove XState only after drain and full parity verification**

Run the drain query against a copy of the production database. Expected: `remaining = 0`.

Delete the machine files, remove `xstate` from `apps/api/package.json`, remove legacy service branches and old application checkpoint writes, then run `rtk corepack pnpm install`.

Run: `rtk corepack pnpm --filter @resume/api test`

Expected: PASS with route, restart, challenge, content-review, and task-event compatibility tests.

Run: `rtk corepack pnpm typecheck`

Expected: exit 0.

Run: `rtk corepack pnpm build`

Expected: exit 0 and the API bundle contains no XState import.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/api/src/db/migrate.ts apps/api/src/applications/application-task-repository.ts apps/api/src/applications/application-task-repository.test.ts apps/api/src/applications/application-service.ts apps/api/src/applications/routes.ts apps/api/src/applications/routes.test.ts apps/api/src/production-dependencies.ts apps/api/src/production-dependencies.test.ts apps/api/package.json pnpm-lock.yaml
rtk git rm apps/api/src/applications/application-machine.ts apps/api/src/applications/application-machine.test.ts
rtk git commit -m "refactor: make LangGraph the application orchestrator"
```

### Task 9: Make OCR Runtime-Neutral and Add a Gated MindSpore Lite Backend

**Files:**
- Modify: `services/ocr-worker/src/resume_ocr_worker/types.py`
- Create: `services/ocr-worker/src/resume_ocr_worker/backends/__init__.py`
- Create: `services/ocr-worker/src/resume_ocr_worker/backends/pytorch_backend.py`
- Create: `services/ocr-worker/src/resume_ocr_worker/backends/mindspore_lite_backend.py`
- Create: `services/ocr-worker/src/resume_ocr_worker/backend_factory.py`
- Modify: `services/ocr-worker/src/resume_ocr_worker/model.py`
- Modify: `services/ocr-worker/src/resume_ocr_worker/config.py`
- Modify: `services/ocr-worker/src/resume_ocr_worker/app.py`
- Modify: `services/ocr-worker/tests/test_model.py`
- Modify: `services/ocr-worker/tests/test_config.py`
- Modify: `services/ocr-worker/tests/test_app.py`
- Modify: `packages/profile-domain/src/pdf/remote-ocr-engine.ts`
- Modify: `packages/profile-domain/src/pdf/remote-ocr-engine.test.ts`

**Interfaces:**
- Consumes: current validated offline model manifest and current `/v1/ocr` authentication/body limits.
- Produces: runtime-neutral `OcrBackend.recognize(bytes): OcrResult` and a backward-compatible HTTP result enriched with `runtime` and `blocks`.

```py
@dataclass(frozen=True)
class OcrBlock:
    text: str
    bbox: tuple[int, int, int, int]

@dataclass(frozen=True)
class OcrResult:
    text: str
    blocks: list[OcrBlock]
    model: str
    revision: str
    runtime: Literal["pytorch", "mindspore_lite"]

class OcrBackend(Protocol):
    @property
    def ready(self) -> bool: pass
    def recognize(self, image_bytes: bytes) -> OcrResult: pass
```

- [ ] **Step 1: Write failing backend conformance and HTTP contract tests**

```py
def test_backend_factory_defaults_to_pytorch(settings):
    backend = create_backend(replace(settings, runtime="pytorch"), pytorch_loader=lambda _: FakeBackend("pytorch"))
    assert backend.recognize(PNG).runtime == "pytorch"

def test_mindspore_backend_rejects_unsigned_model_package(settings, fake_runtime):
    with pytest.raises(ValueError, match="manifest"):
        MindSporeLiteBackend(replace(settings, runtime="mindspore_lite"), runtime=fake_runtime)

def test_ocr_response_reports_runtime(client):
    response = client.post("/v1/ocr", content=PNG, headers=AUTH_HEADERS)
    assert response.json()["runtime"] in {"pytorch", "mindspore_lite"}
```

- [ ] **Step 2: Run worker and TypeScript contract tests and confirm failures**

Run: `rtk py -m pytest services/ocr-worker/tests/test_model.py services/ocr-worker/tests/test_config.py services/ocr-worker/tests/test_app.py -q`

Expected: FAIL because runtime-aware result types and backend factory are absent.

Run: `rtk corepack pnpm --filter @resume/profile-domain test -- src/pdf/remote-ocr-engine.test.ts`

Expected: FAIL for the new `runtime`/`blocks` response fixtures.

- [ ] **Step 3: Extract PyTorch backend without changing inference behavior**

Move the existing Transformers/torch loading and Markdown normalization into `PyTorchBackend`. Keep model/revision pins, CUDA device, manifest closure verification, input bounds, timeout behavior, and returned text unchanged. Set `runtime="pytorch"` and `blocks=()` because DeepSeek's current Markdown path does not expose stable block geometry. `model.py` remains a compatibility import that re-exports `PyTorchBackend` during one release.

- [ ] **Step 4: Implement the MindSpore Lite adapter behind explicit configuration**

Add `OCR_RUNTIME` with accepted values `pytorch` and `mindspore_lite`; default and production examples remain `pytorch`. The MindSpore backend must load only a verified manifest whose identity names the detector, recognizer, vocabulary, preprocessing version, and hashes of every `.mindir`/vocabulary file. It must use an injected runtime interface in unit tests:

```py
class LiteRuntime(Protocol):
    def load(self, model_path: Path, device: str) -> object: pass
    def run(self, model: object, inputs: list[np.ndarray]) -> list[np.ndarray]: pass
```

Implement image normalization, detector box decoding, reading-order sort, recognizer batching, vocabulary decoding, and bounding-box clipping as pure tested functions. The production runtime adapter imports `mindspore_lite` only when `OCR_RUNTIME=mindspore_lite`; startup fails closed with `mindspore_lite_runtime_unavailable` when the reviewed offline runtime wheel is absent. Do not add an unresolvable PyPI dependency: the deployment bundle owns the platform-specific runtime wheel and manifest.

- [ ] **Step 5: Update and verify the client protocol**

Extend `OcrResponseSchema` with `runtime: z.enum(["pytorch", "mindspore_lite"])` and `blocks: z.array(z.object({ text: z.string().min(1), bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]) }).strict()).max(10_000)`. Keep `RemoteOcrEngine.recognize(image): Promise<string>` unchanged for existing callers; add `recognizeDetailed` for graph/evaluation callers.

Run: `rtk py -m pytest services/ocr-worker/tests -q`

Expected: PASS with PyTorch default, lazy MindSpore import, manifest rejection, geometry validation, and identical HTTP security behavior.

Run: `rtk corepack pnpm --filter @resume/profile-domain test -- src/pdf/remote-ocr-engine.test.ts src/pdf/extract-pdf.test.ts`

Expected: PASS with both runtime response fixtures and unchanged extraction fallback.

- [ ] **Step 6: Commit**

```bash
rtk git add services/ocr-worker/src/resume_ocr_worker services/ocr-worker/tests packages/profile-domain/src/pdf/remote-ocr-engine.ts packages/profile-domain/src/pdf/remote-ocr-engine.test.ts
rtk git commit -m "feat: add runtime-neutral OCR backends"
```

### Task 10: Add Reproducible End-to-End Evaluation and Release Gates

**Files:**
- Create: `evals/agent/manifest.schema.json`
- Create: `evals/agent/resume-extraction.jsonl`
- Create: `evals/agent/job-matching.jsonl`
- Create: `evals/agent/form-readback.jsonl`
- Create: `evals/agent/ocr-parity.jsonl`
- Create: `evals/agent/langsmith-review.jsonl`
- Create: `evals/agent/run-evals.ts`
- Create: `evals/agent/run-evals.test.ts`
- Create: `evals/agent/langsmith-review.test.ts`
- Create: `evals/agent/README.md`
- Modify: `package.json`
- Create: `docs/superpowers/evaluations/.gitkeep`

**Interfaces:**
- Consumes: compiled subgraphs and versioned local fixture IDs.
- Produces: `pnpm eval:agent`, machine-readable `report.json`, and human-readable `report.md` with dataset hash, graph version, model/runtime versions, and metric denominators.

- [ ] **Step 1: Write failing metric tests**

```ts
it("computes metrics from explicit denominators and refuses empty suites", async () => {
  expect(computeRecallAtK([{ expected: ["job-2"], ranked: ["job-1", "job-2"] }], 3)).toBe(1);
  expect(() => computeFactAccuracy([])).toThrow("evaluation_suite_empty");
});

it("fails the safety suite if any submit command is observed", async () => {
  expect(() => assertNoAutomaticSubmit([{ commandType: "submit", actor: "graph" }]))
    .toThrow("automatic_submit_observed");
});
```

- [ ] **Step 2: Run focused tests and confirm the harness is absent**

Run: `rtk corepack pnpm vitest run evals/agent/run-evals.test.ts`

Expected: FAIL because `run-evals.ts` does not exist.

- [ ] **Step 3: Implement fixed manifests, LangSmith review cases, and report generation**

Each JSONL row must contain `caseId`, `suiteVersion`, input fixture/object IDs, expected IDs/labels, and privacy classification; raw candidate PII is forbidden. Implement exact metrics:

- Core fact accuracy = correct normalized core fields / labeled core fields.
- Evidence grounding = correctly located evidence spans / extracted facts accepted as correct.
- Recall@3 = cases where any expected posting appears in top 3 / ranking cases.
- First-pass readback = fields stable after the first double-readback transaction / attempted fields.
- Mis-submission count = observed submit commands or submit side effects; release threshold is exactly 0.
- OCR character accuracy = `1 - character_edit_distance / reference_character_count`.
- OCR parity regression = candidate accuracy minus PyTorch baseline accuracy on the identical corpus.

Add `evals/agent/langsmith-review.jsonl` with only versioned case IDs, input hashes and expected labels. Implement `evals/agent/langsmith-review.test.ts` to verify that a local Trace sequence and its LangSmith projection preserve run/node/tool parentage, event order, graph/model/tool versions and terminal outcome; inject names, phone numbers, email addresses, prompts, DOM fragments and evidence quotes and require export rejection. Use an injected fake LangSmith client to test timeout, rate-limit, auth failure, duplicate flush and dead-letter behavior. The evaluation report must record `langsmithEnabled`, outbox sent/retried/dead-letter counts, privacy rejection count, and local-versus-remote correlation mismatches.

Write reports under `docs/superpowers/evaluations/<dataset-hash>/` and include git commit, dataset SHA-256, graph version, adapter versions, model revisions, OCR runtime, case counts, failures, and confidence intervals. Never overwrite a report directory whose dataset hash already exists.

- [ ] **Step 4: Add release commands and run the complete gate**

Add root script:

```json
"eval:agent": "tsx evals/agent/run-evals.ts"
```

Run: `rtk corepack pnpm vitest run evals/agent/run-evals.test.ts evals/agent/langsmith-review.test.ts`

Expected: PASS for denominator, hashing, determinism, local-only privacy validation, LangSmith correlation, failure isolation, and submit detection.

Run: `rtk corepack pnpm test`

Expected: exit 0.

Run: `rtk corepack pnpm typecheck`

Expected: exit 0.

Run: `rtk corepack pnpm build`

Expected: exit 0.

Run: `rtk corepack pnpm eval:agent`

Expected: exit 0, one immutable report directory, and a report containing measured values rather than hard-coded `92%`, `85%`, or `94%` claims.

- [ ] **Step 5: Perform manual safety acceptance**

Replay one login page, one challenge page, one controlled React input, one dynamic DOM reorder, one generated-content review, and one final-review page. Confirm checkpoint restart at every interrupt, verify the browser receives no submit command, and verify trace payloads contain only allowed fields. Record case IDs and outcomes in the generated report rather than free-form production logs.

- [ ] **Step 6: Commit**

```bash
rtk git add evals/agent package.json docs/superpowers/evaluations/.gitkeep
rtk git commit -m "test: add reproducible agent evaluation gates"
```

---

## Final Acceptance Checklist

- [ ] New resume, job-matching, and application tasks all persist `graphVersion=agent-v1` checkpoints and can resume after process restart.
- [ ] A model caller cannot discover or invoke browser execution, navigation, approval, epoch, or submit tools.
- [ ] Every accepted model decision names supplied candidate/evidence IDs and passes strict schema validation.
- [ ] Missing or conflicting objective facts interrupt the graph and user corrections become auditable facts.
- [ ] Challenge handling invalidates the execution epoch before checkpointing the interrupt.
- [ ] NodeRef, snapshot ID, approval token, execution epoch, double-readback, and full-page audit tests pass unchanged or stronger.
- [ ] Final-review pages are terminal review locks; no graph edge or registered tool can submit.
- [ ] Trace records reject unknown keys and contain no direct PII, prompts, resume text, tokens, or browser HTML.
- [ ] Trace and LangSmith outbox rows are committed atomically; LangSmith is disabled by default and has no network client when disabled.
- [ ] LangSmith receives only allowlisted hashes, IDs, counts, versions, confidence, durations, bounded reasons, and error codes.
- [ ] PII, prompts, DOM, evidence quotes, form values, secrets, and business primary keys are rejected before export.
- [ ] LangSmith timeout, rate limit, authentication failure, duplicate delivery, and dead-letter behavior do not affect graph execution or Checkpoint recovery.
- [ ] Local Trace and LangSmith projections preserve parentage, ordering, versions, and terminal outcomes for the same run.
- [ ] Existing ATS adapters remain the only HTML-to-`JobPosting` boundary.
- [ ] Dense/model outages degrade to deterministic matching without turning `unknown` into `conflict`.
- [ ] PyTorch OCR remains deployable and behaviorally compatible after backend extraction.
- [ ] MindSpore Lite cannot start without a reviewed offline runtime, signed model manifest, and parity report.
- [ ] XState is removed only after the legacy-task drain query returns zero.
- [ ] Full unit, typecheck, build, browser-worker, restart, and evaluation suites pass.
- [ ] Resume claims use only metric values copied from the immutable evaluation report with its dataset size and version.

## Execution Order

Execute Tasks 1-2A first as the foundation. Task 3 then adds persistent checkpoints; Task 4 follows with graph routing. Tasks 5 and 6 may then run in parallel because both are read-oriented and depend only on the foundation. Task 7 follows the foundation and receives a dedicated safety review. Task 8 starts only after Tasks 5-7 pass parity suites. Task 9 may run in parallel with Tasks 5-7 because the HTTP compatibility contract isolates it. Task 10 runs last and is the release gate for architecture, LangSmith privacy, and resume metrics.
