# Browser Worker 任务释放与条件恢复设计

## 背景

当前取消任务只停止 API 状态机、释放任务锁并使旧执行序号失效。Browser Worker 仍保留当前任务 ID、页面监听、执行器、执行序号和 `trustedOrigin`。当用户关闭、跳转或跨域切换旧页面后，新任务可能在 `ensureActivePage()` 阶段被旧会话状态阻断；Worker 进程仍存活，因此现有健康检查无法发现该问题。

## 目标

- 取消任务时完整释放任务级浏览器状态，但保留持久化浏览器上下文、Cookie 和登录态。
- 新任务首次打开遇到 Worker 通信或会话错误时，回收 Worker 并重试一次。
- 释放失败时条件回收 Worker，不让取消接口带着失效会话成功返回。
- 不引入多任务并行、浏览器池、跨站共享自动化或终态提交能力。

## 方案比较

### 方案 A：每次取消都重启 Worker

实现简单，但会关闭用户正在看的受控浏览器、增加启动延迟，并可能打断尚未保存的人工操作。持久化 Profile 可以保留 Cookie，但不能保留当前页面交互状态。

### 方案 B：任务级释放，故障时条件重启

新增 `release_task` IPC。正常取消只清理任务 ID、监听器、执行器、执行序号和旧域名约束，保留 BrowserContext 与页面；释放或下一次首次打开失败时才回收并重建 Worker，且只重试一次。这是采用方案。

### 方案 C：每个任务独立 BrowserContext

隔离最强，但与当前单一持久化登录会话模型冲突，改动和资源成本明显更高，不符合本次稳定化范围。

## 架构

### 契约与 Worker

`WorkerRequestSchema` 增加：

```ts
{ type: "release_task"; taskId: string }
```

`WorkerResponseSchema` 增加：

```ts
{ type: "released"; taskId: string }
```

`BrowserSessionManager.releaseTask(taskId)` 仅在该任务是当前活动任务时停止 Activity Monitor，清空 `activeTaskId`、`monitoredTaskId`、执行器、旧域名和首选页面；无论是否活动都删除该任务执行序号。它不关闭 BrowserContext，不清 Cookie，也不执行页面动作。

下一次 `open()` 会从保留的上下文中重新绑定一个可用页面，再导航到经过 HTTP(S) 校验的目标 URL。

### API 状态机

`BrowserPort` 增加可选的 `releaseTask(taskId)`。`ApplicationService.cancel()` 改为异步：先让运行代际失效并取消进度，再等待 Worker 释放，然后进入 `cancelled` 并释放 API 浏览器锁。释放失败时不伪装成功，由路由返回稳定错误；生产适配器负责在可恢复故障下重建 Worker。

任务创建失败后的 `dispose()` 仍负责清理内存状态，现有任务锁回滚规则保持不变。

### Worker 生命周期恢复

生产依赖层集中拥有 Worker 启动参数与当前实例。正常 `open/observe/execute` 复用同一实例。

- `releaseTask` 失败：强制回收当前实例，启动新 Worker；取消流程随后成功结束。
- 新任务首次 `open` 失败：回收当前实例，启动新 Worker并重试同一安全导航一次。
- 第二次失败：原样抛出，不循环重试。
- `observe` 和 `execute` 不做隐式进程级重试，避免在未知页面状态下重复编辑。

重建时重新绑定 API 的活动监听器。旧实例的订阅被解除，失败的启动 Promise 不进入永久缓存。

## 错误与安全边界

- `release_task` 不填写、点击、上传或提交。
- 自动重试仅用于新任务的首次 `open`，不重试表单编辑和中间点击。
- Worker 优雅停止失败时必须终止子进程，防止同一 Profile 被两个 Chromium 上下文同时占用。
- 终态提交禁令、审批令牌、同源页面约束和 URL 协议校验保持不变。
- 用户原有 `.superpowers/sdd` 修改不纳入提交。

## 测试

- Contracts：`release_task` 与 `released` 严格解析，拒绝额外字段。
- Session Manager：释放后可以从跨源残留页面打开新任务，并保留 BrowserContext。
- IPC：`release_task` 调用会话并返回 `released`。
- Worker Client：发送释放请求；停止超时时强制终止。
- Application Service/Routes：取消会等待释放完成，释放失败不提前释放锁或返回成功。
- Production Dependencies：释放失败条件重建；首次 `open` 失败只重试一次；新实例重新订阅活动。
- 全量 API、Contracts、Browser Worker、Web 回归与真实本地创建/取消验证。
