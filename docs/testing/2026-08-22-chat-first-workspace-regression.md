# Chat-First 工作区回归报告

日期：2026-09-01
分支：`fix/mokahr-campus-apply`

## 本期范围

- 岗位推荐和受控投递统一从对话首页进入，保留岗位匹配工作台、投递审核和任务详情深链。
- 招聘入口通过 Tavily Remote MCP 搜索，候选链接经过公网 HTTPS 校验并要求用户确认；确认后才进入岗位推荐。
- 保留现有岗位匹配、筛选确认、岗位选择、受控浏览器、人工接管和最终提交锁定逻辑。
- 不实现企业账号绑定、企业招聘状态跟踪、状态轮询、Webhook、通知或状态推送。
- 对话过程链显示理解请求、搜索入口、等待确认、创建岗位匹配会话和失败等阶段；失败时结束在明确的 `failed` 事件。

## 本次收尾修复

- 修复 Tavily 返回 `https://talent.baidu.com/` 或 `/jobs` 时，百度适配器无法识别入口的问题。
- 岗位匹配服务现在会在打开浏览器前调用站点适配器的入口归一化钩子；百度校招根入口会转换为：
  `https://talent.baidu.com/jobs/list?projectType=4&recruitType=GRADUATE`
- 增加 `unsupported_job_entry` 的中文提示：
  “当前招聘页面结构尚未识别，请确认链接打开的是岗位列表或岗位详情页。”
- 归一化只对百度官方 HTTPS 主机的根路径和 `/jobs` 路径生效，不改变其他招聘网站和现有受控投递边界。

## 专项验证结果

| 验证范围 | 结果 |
| --- | --- |
| 百度入口与对话失败回归 | API 2 个测试文件，`30/30` 通过；包含岗位匹配入口归一化和中文失败提示 |
| 岗位匹配包 | 7 个测试文件，`65/65` 通过 |
| Tavily、生产依赖、对话工具 | 3 个测试文件，`57/57` 通过 |
| 对话、路由、服务、Tavily、岗位匹配专项 | 6 个 API 测试文件，`54/54` 通过 |
| Web 全量 | 38 个测试文件，`229/229` 通过 |
| TypeScript 类型检查 | API 与岗位匹配包通过，无诊断 |
| 工作区生产构建 | `pnpm build` 通过，Web、API、Browser Worker 和共享包均完成构建 |
| 差异格式检查 | `git diff --check` 通过；Windows `core.autocrlf=true` 仅输出 LF/CRLF 转换告警 |

## 真实链路验证

使用 UTF-8 Node 请求连接本地 API，并使用本地环境中的 Tavily Key 执行：

1. 发送“帮我投递一下百度”。
2. Tavily 返回 3 个候选，其中百度官方候选为 `https://talent.baidu.com/`。
3. 用户确认百度官方入口。
4. 用户确认继续岗位推荐。
5. API 返回岗位匹配卡片，未出现“当前没有可展示的推荐记录”或通用失败文案。

实际会话核对结果：

- `source=baidu`
- `adapterVersion=baidu-job-v1`
- `entryKind=job_list`
- 持久化 `initialUrl=https://talent.baidu.com/jobs/list?projectType=4&recruitType=GRADUATE`
- 状态为 `awaiting_filter_confirmation`

验证完成后已取消该测试会话，状态为 `cancelled`，没有创建投递任务，也没有执行最终提交。

## 全量门禁说明

串行执行 `pnpm -r --workspace-concurrency=1 test` 时，Synthetic ATS、Contracts、Model Provider、Action Policy、Form Semantics、Job Matching 和 RAG 共 `449/449` 通过。

Browser Worker 的 13 个测试文件中有 `61/125` 通过，另外 `64` 条均在 Edge 启动阶段失败，错误相同：
`browserType.launchPersistentContext: Target page, context or browser has been closed`。

该失败发生在测试浏览器启动处，不涉及本次百度入口或对话断言；服务管理器中的实际 API/Browser Worker 仍可正常启动。Web 已单独串行复跑并得到 `229/229`，本次报告不把受 Edge 启动环境影响的全量命令标记为通过。

`git diff --check` 在当前 Windows 工作区返回退出码 `0`；Git 仍输出工作区文件即将由 LF 转换为 CRLF 的提示。本次未修改无关文件的行尾。

## 安全边界

- 岗位结果和投递任务使用真实 ID；对话不会从助手文本重建岗位或数据库主键。
- 招聘入口候选在用户确认前不会进入已验证招聘站点，也不会创建岗位匹配会话。
- Tavily 只负责发现候选入口，搜索阶段不启动浏览器模拟搜索。
- 受控浏览器继续只允许既有的结构化观察、筛选、填充、回读、人工接管和审核路径。
- 对话工具不注册最终提交命令，不保存密钥、DOM、表单值或模型提示词到追踪投影。

## 每轮对话执行轨迹回归（2026-09-02）

- 测试范围：每条用户消息的流程点归属、事件持久化与 SSE 重放、Tavily 搜索、URL 安全校验、确认轮次、岗位匹配、受控投递边界，以及桌面端和 390px 移动端布局。
- 自动化结果：

| 命令 | 测试文件 | 通过 | 失败 | 跳过 | 耗时 |
| --- | --- | ---: | ---: | ---: | ---: |
| `rtk proxy corepack pnpm --filter @resume/contracts exec vitest run src/conversation.test.ts` | 1 | 10 | 0 | 0 | 1.77s |
| `rtk proxy corepack pnpm --filter @resume/api exec vitest run src/db/migrate.test.ts src/conversations/conversation-events.test.ts src/conversations/conversation-process-trace.test.ts src/conversations/conversation-process-summaries.test.ts src/conversations/conversation-service.test.ts src/conversations/conversation-graph.test.ts src/conversations/conversation-routes.test.ts` | 7 | 58 | 0 | 0 | 3.85s |
| `rtk proxy corepack pnpm --filter @resume/web exec vitest run src/conversation/conversation-process-events.test.ts src/conversation/conversation-process-model.test.ts src/conversation/ConversationTurnTrace.test.tsx src/conversation/ChatHome.test.tsx` | 4 | 22 | 0 | 0 | 6.68s |
| `rtk proxy corepack pnpm --filter @resume/api exec vitest run src/recruitment-search/tavily-remote-mcp.test.ts src/job-matching/job-match-service.test.ts src/applications/application-service.test.ts src/applications/application-machine.test.ts` | 3 | 117 | 0 | 0 | 3.02s |
| `rtk proxy corepack pnpm --filter @resume/web exec vitest run src/conversation/ConversationCards.test.tsx src/workspace/ProfileApplicationWorkspace.test.tsx src/router.test.tsx` | 3 | 21 | 0 | 0 | 3.93s |
| `rtk proxy corepack pnpm --filter @resume/api exec vitest run src/applications/application-service-router.test.ts src/applications/graph-application-service.test.ts` | 2 | 7 | 0 | 0 | 1.00s |

- 全仓测试：`rtk proxy corepack pnpm test` 退出码为 `0`；11 个 workspace 均通过，逐包结果为 Synthetic ATS `5/5`、Contracts `90/90`、Model Provider `53/53`、Action Policy `5/5`、Form Semantics `36/36`、Job Matching `65/65`、RAG `195/195`、Browser Worker `125/125`、Web `236/236`、Profile Domain `49/49`、API `725/725`，各包均为 `0` 失败、`0` 跳过；根命令未打印汇总耗时。
- 全仓门禁：`rtk proxy corepack pnpm typecheck` 退出码为 `0`；`rtk proxy corepack pnpm build` 退出码为 `0`；`rtk git diff --check` 退出码为 `0`。
- 服务状态：重启后的最终 `service-control.ps1 status` 显示守护器、远程 OCR、远程 Embedding、SSH 隧道、API/浏览器 Worker 和前端均为“就绪”。
- 桌面端结果：在 `http://127.0.0.1:5173/?conversation=3d652d8c-d09b-4860-9fad-b490143892ce` 发送“帮我投递一下百度校园招聘”后，用户消息下依次出现理解请求、Tavily Search、URL 安全校验、等待确认和生成回复；确认百度校园招聘入口后，新的“确认开始投递”用户轮次单独出现处理确认、受控浏览器和岗位匹配流程点，最终进入岗位匹配工作台，没有执行最终提交。截图：`playwright-artifacts/per-turn-trace-desktop.png`。
- 移动端结果：隔离的 390px 视口测得 `innerWidth=390`、`clientWidth=390`、`scrollWidth=390`，无横向溢出；流程点区域 `3` 个，用户消息区域 `6` 个；截图：`playwright-artifacts/per-turn-trace-mobile.png`。
- 隐私检查：流程摘要未出现 `tavilyApiKey`、Authorization、Cookie、原始 MCP 报文、原始模型提示词或隐私提示文案；旧的全局“处理过程”标题数量为 `0`，已移除的“可审计执行摘要 · 隐私内容和密钥已隐藏”数量为 `0`。
- 安全边界：岗位匹配、筛选确认、受控浏览器、人工接管和最终提交锁定逻辑保持不变；额外的投递服务测试为 `7/7`；本期未新增企业招聘状态跟踪、外部状态轮询、Webhook、同步或通知。
- 已知问题：计划指定的 `src/applications/application-service.test.ts` 在当前仓库不存在，因此该命令实际收集了 3 个测试文件；已用现有 `application-service-router.test.ts` 和 `graph-application-service.test.ts` 补跑，结果为 `7/7`。全仓测试第一次运行时曾在高负载下出现 Browser Worker `node-registry.test.ts` 的 `1/125` 时序失败，单文件连续 3 次和随后第二次全仓运行均通过（Browser Worker `125/125`）；本次未修改该无关逻辑。这不是当前功能的运行时失败，但后续可考虑将该定时器测试改为条件等待。
