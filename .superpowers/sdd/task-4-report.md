# Task 4 Report

## 状态

完成。直接在当前工作区实现，按用户要求未创建 worktree、提交或自动合并。

## 实现摘要

- 新增服务器权威的投递进度协调器：每个任务仅允许一个 active operation，使用 generation 隔离过期完成/失败响应，并确保成功、失败、超时和取消都释放 busy 状态。
- 操作开始、完成、失败、暂停和恢复均写入可恢复进度检查点，并通过持久化事件总线支持 SSE 重放与 history gap reset。
- 固化超时与重试策略：普通 `fill`/`select` 每个字段最多自动重试一次；上传和中间点击不自动重试；暂停期间禁止继续执行字段。
- 任意用户活动都会取消当前待执行自动操作，避免覆盖用户正在输入的内容；无 active operation 时不会凭空暂停。
- 接入 Worker 活动：用户操作、页面不稳定和 Worker 断线触发暂停；页面稳定后执行本地页面回读，仅在当前值、可见错误和检查点结构验证通过后自动恢复。
- 新增 `retry_current`、`manual_done`、`cancel` 恢复路由。所有恢复动作均重新观察页面并验证检查点或人工填写结果，没有新增提交能力。
- 生产依赖组合保持浏览器惰性启动，并在客户端首次解析后转发 `onActivity`，保证真实 Worker 活动进入 Application Service 和事件总线。

## RED 证据

`corepack pnpm --filter @resume/api exec vitest run src/applications/application-progress.test.ts`

- 8/10 通过，2 项按预期失败。
- 跨字段用户活动未取消 pending operation，测试超时。
- 第二个新字段复用了任务全局重试次数，首次失败后未获得独立重试机会。

`corepack pnpm --filter @resume/api exec vitest run src/production-dependencies.test.ts -t "lazily forwards browser Worker activity"`

- 0/1 通过：创建任务并启动浏览器后，`onActivity` 调用次数仍为 0，证明生产组合漏掉活动通道。

## GREEN 证据

- `application-progress.test.ts`：10/10 通过。
- Task 4 聚焦测试：6 个文件，65/65 通过。
- 完整 API 测试：25 个文件，214/214 通过。
- `@resume/api` typecheck：通过。
- `git diff --check`：通过。

最终复验：Task 4 聚焦测试 6 个文件、65/65 通过；严格 TypeScript fixture 已修正，`@resume/api` typecheck 与 `git diff --check` 均以退出码 0 通过。

## 主要文件

- `apps/api/src/applications/application-progress.ts`
- `apps/api/src/applications/application-progress.test.ts`
- `apps/api/src/applications/application-service.ts`
- `apps/api/src/applications/application-machine.test.ts`
- `apps/api/src/applications/checkpoint-repository.ts`
- `apps/api/src/applications/task-events.ts`
- `apps/api/src/applications/task-events.test.ts`
- `apps/api/src/applications/routes.ts`
- `apps/api/src/applications/routes.test.ts`
- `apps/api/src/production-dependencies.ts`
- `apps/api/src/production-dependencies.test.ts`

## 安全边界

- 活动事件不携带输入值、密码、验证码、原始标签、选择器、坐标或 CDP 数据。
- 页面观察与稳定性判断均在本地完成，不调用 DeepSeek。
- 用户活动优先于自动操作，恢复前必须回读验证。
- Worker 活动不能结算请求响应，也不能产生终态提交命令。
- 自动化仍无法执行 `terminal_submit`，最终提交必须由用户人工审核和操作。

## 关注项

无 Task 4 范围内已知阻塞。Task 5 将消费这些进度和活动事件，构建精简任务界面。

## 审查修复：运行取消边界

- 在 `ApplicationService` 中增加每任务运行代际。显式取消或用户活动会使当前 `runUntilPause` 失效，异步字段解析或过期浏览器结果无法重新启动自动化。
- 显式取消现在会终止 active progress operation、释放 `busy`、保留状态机的 `cancelled` 状态，且不提供恢复命令。
- 用户在规划/解析阶段活动时，即使协调器没有 active operation，也会暂停进度；排队运行在解析完成后直接退出，不会开始字段执行。
- 现有可执行命令边界保持不变，未增加提交能力、UI 行为或 IPC 契约。

### 审查 RED 证据

- 两条服务并发回归测试按预期失败：显式取消后 `busy` 仍为 `true`；字段解析期间用户活动后进度仍为 `idle`，排队运行可继续。
- 协调器回归测试按预期因缺少显式操作取消能力而失败。

### 审查 GREEN 证据

- 定向审查回归测试：3/3 通过。
- 完整 Task 4 聚焦测试：5 个文件，65/65 通过。
- `corepack pnpm --filter @resume/api typecheck`：退出码 0。
- `git diff --check`：退出码 0。

### 审查关注项

Task 4 范围内无已知问题。
