# 轻量化语义识别与填写任务修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让带网址的自然语言请求可靠进入固定的填写模块，并保证对话创建的填写任务可以被列表、详情页和工作台正常读取。

**Architecture:** 前端只在粘贴完整网址时补一个空格；后端确定性提取网址，将其替换为 `[URL]` 后交给 DeepSeek 选择固定意图，再由后端绑定原始网址。对话任务改用确定性 UUID；应用契约仅为已有的严格旧格式任务保留窄兼容。

**Tech Stack:** TypeScript、React、Zod、LangGraph、DeepSeek structured output、Vitest、Testing Library、Fastify、Playwright、pnpm

## Global Constraints

- 不增加 `@` 引用、链接标签或新的聊天消息协议。
- DeepSeek 只理解语义，不生成网址、任务编号、工具名或浏览器命令。
- 所有可执行路径仍映射到现有固定模块，并继续经过网址校验和用户确认。
- 裸网址、多个网址、无目标网址和模型故障都不得静默创建填写任务。
- 新任务只产生标准 UUID；旧兼容仅接受 `conversation-application-` 加 32 位十六进制字符。
- 不删除、重写或覆盖现有任务数据。
- 最终提交仍然需要用户确认。

---

## 文件结构

- `packages/contracts/src/application.ts`：统一定义新 UUID 与严格旧任务 ID 的读取契约。
- `packages/contracts/src/application.test.ts`：验证新旧合法 ID 和非法 ID 边界。
- `apps/api/src/applications/routes.ts`：所有应用任务路由复用统一任务 ID 契约。
- `apps/api/src/applications/routes.test.ts`：验证旧任务可列出、可读取，非法 ID 仍拒绝。
- `apps/api/src/conversations/conversation-tools.ts`：为会话任务生成确定性 UUID。
- `apps/api/src/conversations/conversation-tools.test.ts`：验证 UUID 格式与幂等性。
- `apps/api/src/conversations/conversation-graph.ts`：屏蔽真实 URL、调用 DeepSeek、校验并重新绑定目标。
- `apps/api/src/conversations/conversation-graph.test.ts`：覆盖多种说法、错误分类和降级路径。
- `apps/web/src/conversation/ConversationComposer.tsx`：粘贴完整网址时插入一个尾随空格。
- `apps/web/src/conversation/ConversationComposer.test.tsx`：覆盖光标、选区、长度限制和普通粘贴保留行为。
- `tests/browser/conversation-job-match-flow.spec.ts`：覆盖聊天确认、任务创建和工作台打开的浏览器回归。

---

### Task 1: 统一填写任务 ID 契约并兼容旧任务

**Files:**
- Modify: `packages/contracts/src/application.ts:197`
- Modify: `packages/contracts/src/application.ts:294`
- Modify: `packages/contracts/src/application.ts:348`
- Test: `packages/contracts/src/application.test.ts`
- Modify: `apps/api/src/applications/routes.ts:20`
- Test: `apps/api/src/applications/routes.test.ts`

**Interfaces:**
- Produces: `ApplicationTaskIdSchema`，接受 UUID 或严格的旧会话任务 ID。
- Consumes: 应用任务响应、任务事件、历史重置事件和 HTTP 路由参数中的任务 ID。

- [ ] **Step 1: 写入失败的契约测试**

在 `packages/contracts/src/application.test.ts` 导入 `ApplicationTaskIdSchema`，加入：

```ts
it("accepts UUIDs and only the exact legacy conversation application id shape", () => {
  expect(ApplicationTaskIdSchema.parse("91dc4bd6-425a-4cab-a38d-d13e33cda771"))
    .toBe("91dc4bd6-425a-4cab-a38d-d13e33cda771");
  expect(ApplicationTaskIdSchema.parse(
    "conversation-application-c655eb3bfb0dd5a53bb138b78c1e4377"
  )).toBe("conversation-application-c655eb3bfb0dd5a53bb138b78c1e4377");
  expect(ApplicationTaskIdSchema.safeParse("conversation-application-not-hex").success).toBe(false);
  expect(ApplicationTaskIdSchema.safeParse("arbitrary-task-id").success).toBe(false);
});
```

- [ ] **Step 2: 运行契约测试并确认 RED**

Run: `rtk corepack pnpm --filter @resume/contracts test -- application.test.ts`

Expected: FAIL，提示 `ApplicationTaskIdSchema` 尚未导出。

- [ ] **Step 3: 实现统一任务 ID Schema**

在 `packages/contracts/src/application.ts` 定义并复用：

```ts
const LegacyConversationApplicationTaskIdSchema = z.string()
  .regex(/^conversation-application-[a-f0-9]{32}$/u);

export const ApplicationTaskIdSchema = z.union([
  z.string().uuid(),
  LegacyConversationApplicationTaskIdSchema
]);
```

把以下三处的 `z.string().uuid()` 改为 `ApplicationTaskIdSchema`：

```ts
export const ApplicationTaskSchema = z.object({
  id: ApplicationTaskIdSchema,
  // 保留其余现有字段
}).strict();

const ApplicationTaskEventBaseShape = {
  id: z.string().regex(/^\d+$/),
  taskId: ApplicationTaskIdSchema,
  createdAt: z.string().datetime()
};

export const ApplicationTaskHistoryResetSchema = z.object({
  type: z.literal("history_reset"),
  taskId: ApplicationTaskIdSchema,
  reason: z.literal("history_gap"),
  requestedLastEventId: z.string().regex(/^\d+$/),
  oldestAvailableId: z.string().regex(/^\d+$/)
}).strict();
```

- [ ] **Step 4: 为应用路由写入失败测试**

在现有 `apps/api/src/applications/routes.test.ts` 测试夹具中插入严格旧 ID 任务，并断言：

```ts
const legacyTaskId = "conversation-application-c655eb3bfb0dd5a53bb138b78c1e4377";
tasks.createFromJob({
  id: legacyTaskId,
  name: "旧会话填写任务",
  applicationUrl: "https://jobs.example.com/apply/legacy"
});

const listResponse = await app.inject({ method: "GET", url: "/api/applications" });
expect(listResponse.statusCode).toBe(200);
expect(listResponse.json()).toEqual(expect.arrayContaining([
  expect.objectContaining({ id: legacyTaskId })
]));

const detailResponse = await app.inject({
  method: "GET",
  url: `/api/applications/${legacyTaskId}`
});
expect(detailResponse.statusCode).toBe(200);
expect(detailResponse.json()).toMatchObject({ id: legacyTaskId });

const invalidResponse = await app.inject({
  method: "GET",
  url: "/api/applications/arbitrary-task-id"
});
expect(invalidResponse.statusCode).toBe(400);
expect(invalidResponse.json()).toMatchObject({ code: "invalid_task_id" });
```

- [ ] **Step 5: 运行路由测试并确认 RED**

Run: `rtk corepack pnpm --filter @resume/api test -- routes.test.ts`

Expected: FAIL；列表在 `ApplicationTaskSchema.parse` 处失败，详情返回 `invalid_task_id`。

- [ ] **Step 6: 让 HTTP 路由复用统一 Schema**

修改 `apps/api/src/applications/routes.ts`：

```ts
import {
  ApplicationCommandSchema,
  ApplicationTaskIdSchema,
  ApplicationTaskInputSchema,
  ApplicationTaskSchema,
  // 保留其余现有导入
} from "@resume/contracts";

const TaskParamsSchema = z.object({ id: ApplicationTaskIdSchema }).strict();
```

不得把参数改成任意字符串，也不得删除现有的 `safeParse` 错误处理。

- [ ] **Step 7: 验证 Task 1 GREEN**

Run:

```text
rtk corepack pnpm --filter @resume/contracts test -- application.test.ts
rtk corepack pnpm --filter @resume/api test -- routes.test.ts
```

Expected: 两组测试 PASS。

- [ ] **Step 8: 提交 Task 1**

```text
rtk git add packages/contracts/src/application.ts packages/contracts/src/application.test.ts apps/api/src/applications/routes.ts apps/api/src/applications/routes.test.ts
rtk git commit -m "fix: read legacy conversation application tasks"
```

---

### Task 2: 对话创建任务改用确定性 UUID

**Files:**
- Modify: `apps/api/src/conversations/conversation-tools.ts:485`
- Test: `apps/api/src/conversations/conversation-tools.test.ts:190`

**Interfaces:**
- Consumes: `conversationId: string` 和结果 ID 或规范化申请 URL。
- Produces: `defaultTaskId(conversationId: string, resultId: string): string`，返回稳定的 UUID v5 格式。

- [ ] **Step 1: 强化现有幂等测试并确认 RED**

在 `creates and starts an idempotent controlled application task from a direct URL` 中增加：

```ts
const firstTaskId = createFromJob.mock.calls[0]![0].id;
const secondTaskId = createFromJob.mock.calls[1]![0].id;

expect(firstTaskId).toBe(secondTaskId);
expect(firstTaskId).toMatch(
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
);
expect(first.cards[0]).toMatchObject({
  type: "application_task",
  taskId: firstTaskId,
  applicationUrl: input.applicationUrl
});
```

- [ ] **Step 2: 运行工具测试并确认 RED**

Run: `rtk corepack pnpm --filter @resume/api test -- conversation-tools.test.ts`

Expected: FAIL；当前 ID 以 `conversation-application-` 开头。

- [ ] **Step 3: 实现最小 UUID v5 生成器**

在 `conversation-tools.ts` 保留现有 `createHash` 导入并加入 `Buffer` 可用的实现：

```ts
const CONVERSATION_APPLICATION_NAMESPACE = Buffer.from(
  "6ba7b8119dad11d180b400c04fd430c8",
  "hex"
);

function defaultTaskId(conversationId: string, resultId: string): string {
  const name = Buffer.from(`${conversationId}\u0000${resultId}`, "utf8");
  const bytes = createHash("sha1")
    .update(CONVERSATION_APPLICATION_NAMESPACE)
    .update(name)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
```

不要改动 `createFromJob` 的幂等检查，也不要使用随机 UUID。

- [ ] **Step 4: 验证 Task 2 GREEN**

Run: `rtk corepack pnpm --filter @resume/api test -- conversation-tools.test.ts`

Expected: PASS；两次调用得到相同 UUID。

- [ ] **Step 5: 提交 Task 2**

```text
rtk git add apps/api/src/conversations/conversation-tools.ts apps/api/src/conversations/conversation-tools.test.ts
rtk git commit -m "fix: generate deterministic UUID application tasks"
```

---

### Task 3: 使用 DeepSeek 判断 URL 请求语义并由后端绑定网址

**Files:**
- Modify: `apps/api/src/conversations/conversation-graph.ts:301-356`
- Test: `apps/api/src/conversations/conversation-graph.test.ts`

**Interfaces:**
- Consumes: 原始用户文本、最多一个由 `extractSingleHttpsUrl` 提取的 HTTPS URL、`StructuredModelProvider`。
- Produces: 经过 `ConversationIntentSchema` 校验且由后端绑定真实 URL 的 `ConversationIntent`。

- [ ] **Step 1: 写入 URL 屏蔽与重新绑定的失败测试**

在 `conversation-graph.test.ts` 增加：

```ts
it("uses DeepSeek semantics for varied application wording and binds the original URL", async () => {
  const dependencies = fakeDependencies();
  const generateStructured = vi.fn(async () => ({
    kind: "start_application",
    requiresConfirmation: true
  }));
  dependencies.modelProvider = { generateStructured };

  const response = await runConversationTurn(
    dependencies,
    "用这个页面帮我处理申请 https://jobs.example.com/apply/123 好吗",
    { version: 0, recentPostingIds: [] }
  );

  expect(generateStructured).toHaveBeenCalledWith(expect.objectContaining({
    user: "用这个页面帮我处理申请 [URL] 好吗"
  }));
  expect(JSON.stringify(generateStructured.mock.calls[0]![0])).not
    .toContain("https://jobs.example.com/apply/123");
  expect(response.message.intent).toMatchObject({
    kind: "start_application",
    target: {
      kind: "application_url",
      url: "https://jobs.example.com/apply/123"
    },
    requiresConfirmation: true
  });
  expect(response.pendingConfirmation?.target).toMatchObject({
    kind: "application_url",
    url: "https://jobs.example.com/apply/123"
  });
});
```

- [ ] **Step 2: 写入保留集与安全降级测试**

加入以下三个用例：

```ts
it("does not turn recruitment wording into direct filling", async () => {
  const dependencies = fakeDependencies();
  dependencies.modelProvider = {
    generateStructured: vi.fn(async () => ({
      kind: "request_job_recommendations",
      requiresConfirmation: false
    }))
  };
  const response = await runConversationTurn(
    dependencies,
    "用这个招聘入口推荐岗位 https://jobs.example.com/campus",
    { version: 0, recentPostingIds: [] }
  );
  expect(response.message.intent?.kind).not.toBe("start_application");
});

it("keeps a bare URL as a clarification without calling DeepSeek", async () => {
  const dependencies = fakeDependencies();
  const generateStructured = vi.fn();
  dependencies.modelProvider = { generateStructured };
  const response = await runConversationTurn(
    dependencies,
    "https://jobs.example.com/apply/123",
    { version: 0, recentPostingIds: [] }
  );
  expect(response.message.intent?.kind).toBe("unknown");
  expect(response.pendingConfirmation).toBeUndefined();
  expect(generateStructured).not.toHaveBeenCalled();
});

it("does not create a URL target when DeepSeek is unavailable", async () => {
  const dependencies = fakeDependencies();
  dependencies.modelProvider = {
    generateStructured: vi.fn(async () => { throw new Error("offline"); })
  };
  const response = await runConversationTurn(
    dependencies,
    "用这个页面帮我处理申请 https://jobs.example.com/apply/123 好吗",
    { version: 0, recentPostingIds: [] }
  );
  expect(response.message.intent?.kind).toBe("unknown");
  expect(response.pendingConfirmation).toBeUndefined();
  expect(dependencies.createFromJob).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: 运行图测试并确认 RED**

Run: `rtk corepack pnpm --filter @resume/api test -- conversation-graph.test.ts`

Expected: URL 屏蔽和后端绑定用例 FAIL；现有实现把真实 URL 直接传给模型，或无法为无 target 的 `start_application` 绑定网址。

- [ ] **Step 4: 增加模型可见文本与绑定函数**

在 `conversation-graph.ts` 增加：

```ts
function modelVisibleText(text: string, manualUrl: string | undefined): string {
  return manualUrl === undefined ? text : text.replace(manualUrl, "[URL]");
}

function bindExtractedApplicationUrl(
  intent: ConversationIntent,
  manualUrl: string | undefined
): ConversationIntent {
  if (manualUrl === undefined || intent.kind !== "start_application") return intent;
  return ConversationIntentSchema.parse({
    ...intent,
    target: { kind: "application_url", url: manualUrl },
    requiresConfirmation: true
  });
}
```

该函数只允许覆盖 `start_application` 的目标；不得为岗位推荐或招聘入口意图绑定申请 URL。

- [ ] **Step 5: 修改受限分类调用**

将通用模型调用改为：

```ts
const raw = await dependencies.modelProvider.generateStructured({
  system: [
    "你是受限的求职工作台意图分类器。",
    "只能从 ConversationIntentSchema 已允许的固定 kind 中选择。",
    "[URL] 表示后端已经安全提取的网址；不要返回、复制或猜测网址。",
    "用户希望填写、申请或处理具体页面时选择 start_application，target 可以省略。",
    "用户希望发现招聘入口或推荐岗位时选择对应的 recruitment/job recommendation kind。",
    "意思不明确时返回 unknown。",
    "不得生成工具名、浏览器命令或数据库 ID。只返回 JSON。"
  ].join(""),
  user: modelVisibleText(state.text!, manualUrl),
  schema: ConversationIntentSchema,
  jsonExample: {
    kind: "start_application",
    requiresConfirmation: true
  }
});
const parsed = ConversationIntentSchema.safeParse(raw);
if (!parsed.success) {
  const intent = unknownIntent();
  return finish({
    intent,
    traceIds: trace(
      dependencies,
      nodeEvent(state, "classify_intent", "unknown", "model_output_invalid"),
      state.traceIds
    )
  });
}
const intent = normalizeIntent(bindExtractedApplicationUrl(parsed.data, manualUrl));
```

保留确认输入、裸 URL、明确固定命令和模型异常 fallback 的现有先后顺序。

- [ ] **Step 6: 验证 Task 3 GREEN**

Run: `rtk corepack pnpm --filter @resume/api test -- conversation-graph.test.ts`

Expected: 新增边界集与原有会话图测试全部 PASS。

- [ ] **Step 7: 提交 Task 3**

```text
rtk git add apps/api/src/conversations/conversation-graph.ts apps/api/src/conversations/conversation-graph.test.ts
rtk git commit -m "fix: bind DeepSeek application intents to extracted URLs"
```

---

### Task 4: 粘贴完整网址后自动补空格

**Files:**
- Modify: `apps/web/src/conversation/ConversationComposer.tsx`
- Create: `apps/web/src/conversation/ConversationComposer.test.tsx`

**Interfaces:**
- Consumes: `ClipboardEvent<HTMLTextAreaElement>` 中的 `text/plain`、当前输入值和选区。
- Produces: `insertPastedWebUrl(text, pasted, start, end): { value: string; caret: number } | undefined`。

- [ ] **Step 1: 写入纯函数失败测试**

创建 `ConversationComposer.test.tsx`，导入 `insertPastedWebUrl` 并加入：

```ts
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationComposer, insertPastedWebUrl } from "./ConversationComposer.js";

describe("ConversationComposer", () => {
  it("adds one space after a pasted web URL and preserves the selection", () => {
    expect(insertPastedWebUrl(
      "请填写这里",
      "https://jobs.example.com/apply/123",
      3,
      5
    )).toEqual({
      value: "请填写https://jobs.example.com/apply/123 ",
      caret: "请填写https://jobs.example.com/apply/123 ".length
    });
  });

  it("leaves ordinary or mixed clipboard text to native paste", () => {
    expect(insertPastedWebUrl("", "普通文字", 0, 0)).toBeUndefined();
    expect(insertPastedWebUrl("", "网址 https://jobs.example.com", 0, 0)).toBeUndefined();
    expect(insertPastedWebUrl("", "mailto:user@example.com", 0, 0)).toBeUndefined();
  });

  it("submits the separated URL and following prose", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ConversationComposer sending={false} onSend={onSend} />);
    const input = screen.getByRole("textbox", { name: "输入消息" });

    fireEvent.paste(input, {
      clipboardData: {
        getData: () => "https://jobs.example.com/apply/123"
      }
    });
    await user.type(input, "这个页面帮我填写");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(onSend).toHaveBeenCalledWith(
      "https://jobs.example.com/apply/123 这个页面帮我填写"
    );
  });
});
```

- [ ] **Step 2: 运行组件测试并确认 RED**

Run: `rtk corepack pnpm --filter @resume/web test -- ConversationComposer.test.tsx`

Expected: FAIL；`insertPastedWebUrl` 未导出，组件没有自定义 paste 行为。

- [ ] **Step 3: 实现 URL 粘贴纯函数**

在 `ConversationComposer.tsx` 加入：

```ts
const MAX_MESSAGE_LENGTH = 500;

export function insertPastedWebUrl(
  current: string,
  clipboardText: string,
  selectionStart: number,
  selectionEnd: number
): { value: string; caret: number } | undefined {
  const pasted = clipboardText.trim();
  if (pasted !== clipboardText || /\s/u.test(pasted)) return undefined;
  try {
    const url = new URL(pasted);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  const inserted = `${pasted} `;
  const value = `${current.slice(0, selectionStart)}${inserted}${current.slice(selectionEnd)}`;
  if (value.length > MAX_MESSAGE_LENGTH) return undefined;
  return { value, caret: selectionStart + inserted.length };
}
```

- [ ] **Step 4: 接入 textarea paste 事件并恢复光标**

修改 React 导入并在组件中加入 ref：

```ts
import { useRef, useState, type ClipboardEvent } from "react";

const inputRef = useRef<HTMLTextAreaElement>(null);

const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
  const input = event.currentTarget;
  const next = insertPastedWebUrl(
    text,
    event.clipboardData.getData("text/plain"),
    input.selectionStart,
    input.selectionEnd
  );
  if (next === undefined) return;
  event.preventDefault();
  setText(next.value);
  requestAnimationFrame(() => {
    inputRef.current?.setSelectionRange(next.caret, next.caret);
  });
};
```

将 textarea 改为：

```tsx
<textarea
  ref={inputRef}
  aria-label="输入消息"
  maxLength={MAX_MESSAGE_LENGTH}
  rows={1}
  value={text}
  onChange={(event) => setText(event.target.value)}
  onPaste={paste}
  placeholder="输入你想了解的内容……"
/>
```

- [ ] **Step 5: 验证 Task 4 GREEN 与保留集**

Run:

```text
rtk corepack pnpm --filter @resume/web test -- ConversationComposer.test.tsx
rtk corepack pnpm --filter @resume/web test -- ChatHome.test.tsx
```

Expected: 新组件测试与原有聊天测试全部 PASS。

- [ ] **Step 6: 提交 Task 4**

```text
rtk git add apps/web/src/conversation/ConversationComposer.tsx apps/web/src/conversation/ConversationComposer.test.tsx
rtk git commit -m "fix: separate pasted URLs from conversation text"
```

---

### Task 5: API、前端与真实浏览器回归

**Files:**
- Modify: `tests/browser/conversation-job-match-flow.spec.ts`
- Test: `apps/api/src/applications/routes.test.ts`
- Test: `apps/api/src/conversations/conversation-tools.test.ts`
- Test: `apps/api/src/conversations/conversation-graph.test.ts`
- Test: `apps/web/src/conversation/ConversationComposer.test.tsx`

**Interfaces:**
- Consumes: 聊天发送、确认卡片、`/api/applications`、`/api/applications/:id` 和任务工作台路由。
- Produces: 一条证明“聊天创建 → API 可读 → 工作台可开”的端到端回归证据。

- [ ] **Step 1: 增加浏览器端到端失败用例**

在现有会话浏览器测试夹具中复用 API mock/测试服务器，加入一个用例，其关键断言为：

```ts
test("pasted application URL creates a loadable filling task", async ({ page, request }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "输入消息" });
  await composer.fill("用这个页面帮我填写 https://jobs.example.com/apply/123 好吗");
  await page.getByRole("button", { name: "发送" }).click();

  await expect(page.getByRole("button", { name: "确认开始填写" })).toBeVisible();
  await page.getByRole("button", { name: "确认开始填写" }).click();

  const taskLink = page.getByRole("button", { name: "打开投递任务" });
  await expect(taskLink).toBeVisible();

  await taskLink.click();
  await page.waitForURL(/\/applications\/[0-9a-f-]{36}$/u);
  const taskId = new URL(page.url()).pathname.split("/").at(-1)!;
  expect(taskId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
  );
  expect((await request.get("/api/applications")).status()).toBe(200);
  expect((await request.get(`/api/applications/${taskId}`)).status()).toBe(200);

  await expect(page.getByRole("heading", { name: "实时任务控制" })).toBeVisible();
  await expect(page.getByText("任务加载失败，请重试")).toHaveCount(0);
});
```

- [ ] **Step 2: 运行浏览器用例并确认 RED 或现有夹具缺口**

Run: `rtk corepack pnpm test:e2e -- tests/browser/conversation-job-match-flow.spec.ts`

Expected: 在完整修复前，任务 ID 或详情加载断言失败；若测试夹具未覆盖真实 API，则先让夹具使用与生产相同的任务 ID/详情契约后再确认失败点。

- [ ] **Step 3: 运行全部聚焦回归**

Run:

```text
rtk corepack pnpm --filter @resume/contracts test -- application.test.ts
rtk corepack pnpm --filter @resume/api test -- routes.test.ts conversation-tools.test.ts conversation-graph.test.ts
rtk corepack pnpm --filter @resume/web test -- ConversationComposer.test.tsx ChatHome.test.tsx ApplicationTaskPage.test.tsx
rtk corepack pnpm typecheck
```

Expected: 所有命令退出码为 0。

- [ ] **Step 4: 运行工作区回归**

Run:

```text
rtk corepack pnpm test
rtk corepack pnpm build
rtk corepack pnpm test:e2e -- tests/browser/conversation-job-match-flow.spec.ts
```

Expected: 单元/集成测试、构建和目标浏览器测试全部 PASS。

- [ ] **Step 5: 使用本地真实服务联调**

启动仓库正常开发服务，在 `http://127.0.0.1:5173` 执行：

1. 新建对话。
2. 粘贴一个真实申请 URL，并紧接着输入“这个页面帮我填写”。
3. 确认输入框中 URL 后自动出现空格。
4. 发送后确认出现“确认开始填写”，不出现岗位推荐空结果。
5. 批准后记录任务 ID，确认其为 UUID。
6. 请求 `/api/applications` 和 `/api/applications/:id`，确认均为 HTTP 200。
7. 点击“打开投递任务”，确认工作台加载，且不出现“任务加载失败，请重试”。
8. 打开包含旧 `conversation-application-*` 记录的任务列表，确认列表不再返回 500。

- [ ] **Step 6: 检查 TraceSink 证据**

检查该回合的会话跟踪，确认依次存在：

```text
classify_intent -> model_structured
resolve_target -> application_url_resolved
prepare_side_effect -> confirmation_prepared
invoke_tool -> create_application_task
```

同时确认跟踪中没有 `list_recommendations`、`create_job_match_session` 或未经确认的浏览器执行。

- [ ] **Step 7: 提交 Task 5**

```text
rtk git add tests/browser/conversation-job-match-flow.spec.ts
rtk git commit -m "test: cover loadable conversation application tasks"
```

---

## 自检结果

- 设计中的粘贴补空格、DeepSeek 固定语义分类、后端 URL 绑定、缺失/歧义处理、确定性 UUID、旧任务窄兼容和真实联调均有对应任务。
- 每个生产改动之前都有明确的失败测试和 RED 命令。
- 新增接口名称在后续任务中保持一致：`ApplicationTaskIdSchema`、`insertPastedWebUrl`、`modelVisibleText`、`bindExtractedApplicationUrl`。
- 计划没有引入 `@` 系统、消息协议升级、自由工具调用或数据迁移。

---

### Task 6: 修复编码中文边界并收窄 DeepSeek URL 路由

**Files:**
- Create: `apps/api/src/conversations/conversation-url-input.ts`
- Create: `apps/api/src/conversations/conversation-url-input.test.ts`
- Modify: `apps/api/src/conversations/conversation-graph.ts`
- Modify: `apps/api/src/conversations/conversation-graph.test.ts`
- Modify: `apps/api/src/conversations/conversation-routes.test.ts`
- Modify: `tests/browser/conversation-job-match-flow.spec.ts`

**Interfaces:**
- Produces: `extractConversationUrlInput(rawText: string): ConversationUrlInput | undefined`，保留原文、输出净化 URL 和 `[URL]` 模型文本。
- Produces: `UrlIntentRouteSchema`，只允许 `start_application`、`request_job_recommendations`、`discover_recruitment_site`、`list_application_tasks`、`unknown`。
- Consumes: 单个 HTTPS URL、`StructuredModelProvider`、现有 `ConversationIntentSchema` 与确认流程。

- [ ] **Step 1: 写入 URL 边界失败测试**

创建 `conversation-url-input.test.ts`，使用本次真实原始输入断言：

```ts
const raw = "投递https://wondersharecampus.zhiye.com/form?fromPage=job&jobAdId=1e15df19-c887-41f5-b632-3845af9b5131&shareId=16002765-e0e5-4238-a46a-4f8b717777fc&userId=125079440%E8%BF%99%E4%B8%AA%E9%A1%B5%E9%9D%A2%E5%8F%AF%E4%BB%A5%E6%8A%95%E9%80%92%E5%90%97";
expect(extractConversationUrlInput(raw)).toEqual({
  rawText: raw,
  url: "https://wondersharecampus.zhiye.com/form?fromPage=job&jobAdId=1e15df19-c887-41f5-b632-3845af9b5131&shareId=16002765-e0e5-4238-a46a-4f8b717777fc&userId=125079440",
  modelText: "投递[URL]这个页面可以投递吗",
  boundary: "recovered_encoded_suffix"
});
```

同时加入保留集：`keyword=%E9%AB%98%E7%BA%A7%E5%89%8D%E7%AB%AF%E5%B7%A5%E7%A8%8B%E5%B8%88` 必须完整保留；显式空格后的中文必须保留在 `modelText`；多 URL 返回 `undefined`。

- [ ] **Step 2: 运行边界测试并确认 RED**

Run: `rtk corepack pnpm exec vitest run src/conversations/conversation-url-input.test.ts`（工作目录 `apps/api`）

Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 实现独立 URL 输入投影**

在 `conversation-url-input.ts` 实现 `ConversationUrlInput` 与 `extractConversationUrlInput`：

```ts
export interface ConversationUrlInput {
  rawText: string;
  url: string;
  modelText: string;
  boundary: "explicit" | "recovered_encoded_suffix";
}

export function extractConversationUrlInput(rawText: string): ConversationUrlInput | undefined;
```

URL 扫描只接受 RFC 3986 ASCII URL 字符；编码后缀恢复仅在最后一个查询参数名匹配 `/(?:id|uuid|token|code|key)$/iu`、参数值存在 ASCII 标识符前缀且尾部是可解码的连续 UTF-8 百分号字节时成立。恢复出的后缀至少包含两个 CJK 字符，否则保持原 URL。函数不得修改 `rawText`。

- [ ] **Step 4: 验证 URL 边界 GREEN**

Run: `rtk corepack pnpm exec vitest run src/conversations/conversation-url-input.test.ts`（工作目录 `apps/api`）

Expected: PASS，真实输入被修复且中文搜索参数保留。

- [ ] **Step 5: 写入固定路由 Schema 失败测试**

在 `conversation-graph.test.ts` 添加参数化边界集，四条文本分别为“填写 [URL]”“投递[URL]”“用这个页面申请 [URL]”“[URL] 帮我处理”，模型均返回 `{ kind: "start_application", requiresConfirmation: true }`。断言每次调用都使用 `UrlIntentRouteSchema`、模型输入不含真实 URL，返回目标由后端绑定。

加入保留集：模型返回岗位推荐或招聘入口时不得绑定申请 URL；裸 URL 不调用模型；多 URL、模型异常和非法输出不创建任务。真实失败输入必须调用模型且使用净化 URL。

- [ ] **Step 6: 运行图测试并确认 RED**

Run: `rtk corepack pnpm exec vitest run src/conversations/conversation-graph.test.ts`（工作目录 `apps/api`）

Expected: FAIL；当前 `hasExplicitFillingIntent` 绕过模型，且编码中文仍包含在 URL 中。

- [ ] **Step 7: 接入固定 URL 路由 Schema**

在 `conversation-graph.ts` 导入 `extractConversationUrlInput`，定义并只向模型暴露：

```ts
const UrlIntentRouteSchema = z.object({
  kind: z.enum([
    "start_application",
    "request_job_recommendations",
    "discover_recruitment_site",
    "list_application_tasks",
    "unknown"
  ]),
  requiresConfirmation: z.boolean()
}).strict();
```

确认输入、裸 URL 和多 URL 的安全分支保持确定性。其余单 URL 文本统一调用一次模型；删除 `hasExplicitFillingIntent` 对 URL 请求的短路。模型结果先经 `UrlIntentRouteSchema` 校验，再映射到 `ConversationIntentSchema`；仅 `start_application` 绑定 `urlInput.url` 并强制确认。

- [ ] **Step 8: 验证原始消息持久化**

在 `conversation-routes.test.ts` 使用真实原始输入完成发送，断言 `GET /api/conversations/:id` 返回的用户消息 `text` 与原字符串逐字相等，模型仅收到恢复后的 `modelText`。

- [ ] **Step 9: 运行 API 聚焦回归并提交**

Run:

```text
rtk corepack pnpm exec vitest run src/conversations/conversation-url-input.test.ts src/conversations/conversation-graph.test.ts src/conversations/conversation-routes.test.ts
rtk corepack pnpm typecheck
```

Expected: 全部 PASS，类型检查退出码为 0。

Commit: `fix: route URL requests through bounded DeepSeek schema`

- [ ] **Step 10: 扩展浏览器回归并执行真实联调**

将真实失败输入加入 `conversation-job-match-flow.spec.ts`，断言发送后出现“确认开始填写”，确认后生成 UUID，列表和详情均为 200，工作台可打开。启动真实服务时显式加载仓库根目录 `.env.local`，健康状态必须显示 DeepSeek 已配置；TraceSink 的分类原因为 `model_structured`，且没有岗位匹配创建或未经确认的浏览器执行。

Run:

```text
rtk corepack pnpm test
rtk corepack pnpm build
rtk corepack pnpm test:e2e -- tests/browser/conversation-job-match-flow.spec.ts
```

Expected: 全量测试、构建、浏览器回归与真实联调全部通过。

Commit: `test: cover encoded application URL prose`

## Task 6 自检结果

- 真实失败原文、原文保真、固定路由 Schema、同义表达边界集和招聘/搜索参数保留集均有明确测试。
- URL 边界解析与意图分类职责分离；模型不接触真实 URL，也不产生工具或 ID。
- 新任务 UUID 与旧任务兼容复用 Tasks 1–2 的既有实现，没有重复改造。
- 不引入 ReAct、多 Agent、新模块或最终提交权限。
