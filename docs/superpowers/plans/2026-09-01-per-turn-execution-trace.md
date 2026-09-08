# Per-Turn Conversation Execution Trace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in the current session. Do not create or dispatch subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the global conversation process card with a real, persisted, per-user-message execution trace rendered as unframed process points.

**Architecture:** The API will persist sanitized process events keyed by `conversationId`, user-message `turnSequence`, and per-turn `stepId`, then stream them over the existing SSE route. ConversationGraph and its allowed tool registry will emit explicit audit summaries through a best-effort trace recorder. The web client will reduce events by turn and step, then interleave a lightweight `ConversationTurnTrace` between each user message and the corresponding assistant response.

**Tech Stack:** TypeScript 5.8, Zod, Fastify, better-sqlite3, LangGraph, React 19, EventSource/SSE, Vitest, Testing Library, pnpm workspace.

## Global Constraints

- Execute every task in this current session; do not create subagents or additional Codex tasks.
- Use test-driven development: add a failing focused test, verify the failure, implement the minimum change, and rerun the focused test.
- After every task, report the exact test command, passing/failing counts, and any skipped tests before starting the next task.
- Show only explicit execution summaries and real tool calls; never expose hidden chain-of-thought, prompts, raw model output, stack traces, or unfiltered tool payloads.
- Never persist or render API keys, Authorization headers, cookies, complete resume text, private form values, raw MCP messages, or internal network diagnostics.
- Keep Tavily recruitment discovery, URL safety validation, user confirmation, job matching, recommendation selection, controlled application, manual login/CAPTCHA takeover, and final-submit lock behavior unchanged.
- Do not implement employer recruitment-status tracking, polling, webhooks, synchronization, or notifications.
- Process-event failures remain best effort and must never change the conversation or application result.
- Preserve unrelated changes in the dirty worktree. Stage and commit only the files listed by the current task.
- Use `rtk` for every shell command.

---

## File Responsibility Map

- `packages/contracts/src/conversation.ts`: public process-event, tool-summary, status, and confirmation-source schemas.
- `packages/contracts/src/conversation.test.ts`: strict bounds, redaction-shaped data, and legacy confirmation compatibility tests.
- `apps/api/src/db/migrate.ts`: upgrade the old global process-event table to turn-aware storage.
- `apps/api/src/db/migrate.test.ts`: migration and idempotency coverage.
- `apps/api/src/db/schema.ts`: Drizzle representation of the upgraded process-event table.
- `apps/api/src/conversations/conversation-events.ts`: persistence, replay, trimming, and publish/subscribe for structured process events.
- `apps/api/src/conversations/conversation-events.test.ts`: event-bus persistence and replay tests.
- `apps/api/src/conversations/conversation-process-trace.ts`: best-effort step lifecycle and duration recorder.
- `apps/api/src/conversations/conversation-process-trace.test.ts`: recorder lifecycle and failure-isolation tests.
- `apps/api/src/conversations/conversation-process-summaries.ts`: allowlisted tool input/result summaries.
- `apps/api/src/conversations/conversation-process-summaries.test.ts`: secret and raw-payload leakage tests.
- `apps/api/src/conversations/conversation-tools.ts`: exports the already-used bounded recruitment-discovery input schema for safe summary parsing.
- `apps/api/src/conversations/conversation-service.ts`: assigns every graph invocation to a user-message sequence and carries confirmation source sequences.
- `apps/api/src/conversations/conversation-service.test.ts`: text-turn, confirmation-turn, and legacy confirmation tests.
- `apps/api/src/conversations/conversation-graph.ts`: emits real intent, tool, waiting, response, and failure steps.
- `apps/api/src/conversations/conversation-graph.test.ts`: exact per-turn event sequences and sanitization integration tests.
- `apps/api/src/conversations/conversation-routes.test.ts`: SSE replay of the expanded event contract.
- `apps/web/src/conversation/conversation-process-events.ts`: SSE transport only.
- `apps/web/src/conversation/conversation-process-events.test.ts`: SSE parsing, reconnection, and strict event acceptance.
- `apps/web/src/conversation/conversation-process-model.ts`: pure grouping and latest-step reduction by turn.
- `apps/web/src/conversation/conversation-process-model.test.ts`: duplicate, repeated-tool, partial-history, and turn-isolation tests.
- `apps/web/src/conversation/ConversationTurnTrace.tsx`: unframed process-point timeline and disclosure behavior.
- `apps/web/src/conversation/ConversationTurnTrace.test.tsx`: rendering, accessibility, expansion, and failure tests.
- `apps/web/src/conversation/ChatMessageList.tsx`: interleaves a trace after each user message.
- `apps/web/src/conversation/ChatHome.tsx`: owns SSE state, optimistic user turns, and connection status.
- `apps/web/src/conversation/ChatHome.test.tsx`: two-turn placement, confirmation, replay, and connection-state integration tests.
- `apps/web/src/styles.css`: blue-white timeline styling without process cards.
- Delete after replacement: `apps/web/src/conversation/ConversationProcessChain.tsx` and `apps/web/src/conversation/ConversationProcessChain.test.tsx`.

---

### Task 1: Expand the Conversation Process Contract

**Files:**
- Modify: `packages/contracts/src/conversation.ts`
- Modify: `packages/contracts/src/conversation.test.ts`

**Interfaces:**
- Produces: `ConversationProcessToolName`, `ConversationProcessToolSummary`, `ConversationProcessFailure`, expanded `ConversationProcessEvent`, and optional `ConversationConfirmation.sourceTurnSequence`.
- Consumed by: API event persistence, graph trace recorder, SSE parser, and web trace renderer.

- [ ] **Step 1: Write failing contract tests**

Add tests that parse one completed Tavily step, one waiting step, and one failed step, then reject missing turn ownership, unknown tool names, oversized summary fields, negative duration, raw extra fields, and an invalid `sourceTurnSequence`.

```ts
const completed = ConversationProcessEventSchema.parse({
  id: "12",
  conversationId: "conversation-1",
  turnSequence: 1,
  stepId: "recruitment-search-1",
  type: "process_changed",
  stage: "searching_recruitment_site",
  status: "completed",
  summary: "找到 3 个候选招聘入口",
  tool: {
    name: "tavily_search",
    input: [
      { label: "公司", value: "百度" },
      { label: "招聘类型", value: "校园招聘" }
    ],
    result: "3 个候选，优先域名 talent.baidu.com"
  },
  durationMs: 4820,
  createdAt: "2026-09-01T00:00:00.000Z"
});

expect(completed.turnSequence).toBe(1);
expect(() => ConversationProcessEventSchema.parse({ ...completed, turnSequence: 0 })).toThrow();
expect(() => ConversationProcessEventSchema.parse({
  ...completed,
  tool: { ...completed.tool, name: "raw_shell" }
})).toThrow();
expect(() => ConversationProcessEventSchema.parse({ ...completed, durationMs: -1 })).toThrow();
expect(ConversationConfirmationSchema.parse({
  confirmationId: "confirmation-1",
  action: "request_job_recommendations",
  target: {
    kind: "recruitment_site",
    company: "百度",
    title: "百度校园招聘",
    url: "https://talent.baidu.com/jobs/list",
    source: "tavily"
  },
  sourceTurnSequence: 1
}).sourceTurnSequence).toBe(1);
```

- [ ] **Step 2: Run the focused contract test and verify failure**

Run:

```powershell
rtk proxy corepack pnpm --filter @resume/contracts exec vitest run src/conversation.test.ts
```

Expected: FAIL because `turnSequence`, `stepId`, tool summaries, `waiting`, and `sourceTurnSequence` are not in the current schemas.

- [ ] **Step 3: Implement strict bounded schemas**

Add the following schema structure and export inferred types. Keep `sourceTurnSequence` optional only so persisted pre-upgrade confirmations remain readable; every new confirmation created by the graph will set it.

```ts
const ProcessSummarySchema = z.string().trim().min(1).max(500);
const ProcessStepIdSchema = z.string().trim().min(1).max(96)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/u);

export const ConversationProcessToolNameSchema = z.enum([
  "tavily_search",
  "url_guard",
  "browser_worker",
  "job_matching",
  "application_progress",
  "controlled_application"
]);

export const ConversationProcessToolSummarySchema = z.object({
  name: ConversationProcessToolNameSchema,
  input: z.array(z.object({
    label: z.string().trim().min(1).max(40),
    value: z.string().trim().min(1).max(200)
  }).strict()).max(8),
  result: ProcessSummarySchema.optional()
}).strict();

export const ConversationProcessFailureSchema = z.object({
  code: z.string().regex(/^[A-Z0-9_]+$/u).max(64),
  summary: ProcessSummarySchema,
  retryable: z.boolean()
}).strict();

export const ConversationProcessStatusSchema = z.enum([
  "running",
  "completed",
  "waiting",
  "failed"
]);

export const ConversationProcessStageSchema = z.enum([
  "understanding_request",
  "searching_recruitment_site",
  "validating_recruitment_site",
  "recruitment_site_found",
  "waiting_for_confirmation",
  "processing_confirmation",
  "reading_recruitment_site",
  "loading_recommendations",
  "matching_jobs",
  "loading_application_progress",
  "creating_job_match_session",
  "job_match_session_ready",
  "creating_application_task",
  "generating_response",
  "completed",
  "failed"
]);

export const ConversationProcessEventSchema = z.object({
  id: z.string().regex(/^\d+$/u),
  conversationId: IdentifierSchema,
  turnSequence: z.number().int().positive(),
  stepId: ProcessStepIdSchema,
  type: z.literal("process_changed"),
  stage: ConversationProcessStageSchema,
  status: ConversationProcessStatusSchema,
  summary: ProcessSummarySchema,
  tool: ConversationProcessToolSummarySchema.optional(),
  durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
  failure: ConversationProcessFailureSchema.optional(),
  createdAt: TimestampSchema
}).strict().superRefine((event, context) => {
  if (event.status === "failed" && event.failure === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["failure"], message: "process_failure_required" });
  }
  if (event.status !== "failed" && event.failure !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["failure"], message: "process_failure_unexpected" });
  }
});
```

Add `sourceTurnSequence: z.number().int().positive().optional()` to all three confirmation variants and add these exports:

```ts
export type ConversationProcessToolName = z.infer<typeof ConversationProcessToolNameSchema>;
export type ConversationProcessToolSummary = z.infer<typeof ConversationProcessToolSummarySchema>;
export type ConversationProcessFailure = z.infer<typeof ConversationProcessFailureSchema>;
```

- [ ] **Step 4: Run contract tests and typecheck**

Run:

```powershell
rtk proxy corepack pnpm --filter @resume/contracts exec vitest run src/conversation.test.ts
rtk proxy corepack pnpm --filter @resume/contracts typecheck
```

Expected: all `conversation.test.ts` tests PASS and contract typecheck exits 0.

- [ ] **Step 5: Commit Task 1**

```powershell
rtk git add -- packages/contracts/src/conversation.ts packages/contracts/src/conversation.test.ts
rtk git commit -m "feat: define per-turn process event contract"
```

---

### Task 2: Upgrade Process-Event Persistence

**Files:**
- Modify: `apps/api/src/db/migrate.ts`
- Modify: `apps/api/src/db/migrate.test.ts`
- Modify: `apps/api/src/db/schema.ts`

**Interfaces:**
- Consumes: expanded contract from Task 1.
- Produces: `conversation_process_events` columns `turn_sequence`, `step_id`, `summary`, and `details_json`, plus index `conversation_process_events_turn_idx`.

- [ ] **Step 1: Write a failing legacy migration test**

Create the old table shape, insert one unattributable global event, run `migrateDatabase`, and assert that only process history is cleared while conversation messages remain.

```ts
it("upgrades global process events without guessing their message owner", () => {
  const database = new Database(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE conversation_sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE conversation_process_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      type TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO conversation_sessions VALUES ('c1', '会话', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    INSERT INTO conversation_process_events
      (conversation_id, type, stage, status, created_at)
      VALUES ('c1', 'process_changed', 'understanding_request', 'running', '2026-09-01T00:00:00.000Z');
  `);

  migrateDatabase(database);

  const columns = database.prepare("PRAGMA table_info(conversation_process_events)").all() as Array<{ name: string }>;
  expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining([
    "turn_sequence", "step_id", "summary", "details_json"
  ]));
  expect(database.prepare("SELECT COUNT(*) AS count FROM conversation_process_events").get()).toEqual({ count: 0 });
  expect(database.prepare("SELECT id FROM conversation_sessions").all()).toEqual([{ id: "c1" }]);
});
```

- [ ] **Step 2: Run migration tests and verify failure**

```powershell
rtk proxy corepack pnpm --filter @resume/api exec vitest run src/db/migrate.test.ts
```

Expected: FAIL because the old table is not rebuilt with turn-aware columns.

- [ ] **Step 3: Implement an idempotent table upgrade**

Call a focused helper before the final `CREATE TABLE IF NOT EXISTS` block. Rebuild only the process-event tables when the old column set is detected.

```ts
function upgradeConversationProcessEvents(database: SqliteDatabase): void {
  const existing = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_process_events'"
  ).get();
  if (existing === undefined) return;
  const columns = database.prepare("PRAGMA table_info(conversation_process_events)").all() as Array<{ name: string }>;
  if (columns.some(({ name }) => name === "turn_sequence")) return;

  database.exec(`
    DROP TABLE IF EXISTS conversation_process_event_cursors;
    DROP TABLE conversation_process_events;
  `);
}
```

Create the new table with bounded checks and the turn index:

```sql
CREATE TABLE IF NOT EXISTS conversation_process_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  turn_sequence INTEGER NOT NULL CHECK (turn_sequence > 0),
  step_id TEXT NOT NULL CHECK (length(step_id) BETWEEN 1 AND 96),
  type TEXT NOT NULL CHECK (type = 'process_changed'),
  stage TEXT NOT NULL CHECK (stage IN (
    'understanding_request', 'searching_recruitment_site', 'validating_recruitment_site',
    'recruitment_site_found', 'waiting_for_confirmation', 'processing_confirmation',
    'reading_recruitment_site', 'loading_recommendations', 'matching_jobs',
    'loading_application_progress', 'creating_job_match_session', 'job_match_session_ready',
    'creating_application_task', 'generating_response', 'completed', 'failed'
  )),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'waiting', 'failed')),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json) AND json_type(details_json) = 'object'),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversation_process_events_conversation_id_idx
  ON conversation_process_events(conversation_id, id);
CREATE INDEX IF NOT EXISTS conversation_process_events_turn_idx
  ON conversation_process_events(conversation_id, turn_sequence, id);
```

Mirror the columns and checks in `apps/api/src/db/schema.ts`.

- [ ] **Step 4: Run migration tests and API typecheck**

```powershell
rtk proxy corepack pnpm --filter @resume/api exec vitest run src/db/migrate.test.ts
rtk proxy corepack pnpm --filter @resume/api typecheck
```

Expected: migration tests PASS, a second migration remains idempotent, and API typecheck exits 0.

- [ ] **Step 5: Commit Task 2**

```powershell
rtk git add -- apps/api/src/db/migrate.ts apps/api/src/db/migrate.test.ts apps/api/src/db/schema.ts
rtk git commit -m "feat: persist turn-aware process events"
```

---

### Task 3: Add the Structured Event Bus, Trace Recorder, and Safe Summaries

**Files:**
- Modify: `apps/api/src/conversations/conversation-events.ts`
- Modify: `apps/api/src/conversations/conversation-events.test.ts`
- Create: `apps/api/src/conversations/conversation-process-trace.ts`
- Create: `apps/api/src/conversations/conversation-process-trace.test.ts`
- Create: `apps/api/src/conversations/conversation-process-summaries.ts`
- Create: `apps/api/src/conversations/conversation-process-summaries.test.ts`
- Modify: `apps/api/src/conversations/conversation-tools.ts`

**Interfaces:**
- Produces: `ConversationProcessEventInput`, `ConversationProcessEventBus.emit(input)`, `createConversationProcessTrace(...)`, `summarizeToolStart(...)`, and `summarizeToolResult(...)`.
- Consumed by: ConversationGraph instrumentation in Task 5.

- [ ] **Step 1: Write failing event-bus tests**

Update fixtures to call one structured `emit` argument and assert all public details survive persistence and replay.

```ts
const emitted = bus.emit({
  conversationId: conversation.id,
  turnSequence: 1,
  stepId: "search-1",
  stage: "searching_recruitment_site",
  status: "completed",
  summary: "找到 3 个候选招聘入口",
  tool: {
    name: "tavily_search",
    input: [{ label: "公司", value: "百度" }],
    result: "3 个候选"
  },
  durationMs: 1200
});

expect(createConversationProcessEventBus(database).replay(conversation.id).events).toEqual([emitted]);
```

Add a test that a replayed `details_json` with extra keys is rejected rather than forwarded.

- [ ] **Step 2: Write failing recorder and summary tests**

```ts
it("records one stable step lifecycle and computes duration", () => {
  const emit = vi.fn();
  const times = [new Date("2026-09-01T00:00:00.000Z"), new Date("2026-09-01T00:00:01.250Z")];
  const trace = createConversationProcessTrace({
    conversationId: "c1",
    turnSequence: 1,
    emit,
    now: () => times.shift()!
  });
  const step = trace.start({
    stepId: "search-1",
    stage: "searching_recruitment_site",
    summary: "正在搜索百度校园招聘入口"
  });
  step.complete({ summary: "找到 3 个候选招聘入口" });
  expect(emit.mock.calls.map(([event]) => [event.stepId, event.status, event.durationMs])).toEqual([
    ["search-1", "running", undefined],
    ["search-1", "completed", 1250]
  ]);
});

it("never copies secrets or raw MCP payloads into a Tavily summary", () => {
  const summary = summarizeToolStart("discover_recruitment_site", {
    company: "百度",
    recruitmentType: "campus",
    tavilyApiKey: "secret-value",
    rawResponse: { authorization: "Bearer secret-value" }
  });
  expect(JSON.stringify(summary)).toContain("百度");
  expect(JSON.stringify(summary)).not.toMatch(/secret-value|authorization|rawResponse/i);
});
```

- [ ] **Step 3: Run the three focused tests and verify failure**

```powershell
rtk proxy corepack pnpm --filter @resume/api exec vitest run src/conversations/conversation-events.test.ts src/conversations/conversation-process-trace.test.ts src/conversations/conversation-process-summaries.test.ts
```

Expected: FAIL because the structured emitter, recorder, and summary modules do not exist.

- [ ] **Step 4: Implement the event bus and recorder**

Use one input type and serialize only the validated optional details:

```ts
export type ConversationProcessEventInput = Omit<
  ConversationProcessEvent,
  "id" | "type" | "createdAt"
>;

export interface ConversationProcessEventBus {
  emit(input: ConversationProcessEventInput): ConversationProcessEvent;
  replay(conversationId: string, afterId?: string): ConversationProcessEventReplay;
  subscribe(conversationId: string, listener: (event: ConversationProcessEvent) => void): () => void;
  subscriberCount(conversationId: string): number;
}
```

The recorder must swallow emitter exceptions and expose only explicit terminal methods:

```ts
interface TraceStepStart {
  stepId: string;
  stage: ConversationProcessStage;
  summary: string;
  tool?: ConversationProcessToolSummary;
}

interface TraceStepTerminal {
  summary: string;
  tool?: ConversationProcessToolSummary;
}

interface TraceStepFailureTerminal extends TraceStepTerminal {
  failure: ConversationProcessFailure;
}

export function createConversationProcessTrace(input: {
  conversationId: string;
  turnSequence: number;
  emit(event: ConversationProcessEventInput): unknown;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  const safeEmit = (event: ConversationProcessEventInput): void => {
    try { input.emit(event); } catch { /* visibility cannot change behavior */ }
  };
  return {
    start(step: TraceStepStart) {
      const startedAt = now().getTime();
      safeEmit({ ...step, conversationId: input.conversationId, turnSequence: input.turnSequence, status: "running" });
      const finish = (status: "completed" | "waiting" | "failed", terminal: TraceStepTerminal): void => {
        safeEmit({
          ...step,
          ...terminal,
          conversationId: input.conversationId,
          turnSequence: input.turnSequence,
          status,
          durationMs: Math.max(0, now().getTime() - startedAt)
        });
      };
      return {
        complete: (terminal: TraceStepTerminal) => finish("completed", terminal),
        wait: (terminal: TraceStepTerminal) => finish("waiting", terminal),
        fail: (terminal: TraceStepFailureTerminal) => finish("failed", terminal)
      };
    }
  };
}
```

- [ ] **Step 5: Implement allowlisted tool summaries**

Export the existing bounded discovery schema from `conversation-tools.ts`, then use exhaustive switches over `ConversationToolName`; never spread input or result objects.

```ts
export const DiscoverRecruitmentSiteInputSchema = z.object({
  company: z.string().trim().min(1).max(120),
  recruitmentType: RecruitmentSearchRequestSchema.shape.recruitmentType
}).strict();

function recruitmentTypeLabel(value: RecruitmentSearchRequest["recruitmentType"]): string {
  if (value === "campus") return "校园招聘";
  if (value === "social") return "社会招聘";
  if (value === "internship") return "实习招聘";
  return "招聘";
}

export function summarizeToolStart(name: ConversationToolName, input: unknown): ConversationProcessToolSummary {
  switch (name) {
    case "discover_recruitment_site": {
      const parsed = DiscoverRecruitmentSiteInputSchema.parse(input);
      return {
        name: "tavily_search",
        input: [
          { label: "公司", value: parsed.company },
          { label: "招聘类型", value: recruitmentTypeLabel(parsed.recruitmentType) }
        ]
      };
    }
    case "create_job_match_session":
      return { name: "browser_worker", input: [{ label: "范围", value: "已确认招聘入口" }] };
    case "list_recommendations":
    case "show_recommendation":
      return { name: "job_matching", input: [{ label: "操作", value: "读取岗位推荐" }] };
    case "list_application_tasks":
    case "show_application_task":
      return { name: "application_progress", input: [{ label: "操作", value: "读取本系统投递任务" }] };
    case "create_application_task":
      return { name: "controlled_application", input: [{ label: "操作", value: "创建受控投递任务" }] };
  }
}

export function summarizeToolResult(
  name: ConversationToolName,
  input: unknown,
  result: ConversationToolResult
): ConversationProcessToolSummary {
  const summary = summarizeToolStart(name, input);
  if (name === "discover_recruitment_site") {
    return { ...summary, result: `找到 ${result.recruitmentSearch?.candidates.length ?? 0} 个候选招聘入口` };
  }
  if (name === "create_job_match_session") {
    return { ...summary, result: "招聘页面已读取，等待筛选确认" };
  }
  if (name === "create_application_task") {
    return { ...summary, result: "受控投递任务已创建，尚未最终提交" };
  }
  return { ...summary, result: `返回 ${result.cards.length} 条记录` };
}
```

Result summaries may use counts, public company names, public hostnames, and state labels only. Do not include full URLs with query strings, IDs unnecessary to the user, cards JSON, resume content, or exception messages.

- [ ] **Step 6: Run focused tests and API typecheck**

```powershell
rtk proxy corepack pnpm --filter @resume/api exec vitest run src/conversations/conversation-events.test.ts src/conversations/conversation-process-trace.test.ts src/conversations/conversation-process-summaries.test.ts
rtk proxy corepack pnpm --filter @resume/api typecheck
```

Expected: all focused tests PASS and typecheck exits 0.

- [ ] **Step 7: Commit Task 3**

```powershell
rtk git add -- apps/api/src/conversations/conversation-events.ts apps/api/src/conversations/conversation-events.test.ts apps/api/src/conversations/conversation-process-trace.ts apps/api/src/conversations/conversation-process-trace.test.ts apps/api/src/conversations/conversation-process-summaries.ts apps/api/src/conversations/conversation-process-summaries.test.ts apps/api/src/conversations/conversation-tools.ts
rtk git commit -m "feat: record sanitized conversation process steps"
```

---

### Task 4: Bind Text and Confirmation Operations to User Turns

**Files:**
- Modify: `apps/api/src/conversations/conversation-service.ts`
- Modify: `apps/api/src/conversations/conversation-service.test.ts`
- Modify: `apps/api/src/conversations/conversation-graph.ts`
- Modify: `apps/api/src/conversations/conversation-graph.test.ts`

**Interfaces:**
- Produces: required `ConversationGraphInput.turnSequence` and optional `confirmationSourceTurnSequence`.
- Consumes: `ConversationConfirmation.sourceTurnSequence` from Task 1.

- [ ] **Step 1: Write failing service tests for turn ownership**

Assert that a text message passes `nextSequence`, a confirmation passes its own `nextSequence`, and a newly generated pending confirmation records the originating user sequence.

```ts
expect(graph.invoke).toHaveBeenCalledWith(expect.objectContaining({
  conversationId: conversation.id,
  text: "帮我投递百度校园招聘",
  turnSequence: 1,
  sequence: 1
}), expect.anything());

expect(graph.invoke).toHaveBeenLastCalledWith(expect.objectContaining({
  confirmationId: "confirmation-1",
  turnSequence: 3,
  confirmationSourceTurnSequence: 1
}), expect.anything());
```

Also retain a test where a legacy confirmation has no `sourceTurnSequence`; confirmation must still work but must not guess and close an unrelated waiting trace.

- [ ] **Step 2: Run focused service tests and verify failure**

```powershell
rtk proxy corepack pnpm --filter @resume/api exec vitest run src/conversations/conversation-service.test.ts
```

Expected: FAIL because graph invocations do not carry explicit turn ownership.

- [ ] **Step 3: Add turn fields before graph invocation**

Extend the graph input schema and state:

```ts
const ConversationGraphInputSchema = z.object({
  conversationId: ConversationIdSchema,
  turnSequence: z.number().int().positive(),
  confirmationSourceTurnSequence: z.number().int().positive().optional(),
  text: z.string().trim().min(1).max(500).optional(),
  context: ConversationContextSchema,
  sequence: z.number().int().nonnegative().optional(),
  confirmationId: ConfirmationIdSchema.optional(),
  approved: z.boolean().optional(),
  selectedUrl: HttpsUrlSchema.optional()
}).strict();
```

Pass the values in both service paths:

```ts
const output = await dependencies.graph.invoke({
  conversationId: id,
  turnSequence: nextSequence,
  text,
  context,
  sequence: nextSequence
}, graphConfig(id));
```

```ts
const output = await dependencies.graph.invoke({
  conversationId: id,
  turnSequence: nextSequence,
  ...(pending.sourceTurnSequence === undefined
    ? {}
    : { confirmationSourceTurnSequence: pending.sourceTurnSequence }),
  context,
  sequence: nextSequence,
  confirmationId: input.confirmationId,
  approved: input.approved,
  ...(input.selectedUrl === undefined ? {} : { selectedUrl: input.selectedUrl })
}, graphConfig(id));
```

When Graph creates any new confirmation, set `sourceTurnSequence: state.turnSequence` before validating it with `ConversationConfirmationSchema`.

- [ ] **Step 4: Run service and graph tests**

```powershell
rtk proxy corepack pnpm --filter @resume/api exec vitest run src/conversations/conversation-service.test.ts src/conversations/conversation-graph.test.ts
```

Expected: tests PASS; legacy confirmations remain usable and new confirmations carry the exact source turn.

- [ ] **Step 5: Commit Task 4**

```powershell
rtk git add -- apps/api/src/conversations/conversation-service.ts apps/api/src/conversations/conversation-service.test.ts apps/api/src/conversations/conversation-graph.ts apps/api/src/conversations/conversation-graph.test.ts
rtk git commit -m "feat: bind process events to conversation turns"
```

---

### Task 5: Instrument Real Graph and Tool Execution

**Files:**
- Modify: `apps/api/src/conversations/conversation-graph.ts`
- Modify: `apps/api/src/conversations/conversation-graph.test.ts`
- Modify: `apps/api/src/conversations/conversation-routes.test.ts`

**Interfaces:**
- Consumes: `createConversationProcessTrace`, tool summarizers, and structured event bus from Task 3.
- Produces: real per-turn lifecycle events for intent parsing, recruitment search, URL validation, confirmations, recommendation reads, job matching, application-progress reads, controlled task creation, response generation, and failures.

- [ ] **Step 1: Write failing graph tests for two independent turns**

Run recruitment discovery as turn 1, then confirmation/recommendation as turn 3. Assert every event has the correct turn, repeated status updates share `stepId`, and separate calls never collapse.

```ts
const firstTurn = processEvents.replay("conversation-process").events
  .filter((event) => event.turnSequence === 1);
expect(firstTurn.map(({ stage, status }) => [stage, status])).toEqual([
  ["understanding_request", "running"],
  ["understanding_request", "completed"],
  ["searching_recruitment_site", "running"],
  ["searching_recruitment_site", "completed"],
  ["validating_recruitment_site", "running"],
  ["validating_recruitment_site", "completed"],
  ["waiting_for_confirmation", "running"],
  ["waiting_for_confirmation", "waiting"],
  ["generating_response", "running"],
  ["generating_response", "completed"]
]);
const tavilyLifecycle = firstTurn.filter((event) => event.tool?.name === "tavily_search");
expect(new Set(tavilyLifecycle.map(({ stepId }) => stepId)).size).toBe(1);
expect(firstTurn.find((event) => event.tool?.name === "tavily_search")?.tool).toEqual(expect.objectContaining({
  result: expect.stringContaining("候选")
}));
expect(JSON.stringify(firstTurn)).not.toMatch(/tavilyApiKey|authorization|cookie|rawResponse/i);
```

Add tests for ordinary no-tool chat (`understand-request` plus `generate-response` only), a failed tool call with stable failure summary, and event-bus exceptions that do not change the assistant response.

- [ ] **Step 2: Run graph tests and verify failure**

```powershell
rtk proxy corepack pnpm --filter @resume/api exec vitest run src/conversations/conversation-graph.test.ts
```

Expected: FAIL because existing events have no turn, step, summaries, tool details, waiting status, or duration.

- [ ] **Step 3: Create trace contexts from serializable graph state**

Add `turnSequence` and `confirmationSourceTurnSequence` to `GraphState`. Create a short-lived recorder inside each node or `invokeTool` from those serializable fields; do not store functions in LangGraph state or checkpoints:

```ts
function processTraceFor(
  dependencies: ConversationGraphDependencies,
  state: GraphState,
  now: () => Date
) {
  return createConversationProcessTrace({
    conversationId: state.conversationId,
    turnSequence: state.turnSequence,
    emit: (event) => dependencies.processEvents?.emit(event),
    now
  });
}

const processTrace = processTraceFor(dependencies, state, now);
const understanding = processTrace.start({
  stepId: "understand-request",
  stage: "understanding_request",
  summary: "正在理解你的请求"
});
understanding.complete({ summary: intentSummary(parsedIntent) });
```

The helper creates no persisted function values. Replace the old `emitProcessEvent(dependencies, state, stage, status)` helper. Every visible step must call `start` immediately before the real operation and exactly one terminal method in success, waiting, and error paths.

Define `intentSummary` with explicit intent fields only:

```ts
function intentSummary(intent: ConversationIntent): string {
  if (intent.kind === "discover_recruitment_site") {
    return `识别到招聘入口查找请求${intent.company === undefined ? "" : `，公司：${intent.company}`}`;
  }
  if (intent.kind === "request_job_recommendations") return "识别到岗位推荐请求";
  if (intent.kind === "list_application_tasks" || intent.kind === "show_application_task") {
    return "识别到本系统投递进度查询";
  }
  return "请求已理解";
}
```

- [ ] **Step 4: Wrap allowed tool calls with sanitized lifecycle events**

Extend `invokeTool` without passing raw inputs to the event bus:

```ts
function toolStepId(name: ConversationToolName): string {
  return `${name}:${randomUUID()}`;
}

function stageForTool(name: ConversationToolName): ConversationProcessStage {
  if (name === "discover_recruitment_site") return "searching_recruitment_site";
  if (name === "create_job_match_session") return "reading_recruitment_site";
  if (name === "list_application_tasks" || name === "show_application_task") {
    return "loading_application_progress";
  }
  if (name === "create_application_task") return "creating_application_task";
  return "loading_recommendations";
}

function runningSummary(name: ConversationToolName): string {
  if (name === "discover_recruitment_site") return "正在搜索官方招聘入口";
  if (name === "create_job_match_session") return "正在读取已确认的招聘页面";
  if (name === "list_application_tasks" || name === "show_application_task") return "正在查询本系统投递进度";
  if (name === "create_application_task") return "正在创建受控投递任务";
  return "正在读取岗位推荐";
}

function completedSummary(name: ConversationToolName, result: ConversationToolResult): string {
  if (name === "discover_recruitment_site") return `找到 ${result.recruitmentSearch?.candidates.length ?? 0} 个候选招聘入口`;
  if (name === "create_job_match_session") return "招聘页面已读取，等待筛选确认";
  if (name === "list_application_tasks" || name === "show_application_task") return `返回 ${result.cards.length} 条本系统投递记录`;
  if (name === "create_application_task") return "受控投递任务已创建，尚未执行最终提交";
  return `返回 ${result.cards.length} 条岗位推荐`;
}

function publicProcessFailure(code: string): ConversationProcessFailure {
  const retryable = code === "TAVILY_TIMEOUT" || code === "TAVILY_UNAVAILABLE";
  return {
    code: /^[A-Z0-9_]+$/u.test(code) ? code.slice(0, 64) : "PROCESS_STEP_FAILED",
    summary: retryable ? "服务暂时不可用，可以稍后重试" : "当前步骤未完成，请根据对话提示处理",
    retryable
  };
}

const stepId = toolStepId(name);
const visible = processTrace.start({
  stepId,
  stage: stageForTool(name),
  summary: runningSummary(name),
  tool: summarizeToolStart(name, input)
});
try {
  const result = await registry.invoke(name, input, toolContext(state));
  visible.complete({
    summary: completedSummary(name, result),
    tool: summarizeToolResult(name, input, result)
  });
  return {
    ok: true,
    result,
    traceIds: trace(dependencies, {
      conversationId: state.conversationId,
      node,
      kind: "tool_call",
      toolName: name,
      outcome: "completed",
      reasonCode: "tool_completed",
      durationMs: elapsedMs(startedAt),
      counts: { results: result.cards.length }
    }, state.traceIds)
  };
} catch (error) {
  const code = errorCode(error);
  visible.fail({
    summary: publicProcessFailure(code).summary,
    failure: publicProcessFailure(code),
    tool: summarizeToolStart(name, input)
  });
  return {
    ok: false,
    error,
    traceIds: trace(dependencies, {
      conversationId: state.conversationId,
      node,
      kind: "tool_call",
      toolName: name,
      outcome: "failed",
      reasonCode: code,
      errorCode: code,
      durationMs: elapsedMs(startedAt)
    }, state.traceIds)
  };
}
```

Use these user-visible mappings:

- `discover_recruitment_site` -> Tavily Search.
- URL candidate verification inside recruitment discovery -> URL Guard.
- `create_job_match_session` -> Browser Worker because `JobMatchService.create` really calls `browser.open` and `browser.observeJob`; do not claim that matching has completed at this point.
- `list_recommendations` and `show_recommendation` -> Job Matching result read.
- `list_application_tasks` and `show_application_task` -> application-progress read limited to this system's tasks.
- `create_application_task` -> controlled application creation; never label it as final submission.

Do not emit a Browser Worker step if the worker is not actually invoked on that path.

- [ ] **Step 5: Close prior waiting steps on confirmation**

If `confirmationSourceTurnSequence` and the loaded `pending` confirmation both exist, emit a terminal update for the exact prior step before beginning the current confirmation turn:

```ts
function waitingStepId(action: ConversationConfirmation["action"]): string {
  if (action === "confirm_recruitment_site") return "wait-recruitment-site-confirmation";
  if (action === "request_job_recommendations") return "wait-recommendation-confirmation";
  return "wait-application-confirmation";
}

if (state.confirmationSourceTurnSequence !== undefined && pending !== undefined) {
  dependencies.processEvents?.emit({
    conversationId: state.conversationId,
    turnSequence: state.confirmationSourceTurnSequence,
    stepId: waitingStepId(pending.action),
    stage: "waiting_for_confirmation",
    status: "completed",
    summary: state.approved ? "已收到确认" : "用户已取消"
  });
}
```

The current confirmation turn then starts its own `processing-confirmation` step. For a legacy confirmation without a source sequence, skip the prior-step update.

- [ ] **Step 6: Update SSE route fixtures for the expanded event contract**

Use structured `processEvents.emit({...})` calls and assert serialized events include `turnSequence`, `stepId`, `summary`, and safe `tool` details after `Last-Event-ID` replay.

- [ ] **Step 7: Run graph, route, event, and type tests**

```powershell
rtk proxy corepack pnpm --filter @resume/api exec vitest run src/conversations/conversation-graph.test.ts src/conversations/conversation-routes.test.ts src/conversations/conversation-events.test.ts
rtk proxy corepack pnpm --filter @resume/api typecheck
```

Expected: focused tests PASS, SSE replay retains per-turn fields, and API typecheck exits 0.

- [ ] **Step 8: Commit Task 5**

```powershell
rtk git add -- apps/api/src/conversations/conversation-graph.ts apps/api/src/conversations/conversation-graph.test.ts apps/api/src/conversations/conversation-routes.test.ts
rtk git commit -m "feat: stream real per-turn tool execution"
```

---

### Task 6: Group and Reduce Process Events in the Web Client

**Files:**
- Modify: `apps/web/src/conversation/conversation-process-events.ts`
- Modify: `apps/web/src/conversation/conversation-process-events.test.ts`
- Create: `apps/web/src/conversation/conversation-process-model.ts`
- Create: `apps/web/src/conversation/conversation-process-model.test.ts`

**Interfaces:**
- Produces: `groupConversationProcessEvents(events)` and `ConversationTurnProcess`.
- Consumed by: `ChatMessageList` and `ConversationTurnTrace` in Task 7.

- [ ] **Step 1: Write failing pure reducer tests**

```ts
it("keeps turns separate and reduces updates by step id", () => {
  const grouped = groupConversationProcessEvents([
    event({ id: "1", turnSequence: 1, stepId: "search-1", status: "running" }),
    event({ id: "2", turnSequence: 1, stepId: "search-1", status: "completed" }),
    event({ id: "3", turnSequence: 3, stepId: "search-1", status: "running" }),
    event({ id: "4", turnSequence: 3, stepId: "search-2", status: "running" })
  ]);

  expect(grouped.get(1)?.steps).toHaveLength(1);
  expect(grouped.get(1)?.steps[0]?.status).toBe("completed");
  expect(grouped.get(3)?.steps.map(({ stepId }) => stepId)).toEqual(["search-1", "search-2"]);
});
```

Add cases for duplicate event IDs, out-of-order duplicate delivery, failed summaries, total duration, active/waiting state, and an incomplete group after history reset.

- [ ] **Step 2: Add an SSE parsing test for the expanded schema**

Dispatch a valid per-turn event and a malformed event with a raw `headers` key. Assert only the valid event reaches `onEvent`.

- [ ] **Step 3: Run the focused web tests and verify failure**

```powershell
rtk proxy corepack pnpm --filter @resume/web exec vitest run src/conversation/conversation-process-events.test.ts src/conversation/conversation-process-model.test.ts
```

Expected: FAIL because the grouping module does not exist and old fixtures do not satisfy the expanded schema.

- [ ] **Step 4: Implement the pure event model**

```ts
export interface ConversationTurnProcess {
  turnSequence: number;
  steps: ConversationProcessEvent[];
  active: boolean;
  failed: boolean;
  totalDurationMs: number;
}

export function groupConversationProcessEvents(
  events: readonly ConversationProcessEvent[]
): Map<number, ConversationTurnProcess> {
  const seenIds = new Set<string>();
  const byTurn = new Map<number, Map<string, ConversationProcessEvent>>();
  const stepOrder = new Map<number, string[]>();
  for (const event of [...events].sort((left, right) => Number(left.id) - Number(right.id))) {
    if (seenIds.has(event.id)) continue;
    seenIds.add(event.id);
    const steps = byTurn.get(event.turnSequence) ?? new Map();
    const order = stepOrder.get(event.turnSequence) ?? [];
    if (!steps.has(event.stepId)) order.push(event.stepId);
    steps.set(event.stepId, event);
    byTurn.set(event.turnSequence, steps);
    stepOrder.set(event.turnSequence, order);
  }
  return new Map([...byTurn].map(([turnSequence, steps]) => {
    const ordered = (stepOrder.get(turnSequence) ?? []).map((stepId) => steps.get(stepId)!);
    return [turnSequence, {
      turnSequence,
      steps: ordered,
      active: ordered.some(({ status }) => status === "running" || status === "waiting"),
      failed: ordered.some(({ status }) => status === "failed"),
      totalDurationMs: ordered.reduce((sum, event) => sum + (event.durationMs ?? 0), 0)
    }];
  }));
}
```

Keep `conversation-process-events.ts` limited to EventSource transport, schema parsing, connection state, and `history_reset` notification.

- [ ] **Step 5: Run reducer, transport tests, and web typecheck**

```powershell
rtk proxy corepack pnpm --filter @resume/web exec vitest run src/conversation/conversation-process-events.test.ts src/conversation/conversation-process-model.test.ts
rtk proxy corepack pnpm --filter @resume/web typecheck
```

Expected: all focused tests PASS and web typecheck exits 0.

- [ ] **Step 6: Commit Task 6**

```powershell
rtk git add -- apps/web/src/conversation/conversation-process-events.ts apps/web/src/conversation/conversation-process-events.test.ts apps/web/src/conversation/conversation-process-model.ts apps/web/src/conversation/conversation-process-model.test.ts
rtk git commit -m "feat: group process events by conversation turn"
```

---

### Task 7: Render Unframed Per-Message Process Points

**Files:**
- Create: `apps/web/src/conversation/ConversationTurnTrace.tsx`
- Create: `apps/web/src/conversation/ConversationTurnTrace.test.tsx`
- Modify: `apps/web/src/conversation/ChatMessageList.tsx`
- Modify: `apps/web/src/conversation/ChatHome.tsx`
- Modify: `apps/web/src/conversation/ChatHome.test.tsx`
- Modify: `apps/web/src/styles.css`
- Delete: `apps/web/src/conversation/ConversationProcessChain.tsx`
- Delete: `apps/web/src/conversation/ConversationProcessChain.test.tsx`

**Interfaces:**
- Consumes: `ConversationTurnProcess` from Task 6.
- Produces: `ConversationTurnTrace({ process, isLatestTurn })` and message-list interleaving.

- [ ] **Step 1: Write failing component tests for visual hierarchy and disclosure**

```tsx
render(<ConversationTurnTrace process={runningProcess} isLatestTurn />);
expect(screen.getByRole("list", { name: "本轮执行过程" })).toBeVisible();
expect(screen.getByText("Tavily Search")).toBeVisible();
expect(screen.getByText("公司：百度")).toBeVisible();
expect(screen.queryByText(/可审计执行摘要|隐私内容和密钥已隐藏/)).toBeNull();
expect(screen.getByRole("button", { name: "收起执行过程" })).toHaveAttribute("aria-expanded", "true");
```

Add tests that a terminal process is initially collapsed, a running process remains expanded when it becomes terminal, an older terminal turn auto-collapses when a new turn begins, a user can reopen it, and a failed step exposes its public failure summary.

- [ ] **Step 2: Write a failing ChatHome two-turn placement test**

Send two user messages and dispatch interleaved SSE events for `turnSequence` 1 and 3. Assert each trace is inside the DOM section for its own user message and neither trace appears in a global process card.

```ts
const firstTurn = await screen.findByTestId("conversation-turn-1");
const secondTurn = await screen.findByTestId("conversation-turn-3");
expect(within(firstTurn).getByText("找到百度招聘入口")).toBeVisible();
expect(within(firstTurn).queryByText("正在查询投递进度")).toBeNull();
expect(within(secondTurn).getByText("正在查询投递进度")).toBeVisible();
expect(screen.queryByRole("heading", { name: "处理过程" })).toBeNull();
```

Add a confirmation-button test that immediately inserts a user confirmation message with the next sequence so incoming events have a visible owner before the API response returns.

- [ ] **Step 3: Run component and ChatHome tests and verify failure**

```powershell
rtk proxy corepack pnpm --filter @resume/web exec vitest run src/conversation/ConversationTurnTrace.test.tsx src/conversation/ChatHome.test.tsx
```

Expected: FAIL because the per-turn component and interleaving do not exist.

- [ ] **Step 4: Implement `ConversationTurnTrace`**

Use semantic list markup, real buttons, and explicit labels. Do not render a wrapper card.

```tsx
export function ConversationTurnTrace({ process, isLatestTurn }: {
  process: ConversationTurnProcess;
  isLatestTurn: boolean;
}) {
  const [expanded, setExpanded] = useState(process.active);
  const manuallyChanged = useRef(false);
  useEffect(() => {
    if (process.active) setExpanded(true);
    else if (!isLatestTurn && !manuallyChanged.current) setExpanded(false);
  }, [isLatestTurn, process.active]);

  return <section className="conversation-turn-trace" aria-label="本轮执行过程">
    <button
      type="button"
      className="conversation-turn-trace-toggle"
      aria-expanded={expanded}
      aria-label={expanded ? "收起执行过程" : "展开执行过程"}
      onClick={() => {
        manuallyChanged.current = true;
        setExpanded((value) => !value);
      }}
    >
      <TraceSummary process={process} />
    </button>
    {expanded ? <ol className="conversation-turn-trace-list" aria-label="本轮执行过程">
      {process.steps.map((step) => <TraceStep key={step.stepId} event={step} />)}
    </ol> : null}
  </section>;
}
```

Map allowlisted tool names to Chinese display labels in the component. Render input rows as `label：value`, result and failure summaries as text, and format duration as milliseconds below one second or one decimal second otherwise.

- [ ] **Step 5: Interleave traces with messages and add optimistic confirmation turns**

Pass grouped processes into `ChatMessageList`. For each user message, render one containing turn section:

```tsx
const processByTurn = groupConversationProcessEvents(processEvents);
const latestUserSequence = messages.filter(({ role }) => role === "user").at(-1)?.sequence;

return messages.map((message, index) => message.role === "user"
  ? <section key={message.id} data-testid={`conversation-turn-${message.sequence}`}>
      <MessageArticle message={message} />
      {processByTurn.has(message.sequence) ? <ConversationTurnTrace
        process={processByTurn.get(message.sequence)!}
        isLatestTurn={message.sequence === latestUserSequence}
      /> : null}
    </section>
  : <MessageArticle key={`${message.id}-${index}`} message={message} />);
```

Before `api.confirm`, append a local user message with `sequence = lastSequence + 1` and the same decision text used by the service. On failure, keep the message and show the existing error so events are never detached from their owner. On subsequent `get`, replace local history with persisted messages.

Move SSE connection status into the existing page heading beside “已就绪”; remove the global `ConversationProcessChain` render.

- [ ] **Step 6: Replace process-card CSS with timeline CSS**

Delete `.conversation-process-chain`, heading, card-item, and card-background rules. Add unframed styles:

```css
.conversation-turn-trace { margin: 7px 0 2px 42px; max-width: 680px; }
.conversation-turn-trace-toggle { align-items: center; background: transparent; border: 0; color: #6f8197; cursor: pointer; display: inline-flex; gap: 7px; min-height: 32px; padding: 0; }
.conversation-turn-trace-list { list-style: none; margin: 0; padding: 3px 0 0; }
.conversation-turn-trace-step { display: grid; gap: 10px; grid-template-columns: 18px minmax(0, 1fr) auto; min-height: 46px; padding-bottom: 14px; position: relative; }
.conversation-turn-trace-step:not(:last-child)::after { background: #d9e4ef; bottom: 0; content: ""; left: 8px; position: absolute; top: 18px; width: 1px; }
.conversation-turn-trace-point { align-items: center; background: #ffffff; border: 2px solid #9eacbc; border-radius: 50%; display: inline-flex; height: 18px; justify-content: center; position: relative; width: 18px; z-index: 1; }
.conversation-turn-trace-step.completed .conversation-turn-trace-point { border-color: #1b8a61; color: #1b8a61; }
.conversation-turn-trace-step.running .conversation-turn-trace-point,
.conversation-turn-trace-step.waiting .conversation-turn-trace-point { border-color: #1f67d5; color: #1f67d5; }
.conversation-turn-trace-step.failed .conversation-turn-trace-point { border-color: #c34141; color: #c34141; }
.conversation-turn-trace-tool-detail { border-left: 1px dashed #9ebee8; display: grid; gap: 4px; margin-top: 7px; padding-left: 10px; }
```

Use the existing blue-white palette and responsive breakpoint. At narrow widths, hide only the right-side duration; keep every step title, summary, failure reason, and disclosure control visible.

- [ ] **Step 7: Run component, ChatHome, and web type tests**

```powershell
rtk proxy corepack pnpm --filter @resume/web exec vitest run src/conversation/ConversationTurnTrace.test.tsx src/conversation/ChatHome.test.tsx src/conversation/conversation-process-model.test.ts src/conversation/conversation-process-events.test.ts
rtk proxy corepack pnpm --filter @resume/web typecheck
```

Expected: focused tests PASS, no global process-card heading remains, and web typecheck exits 0.

- [ ] **Step 8: Commit Task 7**

```powershell
rtk git add -- apps/web/src/conversation/ConversationTurnTrace.tsx apps/web/src/conversation/ConversationTurnTrace.test.tsx apps/web/src/conversation/ChatMessageList.tsx apps/web/src/conversation/ChatHome.tsx apps/web/src/conversation/ChatHome.test.tsx apps/web/src/styles.css apps/web/src/conversation/ConversationProcessChain.tsx apps/web/src/conversation/ConversationProcessChain.test.tsx
rtk git commit -m "feat: show execution points under each user message"
```

---

### Task 8: Complete Cross-Layer Regression and Chinese Test Report

**Files:**
- Modify: `docs/testing/2026-08-22-chat-first-workspace-regression.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verified release evidence and a Chinese regression section for per-turn execution traces.

- [ ] **Step 1: Run the complete focused conversation suites**

```powershell
rtk proxy corepack pnpm --filter @resume/contracts exec vitest run src/conversation.test.ts
rtk proxy corepack pnpm --filter @resume/api exec vitest run src/db/migrate.test.ts src/conversations/conversation-events.test.ts src/conversations/conversation-process-trace.test.ts src/conversations/conversation-process-summaries.test.ts src/conversations/conversation-service.test.ts src/conversations/conversation-graph.test.ts src/conversations/conversation-routes.test.ts
rtk proxy corepack pnpm --filter @resume/web exec vitest run src/conversation/conversation-process-events.test.ts src/conversation/conversation-process-model.test.ts src/conversation/ConversationTurnTrace.test.tsx src/conversation/ChatHome.test.tsx
```

Expected: all focused suites PASS. Report exact files, test counts, duration, and skips.

- [ ] **Step 2: Run safety-boundary regression suites**

```powershell
rtk proxy corepack pnpm --filter @resume/api exec vitest run src/recruitment-search/tavily-remote-mcp.test.ts src/job-matching/job-match-service.test.ts src/applications/application-service.test.ts src/applications/application-machine.test.ts
rtk proxy corepack pnpm --filter @resume/web exec vitest run src/conversation/ConversationCards.test.tsx src/workspace/ProfileApplicationWorkspace.test.tsx src/router.test.tsx
```

Expected: Tavily safety, job matching, controlled application, confirmation cards, workspace, and route tests PASS with no employer-status feature added.

- [ ] **Step 3: Run workspace typecheck and builds**

```powershell
rtk proxy corepack pnpm typecheck
rtk proxy corepack pnpm build
```

Expected: both commands exit 0.

- [ ] **Step 4: Start services and perform desktop/mobile visual verification**

```powershell
rtk proxy powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/service-control.ps1 start
rtk proxy powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/service-control.ps1 status
```

Verify at `http://127.0.0.1:5173/`:

1. Send “帮我投递一下百度校园招聘”.
2. Confirm the trace appears under that user message and shows understanding, Tavily, URL validation, and waiting points.
3. Confirm the trace has no card border/background and does not show the removed privacy sentence.
4. Confirm the recruitment-entry action remains clickable.
5. Start job recommendations and confirm the new turn has its own trace.
6. Confirm only real Browser Worker/job-matching steps appear.
7. Refresh and confirm traces remain attached to the correct messages.
8. Check desktop and a 390px-wide viewport for overlap, clipping, or horizontal scrolling.

Expected: all eight checks pass. Capture failures with the exact turn, visible status, and console/network evidence; do not silently mark them as passing.

- [ ] **Step 5: Update the Chinese regression report**

Append a section with this exact structure. Write one row per command using the literal pass, fail, skip, and duration counts printed by that command; do not estimate or leave blank fields:

```markdown
## 每轮对话执行轨迹回归（2026-09-01）

- 测试范围：契约、数据库迁移、SSE 重放、轮次归组、流程点交互、招聘搜索、岗位匹配、受控投递。
- 自动化结果：按命令逐行记录“命令、通过数、失败数、跳过数、耗时”。
- 桌面端结果：记录八项人工检查的实际结论和截图路径。
- 移动端结果：记录 390px 视口的实际结论和截图路径。
- 隐私检查：未发现密钥、Cookie、完整简历、原始 MCP 报文或模型隐性思维链。
- 安全边界：岗位匹配与受控投递逻辑保持不变；未实现企业招聘状态跟踪。
- 已知问题：没有问题时明确写“无”；有问题时逐条写现象、影响范围和复现步骤。
```

- [ ] **Step 6: Commit Task 8**

```powershell
rtk git add -- docs/testing/2026-08-22-chat-first-workspace-regression.md
rtk git commit -m "docs: record per-turn trace regression results"
```

---

## Final Completion Check

- [ ] Run `rtk git status --short` and verify no unrelated file was staged or committed.
- [ ] Run `rtk git log -8 --oneline` and confirm one focused commit per completed task.
- [ ] Confirm each task report contains its exact test command and result count.
- [ ] Confirm the implementation contains no enterprise recruitment-status API, table, worker, poller, webhook, or notification code.
- [ ] Confirm the final UI contains no global process card and no “可审计执行摘要 · 隐私内容和密钥已隐藏” text.
- [ ] Confirm every valid user turn has either real process points or the minimal “理解请求 / 生成回复” trace without invented tool calls.
