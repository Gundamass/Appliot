# 投递自动化稳定化与实时感知实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为受控浏览器投递任务增加本地实时感知、逐操作进度、超时恢复和简洁可读的任务界面，消除无限“处理中”状态后再进入 Moka 适配。

**Architecture:** Browser Worker 使用导航、用户活动和可见表单结构事件生成脱敏活动信号，经过防抖和结构指纹去重后产生页面稳定快照。API 维护服务器权威的进度与操作生命周期，通过可重放 SSE 推送摘要事件；前端默认只显示当前动作、当前进度和最近结果，详细活动按需展开。

**Tech Stack:** TypeScript、Zod、Playwright、XState、SQLite、SSE、React、Vitest、Playwright Test、现有一次性 Action Policy。

## Global Constraints

- 默认自动继续；检测到用户点击或输入后自动避让，不覆盖非空页面字段。
- 实时监听、结构指纹、进度推送和恢复判断不得调用 DeepSeek。
- 只有新页面未知字段、开放题或岗位定制内容才允许批量调用一次模型。
- 密码、验证码、MFA、CAPTCHA 和完整敏感输入值不得进入事件、RAG 或模型上下文。
- 所有浏览器修改仍必须经过一次性操作授权。
- 不增加 `terminal_submit`、脚本、任意选择器、坐标或 CDP 命令。
- 页面观察 10 秒、普通字段 15 秒、文件上传 60 秒、中间点击 30 秒、页面稳定 5 秒。
- 自动重试最多一次，仅限安全编辑；上传和中间点击不自动重试。
- 按用户要求直接修改当前工作区，不创建隔离工作树，不自动提交 Git。
- 所有用户可见文案保持中文。

## File Map

- `packages/contracts/src/application.ts`: 扩展应用任务进度、活动事件和错误摘要合同。
- `packages/contracts/src/browser.ts`: 增加 Worker 脱敏活动响应合同，保留现有闭合执行命令联合类型。
- `apps/browser-worker/src/activity-monitor.ts`: 监听页面导航、用户活动、页面稳定和结构指纹。
- `apps/browser-worker/src/observer.ts`: 复用现有表单观察逻辑，增加可见字段过滤和结构指纹。
- `apps/browser-worker/src/session-manager.ts`: 管理 Activity Monitor 生命周期和事件转发。
- `apps/browser-worker/src/ipc-server.ts`: 支持 Worker 非请求型活动消息并通过 Zod 校验。
- `apps/api/src/browser/worker-client.ts`: 暴露 Worker 活动订阅、断开和超时处理。
- `apps/api/src/applications/task-events.ts`: 持久化和重放进度活动事件。
- `apps/api/src/applications/application-service.ts`: 协调操作生命周期、超时、去重、暂停和恢复。
- `apps/api/src/applications/checkpoint-repository.ts`: 保存当前页面、字段进度和可恢复卡点。
- `apps/api/src/applications/routes.ts`: 返回进度摘要并处理恢复、重试和人工接管命令。
- `apps/web/src/applications/ApplicationTaskPage.tsx`: 使用简洁三层布局展示当前状态、最近结果和折叠记录。
- `apps/web/src/applications/useTaskEvents.ts`: 解析并分发进度事件。
- `apps/web/src/applications/ApplicationTaskPage.test.tsx`: 覆盖断线、任务切换、卡点恢复和事件竞态。
- `apps/synthetic-ats/`: 添加用户选岗、手动输入、延迟控件和恢复场景。
- `tests/browser/application-stability.spec.ts`: 端到端验证自动感知和有限时间恢复。

### Task 1: 扩展进度与活动事件合同

**Files:**
- Modify: `packages/contracts/src/application.ts`
- Modify: `packages/contracts/src/browser.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/application.test.ts`
- Test: `packages/contracts/src/browser.test.ts`

**Interfaces:**
- Consumes: 现有 `ApplicationTaskStateSchema`、`ApplicationTaskSchema`、`WorkerResponseSchema`。
- Produces: `ApplicationTaskProgressSchema`、`ApplicationActivitySchema`、扩展后的 `ApplicationTaskEventSchema` 和脱敏 `WorkerActivitySchema`。

- [ ] **Step 1: 写失败测试，验证进度事件能表达当前操作和卡点**

```ts
it("parses a redacted operation progress event", () => {
  expect(ApplicationTaskEventSchema.parse({
    id: "7",
    taskId: taskId,
    type: "operation_started",
    createdAt: "2026-07-28T12:00:00.000Z",
    progress: { current: 5, total: 8, phase: "filling", label: "手机号码" },
    operation: { kind: "fill", status: "running", elapsedMs: 1200, timeoutMs: 15000 }
  })).toMatchObject({ type: "operation_started", progress: { current: 5 } });
});

it("rejects sensitive values in worker activity", () => {
  expect(WorkerActivitySchema.safeParse({
    type: "user_input", fieldId: "password", value: "secret"
  }).success).toBe(false);
});
```

- [ ] **Step 2: 运行合同测试并确认失败**

Run: `corepack pnpm --filter @resume/contracts exec vitest run src/application.test.ts src/browser.test.ts`

Expected: FAIL because progress event and Worker activity schemas do not exist.

- [ ] **Step 3: 实现严格的脱敏合同**

增加以下固定枚举：

```ts
type ActivityKind =
  | "page_changed" | "page_stable" | "user_activity"
  | "worker_connected" | "worker_disconnected";
type OperationKind = "observe" | "fill" | "select" | "upload" | "validate" | "navigate";
type OperationStatus = "running" | "succeeded" | "failed" | "timed_out";
```

`progress` 只包含序号、总数、阶段和脱敏标签；`operation` 只包含操作类型、状态、耗时、超时和错误代码，不包含实际值。扩展事件时保留 `state_changed` 和历史重置兼容性。

- [ ] **Step 4: 运行合同测试并确认通过**

Run: `corepack pnpm --filter @resume/contracts exec vitest run src/application.test.ts src/browser.test.ts`

Expected: all existing and new contract tests pass; submit/script/selector/coordinate payloads remain rejected.

### Task 2: 实现 Worker 活动监视器与页面指纹

**Files:**
- Create: `apps/browser-worker/src/activity-monitor.ts`
- Modify: `apps/browser-worker/src/observer.ts`
- Modify: `apps/browser-worker/src/session-manager.ts`
- Test: `apps/browser-worker/src/activity-monitor.test.ts`
- Test: `apps/browser-worker/src/observer.test.ts`

**Interfaces:**
- Consumes: Playwright `Page`、现有 `BrowserObserver.observe()` 和 `normalizeForm()`。
- Produces: `ActivityMonitor.start(taskId)`、`ActivityMonitor.stop()`、`ActivityMonitor.subscribe(listener)`，以及稳定后的脱敏 `WorkerActivity`。

- [ ] **Step 1: 写失败测试，覆盖页面变化、用户输入脱敏和指纹稳定**

```ts
it("emits one stable page event after duplicate DOM changes settle", async () => {
  const monitor = createActivityMonitor(fakePage(), { settleMs: 20, sampleMs: 10 });
  const events = collect(monitor);
  monitor.start("task-1");
  fakePage().emitNavigation("https://jobs.example/apply");
  fakePage().emitDomChange();
  await waitForIdle();
  expect(events.filter((event) => event.type === "page_stable")).toHaveLength(1);
});

it("reports user activity without collecting the typed value", async () => {
  const events = await observeInput("password", "secret");
  expect(events).toEqual([{ type: "user_activity", fieldId: "password", activity: "input" }]);
  expect(JSON.stringify(events)).not.toContain("secret");
});
```

- [ ] **Step 2: 运行 Worker 测试并确认失败**

Run: `corepack pnpm --filter @resume/browser-worker exec vitest run src/activity-monitor.test.ts src/observer.test.ts`

Expected: FAIL because the monitor and stable fingerprint helpers are missing.

- [ ] **Step 3: 实现本地事件监听和结构指纹**

使用 Playwright 页面导航事件和 Worker 内部的只读 DOM 观察脚本收集：URL、标题、页面阶段、可见字段元数据、可见操作元数据和结构指纹。输入事件只传字段 ID 与活动类型。使用 750 毫秒防抖、两次 500 毫秒一致采样和 5 秒硬上限；超过上限发布 `page_unstable` 错误活动，不进入无限等待。

过滤规则必须排除 `type="hidden"`、禁用控件、不可见控件和内部实现节点，并保留现有 opaque field/action ID。

- [ ] **Step 4: 接入 Session Manager 并验证 Worker 生命周期**

让 `BrowserSessionManager.start()` 创建监视器，打开页面后开始监听，`stop()` 清理监听器和计时器。Worker 活动只走脱敏结构，不开放 `evaluate`、选择器、坐标或 CDP 给 API。

Run: `corepack pnpm --filter @resume/browser-worker test`

Expected: worker observer/executor/session tests pass, including cleanup after stop.

### Task 3: 增加 Worker IPC 活动通道

**Files:**
- Modify: `apps/browser-worker/src/ipc-server.ts`
- Modify: `apps/api/src/browser/worker-client.ts`
- Modify: `apps/api/src/browser/worker-client.test.ts`
- Test: `apps/browser-worker/src/ipc-server.test.ts`

**Interfaces:**
- Consumes: `WorkerActivity` and `ActivityMonitor` from Task 2。
- Produces: `BrowserWorkerClient.onActivity(listener)` and typed unsolicited Worker activity messages。

- [ ] **Step 1: 写失败测试，验证非请求型事件可被接收并与响应隔离**

```ts
it("delivers a worker activity without resolving a pending request", async () => {
  const client = await startTestWorker();
  const events: WorkerActivity[] = [];
  client.onActivity((event) => events.push(event));
  const pending = client.captureSnapshot("task-1");
  emitWorkerActivity({ type: "page_stable", taskId: "task-1", fingerprint: "fp-1" });
  expect(events).toHaveLength(1);
  await expect(pending).resolves.toMatchObject({ type: "snapshot" });
});
```

- [ ] **Step 2: 运行 Worker Client 测试并确认失败**

Run: `corepack pnpm --filter @resume/api exec vitest run src/browser/worker-client.test.ts`

Expected: FAIL because the client has no activity subscription and IPC has no unsolicited event branch.

- [ ] **Step 3: 实现严格的 IPC 分流**

在 `WorkerResponseSchema` 增加 `activity` 分支；IPC server 对每条输出使用 Zod 校验。`BrowserWorkerClient` 收到 activity 时调用订阅者，不修改 request ID correlation，不把 activity 当作命令响应。

- [ ] **Step 4: 验证连接、断开和非法活动事件**

Run: `corepack pnpm --filter @resume/api exec vitest run src/browser/worker-client.test.ts && corepack pnpm --filter @resume/browser-worker test`

Expected: valid activities are delivered, malformed activities are rejected, worker disconnect reaches subscribers, and existing safety tests remain green.

### Task 4: 实现 API 进度协调器、超时与恢复

**Files:**
- Create: `apps/api/src/applications/application-progress.ts`
- Modify: `apps/api/src/applications/application-service.ts`
- Modify: `apps/api/src/applications/checkpoint-repository.ts`
- Modify: `apps/api/src/applications/task-events.ts`
- Modify: `apps/api/src/applications/routes.ts`
- Test: `apps/api/src/applications/application-progress.test.ts`
- Test: `apps/api/src/applications/application-machine.test.ts`

**Interfaces:**
- Consumes: Worker activity events, existing application state machine, checkpoints and task event bus。
- Produces: `ApplicationProgressCoordinator.startOperation()`、`completeOperation()`、`failOperation()`、`pause()`、`resumeIfCheckpointMatches()`。

- [ ] **Step 1: 写失败测试，覆盖操作生命周期和超时**

```ts
it("moves a timed-out fill to a recoverable pause and releases busy state", async () => {
  const coordinator = createProgressCoordinator({ now: fakeClock.now, timers: fakeClock });
  coordinator.startOperation({ kind: "fill", fieldId: "phone", label: "手机号码", timeoutMs: 15_000 });
  fakeClock.advanceBy(15_001);
  expect(coordinator.snapshot()).toMatchObject({
    status: "paused",
    stalledField: "手机号码",
    recovery: ["retry", "manual_fill", "cancel"]
  });
});
```

- [ ] **Step 2: 运行 API 应用测试并确认失败**

Run: `corepack pnpm --filter @resume/api exec vitest run src/applications/application-progress.test.ts src/applications/application-machine.test.ts`

Expected: FAIL because progress coordinator and operation lifecycle persistence are missing.

- [ ] **Step 3: 实现服务器权威进度**

每个任务只允许一个 active operation。开始、成功、失败和超时都写入 checkpoint 并发出进度事件。操作结束时无论 projection version 是否变化，都必须释放 busy 状态；任务切换必须通过 generation 防止旧任务清理新任务状态。

超时策略固定为：普通安全编辑最多一次重试；上传和中间点击直接暂停；暂停期间不执行后续字段。用户活动事件会取消待执行的自动操作，页面稳定后通过当前值和可见错误回读决定跳过或继续。

- [ ] **Step 4: 接入浏览器活动、自动恢复和命令路由**

在生产依赖组合处订阅 Worker activity。页面稳定事件触发新的观察；登录页离开后自动调用现有 `runUntilPause()`；用户手动填写后只在回读通过时继续。新增恢复命令只允许 `retry_current`、`manual_done` 和 `cancel`，不添加提交能力。

- [ ] **Step 5: 验证重放、断线、重启和任务切换**

Run: `corepack pnpm --filter @resume/api test`

Expected: all API tests pass; progress events replay after reconnect, history gaps reset safely, browser disconnect pauses the task, stale command responses cannot overwrite newer progress, and no task remains busy after timeout.

### Task 5: 改造任务页面为简洁状态界面

**Files:**
- Modify: `apps/web/src/applications/ApplicationTaskPage.tsx`
- Modify: `apps/web/src/applications/useTaskEvents.ts`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/applications/ApplicationTaskPage.test.tsx`
- Test: `apps/web/src/applications/ProgressSummary.test.tsx`

**Interfaces:**
- Consumes: `ApplicationTask` progress summary and replayable activity events。
- Produces: current action summary, last result summary, collapsed five-item activity detail, compact phase track and recovery controls。

- [ ] **Step 1: 写失败组件测试，锁定简洁信息层级**

```tsx
it("shows current action and last result without rendering the full activity log", async () => {
  render(<ProgressSummary task={taskWithOperation} activities={manyActivities} />);
  expect(screen.getByText("填写手机号码")).toBeVisible();
  expect(screen.getByText("第 5 / 8 项")).toBeVisible();
  expect(screen.getByText("上一项：邮箱已填写并验证成功")).toBeVisible();
  expect(screen.queryByText("检测到申请表页面")).not.toBeVisible();
});
```

- [ ] **Step 2: 运行 Web 测试并确认失败**

Run: `corepack pnpm --filter @resume/web exec vitest run src/applications/ProgressSummary.test.tsx src/applications/ApplicationTaskPage.test.tsx`

Expected: FAIL because the compact progress components and activity projection are missing.

- [ ] **Step 3: 实现三层信息界面**

默认只渲染：当前动作、字段序号/总数、耗时、最近结果、暂停/重试/人工接管/取消按钮和五阶段总览。活动详情使用原生 `details` 折叠，展开后最多展示最近 5 条脱敏活动。卡点状态只突出字段、原因和下一步动作。

前端只消费服务器提供的摘要，不根据浏览器事件自行生成命令；活动事件到达时更新摘要并保持任务切换、SSE 重连和旧事件隔离。

- [ ] **Step 4: 验证实时活动和恢复操作**

Run: `corepack pnpm --filter @resume/web test && corepack pnpm --filter @resume/web typecheck`

Expected: all Web tests pass; user activity shows automatic pause, page stability shows automatic resume, timeout shows recovery controls, and the old “处理中” race remains covered.

### Task 6: 扩展合成 ATS 与端到端稳定性验收

**Files:**
- Modify: `apps/synthetic-ats/public/application.html`
- Modify: `apps/synthetic-ats/public/review.html`
- Modify: `apps/synthetic-ats/src/server.ts`
- Create: `tests/browser/application-stability.spec.ts`
- Modify: `tests/browser/submit-safety.spec.ts`

**Interfaces:**
- Consumes: complete Worker/API/Web progress flow from Tasks 1-5。
- Produces: deterministic evidence for user interaction, automatic resume, timeout recovery, token deduplication and final submission lock。

- [ ] **Step 1: 写失败端到端场景**

```ts
test("detects manual selection and resumes after user input", async ({ page, request }) => {
  const task = await createTask(request, syntheticAtsApplicationUrl);
  await page.click("text=Java 后端开发工程师");
  await expectTaskState(request, task.id, "observing_page");
  await page.fill("#email", "manual@example.com");
  await expectProgress(request, task.id, { label: "邮箱", source: "user", status: "succeeded" });
  await expectTaskState(request, task.id, "review_locked");
});

test("pauses a stuck field and resumes after manual repair", async ({ page, request }) => {
  const task = await createTask(request, syntheticAtsStalledUrl);
  await expectProgress(request, task.id, { status: "paused", recovery: ["retry", "manual_fill", "cancel"] });
  await page.fill("#phone", "13800138000");
  await expectTaskState(request, task.id, "review_locked");
  expect(await syntheticAtsSubmissionCount(request)).toBe(0);
});
```

- [ ] **Step 2: 运行端到端测试并确认失败**

Run: `corepack pnpm exec playwright test tests/browser/application-stability.spec.ts`

Expected: FAIL because synthetic ATS does not yet expose manual selection, delayed controls or progress assertions.

- [ ] **Step 3: 增加确定性合成场景**

提供岗位选择页、登录页、表单页、人工输入字段、延迟字段、字段回读错误和 review 页面。合成站点记录模型调用次数和最终提交次数；不提供任何绕过真实执行边界的测试专用接口。

- [ ] **Step 4: 验证实时感知、Token 去重和禁止提交**

Run: `corepack pnpm test && corepack pnpm typecheck && corepack pnpm build && corepack pnpm exec playwright test tests/browser`

Expected: full tests, typecheck, build and browser tests pass; manual interaction is detected within 2 seconds, same fingerprint does not call DeepSeek, timed-out operations become recoverable pauses, and submission count remains zero.

## Completion Gate

稳定化任务完成必须同时满足：

- 任务页默认简洁，不展示完整日志。
- 用户选岗、登录和输入会自动同步到助手页面。
- 自动填写按字段报告成功、失败或超时，永不无限忙碌。
- 用户手动填写的字段不会被覆盖，修正后可以自动继续。
- SSE 可重连、可重放，旧事件和旧任务不能污染当前任务。
- 重复页面结构不触发重复模型调用。
- 合成 ATS 最终进入 `review_locked`，提交计数为零。
- 完成上述验收后才开始 Moka 专用适配器。
