# 投递任务名称 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在新建投递时自动建议并允许修改任务名称，将名称持久化并用于列表和详情页识别。

**Architecture:** 在 contracts 包提供名称契约和共享 URL 派生函数，API 在旧客户端未传名称时补齐并持久化。SQLite 使用可空新增列兼容历史数据库，repository 读取历史空值时派生名称；前端新建表单保护手动编辑，列表和详情页优先展示持久化名称。

**Tech Stack:** TypeScript、Zod、Fastify、SQLite/better-sqlite3、React 19、Vitest、Testing Library。

## Global Constraints

- 任务名称去除首尾空白后长度必须为 1–80 个字符。
- 名称仅用于本地任务识别，不传给 Browser Worker 或招聘网站。
- DJI 链接建议“大疆校招投递”，其他链接使用域名生成建议。
- 用户手动修改名称后，URL 变化不得覆盖名称。
- 历史任务和旧客户端必须继续可用。

---

### Task 1: 名称契约与共享建议函数

**Files:**
- Create: `packages/contracts/src/application-name.ts`
- Create: `packages/contracts/src/application-name.test.ts`
- Modify: `packages/contracts/src/application.ts`
- Modify: `packages/contracts/src/application.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Produces: `ApplicationTaskNameSchema`；`suggestApplicationTaskName(applicationUrl: string): string`。
- Produces: `ApplicationTaskInput.name?: string` 和 `ApplicationTask.name?: string`，用于兼容旧调用者。

- [ ] **Step 1: Write failing tests**

测试合法名称、空白名称、81 字符名称，以及 URL 建议：

```ts
expect(suggestApplicationTaskName("https://apply.careers.dji.com/campus-recruitment/dji/143359")).toBe("大疆校招投递");
expect(suggestApplicationTaskName("https://jobs.example.com/apply/1")).toBe("jobs.example.com 投递");
expect(ApplicationTaskInputSchema.safeParse({ applicationUrl: validUrl, name: "   " }).success).toBe(false);
expect(ApplicationTaskInputSchema.parse({ applicationUrl: validUrl, name: "  后端岗位  " }).name).toBe("后端岗位");
```

- [ ] **Step 2: Verify RED**

Run: `rtk pnpm exec vitest run packages/contracts/src/application-name.test.ts packages/contracts/src/application.test.ts`

Expected: FAIL，因为名称 schema 和建议函数尚不存在。

- [ ] **Step 3: Implement the contract**

```ts
export const ApplicationTaskNameSchema = z.string().trim().min(1).max(80);

export function suggestApplicationTaskName(applicationUrl: string): string {
  const url = new URL(applicationUrl);
  const fingerprint = `${url.hostname}${url.pathname}`.toLowerCase();
  if (fingerprint.includes("dji")) return "大疆校招投递";
  return `${url.hostname.replace(/^www\./, "")} 投递`.slice(0, 80);
}
```

输入和输出 schema 使用 `ApplicationTaskNameSchema.optional()`；API 层负责保证实际新任务始终有名称。

- [ ] **Step 4: Verify GREEN**

Run: `rtk pnpm exec vitest run packages/contracts/src/application-name.test.ts packages/contracts/src/application.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
rtk git add packages/contracts/src/application-name.ts packages/contracts/src/application-name.test.ts packages/contracts/src/application.ts packages/contracts/src/application.test.ts packages/contracts/src/index.ts
rtk git commit -m "feat: add application task naming contract"
```

### Task 2: SQLite 迁移与任务仓库持久化

**Files:**
- Modify: `apps/api/src/db/migrate.ts`
- Modify: `apps/api/src/db/migrate.test.ts`
- Modify: `apps/api/src/applications/application-task-repository.ts`
- Modify: `apps/api/src/applications/application-task-repository.test.ts`

**Interfaces:**
- Consumes: `suggestApplicationTaskName(applicationUrl)`。
- Produces: `StoredApplicationTask.name: string`；`ApplicationTaskRepository.create({ id, name, applicationUrl })`。

- [ ] **Step 1: Write failing migration and repository tests**

测试全新数据库存在 `application_tasks.name` 列、旧表迁移后保留行，以及仓库往返名称：

```ts
expect(database.prepare("PRAGMA table_info(application_tasks)").all()).toEqual(
  expect.arrayContaining([expect.objectContaining({ name: "name" })])
);
expect(repository.create({ id, name: "大疆后端岗位", applicationUrl }).name).toBe("大疆后端岗位");
```

手工构造 `name IS NULL` 的历史行，断言 `repository.get(id)?.name` 等于共享建议名称。

- [ ] **Step 2: Verify RED**

Run: `rtk pnpm exec vitest run apps/api/src/db/migrate.test.ts apps/api/src/applications/application-task-repository.test.ts`

Expected: FAIL，因为列和仓库字段尚不存在。

- [ ] **Step 3: Implement idempotent migration and repository mapping**

新建表定义加入 `name TEXT`。建表后使用 `PRAGMA table_info(application_tasks)` 检查并执行：

```ts
if (!taskColumns.some((column) => column.name === "name")) {
  database.exec("ALTER TABLE application_tasks ADD COLUMN name TEXT");
}
```

仓库 INSERT、`TaskRow` 和 `fromRow` 增加名称；`fromRow` 对 `null` 使用 `suggestApplicationTaskName(row.application_url)`。

- [ ] **Step 4: Verify GREEN**

Run: `rtk pnpm exec vitest run apps/api/src/db/migrate.test.ts apps/api/src/applications/application-task-repository.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
rtk git add apps/api/src/db/migrate.ts apps/api/src/db/migrate.test.ts apps/api/src/applications/application-task-repository.ts apps/api/src/applications/application-task-repository.test.ts
rtk git commit -m "feat: persist application task names"
```

### Task 3: 创建 API 接收并返回任务名称

**Files:**
- Modify: `apps/api/src/applications/routes.ts`
- Modify: `apps/api/src/applications/routes.test.ts`
- Modify: `apps/web/src/applications/api.test.ts`

**Interfaces:**
- Consumes: optional `ApplicationTaskInput.name`。
- Produces: 创建、查询和列表响应中的 `ApplicationTask.name`。

- [ ] **Step 1: Write failing route and client tests**

创建请求传入 `name: "大疆后端岗位"`，断言 repository 和响应保留该值；再发送仅含 URL 的旧请求，断言响应使用 `suggestApplicationTaskName`。Web API 测试断言 JSON body 包含名称。

- [ ] **Step 2: Verify RED**

Run: `rtk pnpm exec vitest run apps/api/src/applications/routes.test.ts apps/web/src/applications/api.test.ts`

Expected: FAIL，因为路由仍只构造 `id` 和 `applicationUrl`。

- [ ] **Step 3: Implement route normalization**

```ts
const name = body.data.name ?? suggestApplicationTaskName(body.data.applicationUrl);
const taskInput = {
  id: randomUUID(),
  name,
  applicationUrl: body.data.applicationUrl
};
```

`taskResponse` 增加 `name: task.name`。名称不传入 `applicationService.start` 或 Browser Worker。

- [ ] **Step 4: Verify GREEN**

Run: `rtk pnpm exec vitest run apps/api/src/applications/routes.test.ts apps/web/src/applications/api.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
rtk git add apps/api/src/applications/routes.ts apps/api/src/applications/routes.test.ts apps/web/src/applications/api.test.ts
rtk git commit -m "feat: expose application task names"
```

### Task 4: 新建表单建议名称并更新任务展示

**Files:**
- Modify: `apps/web/src/applications/ApplicationStartPanel.tsx`
- Modify: `apps/web/src/applications/ApplicationStartPanel.test.tsx`
- Modify: `apps/web/src/applications/ApplicationReviewInbox.tsx`
- Modify: `apps/web/src/applications/ApplicationReviewInbox.test.tsx`
- Modify: `apps/web/src/applications/ApplicationTaskPage.tsx`
- Modify: `apps/web/src/applications/ApplicationTaskPage.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `suggestApplicationTaskName` 和任务响应中的可选 `name`。
- Produces: 可编辑名称输入、列表主标题、详情页标题和带名称的删除确认文案。

- [ ] **Step 1: Write failing UI tests**

覆盖以下行为：

```tsx
await user.type(screen.getByLabelText("投递官网链接"), djiUrl);
expect(screen.getByLabelText("任务名称")).toHaveValue("大疆校招投递");
await user.clear(screen.getByLabelText("任务名称"));
await user.type(screen.getByLabelText("任务名称"), "大疆 Java 后端");
await user.clear(screen.getByLabelText("投递官网链接"));
await user.type(screen.getByLabelText("投递官网链接"), anotherUrl);
expect(screen.getByLabelText("任务名称")).toHaveValue("大疆 Java 后端");
```

提交时断言 `applicationApi.create({ name, applicationUrl })`。列表断言名称为卡片 `h2`，详情页断言页面标题展示名称；没有名称的历史 fixture 继续回退域名。

- [ ] **Step 2: Verify RED**

Run: `rtk pnpm exec vitest run apps/web/src/applications/ApplicationStartPanel.test.tsx apps/web/src/applications/ApplicationReviewInbox.test.tsx apps/web/src/applications/ApplicationTaskPage.test.tsx`

Expected: FAIL，因为名称输入和展示尚不存在。

- [ ] **Step 3: Implement the form and displays**

表单增加 `taskName`、`taskNameTouched` 状态。URL `onChange` 在未手动编辑时调用建议函数；名称 `onChange` 设置 touched。提交前使用 `ApplicationTaskNameSchema.safeParse`，失败显示“请输入 1–80 个字符的任务名称”。

列表使用：

```tsx
<h2>{task.name ?? hostFor(task.applicationUrl)}</h2>
<span>{hostFor(task.applicationUrl)}</span>
```

详情页使用 `task.name ?? host ?? "投递任务"` 作为任务标题。删除确认包含该显示名称。样式保持现有卡片密度，名称、域名和 URL 不重叠。

- [ ] **Step 4: Verify focused tests and build**

Run: `rtk pnpm exec vitest run apps/web/src/applications/ApplicationStartPanel.test.tsx apps/web/src/applications/ApplicationReviewInbox.test.tsx apps/web/src/applications/ApplicationTaskPage.test.tsx`

Expected: PASS。

Run: `rtk pnpm --filter @resume/web build`

Expected: production build succeeds。

- [ ] **Step 5: Run regression suites**

Run: `rtk pnpm --filter @resume/contracts test -- --run`

Run: `rtk pnpm --filter @resume/api test -- --run`

Run: `rtk pnpm --filter @resume/web test -- --run`

Expected: all suites pass。

- [ ] **Step 6: Commit**

```bash
rtk git add apps/web/src/applications/ApplicationStartPanel.tsx apps/web/src/applications/ApplicationStartPanel.test.tsx apps/web/src/applications/ApplicationReviewInbox.tsx apps/web/src/applications/ApplicationReviewInbox.test.tsx apps/web/src/applications/ApplicationTaskPage.tsx apps/web/src/applications/ApplicationTaskPage.test.tsx apps/web/src/styles.css
rtk git commit -m "feat: name application tasks in the workspace"
```
