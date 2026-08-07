# Browser Worker Task Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 取消投递任务时释放 Worker 的任务级状态，并在释放或首次打开失败时条件重建 Worker，避免存活但失效的浏览器会话阻塞新任务。

**Architecture:** Contracts 定义 `release_task/released` IPC；Browser Session 只释放任务状态并保留持久化上下文；Application Service 等待释放完成；Production Dependencies 统一管理可替换的 Worker 实例，并仅对安全的首次打开执行一次重建重试。

**Tech Stack:** TypeScript 5.8、Zod、Vitest 3、Node child_process、Playwright Core、Fastify、pnpm workspace

## Global Constraints

- 正常取消不重启 Worker、不关闭 BrowserContext、不清 Cookie。
- 只有任务释放失败或新任务首次 `open` 失败时重建 Worker。
- 自动重试最多一次，且不用于 `observe`、`execute`、上传、编辑或点击。
- Worker 退出前必须解除旧活动订阅，重建后必须恢复订阅。
- 最终提交禁令、审批令牌、HTTP(S) URL 校验和同源约束保持不变。
- 不提交数据库、构建产物、诊断日志和用户原有 `.superpowers/sdd/*.md` 修改。

---

### Task 1: 任务释放 IPC 与 Browser Session

**Files:**
- Modify: `packages/contracts/src/browser.ts`
- Test: `packages/contracts/src/browser.test.ts`
- Modify: `apps/browser-worker/src/session-manager.ts`
- Test: `apps/browser-worker/src/session-manager.test.ts`
- Modify: `apps/browser-worker/src/ipc-server.ts`
- Test: `apps/browser-worker/src/ipc-server.test.ts`

**Interfaces:**
- Consumes: `WorkerRequestSchema`、`WorkerResponseSchema`、`BrowserSessionManager`。
- Produces: `release_task` 请求、`released` 响应、`BrowserSessionManager.releaseTask(taskId): void`。

- [ ] **Step 1: 写 Contracts 失败测试**

在 `browser.test.ts` 断言：

```ts
expect(WorkerRequestSchema.parse({ type: "release_task", taskId: "task-1" }))
  .toEqual({ type: "release_task", taskId: "task-1" });
expect(WorkerResponseSchema.parse({ type: "released", taskId: "task-1" }))
  .toEqual({ type: "released", taskId: "task-1" });
expect(() => WorkerRequestSchema.parse({ type: "release_task", taskId: "task-1", force: true })).toThrow();
```

- [ ] **Step 2: 运行 Contracts RED**

Run: `rtk pnpm --filter @resume/contracts exec vitest run src/browser.test.ts`

Expected: FAIL，`release_task` 与 `released` 尚未进入 discriminated union。

- [ ] **Step 3: 实现严格 IPC 契约**

在请求和响应 union 中分别加入：

```ts
z.object({ type: z.literal("release_task"), taskId: z.string().min(1) }).strict()
z.object({ type: z.literal("released"), taskId: z.string().min(1) }).strict()
```

- [ ] **Step 4: 写 Session 与 IPC 失败测试**

Session 测试先打开任务、关闭旧同源页并添加跨源残留页，调用 `releaseTask("task-1")` 后断言新任务 `open()` 成功且 `FakeContext.close()` 未调用。IPC 测试发送 `release_task`，断言调用 `session.releaseTask("task-1")` 并返回：

```ts
{ requestId: "release-1", response: { type: "released", taskId: "task-1" } }
```

- [ ] **Step 5: 运行 Browser Worker RED**

Run: `rtk pnpm --filter @resume/browser-worker exec vitest run src/session-manager.test.ts src/ipc-server.test.ts`

Expected: FAIL，`releaseTask` 尚不存在，IPC 返回 `INVALID_REQUEST`。

- [ ] **Step 6: 实现任务级释放**

`releaseTask` 删除该任务 epoch；仅当任务是活动任务时停止 monitor，并清空：

```ts
this.activityMonitor?.stop();
this.activityMonitor = undefined;
this.executor = undefined;
this.activeTaskId = undefined;
this.monitoredTaskId = undefined;
this.trustedOrigin = undefined;
this.preferredPage = undefined;
```

IPC handler 调用它并返回 `released`。不得关闭 Context 或 Page。

- [ ] **Step 7: 验证并提交 Task 1**

Run: `rtk pnpm --filter @resume/contracts exec vitest run src/browser.test.ts`

Run: `rtk pnpm --filter @resume/browser-worker test -- --run`

Commit: `feat: release browser worker task sessions`

### Task 2: Worker Client 释放与可靠停止

**Files:**
- Modify: `apps/api/src/browser/worker-client.ts`
- Test: `apps/api/src/browser/worker-client.test.ts`
- Create: `apps/api/src/browser/fixtures/unresponsive-worker.ts`

**Interfaces:**
- Consumes: Task 1 的 `release_task/released`。
- Produces: `BrowserWorkerClient.releaseTask(taskId): Promise<void>`；`stop()` 在 shutdown 失败时仍终止子进程。

- [ ] **Step 1: 写 releaseTask 失败测试**

使用真实 Worker 启动客户端，先 `open` 再 `releaseTask`，断言随后可为不同任务重新打开页面且登录 Cookie 仍存在。

- [ ] **Step 2: 写强制终止失败测试**

`unresponsive-worker.ts` 完成握手但忽略 `shutdown`。用较短 `requestTimeoutMs` 启动，调用 `stop()` 后断言子进程写出退出标记且 `stop()` 不留下存活进程。

- [ ] **Step 3: 运行 RED**

Run: `rtk pnpm --filter @resume/api exec vitest run src/browser/worker-client.test.ts`

Expected: FAIL，`releaseTask` 不存在；shutdown 超时后未执行 `terminate()`。

- [ ] **Step 4: 实现客户端释放与停止兜底**

新增：

```ts
async releaseTask(taskId: string): Promise<void> {
  const response = await this.request({ type: "release_task", taskId });
  if (response.type !== "released") throw new Error(`浏览器 Worker 返回了意外响应：${response.type}`);
}
```

`stop()` 使用 `try/finally`：优雅 shutdown 或等待退出失败时调用 `terminate()`；方法返回时子进程必须退出。避免重复触发已停止客户端。

- [ ] **Step 5: 验证并提交 Task 2**

Run: `rtk pnpm --filter @resume/api exec vitest run src/browser/worker-client.test.ts`

Commit: `fix: terminate unhealthy browser workers`

### Task 3: 取消流程等待 Worker 释放

**Files:**
- Modify: `apps/api/src/applications/application-service.ts`
- Test: `apps/api/src/applications/application-machine.test.ts`
- Modify: `apps/api/src/applications/routes.ts`
- Test: `apps/api/src/applications/routes.test.ts`

**Interfaces:**
- Consumes: `BrowserPort.releaseTask?(taskId): Promise<void>`。
- Produces: `ApplicationService.cancel(taskId): Promise<void>`；取消响应只在释放完成后返回。

- [ ] **Step 1: 写异步取消失败测试**

用受控 Promise 实现 `releaseTask`，调用 `service.cancel(taskId)` 后断言释放完成前任务锁仍在；完成 Promise 后断言状态为 `cancelled`、锁释放，且 `invalidateExecution` 发生在 `releaseTask` 前。

- [ ] **Step 2: 写路由失败测试**

让 `applicationService.cancel` 拒绝，断言命令接口不返回 200；成功路径断言路由等待异步取消完成。

- [ ] **Step 3: 运行 RED**

Run: `rtk pnpm --filter @resume/api exec vitest run src/applications/application-machine.test.ts src/applications/routes.test.ts`

Expected: FAIL，当前 cancel 同步返回且不调用 `releaseTask`。

- [ ] **Step 4: 实现异步取消**

将接口与实现改为 `Promise<void>`。顺序必须是：使 run generation 失效、取消进度、`await invalidateExecution(taskId)`、`await releaseTask?.(taskId)`、发送 `CANCEL`、释放 API 锁、持久化。

路由改为：

```ts
case "cancel":
  await service.cancel(taskId);
  return;
```

- [ ] **Step 5: 验证并提交 Task 3**

Run: `rtk pnpm --filter @resume/api exec vitest run src/applications/application-machine.test.ts src/applications/routes.test.ts`

Commit: `fix: release browser session on task cancellation`

### Task 4: 生产 Worker 条件回收与单次重试

**Files:**
- Modify: `apps/api/src/production-dependencies.ts`
- Test: `apps/api/src/production-dependencies.test.ts`

**Interfaces:**
- Consumes: `BrowserWorkerClient.releaseTask()`、`stop()`、Worker 启动 options。
- Produces: 可替换 Worker lifecycle；`open` 失败重建后只重试一次；`releaseTask` 失败重建后视为释放完成。

- [ ] **Step 1: 写首次打开单次恢复失败测试**

注入可计数的 Worker 工厂：首实例 `open` 拒绝，次实例成功。断言启动两次、首实例停止一次、第二实例只调用一次 `open`；两个实例都接收到活动订阅。

- [ ] **Step 2: 写释放恢复失败测试**

首实例 `releaseTask` 拒绝，断言生产 BrowserPort 停止首实例并启动第二实例；取消完成且不会调用第二实例的 `releaseTask`。

- [ ] **Step 3: 写失败上限测试**

两个实例的 `open` 都拒绝，断言只启动两次并把第二次错误抛给任务创建路由，不进行第三次重试。

- [ ] **Step 4: 运行 RED**

Run: `rtk pnpm --filter @resume/api exec vitest run src/production-dependencies.test.ts`

Expected: FAIL，当前生产层永久缓存首个 Worker Promise，没有替换和重试入口。

- [ ] **Step 5: 实现 Worker lifecycle owner**

保存启动 options，集中实现：

```ts
getBrowserClient(): Promise<BrowserClient>
recycleBrowserClient(failed: BrowserClient): Promise<BrowserClient>
withOpenRecovery(taskId: string, url: string): Promise<unknown>
releaseBrowserTask(taskId: string): Promise<void>
```

回收时先解除旧订阅，再可靠停止旧实例，清空缓存，启动并绑定新实例。`withOpenRecovery` 只捕获一次首轮错误并重试；`observe/execute` 继续直接失败。

- [ ] **Step 6: 验证并提交 Task 4**

Run: `rtk pnpm --filter @resume/api exec vitest run src/production-dependencies.test.ts`

Commit: `fix: recycle stale browser workers once`

### Task 5: 集成验证与服务更新

**Files:**
- Verify: `apps/api/dist/server.js`
- Verify: `apps/api/dist/browser-worker.js`
- Verify: `apps/api/data/resume-assistant.sqlite`

**Interfaces:**
- Consumes: Tasks 1-4 的完整取消和恢复链。
- Produces: 最新本地构建、运行服务和真实创建/取消证据。

- [ ] **Step 1: 全量测试与静态检查**

Run: `rtk pnpm --filter @resume/contracts test -- --run`

Run: `rtk pnpm --filter @resume/browser-worker test -- --run`

Run: `rtk pnpm --filter @resume/api test -- --run`

Run: `rtk pnpm --filter @resume/web test -- --run`

Run: `rtk pnpm typecheck`

Run: `rtk git diff --check master..HEAD`

- [ ] **Step 2: 构建并重启 API**

Run: `rtk pnpm --filter @resume/api build`

仅停止当前项目 API 与 Browser Worker，使用隐藏窗口重新启动。确认 `GET /api/health/adapters` 返回 200。

- [ ] **Step 3: 真实安全验证**

用大疆职位列表 URL 创建诊断任务，取消后不重启 API，再创建第二个任务。断言两次创建均为 201、取消为 200；随后取消并删除诊断任务。不得填写或提交招聘表单。

- [ ] **Step 4: 最终状态检查**

Run: `rtk git status --short --branch`

Expected: 仅保留用户原有五份 `.superpowers/sdd/*.md` 修改；诊断日志、数据库和构建产物不进入提交。
