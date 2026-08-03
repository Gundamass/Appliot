# Mokahr High Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 DJI/Mokahr 投递页先上传并校正官网 PDF 解析结果，再高覆盖自动填写，并在提交前可靠交给用户审核。

**Architecture:** 保持 Worker、语义适配和应用编排三层分离。Worker 输出可靠 DOM 元数据；Mokahr 适配器生成上传、区块与动态添加步骤；应用服务上传 PDF 后等待结构稳定、执行差异补全并回读，在没有安全中间动作时交接人工。

**Tech Stack:** TypeScript、Playwright、Vitest、XState、SQLite。

## Global Constraints

- 不自动执行任何提交或投递动作。
- 每项新行为先写失败测试，再写最小实现。
- 不修改用户已有的无关改动，不创建隔离工作树，不提交。

---

### Task 1: PDF 优先上传与解析稳定观察

**Files:**
- Modify: `apps/api/src/applications/application-service.ts`
- Modify: `apps/browser-worker/src/executor.ts`
- Test: `apps/api/src/applications/application-machine.test.ts`
- Test: `apps/browser-worker/src/executor.test.ts`

- [ ] 写失败测试：存在“上传简历”且任务有 PDF 时先执行上传；解析过程中必须观察到字段结构或值稳定变化后才继续。
- [ ] 运行定向测试，确认失败。
- [ ] 实现一次性 PDF 上传、条件轮询与超时后人工接管。
- [ ] 运行定向测试，确认通过。

### Task 2: 观察器字段质量与提交动作分类

**Files:**
- Modify: `apps/browser-worker/src/observer.ts`
- Modify: `packages/form-semantics/src/action-classifier.ts`
- Test: `apps/browser-worker/src/observer.test.ts`
- Test: `packages/form-semantics/src/action-classifier.test.ts`

- [ ] 写失败测试：无标签隐藏输入不进入 `fields`；`预览并提交` 为 `terminal_submit`。
- [ ] 运行定向测试，确认失败。
- [ ] 实现可见、可编辑、具可用标签的字段筛选，并扩展终态动作词典。
- [ ] 运行定向测试，确认通过。

### Task 3: Mokahr 动态区块适配

**Files:**
- Create: `packages/form-semantics/src/mokahr-adapter.ts`
- Modify: `packages/form-semantics/src/index.ts`
- Test: `packages/form-semantics/src/mokahr-adapter.test.ts`

- [ ] 写失败测试：Mokahr 的“添加”动作能归属教育、工作或项目区块，且新增条目字段有确定顺序。
- [ ] 运行测试，确认失败。
- [ ] 实现 URL/DOM 特征检测、区块识别和动态添加计划。
- [ ] 运行测试，确认通过。

### Task 4: 执行与回读验证

**Files:**
- Modify: `apps/browser-worker/src/executor.ts`
- Modify: `apps/browser-worker/src/dom-registry.ts`
- Test: `apps/browser-worker/src/executor.test.ts`

- [ ] 写失败测试：定位到控件后写入失败或回读值不匹配时，执行结果不可为 `applied`。
- [ ] 运行测试，确认失败。
- [ ] 实现稳定索引定位、写入后观察回读与动态区块重新建表。
- [ ] 运行测试，确认通过。

### Task 5: 服务编排、差异补全与人工交接

**Files:**
- Modify: `apps/api/src/applications/application-service.ts`
- Modify: `apps/api/src/applications/application-machine.ts`
- Test: `apps/api/src/applications/application-machine.test.ts`
- Test: `apps/api/src/applications/routes.test.ts`

- [ ] 写失败测试：不存在安全下一步/保存时，服务进入审核/人工接管而非 `failed`。
- [ ] 运行测试，确认失败。
- [ ] 接入两阶段级联计划：先填写缓存、精确别名和区块规则能够确定的空字段，再重新观察并只对剩余空字段执行语义补全；单个追问不得阻塞其他确定字段。
- [ ] 对新增区块和条件字段重新观察；中低置信度、敏感承诺及无法安全映射的字段聚合交给人工审核，不得退化为普通失败。
- [ ] 运行 API 定向测试，确认通过。

### Task 6: 端到端回归

**Files:**
- Modify: `apps/synthetic-ats/`
- Test: `tests/browser/mokahr-high-coverage.spec.ts`

- [ ] 建立可解析上传 PDF、含个人信息、教育、实习、项目及“预览并提交”的 Mokahr 仿真页。
- [ ] 先写端到端断言：PDF 先上传，所有已确认值回读成功，提交按钮未点击，任务锁定等待用户。
- [ ] 运行测试确认失败，完成最小集成后复跑。
- [ ] 执行相关测试、类型检查、构建与 `git diff --check`。
