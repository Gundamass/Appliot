# 多会话与历史清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. This project explicitly requires inline execution in the current session and forbids subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在聊天优先工作区中实现服务端管理的多会话、新建与切换、单条删除和清空历史，并采用已确认的 Codex 风格蓝白侧栏交互。

**Architecture:** 共享合约定义会话列表和清空结果，SQLite Repository 负责稳定排序、首次标题事务及精确级联边界，ConversationService 协调 Repository 与执行事件缓存。前端由 `ProfileApplicationWorkspace` 持有会话生命周期，`WorkspaceFrame` 只渲染统一侧栏，`ChatHome` 只加载指定会话并上报忙碌和更新事件。

**Tech Stack:** TypeScript 5.8、React 19、React Router 7、Fastify 5、Zod 3、SQLite/better-sqlite3、Vitest、Testing Library、Playwright 1.53、Lucide React。

## Global Constraints

- 所有 shell 命令必须以 `rtk` 开头。
- 使用当前会话逐 Task 执行，不创建子智能体；实现阶段使用 `superpowers:executing-plans`。
- 每个 Task 严格执行红灯、最小实现、绿灯、任务级回归、提交，并向用户汇报测试命令和结果后才进入下一 Task。
- 工作区已有未提交修改；不得还原它们。编辑重叠文件前先重读当前内容，提交前只暂存本 Task 文件并检查 `rtk git diff --cached --name-only`。
- 新会话标题固定为“新会话”；首次成功用户消息经首尾去空白、连续空白折叠后取前 20 个 Unicode code points，不追加省略号。
- 会话列表以服务端为事实来源；`localStorage` 只保存最近会话编号。
- 删除会话只删除对话消息、上下文、轮次、确认、执行事件和岗位匹配关联，不删除岗位匹配实体、投递任务、审核记录、候选人资料或提交安全状态。
- 保留招聘入口确认、岗位匹配、岗位选择、受控填写、字段回读、登录或验证码人工接管、风险控制和最终提交硬锁。
- 本期不实现企业招聘状态跟踪，不增加相关 API、表或界面。
- 设计依据：`docs/superpowers/specs/2026-09-02-conversation-history-management-design.md`。

---

## File Structure

**Shared contracts**

- Modify: `packages/contracts/src/conversation.ts` — 会话列表和清空结果的运行时合约及类型。
- Create: `packages/contracts/src/conversation-history.test.ts` — 新增合约边界测试。

**API persistence and lifecycle**

- Create: `apps/api/src/conversations/conversation-title.ts` — 唯一的默认标题和首条消息标题规范化规则。
- Create: `apps/api/src/conversations/conversation-title.test.ts` — 中文、英文、Emoji、空白和截断测试。
- Modify: `apps/api/src/conversations/conversation-repository.ts` — 列表、删除、清空、标题原子更新。
- Modify: `apps/api/src/conversations/conversation-repository.test.ts` — 排序、级联边界、清空和幂等标题测试。
- Modify: `apps/api/src/db/migrate.ts` — 旧 `New conversation` 标题回填。
- Modify: `apps/api/src/db/migrate.test.ts` — 旧数据迁移测试。
- Modify: `apps/api/src/conversations/conversation-events.ts` — 清理已删除会话的内存和数据库事件回放状态。
- Modify: `apps/api/src/conversations/conversation-events.test.ts` — 单会话和全量事件清理测试。
- Modify: `apps/api/src/conversations/conversation-service.ts` — 会话生命周期用例。
- Modify: `apps/api/src/conversations/conversation-service.test.ts` — 生命周期协调与错误测试。
- Modify: `apps/api/src/conversations/conversation-routes.ts` — 列表和 DELETE 路由。
- Modify: `apps/api/src/conversations/conversation-routes.test.ts` — HTTP 状态、返回和删除边界测试。
- Modify: `apps/api/src/production-dependencies.ts` — 将同一个执行事件总线注入会话服务。

**Web client and UI**

- Modify: `apps/web/src/conversation/api.ts` — `list`、`delete`、`deleteAll` 客户端方法。
- Modify: `apps/web/src/conversation/api.test.ts` — 请求方法、路径、响应解析和错误测试。
- Create: `apps/web/src/workspace/ConversationNavigation.tsx` — Codex 风格会话树、菜单和确认框。
- Create: `apps/web/src/workspace/ConversationNavigation.test.tsx` — 菜单显隐、键盘和危险操作测试。
- Modify: `apps/web/src/workspace/WorkspaceFrame.tsx` — 接收可选会话导航模型并保持三个一级入口一致。
- Modify: `apps/web/src/styles.css` — 蓝白整行悬停、三个点显隐、菜单、确认框和窄屏布局。
- Create: `apps/web/src/conversation/useConversationHistory.ts` — 列表加载、当前会话选择和生命周期状态机。
- Create: `apps/web/src/conversation/useConversationHistory.test.tsx` — URL 优先级、新建、切换、删除和清空测试。
- Modify: `apps/web/src/workspace/ProfileApplicationWorkspace.tsx` — 统一布局所有权、URL 和 `localStorage` 同步。
- Modify: `apps/web/src/workspace/ProfileApplicationWorkspace.test.tsx` — 三页面共享侧栏和恢复流程测试。
- Modify: `apps/web/src/conversation/ChatHome.tsx` — 只加载指定会话并上报忙碌与成功更新。
- Modify: `apps/web/src/conversation/ChatHome.test.tsx` — 切换隔离、回调和业务回归测试。
- Modify: `apps/web/src/conversation/ChatHome.integration.test.tsx` — 现有岗位卡片和投递确认不回归。

**Browser acceptance**

- Create: `tests/browser/conversation-history.spec.ts` — 桌面、窄屏、悬停、菜单和生命周期验收。

---

### Task 1: Shared Conversation Lifecycle Contracts

**Files:**

- Modify: `packages/contracts/src/conversation.ts`
- Create: `packages/contracts/src/conversation-history.test.ts`

**Interfaces:**

- Produces: `ConversationSessionListSchema` and `ConversationSessionList`.
- Produces: `ConversationHistoryClearResultSchema` and `ConversationHistoryClearResult`.
- Consumes: existing `ConversationSessionSchema`.

- [ ] **Step 1: Write the failing contract tests**

```ts
import { describe, expect, it } from "vitest";
import {
  ConversationHistoryClearResultSchema,
  ConversationSessionListSchema
} from "./conversation.js";

const session = {
  id: "conversation-1",
  title: "新会话",
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z"
};

describe("conversation history contracts", () => {
  it("accepts a bounded conversation summary list", () => {
    expect(ConversationSessionListSchema.parse([session])).toEqual([session]);
    expect(() => ConversationSessionListSchema.parse([{ ...session, extra: true }])).toThrow();
  });

  it("accepts only a non-negative integer clear count", () => {
    expect(ConversationHistoryClearResultSchema.parse({ deletedCount: 2 })).toEqual({ deletedCount: 2 });
    expect(() => ConversationHistoryClearResultSchema.parse({ deletedCount: -1 })).toThrow();
    expect(() => ConversationHistoryClearResultSchema.parse({ deletedCount: 1, extra: true })).toThrow();
  });
});
```

- [ ] **Step 2: Run the focused test and verify red**

Run: `rtk corepack pnpm --filter @resume/contracts test -- src/conversation-history.test.ts`

Expected: FAIL because both schemas are not exported.

- [ ] **Step 3: Add the schemas and inferred types**

Append after `ConversationSessionSchema` and in the type export block:

```ts
export const ConversationSessionListSchema = z.array(ConversationSessionSchema).max(10_000);

export const ConversationHistoryClearResultSchema = z.object({
  deletedCount: z.number().int().nonnegative()
}).strict();

export type ConversationSessionList = z.infer<typeof ConversationSessionListSchema>;
export type ConversationHistoryClearResult = z.infer<typeof ConversationHistoryClearResultSchema>;
```

- [ ] **Step 4: Run focused and package tests**

Run: `rtk corepack pnpm --filter @resume/contracts test -- src/conversation-history.test.ts`

Expected: PASS, 2 tests.

Run: `rtk corepack pnpm --filter @resume/contracts test`

Expected: PASS, no contract regressions.

- [ ] **Step 5: Commit only Task 1 files and report**

```powershell
rtk git add -- packages/contracts/src/conversation.ts packages/contracts/src/conversation-history.test.ts
rtk git diff --cached --name-only
rtk git commit -m "feat: add conversation history contracts"
```

Report the two test commands, passed test counts, commit hash, and any pre-existing changes left unstaged.

---

### Task 2: Conversation Repository, Titles, and Deletion Boundaries

**Files:**

- Create: `apps/api/src/conversations/conversation-title.ts`
- Create: `apps/api/src/conversations/conversation-title.test.ts`
- Modify: `apps/api/src/conversations/conversation-repository.ts`
- Modify: `apps/api/src/conversations/conversation-repository.test.ts`
- Modify: `apps/api/src/db/migrate.ts`
- Modify: `apps/api/src/db/migrate.test.ts`

**Interfaces:**

- Consumes: `ConversationSessionList` from Task 1.
- Produces: `DEFAULT_CONVERSATION_TITLE`, `LEGACY_CONVERSATION_TITLE`, `conversationTitleFromFirstMessage(text)`.
- Produces Repository methods:

```ts
listConversations(): ConversationSession[];
deleteConversation(id: string): boolean;
deleteAllConversations(): number;
```

- [ ] **Step 1: Write failing title tests**

```ts
import { describe, expect, it } from "vitest";
import { conversationTitleFromFirstMessage } from "./conversation-title.js";

describe("conversation title", () => {
  it.each([
    ["  帮我   投递百度校园招聘  ", "帮我 投递百度校园招聘"],
    ["find   DJI graduate roles", "find DJI graduate ro"],
    ["😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀", "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀"]
  ])("normalizes and truncates %s", (input, expected) => {
    expect(conversationTitleFromFirstMessage(input)).toBe(expected);
  });
});
```

- [ ] **Step 2: Extend repository and migration tests before implementation**

Add tests that prove:

```ts
expect(repository.createConversation().title).toBe("新会话");
expect(repository.listConversations().map(({ id }) => id)).toEqual([newest.id, oldest.id]);
expect(repository.deleteConversation("missing")).toBe(false);
expect(repository.deleteAllConversations()).toBe(2);
```

For the title transaction, use `appendTurn` with a user message containing `"  帮我   投递百度校园招聘  "`, then assert the stored session title is `"帮我 投递百度校园招聘"`. Replay the same request ID and append a second turn; assert the title remains unchanged.

For deletion, insert a `job_match_sessions` row, link it to a conversation, append a message and process event, delete the conversation, then assert:

```ts
expect(repository.getConversation(conversation.id)).toBeUndefined();
expect(database.prepare("SELECT * FROM conversation_messages WHERE session_id = ?").all(conversation.id)).toEqual([]);
expect(database.prepare("SELECT * FROM conversation_process_events WHERE conversation_id = ?").all(conversation.id)).toEqual([]);
expect(database.prepare("SELECT * FROM conversation_job_match_sessions WHERE conversation_id = ?").all(conversation.id)).toEqual([]);
expect(database.prepare("SELECT id FROM job_match_sessions WHERE id = ?").get("match-retained")).toEqual({ id: "match-retained" });
```

In the same database fixture, import `createApplicationTaskRepository`, `createGraphApplicationReviewRepository`, and `createProfileRepository`, then create valid sentinels:

```ts
createApplicationTaskRepository(database).create({
  id: "task-retained",
  applicationUrl: "https://jobs.example.test/apply"
});
createGraphApplicationReviewRepository(database).save({
  id: "review-retained",
  interruptId: "interrupt-retained",
  taskId: "task-retained",
  fieldId: "self-evaluation",
  fieldLabel: "自我评价",
  original: "原始内容",
  draft: "待审核内容",
  reasons: ["投递前需要人工审核"],
  evidence: [{ documentId: "resume-1", page: 1, text: "原始内容", extraction: "pdf_text" }],
  unsupportedClaims: [],
  status: "needs_review"
});
createProfileRepository(database).upsertUserFact({
  fieldPath: "basics.name",
  value: "候选人"
});
```

After deleting the conversation, assert:

```ts
expect(database.prepare("SELECT id FROM application_tasks WHERE id = ?").get("task-retained"))
  .toEqual({ id: "task-retained" });
expect(database.prepare("SELECT id FROM agent_application_reviews WHERE id = ?").get("review-retained"))
  .toEqual({ id: "review-retained" });
expect(database.prepare("SELECT field_path FROM profile_facts WHERE field_path = ?").get("basics.name"))
  .toEqual({ field_path: "basics.name" });
```

Add a migration test that creates an old conversation titled `New conversation`, inserts a first user message, reruns `migrateDatabase`, and expects the backfilled title. Also test an empty old conversation becomes `新会话` and an existing custom title remains unchanged.

- [ ] **Step 3: Run focused tests and verify red**

Run: `rtk corepack pnpm --filter @resume/api test -- src/conversations/conversation-title.test.ts src/conversations/conversation-repository.test.ts src/db/migrate.test.ts`

Expected: FAIL on missing title module, missing Repository methods, old default title, and missing backfill.

- [ ] **Step 4: Implement the single title rule**

Create `conversation-title.ts`:

```ts
export const DEFAULT_CONVERSATION_TITLE = "新会话";
export const LEGACY_CONVERSATION_TITLE = "New conversation";

export function conversationTitleFromFirstMessage(text: string): string {
  const normalized = text.trim().replace(/\s+/gu, " ");
  return Array.from(normalized).slice(0, 20).join("");
}
```

- [ ] **Step 5: Add Repository SQL and transaction behavior**

Add prepared statements:

```ts
const listSessions = database.prepare(`
  SELECT * FROM conversation_sessions
  ORDER BY updated_at DESC, created_at DESC, id DESC
`);
const deleteSession = database.prepare("DELETE FROM conversation_sessions WHERE id = ?");
const countSessions = database.prepare("SELECT COUNT(*) AS count FROM conversation_sessions");
const deleteAllSessions = database.prepare("DELETE FROM conversation_sessions");
const updateDefaultTitle = database.prepare(`
  UPDATE conversation_sessions SET title = ?
  WHERE id = ? AND title IN (?, ?)
`);
```

In `appendTurnTransaction`, retain the validated `SessionRow`, insert both messages and context, then use one timestamp for title, touch, turn and return values:

```ts
const sessionRow = requireSession(findSession.get(input.conversationId) as SessionRow | undefined);
const completedAt = new Date().toISOString();
if (input.expectedSequence === 0) {
  updateDefaultTitle.run(
    conversationTitleFromFirstMessage(input.userMessage.text),
    input.conversationId,
    DEFAULT_CONVERSATION_TITLE,
    LEGACY_CONVERSATION_TITLE
  );
}
touchSession.run(completedAt, input.conversationId);
insertTurn.run(input.conversationId, input.requestId, input.inputText, JSON.stringify(response), completedAt);
return { requestId: input.requestId, inputText: input.inputText, response, createdAt: completedAt };
```

Expose methods in the returned Repository:

```ts
listConversations() {
  return (listSessions.all() as SessionRow[]).map(fromSessionRow);
},
deleteConversation(id) {
  validateConversationId(id);
  return deleteSession.run(id).changes === 1;
},
deleteAllConversations() {
  return database.transaction(() => {
    const count = (countSessions.get() as { count: number }).count;
    deleteAllSessions.run();
    return count;
  })();
},
```

Use the existing bounded conversation ID schema for `validateConversationId`; do not introduce a second ID format.

- [ ] **Step 6: Backfill only legacy placeholder titles**

Import the title helper in `migrate.ts`, call `backfillConversationTitles(database)` after conversation tables are created, and add:

```ts
function backfillConversationTitles(database: SqliteDatabase): void {
  const legacy = database.prepare(`
    SELECT id FROM conversation_sessions WHERE title = ? ORDER BY id
  `).all(LEGACY_CONVERSATION_TITLE) as Array<{ id: string }>;
  const firstUserMessage = database.prepare(`
    SELECT text FROM conversation_messages
    WHERE session_id = ? AND role = 'user'
    ORDER BY sequence ASC LIMIT 1
  `);
  const update = database.prepare("UPDATE conversation_sessions SET title = ? WHERE id = ? AND title = ?");
  const run = database.transaction(() => {
    for (const { id } of legacy) {
      const row = firstUserMessage.get(id) as { text: string } | undefined;
      const title = row === undefined ? DEFAULT_CONVERSATION_TITLE : conversationTitleFromFirstMessage(row.text);
      update.run(title, id, LEGACY_CONVERSATION_TITLE);
    }
  });
  run();
}
```

- [ ] **Step 7: Run focused and API package tests**

Run: `rtk corepack pnpm --filter @resume/api test -- src/conversations/conversation-title.test.ts src/conversations/conversation-repository.test.ts src/db/migrate.test.ts`

Expected: PASS for normalization, stable ordering, atomic title, migration, deletion and retained job-match entity.

Run: `rtk corepack pnpm --filter @resume/api test`

Expected: PASS with no persistence regression.

- [ ] **Step 8: Commit only Task 2 files and report**

```powershell
rtk git add -- apps/api/src/conversations/conversation-title.ts apps/api/src/conversations/conversation-title.test.ts apps/api/src/conversations/conversation-repository.ts apps/api/src/conversations/conversation-repository.test.ts apps/api/src/db/migrate.ts apps/api/src/db/migrate.test.ts
rtk git diff --cached --name-only
rtk git commit -m "feat: persist conversation history lifecycle"
```

Report focused and package test results, including explicit confirmation that the retained `job_match_sessions` assertion passed.

---

### Task 3: Conversation Lifecycle Service and HTTP Routes

**Files:**

- Modify: `apps/api/src/conversations/conversation-events.ts`
- Modify: `apps/api/src/conversations/conversation-events.test.ts`
- Modify: `apps/api/src/conversations/conversation-service.ts`
- Modify: `apps/api/src/conversations/conversation-service.test.ts`
- Modify: `apps/api/src/conversations/conversation-routes.ts`
- Modify: `apps/api/src/conversations/conversation-routes.test.ts`
- Modify: `apps/api/src/production-dependencies.ts`

**Interfaces:**

- Consumes Repository lifecycle methods from Task 2.
- Extends `ConversationProcessEventBus` with `clearConversation(conversationId): void` and `clearAll(): void`.
- Extends `ConversationService` with:

```ts
list(): ConversationSession[];
delete(conversationId: string): void;
deleteAll(): ConversationHistoryClearResult;
```

- Produces HTTP `GET /api/conversations`, `DELETE /api/conversations/:id`, and `DELETE /api/conversations`.

- [ ] **Step 1: Write failing event cleanup tests**

Add one in-memory and one SQLite-backed case:

```ts
const bus = createConversationProcessEventBus();
bus.emit(eventInput("conversation-a"));
bus.emit(eventInput("conversation-b"));
bus.clearConversation("conversation-a");
expect(bus.replay("conversation-a").events).toEqual([]);
expect(bus.replay("conversation-b").events).toHaveLength(1);
bus.clearAll();
expect(bus.replay("conversation-b").events).toEqual([]);
```

For SQLite, emit an event and cursor, call `clearConversation`, then assert both `conversation_process_events` and `conversation_process_event_cursors` rows are absent.

- [ ] **Step 2: Write failing service and route tests**

Service tests must assert:

```ts
expect(service.list()).toEqual(repository.listConversations());
expect(() => service.delete("missing")).toThrow("conversation_not_found");
expect(service.deleteAll()).toEqual({ deletedCount: 2 });
expect(processEvents.clearConversation).toHaveBeenCalledWith("conversation-1");
expect(processEvents.clearAll).toHaveBeenCalledOnce();
```

Route tests must request all three endpoints and assert:

```ts
expect(list.statusCode).toBe(200);
expect(list.json()).toEqual([service.session]);
expect(deleted.statusCode).toBe(204);
expect(cleared.json()).toEqual({ deletedCount: 2 });
```

Add a missing single-delete case expecting `404` and `conversation_not_found`, plus repeated clear expecting `200` with `{ deletedCount: 0 }`. Update `fakeService()` with typed `list`, `delete`, and `deleteAll` mocks.

- [ ] **Step 3: Run focused tests and verify red**

Run: `rtk corepack pnpm --filter @resume/api test -- src/conversations/conversation-events.test.ts src/conversations/conversation-service.test.ts src/conversations/conversation-routes.test.ts`

Expected: FAIL because lifecycle methods and routes do not exist.

- [ ] **Step 4: Implement event cache cleanup**

Add prepared deletion statements and interface methods:

```ts
clearConversation(conversationId: string): void;
clearAll(): void;
```

Implementation:

```ts
const deleteConversationEvents = database?.prepare("DELETE FROM conversation_process_events WHERE conversation_id = ?");
const deleteConversationCursor = database?.prepare("DELETE FROM conversation_process_event_cursors WHERE conversation_id = ?");

const clearConversation = (conversationId: string): void => {
  memoryEvents.delete(conversationId);
  memoryDiscardedThrough.delete(conversationId);
  subscribers.delete(conversationId);
  deleteConversationEvents?.run(conversationId);
  deleteConversationCursor?.run(conversationId);
};

// Returned object
clearConversation,
clearAll() {
  memoryEvents.clear();
  memoryDiscardedThrough.clear();
  subscribers.clear();
  database?.prepare("DELETE FROM conversation_process_events").run();
  database?.prepare("DELETE FROM conversation_process_event_cursors").run();
}
```

- [ ] **Step 5: Implement service lifecycle coordination**

Extend dependencies and service:

```ts
export interface ConversationServiceDependencies {
  repository: ConversationRepository;
  graph: ConversationGraph;
  processEvents?: Pick<ConversationProcessEventBus, "clearConversation" | "clearAll">;
  now?: () => Date;
}

list() {
  return ConversationSessionListSchema.parse(dependencies.repository.listConversations());
},
delete(conversationId) {
  const id = requireConversationId(conversationId);
  if (!dependencies.repository.deleteConversation(id)) throw new Error("conversation_not_found");
  dependencies.processEvents?.clearConversation(id);
},
deleteAll() {
  const deletedCount = dependencies.repository.deleteAllConversations();
  dependencies.processEvents?.clearAll();
  return ConversationHistoryClearResultSchema.parse({ deletedCount });
},
```

Inject `conversationProcessEvents` into `createConversationService` in `production-dependencies.ts`:

```ts
const conversationService = createConversationService({
  repository: conversationRepository,
  graph: conversationGraph,
  processEvents: conversationProcessEvents
});
```

- [ ] **Step 6: Add the HTTP routes**

Register the static collection routes before the parameterized route:

```ts
app.get("/api/conversations", async (_request, reply) =>
  execute(reply, 200, () => ConversationSessionListSchema.parse(dependencies.service.list()))
);

app.delete("/api/conversations", async (_request, reply) =>
  execute(reply, 200, () => ConversationHistoryClearResultSchema.parse(dependencies.service.deleteAll()))
);

app.delete("/api/conversations/:id", async (request, reply) => {
  const params = ConversationParamsSchema.safeParse(request.params);
  if (!params.success) return invalid(reply, "invalid_conversation_id");
  try {
    dependencies.service.delete(params.data.id);
    return reply.code(204).send();
  } catch (error) {
    const mapped = mapConversationError(error);
    return sendError(reply, mapped.statusCode, mapped.error, mapped.code);
  }
});
```

- [ ] **Step 7: Run focused and API package tests**

Run: `rtk corepack pnpm --filter @resume/api test -- src/conversations/conversation-events.test.ts src/conversations/conversation-service.test.ts src/conversations/conversation-routes.test.ts`

Expected: PASS for event cleanup, service lifecycle and all route statuses.

Run: `rtk corepack pnpm --filter @resume/api test`

Expected: PASS; existing search, confirmation, matching and controlled application tests remain green.

- [ ] **Step 8: Commit only Task 3 files and report**

```powershell
rtk git add -- apps/api/src/conversations/conversation-events.ts apps/api/src/conversations/conversation-events.test.ts apps/api/src/conversations/conversation-service.ts apps/api/src/conversations/conversation-service.test.ts apps/api/src/conversations/conversation-routes.ts apps/api/src/conversations/conversation-routes.test.ts apps/api/src/production-dependencies.ts
rtk git diff --cached --name-only
rtk git commit -m "feat: expose conversation lifecycle api"
```

Report focused and API package test counts and explicitly state whether controlled-application regressions remained green.

---

### Task 4: Web Conversation Lifecycle Client

**Files:**

- Modify: `apps/web/src/conversation/api.ts`
- Modify: `apps/web/src/conversation/api.test.ts`

**Interfaces:**

- Consumes Task 1 schemas.
- Produces `ConversationApi.list`, `ConversationApi.delete`, and `ConversationApi.deleteAll` with the same signatures defined in the design.

- [ ] **Step 1: Write failing request tests**

```ts
it("lists and deletes server-managed conversations", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(response([session]))
    .mockResolvedValueOnce(new Response(undefined, { status: 204 }))
    .mockResolvedValueOnce(response({ deletedCount: 1 }));
  vi.stubGlobal("fetch", fetchMock);
  const api = createConversationApi("/gateway");

  await expect(api.list()).resolves.toEqual([session]);
  await expect(api.delete("conversation/1")).resolves.toBeUndefined();
  await expect(api.deleteAll()).resolves.toEqual({ deletedCount: 1 });
  expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
    ["/gateway/api/conversations", "GET"],
    ["/gateway/api/conversations/conversation%2F1", "DELETE"],
    ["/gateway/api/conversations", "DELETE"]
  ]);
});
```

Add invalid-list and invalid-clear payload tests expecting Zod rejection, and a failed delete test expecting `ConversationApiError` with the bounded server code.

- [ ] **Step 2: Run focused tests and verify red**

Run: `rtk corepack pnpm --filter @resume/web test -- src/conversation/api.test.ts`

Expected: FAIL because the three client methods are absent.

- [ ] **Step 3: Implement client methods**

Extend imports and interface:

```ts
import {
  ConversationHistoryClearResultSchema,
  ConversationSessionListSchema,
  type ConversationHistoryClearResult
} from "@resume/contracts";

export interface ConversationApi {
  list(): Promise<ConversationSession[]>;
  create(): Promise<ConversationSession>;
  get(id: string): Promise<ConversationView>;
  delete(id: string): Promise<void>;
  deleteAll(): Promise<ConversationHistoryClearResult>;
  send(id: string, text: string): Promise<ConversationTurnResponse>;
  confirm(id: string, confirmationId: string, approved: boolean, selectedUrl?: string): Promise<ConversationTurnResponse>;
}
```

Add implementation:

```ts
list: async () => ConversationSessionListSchema.parse(
  await request(`${baseUrl}/api/conversations`, { method: "GET" })
),
delete: async (id) => {
  await request(path(id), { method: "DELETE" });
},
deleteAll: async () => ConversationHistoryClearResultSchema.parse(
  await request(`${baseUrl}/api/conversations`, { method: "DELETE" })
),
```

- [ ] **Step 4: Run focused and web package tests**

Run: `rtk corepack pnpm --filter @resume/web test -- src/conversation/api.test.ts`

Expected: PASS.

Run: `rtk corepack pnpm --filter @resume/web test`

Expected: PASS after updating typed test doubles in existing tests with `list`, `delete`, and `deleteAll` mocks returning valid values.

- [ ] **Step 5: Commit only Task 4 files and report**

```powershell
rtk git add -- apps/web/src/conversation/api.ts apps/web/src/conversation/api.test.ts apps/web/src/conversation/ChatHome.test.tsx apps/web/src/conversation/ChatHome.integration.test.tsx apps/web/src/workspace/ProfileApplicationWorkspace.test.tsx apps/web/src/router.test.tsx
rtk git diff --cached --name-only
rtk git commit -m "feat: add conversation lifecycle client"
```

Only stage test-double files that actually required the new interface methods. Report focused and web package test results.

---

### Task 5: Codex-Style Conversation Navigation

**Files:**

- Create: `apps/web/src/workspace/ConversationNavigation.tsx`
- Create: `apps/web/src/workspace/ConversationNavigation.test.tsx`
- Modify: `apps/web/src/workspace/WorkspaceFrame.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**

- Consumes `ConversationSession[]`.
- Produces:

```ts
export interface ConversationNavigationProps {
  active: boolean;
  sessions: ConversationSession[];
  activeConversationId?: string;
  loading: boolean;
  error?: string;
  busy: boolean;
  creating: boolean;
  deletingConversationId?: string;
  clearing: boolean;
  onOpenChat(): void;
  onCreate(): void;
  onSelect(conversationId: string): void;
  onDelete(conversationId: string): void;
  onDeleteAll(): void;
  onRetry(): void;
}
```

- Extends `WorkspaceFrameProps` with optional `conversationNavigation?: ConversationNavigationProps` so application detail and legacy redirect routes remain compatible.

- [ ] **Step 1: Write failing interaction tests**

Render three sessions and assert:

```ts
expect(screen.getByRole("button", { name: "对话首页" })).toHaveAttribute("aria-expanded", "true");
expect(screen.getByRole("button", { name: "新建会话" })).toBeVisible();
expect(screen.getByText("帮我投递百度校园招聘")).toBeVisible();
```

Then verify:

- top `更多操作` opens a menu containing `清空历史会话`;
- a row `会话操作：帮我投递百度校园招聘` opens a menu containing `删除会话`;
- delete and clear each open a `role="dialog"` with the exact data-retention copy;
- cancel and `Escape` close menus/dialogs;
- current conversation deletion and clear are disabled when `busy=true`;
- selecting a row calls `onSelect(id)` and top title calls `onOpenChat()`;
- loading/error/retry states are bounded inside the list.

- [ ] **Step 2: Run focused test and verify red**

Run: `rtk corepack pnpm --filter @resume/web test -- src/workspace/ConversationNavigation.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the navigation component**

Use Lucide icons (`MessageCircle`, `ChevronUp`, `MoreHorizontal`, `SquarePen`, `Trash2`) and native buttons. Keep local UI state only:

```ts
type PendingConfirmation =
  | { type: "single"; conversationId: string }
  | { type: "all" };

const [expanded, setExpanded] = useState(true);
const [openMenu, setOpenMenu] = useState<"history" | string>();
const [pending, setPending] = useState<PendingConfirmation>();
```

Required structure:

```tsx
<div className="workspace-conversation-home-row" data-active={active || undefined} data-open={openMenu === "history" || undefined}>
  <button type="button" className="workspace-conversation-home" aria-expanded={expanded} onClick={() => {
    onOpenChat();
    setExpanded((value) => !value);
  }}>
    <MessageCircle aria-hidden="true" size={18} />
    <span>对话首页</span>
    <ChevronUp aria-hidden="true" size={16} />
  </button>
  <button type="button" className="workspace-more-button" aria-label="对话首页更多操作" aria-haspopup="menu" aria-expanded={openMenu === "history"}>
    <MoreHorizontal aria-hidden="true" size={18} />
  </button>
</div>
```

Each session row must make the label button the main hit target and keep the action separate:

```tsx
<div className="workspace-session-row" data-active={session.id === activeConversationId || undefined}>
  <button type="button" className="workspace-session-main" onClick={() => onSelect(session.id)}>
    <span className="workspace-session-title">{session.title}</span>
    <time dateTime={session.updatedAt}>{formatConversationTime(session.updatedAt)}</time>
  </button>
  <button type="button" className="workspace-session-more" aria-label={`会话操作：${session.title}`} aria-haspopup="menu">
    <MoreHorizontal aria-hidden="true" size={17} />
  </button>
</div>
```

Render menus as opaque `role="menu"` elements, red only on `role="menuitem"` destructive buttons, and a single `role="dialog" aria-modal="true"` confirmation surface. Add one document-level `keydown` listener while a menu or dialog is open and remove it in effect cleanup.

- [ ] **Step 4: Wire the optional navigation into WorkspaceFrame**

When `conversationNavigation` exists, render `ConversationNavigation` followed by only the `投递进度` and `我的简历` top-level buttons. When absent, retain the existing three-button fallback so application detail and redirect routes compile unchanged.

- [ ] **Step 5: Add the confirmed visual states**

Implement root-scoped CSS with these state rules:

```css
.workspace-conversation-home-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 36px;
  gap: 2px;
  border-radius: 7px;
  background: transparent;
}
.workspace-conversation-home-row[data-active="true"] { background: #eaf3ff; }
.workspace-conversation-home-row:hover,
.workspace-conversation-home-row:focus-within,
.workspace-conversation-home-row[data-open="true"] { background: #dcecff; }
.workspace-conversation-home,
.workspace-more-button { background: transparent; border: 0; color: #718399; }
.workspace-conversation-home-row[data-active="true"] .workspace-conversation-home,
.workspace-conversation-home-row[data-active="true"] .workspace-more-button,
.workspace-conversation-home-row:hover .workspace-conversation-home,
.workspace-conversation-home-row:hover .workspace-more-button { color: #1f67d5; }
.workspace-more-button:hover,
.workspace-more-button:focus-visible,
.workspace-more-button[aria-expanded="true"] { background: #c9ddf7; color: #174f9f; }
.workspace-session-more { opacity: 0; pointer-events: none; }
.workspace-session-row:hover .workspace-session-more,
.workspace-session-row:focus-within .workspace-session-more,
.workspace-session-row[data-active="true"] .workspace-session-more { opacity: 1; pointer-events: auto; }
.workspace-destructive-action { color: #b42318; }
@media (hover: none) { .workspace-session-more { opacity: 1; pointer-events: auto; } }
```

Do not use text glyphs for the three dots. Keep all fixed action controls at stable dimensions; menus must use `position: absolute` relative to their row and remain inside the viewport. At `max-width: 720px`, keep top-level navigation vertical while the conversation list is open, and give interactive controls a minimum 44px touch target.

- [ ] **Step 6: Run focused and web component tests**

Run: `rtk corepack pnpm --filter @resume/web test -- src/workspace/ConversationNavigation.test.tsx`

Expected: PASS for menus, dialog, keyboard and disabled states.

Run: `rtk corepack pnpm --filter @resume/web test -- src/workspace/ProfileApplicationWorkspace.test.tsx src/router.test.tsx`

Expected: PASS; fallback routes and current workspace navigation remain compatible.

- [ ] **Step 7: Commit only Task 5 files and report**

```powershell
rtk git add -- apps/web/src/workspace/ConversationNavigation.tsx apps/web/src/workspace/ConversationNavigation.test.tsx apps/web/src/workspace/WorkspaceFrame.tsx apps/web/src/styles.css
rtk git diff --cached --name-only
rtk git commit -m "feat: add codex style conversation navigation"
```

Report component and compatibility test counts. Mention that pseudo-class appearance will receive real-browser verification in Task 7.

---

### Task 6: Workspace Conversation Controller and Chat Isolation

**Files:**

- Create: `apps/web/src/conversation/useConversationHistory.ts`
- Create: `apps/web/src/conversation/useConversationHistory.test.tsx`
- Modify: `apps/web/src/workspace/ProfileApplicationWorkspace.tsx`
- Modify: `apps/web/src/workspace/ProfileApplicationWorkspace.test.tsx`
- Modify: `apps/web/src/conversation/ChatHome.tsx`
- Modify: `apps/web/src/conversation/ChatHome.test.tsx`
- Modify: `apps/web/src/conversation/ChatHome.integration.test.tsx`

**Interfaces:**

- Consumes Task 4 `ConversationApi` and Task 5 `ConversationNavigationProps`.
- Produces `useConversationHistory` state and actions.
- Changes `ChatHome` to require `conversationId: string` and provide:

```ts
onBusyChange?(busy: boolean): void;
onConversationUpdated?(): void;
```

- [ ] **Step 1: Write failing controller tests**

Create a Testing Library hook probe and cover these exact cases:

1. URL-preferred ID exists: choose it, do not create.
2. URL ID is stale but remembered ID exists: choose remembered ID and canonicalize.
3. Neither preferred ID exists: choose first server-sorted session.
4. Empty list: create exactly one `新会话` and activate it.
5. `createConversation`: prepend and activate returned session.
6. Delete another session: call `api.delete`, remove only that row, active ID unchanged.
7. Delete current: call `api.delete`, clear old active ID, call `api.create`, activate replacement.
8. Clear all: call `api.deleteAll`, then create and activate one replacement.
9. Delete/clear failure: retain list and active ID and expose retryable error.
10. `refresh`: replace list with server response while retaining an active ID that still exists.

- [ ] **Step 2: Update ChatHome tests before implementation**

Replace self-creation expectations with an explicit `conversationId`. Add tests:

```ts
render(<ChatHome api={api} conversationId="conversation-restored" onOpenApplication={vi.fn()} />);
expect(api.get).toHaveBeenCalledWith("conversation-restored");
expect(api.create).not.toHaveBeenCalled();
```

Add `onBusyChange` assertions around an unresolved send promise, an `onConversationUpdated` assertion after successful send/confirm/job-match action, and a rerender from conversation A to B where A's late response must not appear in B.

- [ ] **Step 3: Run focused tests and verify red**

Run: `rtk corepack pnpm --filter @resume/web test -- src/conversation/useConversationHistory.test.tsx src/conversation/ChatHome.test.tsx src/workspace/ProfileApplicationWorkspace.test.tsx`

Expected: FAIL because the controller does not exist and ChatHome still owns creation.

- [ ] **Step 4: Implement the controller hook**

Export:

```ts
export interface ConversationHistoryState {
  sessions: ConversationSession[];
  activeConversationId?: string;
  loading: boolean;
  error?: string;
  busy: boolean;
  creating: boolean;
  deletingConversationId?: string;
  clearing: boolean;
  setBusy(busy: boolean): void;
  refresh(): Promise<void>;
  createConversation(): Promise<void>;
  selectConversation(id: string): void;
  deleteConversation(id: string): Promise<void>;
  clearConversations(): Promise<void>;
  retry(): Promise<void>;
}
```

Hook input:

```ts
export function useConversationHistory(input: {
  api: ConversationApi;
  preferredConversationId?: string;
  fallbackConversationId?: string;
  onActiveConversationChange(id: string | undefined): void;
}): ConversationHistoryState
```

Use one `requestEpoch` ref for list loads and one `mounted` ref. `load()` must parse server order, select `preferred`, then `fallback`, then first item, then create. `deleteConversation` must not mutate local rows until DELETE succeeds. For current deletion and clear, call `onActiveConversationChange(undefined)` before creating the replacement so stale URL/local storage are removed even if replacement creation fails.

- [ ] **Step 5: Make Workspace own the single frame and URL state**

Change URL persistence callback to accept `string | undefined`:

```ts
const setActiveConversation = useCallback((sessionId: string | undefined) => {
  if (sessionId === undefined) window.localStorage.removeItem(recentConversationStorageKey);
  else writeRecentConversationId(sessionId);
  setSearchParams((current) => {
    const next = new URLSearchParams(current);
    if (sessionId === undefined) next.delete(conversationSearchParameter);
    else next.set(conversationSearchParameter, sessionId);
    return next;
  }, { replace: true });
}, [setSearchParams]);
```

Always return one frame:

```tsx
return <WorkspaceFrame
  activeView={view}
  onSelectView={selectView}
  conversationNavigation={{
    active: view === "chat",
    sessions: history.sessions,
    activeConversationId: history.activeConversationId,
    loading: history.loading,
    error: history.error,
    busy: history.busy,
    creating: history.creating,
    deletingConversationId: history.deletingConversationId,
    clearing: history.clearing,
    onOpenChat: () => selectView("chat"),
    onCreate: () => void history.createConversation(),
    onSelect: (id) => { history.selectConversation(id); selectView("chat"); },
    onDelete: (id) => void history.deleteConversation(id),
    onDeleteAll: () => void history.clearConversations(),
    onRetry: () => void history.retry()
  }}
>
  {view === "chat" && history.activeConversationId !== undefined
    ? <ChatHome
        key={history.activeConversationId}
        conversationId={history.activeConversationId}
        api={conversationApi}
        jobMatchApi={jobMatchApi}
        onBusyChange={history.setBusy}
        onConversationUpdated={() => void history.refresh()}
        onOpenApplication={(taskId) => navigate(`/applications/${taskId}`)}
      />
    : renderNonChatView()}
</WorkspaceFrame>;
```

Preserve optional `conversationJobMatchApi`, notice rendering, profile and applications content exactly as today.

- [ ] **Step 6: Remove lifecycle ownership from ChatHome**

Remove `initialSessionId`, `onSessionResolved`, and all `api.create()` fallback logic. Load exactly `conversationId`, reset per-conversation state before each load, and guard late responses:

```ts
const activeConversationId = useRef(conversationId);
useEffect(() => {
  activeConversationId.current = conversationId;
  setSession(undefined);
  setMessages([]);
  setContext({ version: 0, recentPostingIds: [] });
  setPendingConfirmation(undefined);
  setProcessEvents([]);
  setError(undefined);
  let active = true;
  void api.get(conversationId).then((view) => {
    if (!active || activeConversationId.current !== conversationId) return;
    setSession(view.session);
    setMessages(view.messages);
    setContext(view.context);
    setPendingConfirmation(view.pendingConfirmation);
  }).catch((cause) => {
    if (active) setError(toUserError(cause));
  });
  return () => { active = false; };
}, [api, conversationId]);
```

Whenever `sending` changes, call `onBusyChange(sending)` and return cleanup that reports `false`. After each successful send, confirm, or job-match action, call `onConversationUpdated()` only if the response still belongs to the mounted active conversation. Remove the inner `WorkspaceFrame`; return only the existing conversation content.

- [ ] **Step 7: Run focused tests**

Run: `rtk corepack pnpm --filter @resume/web test -- src/conversation/useConversationHistory.test.tsx src/conversation/ChatHome.test.tsx src/workspace/ProfileApplicationWorkspace.test.tsx`

Expected: PASS for selection priority, CRUD lifecycle, busy state, title refresh trigger and late-response isolation.

- [ ] **Step 8: Run conversation and workspace regressions**

Run: `rtk corepack pnpm --filter @resume/web test -- src/conversation/ChatHome.integration.test.tsx src/conversation/ConversationCards.test.tsx src/conversation/ConversationJobMatchFlow.test.tsx src/workspace/ProfileApplicationWorkspace.test.tsx src/router.test.tsx`

Expected: PASS; inline process points, job cards, recruitment confirmations, application navigation and three shared pages remain operational.

- [ ] **Step 9: Commit only Task 6 files and report**

```powershell
rtk git add -- apps/web/src/conversation/useConversationHistory.ts apps/web/src/conversation/useConversationHistory.test.tsx apps/web/src/workspace/ProfileApplicationWorkspace.tsx apps/web/src/workspace/ProfileApplicationWorkspace.test.tsx apps/web/src/conversation/ChatHome.tsx apps/web/src/conversation/ChatHome.test.tsx apps/web/src/conversation/ChatHome.integration.test.tsx
rtk git diff --cached --name-only
rtk git commit -m "feat: manage multiple conversations in workspace"
```

Report focused and regression test results, including delete-current, delete-other, clear-all and stale-response cases.

---

### Task 7: Browser Acceptance and Full Regression

**Files:**

- Create: `tests/browser/conversation-history.spec.ts`
- Modify only if a verified defect is found: files introduced or modified in Tasks 1-6.

**Interfaces:**

- Consumes the completed HTTP and UI behavior from Tasks 1-6.
- Produces desktop and mobile screenshots under ignored `playwright-artifacts/` during test execution.

- [ ] **Step 1: Write the failing browser acceptance spec**

Use the existing Vite-server pattern from `tests/browser/conversation-job-match-flow.spec.ts`. Maintain an in-test `sessions` array and route:

```ts
await page.route("**/api/conversations", async (route) => {
  const method = route.request().method();
  if (method === "GET") return route.fulfill(json(sessions));
  if (method === "POST") {
    const created = makeSession(`conversation-${sessions.length + 1}`, "新会话");
    sessions = [created, ...sessions];
    return route.fulfill(json(created, 201));
  }
  if (method === "DELETE") {
    const deletedCount = sessions.length;
    sessions = [];
    return route.fulfill(json({ deletedCount }));
  }
  return route.continue();
});
```

Add parameterized detail/event routes and single DELETE mutation. Test:

1. Desktop 1280x900 shows `对话首页`, `投递进度`, `我的简历` and ordered sessions.
2. Hovering `.workspace-conversation-home-row` changes its computed `backgroundColor`; its bounding box includes the right edge of the three-dot button.
3. A non-active row's more button is hidden before hover and visible after hover.
4. Top menu contains red `清空历史会话`; row menu contains red `删除会话`; no permanent red control exists in a closed row.
5. Deleting a non-current session leaves URL/current chat unchanged.
6. Deleting current session creates and navigates to `新会话`.
7. Clear all creates exactly one replacement session.
8. Switching to `投递进度` and `我的简历` leaves the same conversation navigation visible.
9. At 390x844 there is no horizontal overflow, menu remains in viewport, and all visible action hit targets are at least 44px high.

Capture:

```ts
await page.screenshot({
  path: "playwright-artifacts/conversation-history-desktop.png",
  fullPage: true
});
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({
  path: "playwright-artifacts/conversation-history-mobile.png",
  fullPage: true
});
```

- [ ] **Step 2: Run the browser spec and verify red or expose integration gaps**

Run: `rtk corepack pnpm test:e2e -- tests/browser/conversation-history.spec.ts`

Expected before final fixes: FAIL on any missing lifecycle wiring or visual state; the failure must identify a concrete selector, state or geometry mismatch.

- [ ] **Step 3: Fix only observed acceptance defects**

For every failure, make the smallest correction in the owning component and add or tighten a corresponding Vitest assertion. Do not broaden the feature or alter controlled application behavior. Re-run the owning Task test before the browser spec.

- [ ] **Step 4: Run browser acceptance and inspect screenshots**

Run: `rtk corepack pnpm test:e2e -- tests/browser/conversation-history.spec.ts`

Expected: PASS. Inspect both PNGs and confirm:

- blue background spans the `对话首页` label and three-dot area;
- no overlap, clipped menu, blank icon box or permanent red row action;
- desktop and mobile text remains readable;
- session list, process points and job cards are visually distinct.

- [ ] **Step 5: Run full verification**

Run: `rtk corepack pnpm test`

Expected: PASS across all workspace packages.

Run: `rtk corepack pnpm typecheck`

Expected: PASS with no TypeScript errors.

Run: `rtk corepack pnpm build`

Expected: PASS for API and web production builds.

Run: `rtk corepack pnpm test:e2e -- tests/browser/conversation-history.spec.ts tests/browser/conversation-job-match-flow.spec.ts tests/browser/submit-safety.spec.ts`

Expected: PASS for conversation lifecycle, inline job matching and final-submit safety.

- [ ] **Step 6: Confirm forbidden-scope absence**

Run: `rtk rg -n "enterprise.*status|招聘状态同步|企业招聘状态" apps packages`

Expected: no newly introduced production API, table or UI for enterprise recruitment status tracking. Existing explanatory text, if any, must be reviewed rather than deleted blindly.

- [ ] **Step 7: Commit acceptance coverage and report final results**

```powershell
rtk git add -- tests/browser/conversation-history.spec.ts
rtk git diff --cached --name-only
rtk git commit -m "test: verify conversation history workflow"
```

If Step 3 changed a production or component-test file, stage each verified file with an additional explicit `rtk git add -- path/to/file` command before inspecting the cached name list. Report every verification command, pass/fail count, screenshot paths, commit hash, and any unrelated dirty files left untouched.

---

## Final Completion Check

Before claiming completion:

1. Verify all seven Task commits exist in order and no unrelated file entered them.
2. Re-read `docs/superpowers/specs/2026-09-02-conversation-history-management-design.md` and map all 11 acceptance criteria to passing tests.
3. Confirm deleting conversations leaves `job_match_sessions`, application tasks, reviews, profile data and submit locks intact.
4. Confirm the live UI uses server history after refresh, not a local-only session list.
5. Confirm the final report is in Chinese and includes task-by-task test evidence.
