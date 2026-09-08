# 对话内岗位匹配实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将岗位匹配完整收敛到对话中，以当前用户轮次下的无卡片流程点展示真实执行过程，并在助手消息中展示实时岗位卡片，同时保留岗位匹配状态机、受控投递、人工接管和最终提交锁。

**Architecture:** `JobMatchService` 和 `JobMatchRepository` 继续作为岗位匹配的唯一事实来源；对话层只保存 `sessionId`、`resultId`、版本号和幂等键等受校验的轻量引用。API 为岗位动作提供带会话归属校验的编排入口，动作写入对话用户轮次并发布流程事件；Web 通过现有岗位会话读取/轮询接口把会话状态投影为对话内流程点、筛选区和岗位卡片。旧岗位匹配 URL 只负责恢复所属对话，不再渲染独立工作台。

**Tech Stack:** TypeScript, Fastify, Zod, SQLite/`better-sqlite3`, React 19, React Router, Vitest, Testing Library, Playwright, pnpm.

## Global Constraints

- 在当前会话中按任务顺序执行，不创建子智能体或额外 Codex 任务。
- 每个 Task 必须遵循 TDD：先写失败测试，确认失败，写最小实现，运行通过测试和相邻回归测试，最后提交该 Task。
- 每完成一个 Task 汇报实际运行命令、通过/失败/跳过、结果摘要和耗时。
- 复用现有 `JobMatchService` 的状态机、适配器、评分、真实 `sessionId`/`resultId`/`postingId`、版本保护、执行 epoch、幂等键和事件记录；不在 React、对话文案或新服务中复制这些领域逻辑。
- 保留受控浏览器、浏览器所有权租约、人工接管、审核确认和最终提交锁；岗位选择后仍须确认创建受控投递任务，绝不自动执行最终提交。
- 本期不实现企业招聘状态跟踪、外部状态轮询、Webhook、状态同步、通知或新的招聘方状态模型。
- 流程点只展示经过白名单映射的摘要；不得显示密钥、Cookie、完整简历、表单值、DOM、原始 MCP 报文、模型提示词或隐藏思维链。
- 长耗时步骤必须更新同一 `stepId` 的运行/结束状态，不得用重复事件伪造进度；登录、验证码/挑战和暂停使用 `waiting`，失败使用脱敏 `failed`。
- 保留工作区已有无关改动；每个 Task 只暂存本 Task 文件，不回滚用户已有修改，不提交构建产物、日志、截图缓存或本地密钥。
- 所有 shell 命令使用 `rtk` 前缀；源码编辑使用 `apply_patch`。

---

## 文件责任图

```text
对话契约
  packages/contracts/src/conversation.ts
        |
        +--> 会话归属/动作编排
        |      apps/api/src/conversations/conversation-job-match-service.ts
        |      apps/api/src/conversations/conversation-job-match-routes.ts
        |      apps/api/src/conversations/conversation-repository.ts
        |      apps/api/src/db/schema.ts
        |      apps/api/src/db/migrate.ts
        |
        +--> 流程事件
        |      apps/api/src/conversations/conversation-events.ts
        |      apps/api/src/conversations/conversation-process-trace.ts
        |      apps/api/src/conversations/conversation-service.ts
        |
        +--> Web 状态投影
               apps/web/src/job-matching/api.ts
               apps/web/src/job-matching/useJobMatchSession.ts
               apps/web/src/conversation/ConversationJobMatchFlow.tsx
               apps/web/src/conversation/ConversationJobFilters.tsx
               apps/web/src/conversation/ConversationJobCards.tsx
               apps/web/src/conversation/ChatHome.tsx
               apps/web/src/conversation/ChatMessageList.tsx
               apps/web/src/conversation/ConversationCards.tsx
               apps/web/src/workspace/ProfileApplicationWorkspace.tsx
               apps/web/src/router.tsx
               apps/web/src/styles.css
```

`JobMatchService`、`JobMatchRepository`、抽取/匹配协调器、浏览器 worker、受控投递服务和既有应用任务路由是被复用的领域边界；除非测试证明接口适配确实需要，不修改其核心状态转移。

## 现有接口基线

计划实现必须以当前代码中的这些签名为准：

```ts
// apps/api/src/job-matching/job-match-service.ts
service.create({ url: string }): Promise<PresentedJobMatchSession | { redirect: "application"; applicationUrl: string }>;
service.get(sessionId: string): PresentedJobMatchSession;
service.confirmFilters(sessionId: string, expectation: JobExpectationSnapshot, guard: JobMatchMutationGuard): Promise<JobMatchAggregate>;
service.pause(sessionId: string, guard: JobMatchMutationGuard): Promise<JobMatchAggregate>;
service.resume(sessionId: string, guard: JobMatchMutationGuard): Promise<JobMatchAggregate>;
service.continueExtraction(sessionId: string, guard: JobMatchMutationGuard): Promise<JobMatchAggregate>;
service.rematch(sessionId: string, guard: JobMatchMutationGuard): Promise<JobMatchAggregate>;
service.select(sessionId: string, input: JobSelectionInput): StoredJobMatchSession;
service.selectConflict(sessionId: string, input: ConflictJobSelectionInput): StoredJobMatchSession;
service.convert(sessionId: string, input: JobSelectionInput | ConflictJobSelectionInput): Promise<StoredApplicationTask>;

// apps/api/src/conversations/conversation-repository.ts
repository.appendTurn(input: {
  conversationId: string;
  requestId: string;
  inputText: string;
  userMessage: ConversationMessage;
  assistantMessage: ConversationMessage;
  expectedSequence: number;
  expectedContextVersion: number;
  context: ConversationContext;
  response: ConversationTurnResponse;
}): ConversationTurnRecord;

// apps/api/src/conversations/conversation-events.ts
processEvents.emit(input: ConversationProcessEventInput): ConversationProcessEvent;
processEvents.replay(conversationId: string, afterId?: string): ConversationProcessEventReplay;
processEvents.subscribe(conversationId: string, listener: (event: ConversationProcessEvent) => void): () => void;

// apps/web/src/job-matching/api.ts
createJobMatchApi(baseUrl?: string): JobMatchApi;
useJobMatchSession(sessionId: string, api: JobMatchApi, options?: { intervalMs?: number }): JobMatchSessionHook;
```

### Task 1: 扩展对话岗位匹配契约

**Files:**
- Modify: `packages/contracts/src/conversation.ts`
- Test: `packages/contracts/src/conversation.test.ts` 或现有 conversation schema 测试文件
- Verify: `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: 现有 `ConversationCardSchema`、`ConversationContextSchema`、`ConversationProcessEventSchema`、`ConversationTurnResponseSchema`。
- Produces: 严格的 `ConversationJobMatchActionSchema`、`ConversationJobMatchActionResultSchema` 及其推导类型；后续 API/服务只接受这些类型。

- [ ] **Step 1: 写失败测试，锁定允许动作、必需引用和拒绝文案重建 ID。**

```ts
it("accepts only guarded inline job-match actions", () => {
  expect(ConversationJobMatchActionSchema.parse({
    conversationId: "00000000-0000-4000-8000-000000000001",
    sessionId: "00000000-0000-4000-8000-000000000002",
    action: "select_result",
    sessionVersion: 3,
    idempotencyKey: "select-1",
    resultId: "00000000-0000-4000-8000-000000000003",
    resultVersion: 1,
    postingContentHash: "sha256:posting"
  }).action).toBe("select_result");
  expect(() => ConversationJobMatchActionSchema.parse({
    conversationId: "00000000-0000-4000-8000-000000000001",
    sessionId: "00000000-0000-4000-8000-000000000002",
    action: "select_result",
    sessionVersion: 3,
    idempotencyKey: "select-2",
    resultId: "岗位标题"
  })).toThrow();
  expect(() => ConversationJobMatchActionSchema.parse({
    conversationId: "00000000-0000-4000-8000-000000000001",
    sessionId: "00000000-0000-4000-8000-000000000002",
    action: "unknown_action",
    sessionVersion: 0,
    idempotencyKey: "x"
  })).toThrow();
});

it("requires a conflict hash only for conflict selection", () => {
  expect(() => ConversationJobMatchActionSchema.parse({
    conversationId: "00000000-0000-4000-8000-000000000001",
    sessionId: "00000000-0000-4000-8000-000000000002",
    action: "select_conflict_result",
    sessionVersion: 3,
    idempotencyKey: "conflict-1",
    resultId: "00000000-0000-4000-8000-000000000003",
    resultVersion: 1,
    postingContentHash: "sha256:posting"
  })).toThrow();
});
```

- [ ] **Step 2: 运行契约测试确认失败。**

Run: `rtk pnpm --filter @resume/contracts test -- conversation.test.ts`

Expected: FAIL because `ConversationJobMatchActionSchema` is not exported yet.

- [ ] **Step 3: 写最小契约实现。**

在 `conversation.ts` 增加以下精确结构，并导出推导类型：动作枚举为 `confirm_filters`、`adjust_filters`、`pause`、`continue`、`rematch`、`select_result`、`select_conflict_result`；所有动作要求 `conversationId`、`sessionId`、`sessionVersion`、`idempotencyKey`；选岗动作额外要求 `resultId`、`resultVersion`、`postingContentHash`，冲突选岗额外要求 `conflictSummaryHash`；`adjust_filters` 额外要求非空 `expectation`；对象使用 `.strict()`，ID 使用现有 `IdentifierSchema`，版本为非负安全整数，幂等键和 hash 有长度上限。动作结果使用 `{ sessionId, state, version, turnSequence, message, cards, context }`，并允许 `applicationTaskId`，但不新增企业招聘状态字段。

- [ ] **Step 4: 运行契约测试和类型检查确认通过。**

Run: `rtk pnpm --filter @resume/contracts test -- conversation.test.ts`

Expected: PASS with all new validation cases green.

Run: `rtk pnpm --filter @resume/contracts typecheck`

Expected: PASS.

- [ ] **Step 5: 提交 Task 1。**

```bash
rtk git add packages/contracts/src/conversation.ts packages/contracts/src/conversation.test.ts packages/contracts/src/index.ts
rtk git commit -m "feat: define inline job matching actions"
```

### Task 2: 建立岗位匹配会话与对话归属

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/db/migrate.ts`
- Modify: `apps/api/src/conversations/conversation-repository.ts`
- Test: `apps/api/src/conversations/conversation-repository.test.ts`
- Test: `apps/api/src/db/migrate.test.ts`

**Interfaces:**
- Consumes: `conversation_sessions`、`conversation_messages`、`conversation_contexts`、`job_match_sessions` 的现有表和 repository；`conversation_process_events` 继续由现有事件总线维护。
- Produces: `conversation_job_match_sessions` 关联表，以及 `linkJobMatchSession`、`getJobMatchSessionLink`、`findConversationByJobMatchSession`、`unlinkJobMatchSession`；关联由 `(conversationId, sessionId)` 唯一约束保护，删除任一会话不会删除另一领域记录。

- [ ] **Step 1: 写失败测试，覆盖创建、查询、跨会话拒绝前置数据和删除行为。**

```ts
it("links a job-match session to exactly one conversation and survives job deletion", () => {
  const first = repository.createConversation();
  const second = repository.createConversation();
  repository.linkJobMatchSession(first.id, "match-1");
  expect(repository.getJobMatchSessionLink("match-1")).toEqual({ conversationId: first.id, sessionId: "match-1" });
  expect(repository.findConversationByJobMatchSession("match-1")?.id).toBe(first.id);
  expect(() => repository.linkJobMatchSession(second.id, "match-1")).toThrow("conversation_job_match_link_conflict");
  database.prepare("DELETE FROM job_match_sessions WHERE id = ?").run("match-1");
  expect(repository.findConversationByJobMatchSession("match-1")).toBeUndefined();
  expect(repository.getConversation(first.id)).toBeDefined();
});

it("removes links when the conversation is deleted", () => {
  const conversation = repository.createConversation();
  repository.linkJobMatchSession(conversation.id, "match-2");
  database.prepare("DELETE FROM conversation_sessions WHERE id = ?").run(conversation.id);
  expect(repository.getJobMatchSessionLink("match-2")).toBeUndefined();
});
```

- [ ] **Step 2: 运行迁移和 repository 测试确认失败。**

Run: `rtk pnpm --filter @resume/api test -- conversation-repository.test.ts migrate.test.ts`

Expected: FAIL because the link table and repository methods do not exist.

- [ ] **Step 3: 写最小迁移和 repository 实现。**

新增 `conversation_job_match_sessions`：`conversation_id TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE`、`job_match_session_id TEXT NOT NULL REFERENCES job_match_sessions(id) ON DELETE CASCADE`、`created_at TEXT NOT NULL`，以 `job_match_session_id` 为主键并为 `conversation_id` 建索引。注意现有测试需先插入真实 `job_match_sessions` 行再建立关联；禁止用外键关闭来绕过一致性。repository 方法必须检查输入非空、捕获唯一冲突并映射为 `conversation_job_match_link_conflict`，查询返回严格的 `{ conversationId, sessionId }`。

- [ ] **Step 4: 运行测试、迁移测试和类型检查确认通过。**

Run: `rtk pnpm --filter @resume/api test -- conversation-repository.test.ts migrate.test.ts`

Expected: PASS; foreign key cascade tests pass in both directions.

Run: `rtk pnpm --filter @resume/api typecheck`

Expected: PASS.

- [ ] **Step 5: 提交 Task 2。**

```bash
rtk git add apps/api/src/db/schema.ts apps/api/src/db/migrate.ts apps/api/src/conversations/conversation-repository.ts apps/api/src/conversations/conversation-repository.test.ts apps/api/src/db/migrate.test.ts
rtk git commit -m "feat: link job match sessions to conversations"
```

### Task 3: 实现对话岗位匹配动作服务与 API

**Files:**
- Create: `apps/api/src/conversations/conversation-job-match-service.ts`
- Create: `apps/api/src/conversations/conversation-job-match-service.test.ts`
- Create: `apps/api/src/conversations/conversation-job-match-routes.ts`
- Create: `apps/api/src/conversations/conversation-job-match-routes.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/conversations/conversation-repository.ts`

**Interfaces:**
- Consumes: Task 1 的 `ConversationJobMatchActionSchema`；Task 2 的归属查询；`JobMatchService` 的现有方法；`ConversationRepository` 的 `getContext`、`appendTurn`、`getTurn`。
- Produces: `createConversationJobMatchService({ conversations, jobMatches, now? })`；`execute(conversationId, input): Promise<ConversationJobMatchActionResult>`；`findOwningConversation(sessionId): Promise<{ conversationId: string } | undefined>`；Fastify `POST /api/conversations/:conversationId/job-match-actions` 和 `GET /api/job-match-sessions/:sessionId/conversation`，请求体为契约动作，返回契约动作结果或所属对话引用。Task 3 先完成动作校验、领域分派、回合持久化和结果组装；Task 4 在同一 `execute` 内接入流程事件，不新增第二个动作执行方法。

- [ ] **Step 1: 写失败测试，覆盖归属、动作分派、版本/幂等和错误映射。**

测试文件顶部建立 `createConversationJobMatchTestContext()` fixture，返回两个真实的 conversation/session 记录、`service`、带有各领域方法 spy 的 `jobMatches` 和 repository mock；所有动作 fixture 都使用真实 UUID、当前 `version` 以及真实 `resultId`，不要在测试中通过岗位标题临时生成 ID。

```ts
it("dispatches confirm_filters only to the linked session", async () => {
  const validConfirmFiltersAction = {
    conversationId: conversation.id,
    sessionId: match.id,
    action: "confirm_filters" as const,
    sessionVersion: match.version,
    idempotencyKey: "confirm-filters-1",
    expectation: match.expectation
  };
  await service.execute(conversation.id, validConfirmFiltersAction);
  expect(jobMatches.confirmFilters).toHaveBeenCalledWith(match.id, match.expectation, {
    sessionVersion: match.version,
    idempotencyKey: "confirm-filters-1"
  });
});

it("rejects a session linked to another conversation before invoking the domain service", async () => {
  const validSelectAction = {
    conversationId: otherConversation.id,
    sessionId: match.id,
    action: "select_result" as const,
    sessionVersion: match.version,
    idempotencyKey: "select-1",
    resultId: "result-1",
    resultVersion: 1,
    postingContentHash: "sha256:posting"
  };
  await expect(service.execute(otherConversation.id, validSelectAction)).rejects.toThrow("conversation_job_match_not_owned");
  expect(jobMatches.select).not.toHaveBeenCalled();
});

it("replays the same idempotency key and rejects a changed payload", async () => {
  const validPauseAction = {
    conversationId: conversation.id,
    sessionId: match.id,
    action: "pause" as const,
    sessionVersion: match.version,
    idempotencyKey: "pause-1"
  };
  const first = await service.execute(conversation.id, validPauseAction);
  const replay = await service.execute(conversation.id, validPauseAction);
  expect(replay).toEqual(first);
  await expect(service.execute(conversation.id, { ...validPauseAction, sessionVersion: 9 })).rejects.toThrow("conversation_idempotency_conflict");
});
```

- [ ] **Step 2: 运行服务测试确认失败。**

Run: `rtk pnpm --filter @resume/api test -- conversation-job-match-service.test.ts conversation-job-match-routes.test.ts`

Expected: FAIL because the service, route and method do not exist.

- [ ] **Step 3: 写最小服务实现和路由。**

服务先解析动作，再验证 conversation 存在、session 存在且归属当前 conversation；对每个动作只调用对应现有方法：`confirm_filters -> confirmFilters`、`adjust_filters -> confirmFilters`、`pause -> pause`、`continue -> continueExtraction`、`rematch -> rematch`、`select_result -> select`、`select_conflict_result -> selectConflict`。将 `sessionVersion` 和 `idempotencyKey` 映射为 `JobMatchMutationGuard`，将选择字段原样映射为领域输入，禁止从岗位名称生成 ID。使用现有 `conversation_turns` 的 `(conversationId, requestId)` 幂等记录做重放和 payload 冲突判断；成功后读取最新 session，返回脱敏消息、轻量 `job_match_session`/`recommendation` card 和 context 更新。路由复用现有 `sendError`，对 ownership/version/stale/invalid action 映射为 400/403/409，不回传原始异常。`processEvents` 不在本 Task 的依赖中伪造注入，待 Task 4 接入真实 trace。

- [ ] **Step 4: 运行 API 测试和类型检查确认通过。**

Run: `rtk pnpm --filter @resume/api test -- conversation-job-match-service.test.ts conversation-job-match-routes.test.ts`

Expected: PASS; every action dispatch, ownership rejection, replay and error mapping is green.

Run: `rtk pnpm --filter @resume/api typecheck`

Expected: PASS.

- [ ] **Step 5: 提交 Task 3。**

```bash
rtk git add apps/api/src/conversations/conversation-job-match-service.ts apps/api/src/conversations/conversation-job-match-service.test.ts apps/api/src/conversations/conversation-job-match-routes.ts apps/api/src/conversations/conversation-job-match-routes.test.ts apps/api/src/conversations/conversation-repository.ts apps/api/src/app.ts
rtk git commit -m "feat: expose inline job match actions"
```

### Task 4: 将岗位动作接入用户轮次和流程点

**Files:**
- Modify: `apps/api/src/conversations/conversation-job-match-service.ts`
- Modify: `apps/api/src/conversations/conversation-job-match-service.test.ts`
- Modify: `apps/api/src/conversations/conversation-service.ts`
- Modify: `apps/api/src/conversations/conversation-graph.ts`
- Modify: `apps/api/src/conversations/conversation-tools.ts`
- Modify: `apps/api/src/conversations/conversation-process-trace.ts`
- Test: `apps/api/src/conversations/conversation-service.test.ts`
- Test: `apps/api/src/conversations/conversation-process-trace.test.ts`
- Test: `apps/api/src/conversations/conversation-graph.test.ts`

**Interfaces:**
- Consumes: Task 3 action service；既有 `ConversationProcessEventBus` 和 `createConversationProcessTrace`；现有 graph tool 的白名单摘要。
- Produces: 在 Task 3 已有 `createConversationJobMatchService` 配置中增加可选的 `processEvents` 注入（未注入时保持无事件的领域服务行为）；每次岗位动作都会先形成一个真实用户轮次，再发布同一 `turnSequence` 下的稳定步骤；动作完成返回助手消息和岗位卡片，等待/失败状态有明确恢复操作。

- [ ] **Step 1: 写失败测试，锁定流程点顺序、同一 stepId 更新、waiting/failed 脱敏和不虚构工具调用。**

复用 Task 3 的 `createConversationJobMatchTestContext`，以 `processEvents` 真实 event bus 创建 `service`，并从 fixture 导出 `validSelectAction`、`validContinueAction`、`conversation`；测试只调用公开的 `service.execute`。

```ts
it("records a job action under one user turn with ordered real stages", async () => {
  const events: ConversationProcessEvent[] = [];
  const result = await service.execute(conversation.id, validSelectAction);
  events.push(...processEvents.replay(conversation.id).events);
  expect(events.map((event) => [event.turnSequence, event.stepId, event.status])).toEqual([
    [3, "understanding-request", "running"],
    [3, "understanding-request", "completed"],
    [3, "validate-selection", "running"],
    [3, "validate-selection", "completed"],
    [3, "persist-selection", "running"],
    [3, "persist-selection", "completed"]
  ]);
  expect(result.cards.some((card) => card.type === "recommendation")).toBe(true);
});

it("uses waiting for login/challenge and never exposes raw tool data", async () => {
  jobMatches.continueExtraction.mockRejectedValue(new Error("browser_challenge_required cookie=secret"));
  await expect(service.execute(conversation.id, validContinueAction)).rejects.toThrow();
  const event = processEvents.replay(conversation.id).events.at(-1)!;
  expect(event.status).toBe("waiting");
  expect(JSON.stringify(event)).not.toContain("cookie=secret");
  expect(JSON.stringify(event)).not.toContain("browser_worker");
});
```

- [ ] **Step 2: 运行对话服务和 trace 测试确认失败。**

Run: `rtk pnpm --filter @resume/api test -- conversation-service.test.ts conversation-process-trace.test.ts conversation-graph.test.ts`

Expected: FAIL because action execution and stage reporting are not wired.

- [ ] **Step 3: 写最小轮次编排实现。**

在 Task 3 的 `execute` 内接收可选的 `ConversationProcessEventBus`，并调用 `createConversationProcessTrace({ conversationId, turnSequence, emit })`；先确定本轮 sequence，再追加/建立用户动作轮次，用领域 service 执行，最后通过既有 `appendTurn` 原子写助手响应、context 和 cards。阶段固定使用白名单：理解请求、应用筛选/验证选择、读取岗位、匹配岗位、保存选择、等待投递确认、完成；调用实际发生时才附带 `tavily_search`、`browser_worker`、`job_matching`、`controlled_application` 摘要。`browser_challenge_required`、登录等待等错误只映射为 waiting；其他异常只映射为大写错误码、中文短摘要和 `retryable`，禁止把异常 message 原样写入事件。保持 `stepId` 稳定并以 running/terminal 两个事件更新，避免轮询时重复追加同一流程点；对外仍只有 `execute`，不引入 `executeAction`。

- [ ] **Step 4: 运行测试、完整 API 回归和类型检查确认通过。**

Run: `rtk pnpm --filter @resume/api test -- conversation-service.test.ts conversation-process-trace.test.ts conversation-graph.test.ts`

Expected: PASS with ordered turn events, waiting/failed redaction and no fabricated tool event.

Run: `rtk pnpm --filter @resume/api test`

Expected: PASS for all API tests.

Run: `rtk pnpm --filter @resume/api typecheck`

Expected: PASS.

- [ ] **Step 5: 提交 Task 4。**

```bash
rtk git add apps/api/src/conversations/conversation-service.ts apps/api/src/conversations/conversation-graph.ts apps/api/src/conversations/conversation-tools.ts apps/api/src/conversations/conversation-process-trace.ts apps/api/src/conversations/conversation-service.test.ts apps/api/src/conversations/conversation-process-trace.test.ts apps/api/src/conversations/conversation-graph.test.ts
rtk git commit -m "feat: trace inline job matching turns"
```

### Task 5: 增加 Web 端岗位会话动作传输和恢复模型

**Files:**
- Modify: `apps/web/src/job-matching/api.ts`
- Modify: `apps/web/src/job-matching/useJobMatchSession.ts`
- Create: `apps/web/src/conversation/conversation-job-match-api.ts`
- Create: `apps/web/src/conversation/conversation-job-match-api.test.ts`
- Test: `apps/web/src/job-matching/useJobMatchSession.test.ts`

**Interfaces:**
- Consumes: Task 1 `ConversationJobMatchAction`；现有 `createJobMatchApi` 和 `useJobMatchSession`；对话 API 的 `send`/`confirm` 约定。
- Produces: `createConversationJobMatchApi(baseUrl?: string)`，其 `execute(input: ConversationJobMatchAction): Promise<ConversationJobMatchActionResult>`；扩展 `JobMatchApi` 增加 `findOwningConversation(sessionId: string): Promise<{ conversationId: string }>`，供旧地址恢复对话使用；`useConversationJobMatchSession` 或扩展后的 hook 支持 action 后立即刷新、断线保留最后状态、刷新恢复真实 session version。

- [ ] **Step 1: 写失败测试，覆盖 optimistic action transport、版本冲突恢复、重复请求和断线状态。**

测试文件顶部定义 `makeValidSelectAction()`，其返回值引用 fixture 中真实的 `conversationId`、`sessionId`、`resultId`、`resultVersion` 和 `postingContentHash`；`jsonResponse`、`fetchMock` 复用 Web 现有 API 测试 helper，409 错误对象按现有客户端错误类型构造。

```ts
const validSelectAction = makeValidSelectAction();

it("posts a typed action and refreshes the real session after success", async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse({ sessionId: "session-1", state: "selected", version: 4, turnSequence: 3, message: assistantMessage, cards: [], context: { version: 2, recentPostingIds: [] } }));
  const api = createConversationJobMatchApi("http://api.test");
  await api.execute(validSelectAction);
  expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/conversations/conversation-1/job-match-actions", expect.objectContaining({ method: "POST" }));
});

it("does not rebuild IDs from labels after a 409", async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse({ error: "conflict", code: "job_match_version_conflict" }, 409));
  await expect(createConversationJobMatchApi().execute(validSelectAction)).rejects.toMatchObject({ code: "job_match_version_conflict" });
  expect(JSON.stringify(fetchMock.mock.calls[0][1])).toContain("result-1");
  expect(JSON.stringify(fetchMock.mock.calls[0][1])).not.toContain("岗位标题");
});
```

- [ ] **Step 2: 运行 Web 测试确认失败。**

Run: `rtk pnpm --filter @resume/web test -- conversation-job-match-api.test.ts useJobMatchSession.test.ts`

Expected: FAIL because the typed action client and refresh behavior do not exist.

- [ ] **Step 3: 写最小客户端和恢复实现。**

复用现有 `request` 错误解析形式，所有请求 body 先用契约 schema 解析；传输层保留真实 `sessionId`、`resultId`、版本号、content hash 和幂等键。动作成功后调用 `jobMatchApi.get(sessionId)` 更新状态；409 时显示“结果已变化，请刷新后重试”，不自动重试旧 action；读取失败保留上一次 session 并提供显式刷新；SSE 断开时继续显示历史流程点并在连接恢复后按 `Last-Event-ID` 重放。不得用 `JobMatchWorkbench` 作为聊天内状态容器。

- [ ] **Step 4: 运行 Web 测试、类型检查和构建确认通过。**

Run: `rtk pnpm --filter @resume/web test -- conversation-job-match-api.test.ts useJobMatchSession.test.ts`

Expected: PASS.

Run: `rtk pnpm --filter @resume/web typecheck`

Expected: PASS.

Run: `rtk pnpm --filter @resume/web build`

Expected: PASS.

- [ ] **Step 5: 提交 Task 5。**

```bash
rtk git add apps/web/src/job-matching/api.ts apps/web/src/job-matching/useJobMatchSession.ts apps/web/src/conversation/conversation-job-match-api.ts apps/web/src/conversation/conversation-job-match-api.test.ts apps/web/src/conversation/conversation-process-events.ts apps/web/src/job-matching/useJobMatchSession.test.ts
rtk git commit -m "feat: transport inline job match actions"
```

### Task 6: 实现对话内流程点、筛选和岗位卡片

**Files:**
- Create: `apps/web/src/conversation/ConversationJobMatchFlow.tsx`
- Create: `apps/web/src/conversation/ConversationJobFilters.tsx`
- Create: `apps/web/src/conversation/ConversationJobCards.tsx`
- Create: `apps/web/src/conversation/ConversationJobMatchFlow.test.tsx`
- Create: `apps/web/src/conversation/ConversationJobFilters.test.tsx`
- Create: `apps/web/src/conversation/ConversationJobCards.test.tsx`
- Modify: `apps/web/src/conversation/conversation-process-model.ts`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Task 5 的 typed action client；`JobMatchSession`；`ConversationProcessEvent` 分组模型；`JobMatchResult`/`JobPosting` 的真实引用。
- Produces: `ConversationJobMatchFlow`、`ConversationJobFilters`、`ConversationJobCards`；组件通过 callback 发出 typed action，不自己修改对话消息、不生成 ID、不执行投递。

- [ ] **Step 1: 写失败组件测试，覆盖状态映射、按钮动作、详情展开和响应式布局语义。**

测试文件顶部定义 `makeJobMatchComponentFixtures()`，返回三个完整的 `JobMatchSession` 投影（`awaitingFilters`、`resultsSession`、`staleSession`）和一组带 `failed` 状态的 `ConversationProcessGroup`（`failedProcess`）；fixture 中的岗位结果必须含真实 `resultId`、版本、内容 hash、冲突摘要和证据字段，`onAction` 使用 `vi.fn()`。

```tsx
const onAction = vi.fn();
const { awaitingFilters, resultsSession, staleSession, failedProcess } = makeJobMatchComponentFixtures();

it("shows filter confirmation and emits a guarded action", async () => {
  render(<ConversationJobMatchFlow session={awaitingFilters} onAction={onAction} process={process} />);
  expect(screen.getByText("目标岗位")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "确认筛选并读取岗位" }));
  expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ action: "confirm_filters", sessionId: awaitingFilters.id, sessionVersion: awaitingFilters.version }));
});

it("renders results as job cards and requires a second confirmation for conflicts", async () => {
  render(<ConversationJobCards session={resultsSession} onAction={onAction} />);
  expect(screen.getByText("Frontend Engineer")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "查看详情" }));
  expect(screen.getByText("匹配依据")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "选择此岗位" }));
  expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ action: "select_result", resultId: "result-1" }));
  await userEvent.click(screen.getByRole("button", { name: "确认选择冲突岗位" }));
  expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ action: "select_conflict_result", conflictSummaryHash: expect.any(String) }));
});

it("keeps the trace outside cards and exposes waiting, failed and stale recovery", () => {
  render(<ConversationJobMatchFlow session={staleSession} process={failedProcess} onAction={onAction} />);
  expect(screen.getByRole("list", { name: "执行过程" })).toBeInTheDocument();
  expect(screen.getByText("结果已变化")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "重新匹配" })).toBeEnabled();
});
```

- [ ] **Step 2: 运行组件测试确认失败。**

Run: `rtk pnpm --filter @resume/web test -- ConversationJobMatchFlow.test.tsx ConversationJobFilters.test.tsx ConversationJobCards.test.tsx`

Expected: FAIL because the new components are absent.

- [ ] **Step 3: 写最小组件实现。**

`ConversationJobMatchFlow` 只渲染流程点和当前会话投影；流程点使用语义 `ol/li`，运行中/完成/等待/失败具有文本状态和 `aria-current`，不使用独立卡片外壳。`ConversationJobFilters` 在 `awaiting_filter_confirmation` 展示目标岗位、地点、用工类型、网站筛选映射和本地判断，确认按钮发出当前 version/幂等键，调整筛选通过对话输入而非内嵌复杂表单。`ConversationJobCards` 以真实 result/posting 引用展示岗位名、公司、地点、来源、分数、置信度、满足/未知/冲突统计、首条证据/差距；详情在同一消息原地展开；普通岗位直接选择，冲突岗位先显示二次确认，stale 禁止选择并提供重匹配，selected 显示已选择并等待受控投递确认。桌面最多两列，390px 单列，复用蓝白对话风格，禁止嵌套卡片和独立滚动容器。

- [ ] **Step 4: 运行组件测试、类型检查和 Web 构建确认通过。**

Run: `rtk pnpm --filter @resume/web test -- ConversationJobMatchFlow.test.tsx ConversationJobFilters.test.tsx ConversationJobCards.test.tsx`

Expected: PASS.

Run: `rtk pnpm --filter @resume/web typecheck`

Expected: PASS.

Run: `rtk pnpm --filter @resume/web build`

Expected: PASS.

- [ ] **Step 5: 提交 Task 6。**

```bash
rtk git add apps/web/src/conversation/ConversationJobMatchFlow.tsx apps/web/src/conversation/ConversationJobFilters.tsx apps/web/src/conversation/ConversationJobCards.tsx apps/web/src/conversation/ConversationJobMatchFlow.test.tsx apps/web/src/conversation/ConversationJobFilters.test.tsx apps/web/src/conversation/ConversationJobCards.test.tsx apps/web/src/conversation/conversation-process-model.ts apps/web/src/styles.css
rtk git commit -m "feat: render inline job match flow and cards"
```

### Task 7: 集成聊天并关闭独立岗位匹配页面

**Files:**
- Modify: `apps/web/src/conversation/ConversationCards.tsx`
- Modify: `apps/web/src/conversation/ChatMessageList.tsx`
- Modify: `apps/web/src/conversation/ChatHome.tsx`
- Modify: `apps/web/src/workspace/ProfileApplicationWorkspace.tsx`
- Modify: `apps/web/src/router.tsx`
- Modify: `apps/web/src/conversation/ConversationCards.test.tsx`
- Modify: `apps/web/src/conversation/ChatHome.test.tsx`
- Modify: `apps/web/src/conversation/ChatHome.integration.test.tsx`
- Modify: `apps/web/src/router.test.tsx`
- Modify: `apps/web/src/workspace/ProfileApplicationWorkspace.test.tsx`
- Delete after the zero-reference check: `apps/web/src/job-matching/JobMatchWorkbench.tsx`
- Modify or delete after the zero-reference check: `apps/web/src/job-matching/JobMatchWorkbench.test.tsx`
- Modify: `tests/browser/job-matching.spec.ts`

**Interfaces:**
- Consumes: Task 2 的 session-to-conversation lookup；Task 5/6 的 typed action transport and inline components；existing `ChatHome` process event grouping；application task deep link remains unchanged。
- Produces: ChatHome 内完成“招聘入口确认 -> 岗位推荐确认 -> 读取/匹配 -> 岗位卡片 -> 选择岗位 -> 受控投递确认”；`/job-match-sessions/:sessionId` 只跳转所属 conversation，无法恢复时显示明确错误，不回退旧 workbench。

- [ ] **Step 1: 写失败回归测试，锁定无独立入口、无“打开岗位匹配”按钮、旧地址回对话和双轮次流程。**

```tsx
it("renders the job-match session inline without an open-workbench button", async () => {
  render(<ChatHome api={api(view([jobMatchSessionCard]))} onOpenApplication={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "打开岗位匹配" })).not.toBeInTheDocument();
  expect(screen.getByRole("list", { name: "执行过程" })).toBeInTheDocument();
  expect(screen.getByText("等待确认筛选条件")).toBeInTheDocument();
});

it("redirects a legacy job-match URL to its owning conversation", async () => {
  window.history.pushState({}, "", "/job-match-sessions/match-1");
  const applicationApi = { list: vi.fn(), create: vi.fn(), get: vi.fn(), command: vi.fn(), recover: vi.fn() };
  const jobMatchApi = { findOwningConversation: vi.fn().mockResolvedValue({ conversationId: "conversation-1" }) } as never;
  render(<AppRouter applicationApi={applicationApi} jobMatchApi={jobMatchApi} conversationApi={conversationApi()} />);
  await waitFor(() => expect(window.location.pathname).toBe("/"));
  expect(new URL(window.location.href).searchParams.get("conversation")).toBe("conversation-1");
  expect(screen.queryByText("岗位匹配工作台")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: 运行聊天、路由和工作区测试确认失败。**

Run: `rtk pnpm --filter @resume/web test -- ConversationCards.test.tsx ChatHome.test.tsx ChatHome.integration.test.tsx router.test.tsx ProfileApplicationWorkspace.test.tsx`

Expected: FAIL because current props and legacy route still open `JobMatchWorkbench`.

- [ ] **Step 3: 写最小集成实现。**

移除 `JobMatchSessionCard` 的“打开岗位匹配”按钮，改为在对应 assistant message 下渲染 `ConversationJobMatchFlow`；从 `ChatHome`、`ChatMessageList`、`ProfileApplicationWorkspace` 删除 `onOpenJobMatch` callback 和导航分支，保留应用任务链接。每个 card action 先插入乐观 user message，再调用 Task 5 action API；服务端返回的 user/assistant turn 与 process SSE 去重按真实 sequence/event id 合并。将旧 `/job-match-sessions/:sessionId` 改为调用 Task 5 扩展后的 `jobMatchApi.findOwningConversation`（其内部请求 Task 3 的 `GET /api/job-match-sessions/:sessionId/conversation`），成功后导航到 `/?conversation=<conversationId>`；查不到归属时导航最近会话并显示“该岗位匹配记录无法在当前对话中恢复”，禁止渲染 `JobMatchWorkbench`。`jobs`、`apply` 等旧 query view 继续规范化为 chat，侧栏不新增岗位推荐页面。删除或修改旧组件前，先用 `rtk rg` 确认 `JobMatchWorkbench` 已无生产代码引用。

- [ ] **Step 4: 运行 Web 回归、类型检查和构建确认通过。**

Run: `rtk pnpm --filter @resume/web test -- ConversationCards.test.tsx ChatHome.test.tsx ChatHome.integration.test.tsx router.test.tsx ProfileApplicationWorkspace.test.tsx`

Expected: PASS; inline actions, legacy redirect, no old button and application navigation all pass.

Run: `rtk pnpm --filter @resume/web typecheck`

Expected: PASS.

Run: `rtk pnpm --filter @resume/web build`

Expected: PASS.

- [ ] **Step 5: 提交 Task 7。**

```bash
rtk git add apps/web/src/conversation/ConversationCards.tsx apps/web/src/conversation/ChatMessageList.tsx apps/web/src/conversation/ChatHome.tsx apps/web/src/workspace/ProfileApplicationWorkspace.tsx apps/web/src/router.tsx apps/web/src/conversation/ConversationCards.test.tsx apps/web/src/conversation/ChatHome.test.tsx apps/web/src/conversation/ChatHome.integration.test.tsx apps/web/src/router.test.tsx apps/web/src/workspace/ProfileApplicationWorkspace.test.tsx
rtk git add apps/web/src/job-matching/JobMatchWorkbench.tsx apps/web/src/job-matching/JobMatchWorkbench.test.tsx tests/browser/job-matching.spec.ts
rtk git commit -m "feat: move job matching into conversation"
```

### Task 8: 跨层回归、视觉验证和中文报告

**Files:**
- Modify: `docs/testing/2026-08-22-chat-first-workspace-regression.md`
- Create: `tests/browser/conversation-job-match-flow.spec.ts`
- Verify: `README.md` (read-only check that existing project screenshots and links remain valid; do not alter unrelated README changes)

**Interfaces:**
- Consumes: Tasks 1-7 的 contracts/API/DB/Web 实现；现有 Playwright 配置和中文回归报告格式。
- Produces: 中文回归报告，明确列出测试命令、结果、5 个失败原因分析（如实际出现）、未实现企业招聘状态跟踪，以及桌面/390px 视觉证据。

- [ ] **Step 1: 写跨层失败验收测试或补齐现有测试场景。**

```ts
test("inline job-match acceptance flow keeps process points and cards in the owning turn", async ({ page }) => {
  await page.goto("http://127.0.0.1:5173/?conversation=conversation-1");
  await expect(page.getByRole("list", { name: "执行过程" })).toBeVisible();
  await expect(page.getByText("岗位匹配")).toBeVisible();
  await expect(page.getByRole("button", { name: "打开岗位匹配" })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
});
```

- [ ] **Step 2: 先运行聚焦回归确认未通过项。**

Run: `rtk pnpm test`

Expected: 在实现完整后为 PASS；若当前环境没有启动 API/Web，记录为环境前置失败，不把服务不可用误判为业务失败。

Run: `rtk pnpm typecheck`

Expected: PASS。

Run: `rtk pnpm build`

Expected: PASS。

- [ ] **Step 3: 启动服务并执行浏览器回归。**

Run: `rtk pnpm services:start`

Expected: API、Web、浏览器 worker 和配置的远程 OCR 服务按现有脚本启动；不得在本 Task 新增企业招聘状态服务。

Run: `rtk pnpm test:e2e`

Expected: PASS；验证 1280px 与 390px，重点检查无水平溢出、流程点与岗位卡片视觉区分、岗位详情原地展开、刷新恢复、旧地址回跳和受控投递确认。

- [ ] **Step 4: 更新中文回归报告。**

把实际结果写入 `docs/testing/2026-08-22-chat-first-workspace-regression.md`，每条包含：场景、命令、通过/失败/跳过、耗时、观察结果、失败原因和恢复路径。失败分析必须以日志/断言为依据，至少区分：环境/服务未启动、Tavily 配置或网络、会话归属/持久化、版本冲突或 stale、UI 路由/缓存；不能凭空归因。

- [ ] **Step 5: 完成 Task 8 自检并提交。**

```bash
rtk git diff --check
rtk git add docs/testing/2026-08-22-chat-first-workspace-regression.md tests/browser/conversation-job-match-flow.spec.ts
rtk git commit -m "test: verify inline job matching conversation flow"
```

## 任务完成后的验收清单

- [ ] 产品内不存在面向用户的独立岗位匹配工作台入口。
- [ ] 招聘入口确认、筛选确认、读取岗位、岗位匹配、选岗和受控投递确认都在所属对话内完成。
- [ ] 每个用户动作都有同一轮次下的真实流程点，长任务更新稳定 `stepId`，登录/挑战/暂停/失败具有恢复路径。
- [ ] 岗位结果使用独立岗位卡片；流程点不使用卡片；岗位详情原地展开，不嵌套卡片、不建立独立滚动容器。
- [ ] 使用真实 session/result/posting ID、版本号、content hash 和幂等键；过期结果禁用，冲突岗位需要二次确认。
- [ ] 受控投递、人工接管、审核和最终提交锁保持原有行为；不会自动最终提交。
- [ ] 刷新、SSE 重连、历史间隙、旧 URL 回跳和无岗位结果均有明确处理。
- [ ] 390px 下无水平溢出、文字遮挡或操作丢失；桌面最多两列。
- [ ] 中文回归报告记录真实命令、结果、耗时和失败原因；本期明确不实现企业招聘状态跟踪。

## 计划自检记录

- **Spec coverage:** 已覆盖设计文档中的对话内实时投影、流程点、岗位卡片、筛选确认、岗位详情、普通/冲突选岗、受控投递确认、刷新/SSE 恢复、旧地址回跳、安全脱敏、响应式布局、现有领域逻辑保留和不实现企业招聘状态跟踪；分别落在 Tasks 1-8 和最终验收清单。
- **Placeholder scan:** 已对本计划执行占位词扫描；正文没有未解析的任务占位、模糊的“稍后补充”步骤或未定义的相邻接口。自检记录中的扫描关键词仅用于记录检查规则，不属于执行步骤。
- **Type consistency:** 前端 action 使用契约的 `sessionId`/`resultId`/`sessionVersion`/`resultVersion`/`postingContentHash`/`conflictSummaryHash`；API 映射到现有 `JobMatchMutationGuard`、`JobSelectionInput`、`ConflictJobSelectionInput`；事件使用现有 `ConversationProcessEventInput` 和 `ConversationProcessTrace`；旧路由仅消费会话归属查询。
- **Code safety:** 本次只新增本计划文档，未修改业务代码；后续执行必须按 Task 顺序、逐 Task 测试和汇报。
