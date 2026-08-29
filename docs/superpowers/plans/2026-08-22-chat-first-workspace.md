# Chat-First Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将岗位推荐和受控投递统一到桌面端对话首页，同时保留岗位匹配、投递审核和任务详情页作为可深入操作的工作台。

**Architecture:** 新增 Conversation Graph 作为对话入口，负责加载结构化上下文、解析受限意图、解析真实岗位/任务 ID、执行权限检查并调用已有岗位匹配和投递服务。对话消息保存到 Conversation Store，流程中间状态保存到 LangGraph Checkpoint，脱敏决策路径通过现有 TraceSink 和 LangSmith outbox 记录；三者不互相替代。前端以 ChatHome 为主入口，通过 typed card 连接 JobMatchSession 和 ApplicationTask，副作用操作必须经过显式确认，最终提交工具始终不可用。

**Tech Stack:** React 19, React Router, Fastify, TypeScript, SQLite/better-sqlite3, Zod, LangGraph, LangGraph SQLite Checkpoint, TraceSink, LangSmith outbox, Vitest, Testing Library, Playwright.

## Global Constraints

- 本期只支持桌面端，不增加移动端布局或断点适配。
- 本期不实现企业账号绑定、招聘状态轮询、企业状态推送、邮件通知和招聘流程状态归一化。
- 对话消息只保存用户可见文本、卡片和引用 ID；不保存完整简历原文、PDF、DOM、表单值、密钥或模型 token。
- Conversation Store、LangGraph Checkpoint、TraceSink/LangSmith outbox 必须使用独立表和独立接口。
- 大模型只能输出严格 Zod schema；不得返回任意工具名、任意 URL、任意浏览器命令或任意数据库主键。
- 只读查询可以直接执行；创建投递任务属于副作用，必须先返回确认卡片；最终提交动作不进入工具注册表。
- 岗位和投递任务必须解析为真实 ID；“第一份”等序号只能从当前会话最近一次推荐列表中确定解析。
- 保留 `/applications/:taskId`、`/job-match-sessions/:sessionId` 和旧的 `view=apply`、`view=reviews` 链接兼容性。
- 每个任务先写失败测试，再实现最小代码；所有测试命令使用仓库已有的 `pnpm` workspace 脚本。

## File Map

Create:

- `packages/contracts/src/conversation.ts`：对话、意图、卡片和确认请求的共享 schema。
- `apps/api/src/conversations/conversation-repository.ts`：SQLite 对话会话、消息和结构化上下文存取。
- `apps/api/src/conversations/conversation-tools.ts`：有限工具注册表及工具权限声明。
- `apps/api/src/conversations/conversation-graph.ts`：Conversation Graph 的节点、路由和副作用确认边界。
- `apps/api/src/conversations/conversation-service.ts`：HTTP 层使用的会话服务，连接 repository、graph 和领域服务。
- `apps/api/src/conversations/conversation-routes.ts`：会话创建、历史读取、发送消息和确认接口。
- `apps/api/src/conversations/conversation-repository.test.ts`：消息顺序、上下文版本和重启恢复测试。
- `apps/api/src/conversations/conversation-graph.test.ts`：意图限制、目标解析、确认和工具错误测试。
- `apps/api/src/conversations/conversation-routes.test.ts`：HTTP contract 测试。
- `apps/web/src/conversation/api.ts`：前端对话 API 类型和请求封装。
- `apps/web/src/conversation/ChatHome.tsx`：桌面对话首页容器。
- `apps/web/src/conversation/ChatMessageList.tsx`：消息流和状态展示。
- `apps/web/src/conversation/ConversationComposer.tsx`：输入框、长度限制和发送状态。
- `apps/web/src/conversation/ConversationCards.tsx`：推荐卡、投递任务卡和确认卡。
- `apps/web/src/conversation/ChatHome.test.tsx`：对话交互和卡片动作测试。
- `apps/web/src/conversation/api.test.ts`：响应 schema 和错误映射测试。

Modify:

- `packages/contracts/src/index.ts`：导出 conversation contracts。
- `apps/api/src/db/schema.ts`：增加三张对话表。
- `apps/api/src/app.ts`：注入 conversation service 并注册 conversation routes。
- `apps/api/src/db/migrate.ts`：执行新增表的幂等建表语句，并在 `apps/api/src/db/migrate.test.ts` 增加重启和外键约束验证；不新增第二套 migration runner。
- `apps/web/src/workspace/WorkspaceFrame.tsx`：增加对话首页、我的岗位、投递审核和简历导航，并保留旧 view 别名。
- `apps/web/src/workspace/ProfileApplicationWorkspace.tsx`：把对话作为默认视图，复用现有 JobMatchStartPanel、ApplicationReviewInbox 和 ProfilePage。
- `apps/web/src/router.tsx`：注入 ConversationApi，增加对话深链和旧路由兼容。
- `apps/web/src/styles.css`：增加蓝白桌面三栏布局、消息流、卡片和确认状态样式。

## Task 1: Add Conversation Contracts And Database Tables

**Files:**
- Create: `packages/contracts/src/conversation.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/src/db/schema.ts`
- Test: `packages/contracts/src/conversation.test.ts`
- Test: `apps/api/src/db/schema.test.ts` if the repository has schema tests; otherwise cover table creation in `conversation-repository.test.ts`.

**Interfaces:**
- Produces `ConversationIntent`, `ConversationTarget`, `ConversationCard`, `ConversationMessage`, `ConversationContext`, `ConversationTurnInput`, `ConversationTurnResponse` and their Zod schemas.
- `ConversationIntent.kind` is one of `list_recommendations`, `show_recommendation`, `start_application`, `show_application_task`, `list_application_tasks`, `start_application_and_show_status`, `help`, `unknown`.
- `ConversationTarget` is `{ kind: "recommendation" | "task" | "job_match_session"; id?: string; ordinal?: number }`.

- [ ] **Step 1: Write the failing contract tests**

```typescript
it("accepts only bounded conversation intents", () => {
  expect(ConversationIntentSchema.parse({
    kind: "start_application_and_show_status",
    target: { kind: "recommendation", ordinal: 1 },
    requiresConfirmation: true
  })).toMatchObject({ kind: "start_application_and_show_status" });

  expect(() => ConversationIntentSchema.parse({
    kind: "run_browser_command",
    tool: "page.evaluate"
  })).toThrow();
});

it("rejects unbounded message input", () => {
  expect(() => ConversationTurnInputSchema.parse({ text: "x".repeat(501) })).toThrow();
});
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run: `corepack pnpm --filter @resume/contracts test -- conversation.test.ts`

Expected: FAIL because `conversation.ts` and the schemas do not exist.

- [ ] **Step 3: Implement strict schemas and tables**

Implement `ConversationCardSchema` as a discriminated union with only these card types:

```typescript
export const ConversationCardSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("recommendation"), sessionId: z.string().min(1), resultId: z.string().min(1), title: z.string().max(160), company: z.string().max(160), score: z.number().min(0).max(100), evidenceCount: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("application_task"), taskId: z.string().min(1), title: z.string().max(160), state: z.string().min(1).max(80), applicationUrl: z.string().url() }).strict(),
  z.object({ type: z.literal("confirmation"), action: z.literal("start_application"), target: z.object({ kind: z.literal("recommendation"), sessionId: z.string().min(1), resultId: z.string().min(1) }).strict() }).strict()
]);
```

Add strict schemas for messages, context and responses. Context contains only `activeJobMatchSessionId`, `selectedPostingId`, `activeApplicationTaskId`, `recentPostingIds`, `lastIntent` and `version`.

Add SQLite tables:

```typescript
conversationSessions: id, title, createdAt, updatedAt
conversationMessages: id, sessionId, sequence, role, text, cardsJson, intentJson, createdAt
conversationContexts: sessionId, version, contextJson, updatedAt
```

Use foreign keys, unique `(sessionId, sequence)`, JSON validity checks and indexes on `sessionId`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `corepack pnpm --filter @resume/contracts test -- conversation.test.ts` and `corepack pnpm --filter @resume/contracts typecheck`

Expected: PASS with no schema type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/conversation.ts packages/contracts/src/index.ts apps/api/src/db/schema.ts packages/contracts/src/conversation.test.ts
git commit -m "feat: add conversation contracts and persistence schema"
```

## Task 2: Implement Conversation Store And Context Versioning

**Files:**
- Create: `apps/api/src/conversations/conversation-repository.ts`
- Create: `apps/api/src/conversations/conversation-repository.test.ts`
- Modify: `apps/api/src/db/migrate.ts`
- Modify: `apps/api/src/db/migrate.test.ts`

**Interfaces:**
- `createConversation(): ConversationSession`
- `getConversation(id: string): ConversationSession | undefined`
- `listMessages(id: string, afterSequence?: number): ConversationMessage[]`
- `appendMessage(input: { sessionId: string; message: ConversationMessage; expectedSequence: number }): ConversationMessage`
- `getContext(id: string): ConversationContext`
- `updateContext(id: string, expectedVersion: number, next: ConversationContext): ConversationContext`

- [ ] **Step 1: Write failing repository tests**

```typescript
it("appends messages in sequence and rejects stale writers", () => {
  const repository = createConversationRepository(createDatabase());
  const session = repository.createConversation();
  repository.appendMessage({ sessionId: session.id, expectedSequence: 0, message: userMessage("第一轮") });
  expect(() => repository.appendMessage({ sessionId: session.id, expectedSequence: 0, message: userMessage("重复写入") })).toThrow("conversation_sequence_conflict");
  expect(repository.listMessages(session.id)).toHaveLength(1);
});

it("updates structured context with optimistic versioning", () => {
  const repository = createConversationRepository(createDatabase());
  const session = repository.createConversation();
  const context = repository.updateContext(session.id, 0, { version: 1, recentPostingIds: ["posting-1"] });
  expect(context.recentPostingIds).toEqual(["posting-1"]);
  expect(() => repository.updateContext(session.id, 0, context)).toThrow("conversation_context_conflict");
});
```

- [ ] **Step 2: Run the repository tests and verify failure**

Run: `corepack pnpm --filter @resume/api test -- conversation-repository.test.ts`

Expected: FAIL because the repository factory and typed methods do not exist.

- [ ] **Step 3: Add the migration DDL and implement transactional repository methods**

Add the three `CREATE TABLE IF NOT EXISTS` statements and indexes to `apps/api/src/db/migrate.ts`. Add a `migrateDatabase(database); migrateDatabase(database);` assertion to `apps/api/src/db/migrate.test.ts`. Use prepared statements and a single SQLite transaction for message append plus session `updated_at`. Read the next sequence from the database, compare it to `expectedSequence`, and throw `conversation_sequence_conflict` on mismatch. Update context only when `expectedVersion` equals the stored version. Parse all JSON through the contracts before returning it.

- [ ] **Step 4: Verify restart semantics**

Extend the test to close and reopen the same SQLite file, then assert that messages and context are still readable and sequence continues from the stored value.

Run: `corepack pnpm --filter @resume/api test -- conversation-repository.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
  git add apps/api/src/conversations/conversation-repository.ts apps/api/src/conversations/conversation-repository.test.ts apps/api/src/db/migrate.ts apps/api/src/db/migrate.test.ts
git commit -m "feat: persist conversation history and structured context"
```

## Task 3: Add Typed Conversation Tools And LangGraph Intent Flow

**Files:**
- Create: `apps/api/src/conversations/conversation-tools.ts`
- Create: `apps/api/src/conversations/conversation-graph.ts`
- Create: `apps/api/src/conversations/conversation-graph.test.ts`
- Modify: `apps/api/src/agent/state.ts` only if the existing graph state needs a shared trace/thread reference.
- Reuse: `apps/api/src/agent/sqlite-checkpointer.ts`, `apps/api/src/agent/trace-sink.ts`, `apps/api/src/agent/langsmith-outbox.ts`, existing job-match and application services.

**Interfaces:**
- `ConversationToolContext = { conversationId: string; recentPostingIds: string[]; activeJobMatchSessionId?: string; selectedPostingId?: string; activeApplicationTaskId?: string }`
- `ConversationToolRegistry.invoke(name: ConversationToolName, input: unknown, context: ConversationToolContext): Promise<ConversationToolResult>`
- `createConversationGraph(dependencies): CompiledStateGraph`
- Graph nodes: `load_context`, `classify_intent`, `resolve_target`, `policy_gate`, `execute_read`, `prepare_side_effect`, `persist_turn`.

- [ ] **Step 1: Write failing tool and graph tests**

```typescript
it("does not expose arbitrary browser operations", () => {
  const registry = createConversationToolRegistry(fakeDependencies());
  expect(registry.names()).toEqual([
    "list_recommendations", "show_recommendation", "list_application_tasks",
    "show_application_task", "create_application_task"
  ]);
  expect(() => registry.invoke("page.evaluate" as never, {}, emptyContext())).rejects.toThrow("tool_not_allowed");
});

it("turns '投递第一份，帮我查看投递进度' into a confirmation", async () => {
  const result = await runConversationTurn({ text: "投递第一份，帮我查看投递进度" });
  expect(result.pendingConfirmation?.action).toBe("start_application");
  expect(result.pendingConfirmation?.target.ordinal).toBe(1);
  expect(fakeApplicationService.create).not.toHaveBeenCalled();
});

it("executes a read-only status query without confirmation", async () => {
  const result = await runConversationTurn({ text: "我投了哪些岗位" });
  expect(result.cards.every((card) => card.type === "application_task")).toBe(true);
  expect(result.pendingConfirmation).toBeUndefined();
});
```

- [ ] **Step 2: Run the graph tests and verify failure**

Run: `corepack pnpm --filter @resume/api test -- conversation-graph.test.ts`

Expected: FAIL because the registry and graph are not present.

- [ ] **Step 3: Implement the bounded tool registry**

Register only typed read and task-creation tools. `create_application_task` may create a task and hand it to the existing application service, but no tool may invoke a final submit command, arbitrary Playwright method, arbitrary URL, or raw SQL. Tool inputs must be parsed by Zod before execution; tool outputs must be converted to `ConversationCard` references.

- [ ] **Step 4: Implement the LangGraph nodes and policy gate**

`classify_intent` calls the existing structured model provider when configured and validates its output. On provider failure, use a deterministic fallback for the supported Chinese command patterns and return `unknown` for anything else. `resolve_target` maps `ordinal` to `recentPostingIds` and loads the actual `JobMatchResult` or `ApplicationTask`; missing or ambiguous targets become a user-facing clarification response. `policy_gate` routes reads directly and turns `start_application` into an interrupt/confirmation state.

The combined command is handled as one intent envelope:

```typescript
{
  kind: "start_application_and_show_status",
  target: { kind: "recommendation", ordinal: 1 },
  requiresConfirmation: true
}
```

After confirmation, create the task idempotently, update `activeApplicationTaskId`, and return the task card. The existing application graph remains responsible for observation, filling, readback, challenge interruption and review lock.

- [ ] **Step 5: Emit local trace and LangSmith-safe events**

For each node and tool call, write `traceId`, `conversationId`, `nodeName`, `toolName`, `decision`, `confidence`, `durationMs`, `errorCode` and bounded reason codes to `TraceSink`. Reuse the existing LangSmith outbox projector; never export text, prompts, evidence quotes, DOM, form values, URLs or secrets.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `corepack pnpm --filter @resume/api test -- conversation-graph.test.ts agent/graph-service.test.ts agent/langsmith-exporter.test.ts` and `corepack pnpm --filter @resume/api typecheck`

Expected: PASS; a LangSmith timeout or exporter failure does not change the graph response.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/conversations apps/api/src/agent/state.ts
git commit -m "feat: route bounded conversation intents through LangGraph"
```

## Task 4: Expose Conversation HTTP API

**Files:**
- Create: `apps/api/src/conversations/conversation-service.ts`
- Create: `apps/api/src/conversations/conversation-routes.ts`
- Create: `apps/api/src/conversations/conversation-routes.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- `POST /api/conversations` -> `ConversationSession`
- `GET /api/conversations/:id` -> session metadata, messages and context summary
- `POST /api/conversations/:id/messages` body `{ text: string }` -> `ConversationTurnResponse`
- `POST /api/conversations/:id/confirm` body `{ confirmationId: string; approved: boolean }` -> `ConversationTurnResponse`

- [ ] **Step 1: Write failing Fastify route tests**

```typescript
it("rejects oversized and malformed message bodies", async () => {
  const app = await createTestApp();
  const response = await app.inject({
    method: "POST",
    url: "/api/conversations/session-1/messages",
    payload: { text: "x".repeat(501) }
  });
  expect(response.statusCode).toBe(400);
});

it("requires the confirmation token for task creation", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/conversations/session-1/confirm",
    payload: { confirmationId: "wrong", approved: true }
  });
  expect(response.statusCode).toBe(409);
});
```

- [ ] **Step 2: Run route tests and verify failure**

Run: `corepack pnpm --filter @resume/api test -- conversation-routes.test.ts`

Expected: FAIL because the routes are not registered.

- [ ] **Step 3: Implement service and routes**

Register the repository, graph and existing domain services in `AppDependencies`. Route handlers validate bodies with contracts, return `400` for schema violations, `404` for unknown conversations, `409` for stale confirmation/context versions and `503` only when a required domain service is unavailable. Do not expose raw model errors.

- [ ] **Step 4: Verify idempotency and recovery**

Use a request id or graph thread id derived from `conversationId` plus message sequence. Replaying the same message sequence returns the stored response rather than creating a second application task. A confirmation resumes the same checkpoint and cannot be replayed after it is consumed.

Run: `corepack pnpm --filter @resume/api test -- conversation-routes.test.ts conversation-repository.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/conversations apps/api/src/app.ts
git commit -m "feat: expose conversation session APIs"
```

## Task 5: Build The Desktop Chat Home

**Files:**
- Create: `apps/web/src/conversation/api.ts`
- Create: `apps/web/src/conversation/ChatHome.tsx`
- Create: `apps/web/src/conversation/ChatMessageList.tsx`
- Create: `apps/web/src/conversation/ConversationComposer.tsx`
- Create: `apps/web/src/conversation/ConversationCards.tsx`
- Create: `apps/web/src/conversation/api.test.ts`
- Create: `apps/web/src/conversation/ChatHome.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- `ConversationApi.create(): Promise<ConversationSession>`
- `ConversationApi.get(id: string): Promise<ConversationView>`
- `ConversationApi.send(id: string, text: string): Promise<ConversationTurnResponse>`
- `ConversationApi.confirm(id: string, confirmationId: string, approved: boolean): Promise<ConversationTurnResponse>`

- [ ] **Step 1: Write failing UI tests**

```tsx
it("renders history and sends a bounded message", async () => {
  const api = fakeConversationApi({ messages: [assistantMessage("可以开始岗位匹配")] });
  render(<ChatHome api={api} onOpenJobMatch={vi.fn()} onOpenApplication={vi.fn()} />);
  expect(await screen.findByText("可以开始岗位匹配")).toBeVisible();
  await userEvent.setup().type(screen.getByRole("textbox"), "我投了哪些岗位");
  await userEvent.setup().click(screen.getByRole("button", { name: "发送" }));
  expect(api.send).toHaveBeenCalledWith(expect.any(String), "我投了哪些岗位");
});

it("requires explicit approval before creating a task", async () => {
  const api = fakeConversationApi({ pendingConfirmation: { action: "start_application" } });
  render(<ChatHome api={api} onOpenJobMatch={vi.fn()} onOpenApplication={vi.fn()} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "确认进入投递" }));
  expect(api.confirm).toHaveBeenCalledWith(expect.any(String), expect.any(String), true);
});
```

- [ ] **Step 2: Run UI tests and verify failure**

Run: `corepack pnpm --filter @resume/web test -- conversation/api.test.ts conversation/ChatHome.test.tsx`

Expected: FAIL because the conversation components do not exist.

- [ ] **Step 3: Implement API parsing and chat components**

On first load create or reuse a conversation session, then load messages and context summary. Keep `messages`, `pendingConfirmation`, `sending` and `error` as separate local states. Render recommendation cards with “查看匹配依据”和“开始投递”; render task cards with “打开投递任务”. The card callbacks only navigate or call the typed conversation API.

The composer must set `maxLength={500}`, show the remaining count, disable send for blank text or while a request is in flight, and display server validation errors without echoing raw model output.

- [ ] **Step 4: Implement blue-white desktop layout**

Add a fixed-width left navigation column, flexible center message column and optional right context column. Use stable card dimensions, existing Lucide icons, restrained blue/white/gray colors and no mobile-specific layout. Confirmation cards must be visually distinct from ordinary assistant messages and must expose accessible button names.

- [ ] **Step 5: Run focused tests and build**

Run: `corepack pnpm --filter @resume/web test -- conversation/api.test.ts conversation/ChatHome.test.tsx` and `corepack pnpm --filter @resume/web build`

Expected: PASS and a successful Vite build.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/conversation apps/web/src/styles.css
git commit -m "feat: add desktop conversation home"
```

## Task 6: Rewire Workspace Navigation And Preserve Deep Links

**Files:**
- Modify: `apps/web/src/workspace/WorkspaceFrame.tsx`
- Modify: `apps/web/src/workspace/ProfileApplicationWorkspace.tsx`
- Modify: `apps/web/src/router.tsx`
- Modify: `apps/web/src/workspace/ProfileApplicationWorkspace.test.tsx`
- Modify: `apps/web/src/router.test.tsx`

**Interfaces:**
- `WorkspaceView = "chat" | "jobs" | "applications" | "profile"`
- Legacy query values `apply` and `reviews` normalize to `jobs` and `applications`.
- Existing deep routes remain unchanged.

- [ ] **Step 1: Write failing navigation tests**

```tsx
it("opens chat as the default and keeps domain workbenches accessible", async () => {
  render(<BrowserRouter><ProfileApplicationWorkspace {...dependencies()} /></BrowserRouter>);
  expect(await screen.findByRole("heading", { name: "岗位投递助手" })).toBeVisible();
  expect(screen.getByRole("button", { name: "我的岗位" })).toBeVisible();
  expect(screen.getByRole("button", { name: "投递进度" })).toBeVisible();
  expect(screen.getByRole("button", { name: "我的简历" })).toBeVisible();
});

it("maps legacy views without breaking old links", async () => {
  window.history.pushState({}, "", "/?view=reviews");
  render(<BrowserRouter><ProfileApplicationWorkspace {...dependencies()} /></BrowserRouter>);
  expect(await screen.findByRole("heading", { name: "投递审核" })).toBeVisible();
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `corepack pnpm --filter @resume/web test -- workspace/ProfileApplicationWorkspace.test.tsx router.test.tsx`

Expected: FAIL because the default view and navigation labels are still the old workspace layout.

- [ ] **Step 3: Implement navigation normalization and composition**

Make `/` render `ChatHome` by default. The “我的岗位” view contains the existing matching entry and deep session route. The “投递进度” view contains the existing review inbox and links to `/applications/:taskId`. The “我的简历” view renders `ProfilePage`. Keep `/applications/new?` redirecting to the jobs/application entry as it currently does.

Add `conversationApi` injection to `AppRouter` with a default `createConversationApi()`. Pass card callbacks from `ChatHome` to `navigate(`/job-match-sessions/${sessionId}`)` and `navigate(`/applications/${taskId}`)`.

- [ ] **Step 4: Verify old and new routes**

Run: `corepack pnpm --filter @resume/web test -- workspace/ProfileApplicationWorkspace.test.tsx router.test.tsx apps/web/src/applications/ApplicationTaskPage.test.tsx`

Expected: PASS; the old deep task/session routes still render their existing pages and event streams.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workspace apps/web/src/router.tsx apps/web/src/workspace/*.test.tsx apps/web/src/router.test.tsx
git commit -m "feat: make conversation the primary workspace entry"
```

## Task 7: Integrate End-To-End Actions And Error States

**Files:**
- Modify: `apps/api/src/conversations/conversation-graph.ts`
- Modify: `apps/api/src/conversations/conversation-routes.ts`
- Modify: `apps/web/src/conversation/ConversationCards.tsx`
- Modify: `apps/web/src/conversation/ChatHome.tsx`
- Create: `apps/api/src/conversations/conversation-e2e.test.ts`
- Create or modify: `apps/web/src/conversation/ChatHome.integration.test.tsx`

**Interfaces:**
- The recommendation card carries `sessionId`, `resultId`, `postingContentHash` and score/evidence counts, but never raw resume text.
- The task card carries `taskId`, display state and target URL only after the domain service validates the URL.
- Confirmation response carries a consumed `confirmationId` and cannot be reused.

- [ ] **Step 1: Write failing integration tests**

```typescript
it("resolves the first recommendation to a real result before creating a task", async () => {
  const response = await send("投递第一份，帮我查看投递进度");
  expect(response.pendingConfirmation?.target.resultId).toBe("result-1");
  expect(applicationService.createFromJob).not.toHaveBeenCalled();
});

it("does not create a task when the ordinal is ambiguous", async () => {
  const response = await sendWithNoRecommendationContext("投递第一份");
  expect(response.message).toContain("当前没有可确定的第 1 个岗位");
  expect(applicationService.createFromJob).not.toHaveBeenCalled();
});

it("returns a retryable card when the browser worker is unavailable", async () => {
  applicationService.createFromJob.mockRejectedValue(new Error("browser_worker_unavailable"));
  const response = await confirm("confirmation-1");
  expect(response.message).toContain("受控浏览器");
  expect(response.cards).toEqual([]);
});
```

- [ ] **Step 2: Run integration tests and verify failure**

Run: `corepack pnpm --filter @resume/api test -- conversation-e2e.test.ts`

Expected: FAIL until conversation context, existing job result conversion and application task creation are wired together.

- [ ] **Step 3: Implement result-to-task handoff**

Use the existing job-match selection guard and `createFromJob` idempotency path. Store only the selected result ID, posting content hash and resulting task ID in context. Do not reconstruct a job from assistant text. A stale result returns a conflict card linking to the existing job match session for refresh.

- [ ] **Step 4: Implement failure mapping**

Map domain errors to bounded Chinese messages and recovery actions: missing context -> open jobs, stale result -> refresh matching, worker unavailable -> open task/retry, challenge -> open manual takeover, policy rejection -> explain that submission is locked. Preserve the original error code in TraceSink only.

- [ ] **Step 5: Run browser-level verification**

Run: `corepack pnpm test:e2e -- --grep "conversation|job match|application task"`

Expected: the browser opens on the chat home, creates a recommendation session through the existing flow, shows a confirmation card for task creation, and opens the existing task workbench after confirmation. No test may click an automatic final-submit control because none is exposed.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/conversations apps/web/src/conversation
git commit -m "feat: connect chat recommendations to controlled application tasks"
```

## Task 8: Observability, Privacy And Release Verification

**Files:**
- Modify: `apps/api/src/conversations/conversation-graph.ts`
- Modify: `apps/api/src/agent/langsmith-outbox.ts` only if the existing allowlist needs a conversation event field.
- Create: `apps/api/src/conversations/conversation-observability.test.ts`
- Modify: `docs/testing/` with a short chat flow regression report.

- [ ] **Step 1: Write failing privacy tests**

```typescript
it("rejects conversation content and secrets from LangSmith projection", () => {
  expect(() => projectLangSmithEvent({
    traceId: "trace-1",
    input: "投递第一份",
    prompt: "private prompt",
    formValue: "private value",
    apiKey: "secret"
  })).toThrow();
});
```

- [ ] **Step 2: Run privacy tests and verify failure**

Run: `corepack pnpm --filter @resume/api test -- conversation-observability.test.ts`

Expected: FAIL if the projector accepts fields outside the existing safe allowlist.

- [ ] **Step 3: Implement observability assertions**

Record node/tool parentage, intent kind, target kind, confidence bucket, result count, task state, duration and bounded error code. Keep message body and model prompt local. Ensure LangSmith exporter remains asynchronous and its timeout, rate limit, duplicate delivery and dead-letter paths do not alter the conversation response.

- [ ] **Step 4: Run the complete verification gate**

Run:

```bash
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test:e2e -- --grep "conversation|job match|application task"
```

Expected: all commands exit with code 0. Record the actual test counts and any environment-dependent skips in `docs/testing/2026-08-22-chat-first-workspace-regression.md`; do not invent performance or accuracy metrics.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/conversations apps/api/src/agent apps/web/src/conversation docs/testing
git commit -m "test: verify chat-first workspace safety and observability"
```

## Execution Order

Execute Tasks 1-2 first because contracts and persistence are shared by the graph and UI. Task 3 and Task 4 follow sequentially because the HTTP layer depends on the graph service. Task 5 can begin after the contracts exist, but its integration tests wait for Task 4. Task 6 rewires the shell only after the chat home can render. Task 7 connects the complete user journey. Task 8 is the release gate.

## Self-Review

- Requirement coverage: conversation persistence is covered by Tasks 1-2; structured context by Tasks 1-3; intent restrictions and tool error control by Task 3; HTTP integration by Task 4; desktop visualization by Tasks 5-6; job recommendation and controlled application handoff by Task 7; LangSmith audit and privacy by Task 8.
- Enterprise tracking is explicitly excluded from every task: no account binding, external recruitment state, polling scheduler, webhook, or push notification is introduced.
- All cross-task names are consistent: `ConversationApi`, `ConversationToolRegistry`, `createConversationGraph`, `ConversationCard`, `conversationId`, `activeJobMatchSessionId`, `selectedPostingId` and `activeApplicationTaskId`.
- There are no open-ended model tools, arbitrary browser calls, or automatic final-submit paths in the plan.
- Database initialization is fixed to `apps/api/src/db/migrate.ts`; no parallel migration runner is needed.
