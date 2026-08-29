# Chat-First 工作区回归报告

日期：2026-08-24
分支：`codex/langgraph-agent-implementation`

## 本期范围

- 岗位推荐和受控投递统一从对话首页进入，保留岗位匹配工作台、投递任务工作台和深层地址。
- 招聘入口通过 Tavily Remote MCP 返回有限候选；用户确认入口后，才进入岗位推荐或后续投递流程。
- 投递任务创建仍需显式确认，确认令牌只能使用一次；最终提交动作不进入对话工具。
- 保留现有岗位匹配、投递审核和受控浏览器逻辑，不实现企业账号绑定、企业招聘状态跟踪、轮询、Webhook、通知或状态推送。
- 对话和 LangSmith 投影只记录有边界的元数据，不保存对话原文、提示词、DOM、表单值、URL 或密钥。

## 任务验证结果

| 任务 | 验证结果 |
| --- | --- |
| Task 5 对话首页专项 | Web 全量 36 个测试文件、215/215 通过；API 对话相关测试包含在 API 全量 73 个文件、705/705 通过 |
| Task 6 导航与深链 | `router`、工作区导航、投递任务深链 3 个文件，43/43 通过 |
| Task 7 API 集成 | 对话图、路由、岗位推荐到投递任务集成 3 个文件，26/26 通过 |
| Task 7 Web 集成 | 对话卡片和深链集成 2 个文件，5/5 通过 |
| Task 7 浏览器回归 | `--grep job`，9/9 通过；覆盖岗位匹配、登录/挑战边界、旧地址回退、过期结果重新匹配和不提交安全性 |
| Task 8 隐私与可观测性 | 1 个测试文件，3/3 通过 |
| Task 8 工作台视觉回归 | `application-workbench-visual.spec.ts`，桌面/平板/手机 3/3 通过；蓝白侧栏基线为 216px |

## 全量门禁

`pnpm -r --workspace-concurrency=1 test` 完整通过：

| 工作区 | 测试文件 | 测试 |
| --- | ---: | ---: |
| Synthetic ATS | 1 | 5/5 |
| Contracts | 11 | 88/88 |
| Model Provider | 4 | 53/53 |
| Action Policy | 1 | 5/5 |
| Form Semantics | 5 | 36/36 |
| Job Matching | 7 | 65/65 |
| RAG | 3 | 195/195 |
| Browser Worker | 13 | 125/125 |
| Web | 36 | 215/215 |
| Profile Domain | 3 | 49/49 |
| API | 73 | 705/705 |
| **合计** | **157** | **1541/1541** |

其他门禁结果：

- workspace TypeScript 类型检查：通过，无诊断。
- workspace 构建：通过；Web、API、Browser Worker 和各共享包均完成构建。
- Web 生产构建：通过；Vite 可能提示主 chunk 体积较大，但不影响退出状态。
- `better-sqlite3`：测试使用隔离虚拟依赖目录并完成 Node 24.14.1 原生绑定构建；未修改业务代码或锁文件。
- `pnpm-lock.yaml`：已恢复为任务开始前版本，没有把测试环境自动生成的差异带入本次改动。

## 浏览器筛选说明

仓库当前没有标题或用例名匹配 `conversation` 的 Playwright 测试，因此 `--grep conversation` 返回“没有找到测试”，不能将其计为通过。已运行现有 `--grep job` 回归并得到 9/9 通过。

仓库的 `pnpm test:e2e` 依赖前置检查会因 `pnpm-workspace.yaml` 中的 fast-uri override 与已恢复的 `pnpm-lock.yaml` 基线不一致而提前失败；本次使用仓库的 `scripts/run-playwright.mjs` 直接执行实际浏览器用例。

其中两条旧测试已按当前产品要求修正：`?view=apply` 和 `?view=jobs` 不再打开独立岗位入口，而是回到对话首页；岗位匹配深层地址仍可直接打开工作台。

## 安全边界

- 岗位结果和投递任务均使用真实 ID，不从助手文本重建岗位。
- 招聘入口候选在用户确认前不会写入已验证招聘站点。
- 受控浏览器只允许既有的结构化观察、填充、回读、人工接管和审核路径。
- 本期没有新增自动最终提交、企业招聘状态跟踪或企业账号绑定。
