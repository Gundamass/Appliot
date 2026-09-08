# 对话优先工作区与招聘入口发现实施计划

**目标：** 实现“公司校招入口发现 -> 用户确认 -> 岗位推荐 -> 受控投递”的对话流程，统一蓝白工作区，并删除独立岗位导航；保留现有匹配和受控投递安全边界。

**执行约束：** 当前会话逐 Task 执行，不创建子智能体；严格先写失败测试；每个 Task 完成后立即运行对应测试并用中文汇报；不实现企业招聘状态跟踪；保留现有未提交回归报告。

**执行状态（2026-08-24）：** Task 1–4 的实现及对应定向测试已完成；Task 5 的功能回归和视觉检查已完成。全量 API/Browser Worker 测试、仓库根类型检查和 API 构建仍受当前工作树依赖缺失、并发清理超时及 monorepo TypeScript OOM 影响，详见 [中文回归报告](../../testing/2026-08-22-chat-first-workspace-regression.md)；企业招聘状态跟踪按约束未实现。

## Task 1：受限浏览器招聘入口发现

**文件：**

- 修改 `packages/contracts/src/browser.ts`
- 修改 `packages/contracts/src/browser.test.ts`
- 新增 `apps/browser-worker/src/recruitment-site-discovery.ts`
- 新增 `apps/browser-worker/src/recruitment-site-discovery.test.ts`
- 修改 `apps/browser-worker/src/session-manager.ts`
- 修改 `apps/browser-worker/src/session-manager.test.ts`
- 修改 `apps/browser-worker/src/ipc-server.ts`
- 修改 `apps/api/src/browser/worker-client.ts`
- 修改 `apps/api/src/browser/worker-client.test.ts`
- 修改 `apps/api/src/browser/fixtures/activity-worker.ts`

- [x] 先添加失败测试：封闭协议、固定查询、安全 URL、广告过滤、前三个自然结果、最终 URL 校验、IPC 客户端。
- [x] 新增 `search_recruitment_site` 请求和 `recruitment_site_found` 响应契约。
- [x] 实现独立发现器，仅使用固定搜索 URL、只读结果解析和受限页面导航。
- [x] 在 SessionManager、IPC 和 BrowserWorkerClient 串联该操作并正确记录 `ownerId`。
- [x] 运行 contracts、browser-worker、API browser client 对应测试：定向测试 40/40、26/26、32/32 通过。

## Task 2：百度岗位页面适配

**文件：**

- 新增 `packages/job-matching/src/adapters/baidu-job-adapter.ts`
- 新增 `packages/job-matching/src/adapters/baidu-job-adapter.test.ts`
- 修改 `packages/job-matching/src/adapters/index.ts`
- 视真实快照需要修改 `apps/browser-worker/src/job-observer.ts` 及其测试
- 修改 `apps/api/src/production-dependencies.ts`

- [x] 采集并固化百度校招岗位列表/详情的最小脱敏快照。
- [x] 先添加失败测试：URL 支持、筛选映射、岗位提取、分页和不支持页面。
- [x] 实现百度适配器，必要时仅扩展通用 JobPageSnapshot 的结构化观察能力。
- [x] 在生产依赖中注册百度适配器。
- [x] 运行 job-matching、browser-worker 观察器和 production dependencies 对应测试：岗位匹配全量 65/65、百度适配器 4/4、Browser Worker 定向 26/26 通过。

## Task 3：公司意图、入口确认、岗位推荐与投递卡片

**文件：**

- 修改 `packages/contracts/src/conversation.ts` 及测试
- 修改 `apps/api/src/conversations/conversation-graph.ts`
- 修改 `apps/api/src/conversations/conversation-tools.ts`
- 修改对话图和 E2E 测试
- 修改 `apps/web/src/conversation/ConversationCards.tsx`
- 修改 `apps/web/src/conversation/ChatHome.tsx`
- 修改对应前端测试

- [x] 先添加失败测试：识别公司校招意图、入口卡片、入口确认、推荐确认/取消和幂等。
- [x] 增加招聘入口发现工具并在完成后释放搜索租约。
- [x] 将确认入口写入对话上下文；只有用户确认“需要推荐”后才调用现有 `jobMatchService.create({ url })`。
- [x] 复用现有推荐卡片、岗位选择、`start_application` 确认和任务卡片。
- [x] 增加前端招聘入口及推荐确认卡片，不自动登录、不自动提交。
- [x] 运行 contracts、API conversation 和 web conversation 对应测试：Contracts 40/40、API 对话/浏览器客户端 32/32、Web 对话/导航相关测试通过。

## Task 4：统一蓝白工作区并移除独立岗位入口

**文件：**

- 修改 `apps/web/src/workspace/WorkspaceFrame.tsx` 及新增/修改测试
- 修改 `apps/web/src/workspace/ProfileApplicationWorkspace.tsx` 及测试
- 修改 `apps/web/src/conversation/ChatHome.tsx` 及测试
- 修改 `apps/web/src/applications/ApplicationTaskPage.tsx` 及测试
- 修改 `apps/web/src/router.tsx` 及测试
- 修改 `apps/web/src/styles.css`

- [x] 先添加失败测试：导航只含对话、进度、简历；保留快速开始；旧岗位地址回到对话。
- [x] 让 `WorkspaceFrame` 统一蓝白顶部栏、左侧导航、主内容和可选右侧上下文。
- [x] 删除工作区独立 jobs/apply 分支；保留岗位匹配和投递任务深层详情。
- [x] 将 `/applications/new` 替换导航到 `/`，将旧查询参数规范化为对话首页。
- [x] 完成蓝白工作区样式与现有响应式规则。
- [x] 运行 WorkspaceFrame、ChatHome、ProfileApplicationWorkspace、router、ApplicationTaskPage 对应测试：Web 全量 215/215，通过导航定向 15/15。

## Task 5：全量回归与视觉验证

- [x] 运行受影响包的完整单元/集成测试；Contracts、岗位匹配和 Web 全量通过，API/Browser Worker 全量门禁的环境阻塞已记录，受影响定向测试通过。
- [ ] 运行仓库根 TypeScript 类型检查；当前 `tsconfig` 将 monorepo 纳入单一进程并在 Node 堆上限 OOM，待依赖/检查配置修复后重跑。
- [x] 在 `http://127.0.0.1:5173/` 验证桌面视口：蓝白一致、三项导航、无独立岗位入口、无明显溢出；当前浏览器能力未提供视口覆盖，因此未宣称移动视口通过。
- [x] 通过对话图/E2E 测试验证“百度校园招聘”流程停在入口确认、岗位推荐确认和受控投递确认边界，且不会自动最终提交。
- [x] 运行 `git diff --check`，并核对回归报告仅记录本轮相关改动与已知环境阻塞。
- [x] 用中文汇总通过项、失败项及残余风险。
