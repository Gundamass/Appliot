# Profile-Driven Dynamic Autofill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让投递任务使用最新候选人档案填充所有有证据的字段，并可靠处理日期分量、搜索下拉框、条件区块和重复经历。

**Architecture:** API 在观察结果上生成包含条目序号和日期分量的精确语义，RAG 只负责语义别名和低层检索；browser worker 负责把下拉值真正提交并回读。form-semantics 识别可扩展区块，application service 以有界循环协调“补齐条目、重新观察、继续填写”，profile routes 在档案修改后通知活动任务重新处理未解决字段。

**Tech Stack:** TypeScript 5.8、Node.js 24、Fastify、XState、Playwright Core、Vitest、SQLite、React。

## Global Constraints

- 用户自行登录和选择岗位，系统只从简历填写页面开始工作。
- 所有页面已有非空值默认保留，不得覆盖。
- 项目亮点、实习职责和成果不得生成或改写。
- 自动化永远不得触发提交、确认投递或等价终态操作。
- 所有 shell 命令使用 `rtk` 前缀；手工修改使用 `apply_patch`。
- 在当前本地会话和当前工作区执行，不创建工作树，不分派子任务。

---

### Task 1: 精确经历语义和日期分量

**Files:**
- Modify: `apps/api/src/applications/entry-field-semantics.ts`
- Test: `apps/api/src/applications/entry-field-semantics.test.ts`
- Modify: `apps/api/src/applications/control-value.ts`
- Test: `apps/api/src/applications/control-value.test.ts`

**Interfaces:**
- Consumes: `FormField.label`、`FormField.semanticHint` 和字段出现顺序。
- Produces: `deriveEntrySemanticHints(fields)` 生成 `awards[n].name/date.year/date.month/description` 等精确路径；控件值投影从 ISO 或年月日期中取得指定分量。

- [ ] **Step 1: 写失败测试**

新增用例，构造“赛事名称、赛事时间 年、赛事时间 月、赛事描述”字段，断言语义依次为 `awards[0].name`、`awards[0].date.year`、`awards[0].date.month`、`awards[0].description`；同时断言 `2025-03` 对年月控件分别投影为 `2025` 和 `3`。

- [ ] **Step 2: 运行测试确认失败**

Run: `rtk corepack pnpm --filter @resume/api test -- entry-field-semantics.test.ts control-value.test.ts`

Expected: FAIL，现有获奖字段统一返回 `awards[0]` 或完整日期。

- [ ] **Step 3: 实现最小修复**

让获奖字段保留 `fieldFor` 的后缀；根据标签末尾的 `年/月/日` 为日期语义追加分量。扩展控件值投影，使其在语义或标签要求日期分量时返回单独的数字字符串。

- [ ] **Step 4: 运行 API 定向测试**

Run: `rtk corepack pnpm --filter @resume/api test -- entry-field-semantics.test.ts control-value.test.ts`

Expected: PASS。

### Task 2: 搜索型下拉框必须选择并回读

**Files:**
- Modify: `apps/browser-worker/src/control-adapters.ts`
- Modify: `apps/browser-worker/src/executor.ts`
- Test: `apps/browser-worker/src/executor.test.ts`
- Test: `tests/browser/application-stability.spec.ts`

**Interfaces:**
- Consumes: `selectCustomControl(locator, value)`。
- Produces: 成功结果只在候选项被点击且控件回读等于目标值时返回；无候选时抛出或返回 `option_not_found`。

- [ ] **Step 1: 写失败测试**

创建一个搜索输入和动态候选面板：输入 `2024` 后出现 `2024` 候选，但只有点击候选才更新控件值。断言执行器完成点击；再构造无候选页面，断言操作失败且不是已应用。

- [ ] **Step 2: 运行测试确认失败**

Run: `rtk corepack pnpm --filter @resume/browser-worker test -- executor.test.ts`

Expected: 至少一个用例 FAIL，现有实现把搜索文本或不稳定回读视为结果。

- [ ] **Step 3: 实现选择协议**

在 `selectCustomControl` 中依次执行打开、输入过滤、等待可见列表、完全匹配候选点击、等待选中态或面板关闭、规范化回读。删除仅靠输入文本成功的路径，并把无精确候选归一成 `option_not_found`。

- [ ] **Step 4: 运行 worker 与浏览器定向测试**

Run: `rtk corepack pnpm --filter @resume/browser-worker test -- executor.test.ts`

Run: `rtk corepack pnpm test:e2e -- tests/browser/application-stability.spec.ts`

Expected: PASS，且提交按钮仍被策略层阻断。

### Task 3: 条件区块与重复经历补齐

**Files:**
- Modify: `packages/form-semantics/src/mokahr-adapter.ts`
- Modify: `packages/form-semantics/src/action-classifier.ts`
- Test: `packages/form-semantics/src/mokahr-adapter.test.ts`
- Test: `packages/form-semantics/src/action-classifier.test.ts`
- Create: `apps/api/src/applications/repeated-section-planner.ts`
- Create: `apps/api/src/applications/repeated-section-planner.test.ts`
- Modify: `apps/api/src/applications/application-service.ts`
- Test: `apps/api/src/app.test.ts`

**Interfaces:**
- Produces: `MokahrSection` 支持 `awards` 和 `laboratory`；`planRepeatedSectionActions(snapshot, profileFacts)` 返回每个区块尚需点击的安全添加动作；条件字段决策根据对应档案集合得到“是”“否”或不操作。

- [ ] **Step 1: 写区块识别失败测试**

断言“赛事经历 添加”“实验室经历 新增”分别分类到 `awards` 和 `laboratory`，且两者被动作策略识别为安全中间操作。

- [ ] **Step 2: 写数量协调失败测试**

构造档案有 3 个项目、页面有 2 个项目和一个添加动作，断言规划一次添加；构造数量相等时断言无动作。为实验室档案存在、明确空集合和未知状态分别断言“是”“否”和不操作。

- [ ] **Step 3: 运行测试确认失败**

Run: `rtk corepack pnpm --filter @resume/form-semantics test -- mokahr-adapter.test.ts action-classifier.test.ts`

Run: `rtk corepack pnpm --filter @resume/api test -- repeated-section-planner.test.ts`

Expected: FAIL，当前只支持教育、工作、项目且没有数量规划器。

- [ ] **Step 4: 实现区块规划器和有界重扫**

扩展区块词典与安全动作上下文；新增纯函数比较 `profileFacts` 的索引数量和页面语义索引数量。application service 每次只点击一个添加动作，等待结构改变后重新观察并重新运行字段匹配，沿用现有运行代次和取消机制限制循环。

- [ ] **Step 5: 运行语义和 API 集成测试**

Run: `rtk corepack pnpm --filter @resume/form-semantics test`

Run: `rtk corepack pnpm --filter @resume/api test`

Expected: PASS；三个项目只新增一次，展开实验室区块后新字段进入下一轮。

### Task 4: 档案保存后活动任务热同步

**Files:**
- Modify: `apps/api/src/profile/profile-routes.ts`
- Test: `apps/api/src/profile/profile-routes.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/production-dependencies.ts`
- Modify: `apps/api/src/applications/application-service.ts`
- Test: `apps/api/src/app.test.ts`

**Interfaces:**
- Profile routes dependency adds `onProfileChanged?: () => void | Promise<void>`。
- Application service adds `profileUpdated(): Promise<void>`，对活动任务使未解决覆盖状态失效并在可恢复状态重新观察。

- [ ] **Step 1: 写路由通知失败测试**

断言新增、修改、确认和删除档案事实成功后各触发一次 `onProfileChanged`，失败请求不触发。

- [ ] **Step 2: 写活动任务刷新失败测试**

构造任务首次把获奖字段判定为 missing，随后资料仓库加入该事实并调用 `profileUpdated()`；断言重新解析未解决字段、使用最新值，同时跳过页面已有值。

- [ ] **Step 3: 运行测试确认失败**

Run: `rtk corepack pnpm --filter @resume/api test -- profile-routes.test.ts app.test.ts`

Expected: FAIL，当前 profile routes 不发送通知，活动任务决策不会自动失效。

- [ ] **Step 4: 接入修订通知**

在成功持久化后调用通知；production composition 将通知连接到 application service。刷新时清理未解决字段覆盖和问题列表，复用当前 `PROFILE_UPDATED` 状态事件与用户活动静默机制，绝不覆盖非空页面值。

- [ ] **Step 5: 运行 API 全量测试**

Run: `rtk corepack pnpm --filter @resume/api test`

Expected: PASS。

### Task 5: 全链路回归与真实 DJI 验证

**Files:**
- Modify: `tests/browser/application-stability.spec.ts`
- Modify: `docs/superpowers/plans/2026-08-13-profile-driven-dynamic-autofill.md`（勾选执行结果）

**Interfaces:**
- Consumes: Tasks 1-4 的完整行为。
- Produces: 自动化回归证据和真实页面字段覆盖报告。

- [ ] **Step 1: 增加组合回归场景**

模拟可选档案字段、获奖年月搜索下拉框、实验室条件展开、三个项目和运行中档案更新；断言所有有证据字段被填写且提交动作从未执行。

- [ ] **Step 2: 运行仓库级验证**

Run: `rtk corepack pnpm test`

Run: `rtk corepack pnpm typecheck`

Run: `rtk corepack pnpm build`

Run: `rtk corepack pnpm test:e2e`

Expected: 全部 PASS。

- [ ] **Step 3: 启动受控服务并执行 DJI 真实回归**

Run: `rtk corepack pnpm services:start`

在当前 DJI 测试岗位的申请页创建新任务，检查可选字段、赛事年月、项目数量和动态区块。保存一项此前未匹配的档案事实，确认任务自动重新匹配。停在预览或最终审核前，不点击提交。

- [ ] **Step 4: 记录验证结果**

在本计划末尾记录任务 ID、字段总数、成功填充数、剩余字段及原因、所有失败回读、页面截图和“未触发提交”的证据。若真实页面暴露新控件，只以失败回归测试复现后修复。
