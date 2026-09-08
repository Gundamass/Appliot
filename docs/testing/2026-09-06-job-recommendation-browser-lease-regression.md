# 岗位推荐浏览器租约回归记录

## 自动化验证

- 前端全量测试：`corepack pnpm --filter @resume/web test -- --run`，45 个测试文件、259 项通过，0 项失败。
- API 全量测试：`corepack pnpm --filter @resume/api test -- --run`，112 个测试文件、944 项通过，0 项失败。
- 浏览器 worker 全量测试：`corepack pnpm --filter @resume/browser-worker exec vitest run --maxWorkers=1`，13 个测试文件、134 项通过，0 项失败。默认并行模式首次运行有 2 项 Chromium 启停超时，相同测试单 worker 复跑 12/12 通过，全套单 worker 复跑通过。
- 岗位匹配包全量测试：`corepack pnpm --filter @resume/job-matching test -- --run`，7 个测试文件、78 项通过，0 项失败。
- 浏览器回归：`corepack pnpm test:e2e -- tests/browser/conversation-job-match-flow.spec.ts`，2 项通过，0 项失败。
- 构建验证：`@resume/api`、`@resume/browser-worker` 和 `@resume/web` 构建全部通过。Web 仅有既有的大于 500 kB chunk 警告。

## TDD 证据

- RED：使用真实导航的百度 fixture 稳定复现 `Execution context was destroyed, most likely because of a navigation`。
- RED：断言 worker 不得依赖 `page.goto` 之后，原实现失败。
- RED：断言必须向百度官方 `getPostListNew` 端点发送 POST 请求后，原实现失败。
- GREEN：官方列表 API 快照、语义筛选和第二页游标测试通过；真实页面不再因筛选 URL 变化而失去执行上下文。
- RED→GREEN 边界回归：伪造分页游标和缺少 `data.list` 的响应先各自失败，最小修复后均改为稳定错误；不同 `ownerId` 无法读取已缓存的百度快照。
- 审查 RED→GREEN：新增用例先证明城市别名、未知城市、筛选被服务端忽略、响应页码不符和列表内部畸形条目会被原实现误放行；最小修复后聚焦测试分别为 13/13、9/9 和 15/15 通过。
- 同会话重复推荐 RED→GREEN：复现第二个岗位会话复用 `inline-job-match:confirm_filters:0` 而被后端以 `conversation_idempotency_conflict` 拒绝；5 个前端断言先失败，将 `sessionId` 纳入所有岗位操作幂等键后 6/6 通过。随后补充超长标识边界测试，改为保留动作/版本并对完整身份生成稳定摘要，保证键长不超过 128 且不会因直接截断产生碰撞。

## 百度真实冒烟测试

- 招聘入口：`https://talent.baidu.com/`（搜索结果中选择的百度官方入口）。
- 标准化列表地址：`https://talent.baidu.com/jobs/list?projectType=1&recruitType=GRADUATE`。
- 实际岗位数据源：`POST https://talent.baidu.com/httservice/getPostListNew`；传递 `recruitType=GRADUATE`、`postType=1`、`curPage` 和 `pageSize=10`。“全国”不传 `workPlace=9000`，普通校招不向该 API 传 `projectType=1`，避免百度返回空列表。
- 确认消息文案：依次显示“确认使用此入口”、“开始岗位推荐”、“确认岗位筛选条件”。
- 岗位推荐结果：生成 6 个百度技术类岗位，显示为百分比（44% 和 41%），没有超过前六个限制。结果包括深圳/北京全栈开发工程师、上海 AI 异构计算工程师等。
- 分页验证：直接 worker 探测读取首页 10 条，`hasNext=true`，游标为第 2 页；第二页返回不同的 10 条岗位。
- 是否触发真实投递：否。测试停在岗位推荐和“开始投递”按钮之前。
- 同会话重复推荐：重新构建并刷新静态前端后，第二套百度推荐成功读取 93 个岗位，展示 6 张 44%/41% 推荐卡，证明跨任务幂等键冲突已消除。

## 服务状态

- API 使用最新构建重启，`http://127.0.0.1:43120/api/health/adapters` 返回 HTTP 200。
- Web 服务保持在 `http://127.0.0.1:5173`，真实联调由该页面完成。

## 代码审查

- 完成修复后复审，没有剩余 Critical 或 Important 问题。
- 剩余低风险：尚未对百度公开接口的无限期网络停滞做专门单测；当 `total > 0` 但服务端返回空的末页时，当前依赖上层提取契约处理。二者都不会绕过投递确认门。
