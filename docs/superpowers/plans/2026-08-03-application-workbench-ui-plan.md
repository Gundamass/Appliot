# 投递工作台前端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有投递任务页重做为“左深右浅”的紧凑工作台，并让四阶段进度、浏览器实时活动和人工审核边界清晰可见。

**Architecture:** 保留 `ApplicationTaskPage` 的数据加载、SSE 投影和服务器授权命令逻辑；把展示层拆成阶段条、浏览器状态、风险列表和活动摘要组件。进度事件增加向后兼容的 `displayPhase`，由应用服务在确定性填写、语义填写、动态校验和审核交接处传入，旧事件缺失该字段时由前端按操作类型推导。

**Tech Stack:** TypeScript、React、Zod、Vitest、Testing Library、Lucide、现有 CSS、Playwright。

## Global Constraints

- 永远不增加自动提交、投递、确认申请或语义等价动作。
- 保留现有 `ApplicationTaskState`、命令授权和 SSE 事件兼容性。
- 以中文显示用户可见文本，不把敏感明文放入活动摘要或日志。
- 编辑使用 `apply_patch`，不创建隔离工作树，不提交 Git。
- 新功能先写失败测试，再写最小实现；每个任务独立验证。
- 页面必须在 320px、768px 和桌面宽度下无横向溢出和文本遮挡。

---

### Task 1: 增加向后兼容的显示阶段合同

**Files:**
- Modify: `packages/contracts/src/application.ts`
- Test: `packages/contracts/src/application.test.ts`
- Modify: `apps/api/src/applications/application-progress.ts`
- Test: `apps/api/src/applications/application-progress.test.ts`

**Interfaces:**
- Produces `ApplicationDisplayPhase = "deterministic_fill" | "semantic_fill" | "dynamic_validation" | "review_handoff"`。
- `ApplicationTaskProgress.displayPhase?: ApplicationDisplayPhase` 为可选字段，旧事件无需修改即可通过解析。
- `StartOperationInput.displayPhase?: ApplicationDisplayPhase`。

- [ ] **Step 1: 写失败合同测试**

在 `application.test.ts` 增加测试：带 `displayPhase: "semantic_fill"` 的进度事件可以通过 schema；没有该字段的旧事件仍可通过 schema。在 `application-progress.test.ts` 增加测试：`startOperation({ kind: "fill", displayPhase: "semantic_fill" })` 发出的 `operation_started` 保留语义阶段，`validate` 默认得到 `dynamic_validation`。

- [ ] **Step 2: 运行测试确认 RED**

运行：

```powershell
rtk node node_modules/vitest/vitest.mjs --root packages/contracts run src/application.test.ts
rtk node node_modules/vitest/vitest.mjs --root apps/api run src/applications/application-progress.test.ts
```

预期：新断言失败，因为合同没有 `displayPhase`，协调器也没有接收该参数。

- [ ] **Step 3: 实现最小合同和协调器传递**

在合同中新增可选 `ApplicationDisplayPhaseSchema` 字段；在 `StartOperationInput` 和 `ApplicationTaskProgress` 中加入同名可选字段。协调器新增：

```ts
function displayPhaseFor(kind: OperationKind): ApplicationDisplayPhase {
  if (kind === "validate" || kind === "navigate") return "dynamic_validation";
  if (kind === "observe") return "deterministic_fill";
  return "deterministic_fill";
}
```

`startOperation` 和 `recordFailure` 使用 `input.displayPhase ?? displayPhaseFor(input.kind)`，其余恢复、持久化和事件结构保持不变。

- [ ] **Step 4: 运行合同和 API 定向测试确认 GREEN**

运行上面的两条命令，再运行：

```powershell
rtk node node_modules/vitest/vitest.mjs --root apps/api run src/applications/application-machine.test.ts
```

预期所有测试通过，旧进度快照可以继续恢复。

### Task 2: 在应用编排中标记确定性和语义填写

**Files:**
- Modify: `apps/api/src/applications/application-service.ts`
- Test: `apps/api/src/applications/application-machine.test.ts`

**Interfaces:**
- `operationInput` 增加 `displayPhase?: ApplicationDisplayPhase` 参数。
- 确定性 pass 的字段操作传入 `deterministic_fill`。
- semantic pass 的字段操作传入 `semantic_fill`。
- 观察、上传、验证和导航继续使用 `deterministic_fill` 或 `dynamic_validation` 的默认规则。

- [ ] **Step 1: 写失败编排测试**

构造一个同时包含确定字段和 deferred 字段的页面，记录 `taskEvents` 的 `operation_started.progress.displayPhase`，断言确定字段先产生 `deterministic_fill`，语义字段随后产生 `semantic_fill`；验证操作产生 `dynamic_validation`。同时断言旧字段填写行为不变。

- [ ] **Step 2: 运行测试确认 RED**

运行：

```powershell
rtk node node_modules/vitest/vitest.mjs --root apps/api run src/applications/application-machine.test.ts
```

预期：业务填写断言通过，但新增阶段断言失败。

- [ ] **Step 3: 传入阶段而不改变执行顺序**

给 `operationInput` 增加可选参数，并在 `applyVerified` 接收 `phase`；确定性和 semantic 两处调用分别传入对应阶段。不要改变命令审批、回读、重试和终态提交拦截逻辑。

- [ ] **Step 4: 运行 API 回归**

运行：

```powershell
rtk node node_modules/vitest/vitest.mjs --root apps/api run src/applications/application-machine.test.ts src/production-dependencies.test.ts
```

预期：现有 43 项应用状态机测试和生产组合测试全部通过。

### Task 3: 创建展示层组件和纯函数

**Files:**
- Create: `apps/web/src/applications/TaskStageStepper.tsx`
- Create: `apps/web/src/applications/LiveBrowserStatus.tsx`
- Create: `apps/web/src/applications/TaskAttentionList.tsx`
- Create: `apps/web/src/applications/CompactActivityFeed.tsx`
- Create: `apps/web/src/applications/application-workbench.ts`
- Test: `apps/web/src/applications/application-workbench.test.ts`

**Interfaces:**
- `deriveDisplayPhase(task, activities): ApplicationDisplayPhase`：优先读取最近进度事件的 `displayPhase`，缺失时按旧 `phase` 和操作类型推导。
- `deriveAttentionItems(task, activities): AttentionItem[]`：将 `questions`、`contentReview`、暂停恢复和失败事件压缩成排序后的人工处理项。
- `TaskStageStepper` 接收 `{ phase, counts }`，只渲染四个阶段。
- `LiveBrowserStatus` 接收 `{ connection, activities, taskState }`，展示真实连接和用户活动状态。
- `CompactActivityFeed` 默认只显示最近三项，通过原生 `details` 展开其余事件。

- [ ] **Step 1: 写纯函数和组件失败测试**

覆盖：新事件优先、旧事件兼容、`needs_questions` 排在内容审核前、`review_locked` 只显示人工审核阶段、活动摘要最多三条、任何组件树中不存在“提交/投递/发送”按钮。

- [ ] **Step 2: 运行 Web 测试确认 RED**

运行：

```powershell
rtk node node_modules/vitest/vitest.mjs --root apps/web run src/applications/application-workbench.test.ts
```

预期：模块和组件尚不存在，测试失败。

- [ ] **Step 3: 实现最小展示组件**

使用 Lucide 图标、语义 HTML 和稳定 class 名实现四个组件。`deriveAttentionItems` 只读取已存在的任务字段和事件，不推断新的后端事实；敏感字段仅显示状态和遮罩提示。

- [ ] **Step 4: 运行组件测试确认 GREEN**

运行同一条 Vitest 命令，预期全部通过。

### Task 4: 重组 ApplicationTaskPage 工作台布局

**Files:**
- Modify: `apps/web/src/applications/ApplicationTaskPage.tsx`
- Modify: `apps/web/src/applications/ApplicationTaskPage.test.tsx`
- Modify: `apps/web/src/applications/ProgressSummary.test.tsx`

**Interfaces:**
- 保留现有 `ApplicationTaskPageProps`、SSE 去重、版本保护、命令授权、追问提交和内容审核回调。
- 页面使用 `TaskStageStepper`、`LiveBrowserStatus`、`TaskAttentionList` 和 `CompactActivityFeed`，`QuestionPanel` 与 `ContentReviewPage` 作为详情区继续复用。

- [ ] **Step 1: 增加失败的工作台结构断言**

在页面测试中断言存在 `投递任务工作台`、四个阶段、`需要你处理`、`受控浏览器` 和 `最近活动` 区域；断言登录、追问、内容审核、断线和审核锁定仍显示原有操作；断言审核锁定时没有提交类按钮。

- [ ] **Step 2: 运行 Web 页面测试确认 RED**

运行：

```powershell
rtk node node_modules/vitest/vitest.mjs --root apps/web run src/applications/ApplicationTaskPage.test.tsx src/applications/ProgressSummary.test.tsx
```

预期：现有旧结构选择器或新工作台区域断言失败。

- [ ] **Step 3: 只重组渲染层**

保留数据和事件处理函数，将 JSX 改为：页面壳层 → 标题/连接状态 → 阶段条 → 当前操作 → 左侧风险项 → 右侧追问/审核详情 → 活动摘要 → 服务端授权操作。操作按钮仍只根据 `currentTask.commands` 渲染。

- [ ] **Step 4: 运行页面回归确认 GREEN**

运行同一条 Vitest 命令，预期页面现有行为和新结构测试全部通过。

### Task 5: 完成视觉系统和响应式布局

**Files:**
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/applications/ApplicationTaskPage.test.tsx`
- Create: `tests/browser/application-workbench-visual.spec.ts`

**Interfaces:**
- 提供 `application-workbench`、`application-rail`、`application-content`、`task-attention-list`、`task-stage-stepper`、`live-browser-status` 和 `compact-activity-feed` 样式。
- 不改变其他档案页的语义 class，必要时通过 `.application-shell` 限定作用域。

- [ ] **Step 1: 写视觉回归测试**

Playwright 打开一个合成任务页面，在 1280x900、768x900 和 320x800 视口截图并断言 `document.documentElement.scrollWidth <= window.innerWidth`；断言左侧导航在桌面显示、移动端不造成横向溢出，阶段条和风险项文字可见。

- [ ] **Step 2: 运行视觉测试确认 RED**

运行：

```powershell
rtk pnpm exec playwright test tests/browser/application-workbench-visual.spec.ts
```

预期：测试文件尚不存在或新 class 尚不存在，测试失败。

- [ ] **Step 3: 实现无渐变的深浅结合视觉**

在 `.application-shell` 下加入深炭色导航、浅灰主区、青绿色主操作、琥珀色审核提示和红色错误提示；使用 `minmax()`、`clamp()` 仅约束尺寸，不用视口宽度缩放字号；在 768px 以下切换单列，在 420px 以下把阶段条改为可换行的紧凑列表。

- [ ] **Step 4: 运行截图和页面测试确认 GREEN**

运行：

```powershell
rtk pnpm exec playwright test tests/browser/application-workbench-visual.spec.ts
rtk node node_modules/vitest/vitest.mjs --root apps/web run src/applications/ApplicationTaskPage.test.tsx src/applications/ProgressSummary.test.tsx src/applications/application-workbench.test.ts
```

预期：三个视口无横向溢出，组件和页面测试全部通过。

### Task 6: 完整验证与文档同步

**Files:**
- Modify: `docs/superpowers/specs/2026-08-03-application-workbench-ui-design.md` only if implementation exposes a clarified behavior.
- Test: existing `apps/web/src/**/*.test.tsx`, API progress tests, browser visual test.

- [ ] **Step 1: 执行前端全量测试**

运行：

```powershell
rtk node node_modules/vitest/vitest.mjs --root apps/web run src
```

- [ ] **Step 2: 执行合同、API 和类型检查**

运行：

```powershell
rtk node node_modules/vitest/vitest.mjs --root packages/contracts run src
rtk node node_modules/vitest/vitest.mjs --root apps/api run src
rtk pnpm typecheck
```

- [ ] **Step 3: 执行浏览器截图验证**

运行：

```powershell
rtk pnpm exec playwright test tests/browser/application-workbench-visual.spec.ts tests/browser/mokahr-high-coverage.spec.ts
```

确认截图中页面非空、文字不重叠、审核锁定页没有提交控件，合成 ATS 提交计数为零。

- [ ] **Step 4: 检查差异和工作区边界**

运行：

```powershell
rtk git diff --check
rtk git status --short
```

只保留本次前端工作台相关改动，不回滚用户已有改动，不创建提交。
