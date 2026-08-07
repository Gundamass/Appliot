# 稳健控件自动填充实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让投递助手识别并填写原生与自定义年月/下拉控件，字段失败时继续完成整页，并在最终审核中集中展示风险。

**Architecture:** Observer 负责将可交互的原生控件、ARIA 控件和常见自定义控件统一建模；Production Field Resolver 负责把规范日期投影成控件需要的年/月/日；Controlled Executor 负责多策略操作和读回。Application Service 不再因普通字段失败立即暂停，而是记录字段级风险并继续，最终由 Field Coverage Panel 展示。

**Tech Stack:** TypeScript 5.8, Vitest 3, Zod, Playwright Core, Fastify, npm workspace。

## Global Constraints

- 不降低语义相似度、证据、生命周期、作用域、类型或必填项验证标准。
- 高置信度直接填写；中等置信度允许填写并进入最终审核提醒；低置信度留空并进入最终审核清单。
- 单字段失败不得中断同一页面的后续字段填写。
- 继续禁止最终提交和提交请求；中间操作安全策略保持不变。
- 不在通用执行器中硬编码 DJI 域名；网站特殊逻辑通过可测试的控件策略扩展。
- 不读取或暴露原始 DOM selector 给 API 或前端，字段 ID 继续使用不透明 ID。

---

### Task 1: 扩展控件观察与注册模型

**Files:**
- Modify: `apps/browser-worker/src/observer.ts`
- Modify: `apps/browser-worker/src/dom-registry.ts`
- Test: `apps/browser-worker/src/observer.test.ts`

**Interfaces:**
- Consumes: 页面 DOM 中的 `input`、`textarea`、`select`、`[role=combobox]`、可见自定义下拉触发器。
- Produces: 继续返回 `FormSnapshot` 和不透明字段 ID；Worker 内部注册表可通过字段 ID 找到对应 Locator。

- [ ] **Step 1: 写失败测试，证明同标题年月控件会保留“年/月”语义。**

```ts
it("keeps year and month as separate fields for a shared date label", async () => {
  const snapshot = await observeFixture("custom-date-selects");
  expect(snapshot.fields.map((field) => field.label)).toEqual([
    "起止时间 年",
    "起止时间 月"
  ]);
  expect(snapshot.fields.every((field) => field.type === "select")).toBe(true);
});
```

- [ ] **Step 2: 运行测试确认当前实现失败。**

Run: `rtk pnpm --filter @resume/browser-worker test -- observer.test.ts --run`

Expected: FAIL，因为当前观察器只扫描原生表单元素，无法建立两个自定义控件字段。

- [ ] **Step 3: 实现最小控件描述和注册映射。**

在 Worker 内部增加 `ObservedControlKind = "native" | "combobox" | "custom_select"`，原生元素继续使用现有索引；自定义控件通过观察脚本生成稳定的 `field:<index>` 路径，并由 `DomRegistry` 保存对应 Locator。观察脚本只纳入可见、非禁用、非内部控件，读取可访问名称、附近标签、当前文本和可见选项。

- [ ] **Step 4: 运行观察与注册测试确认通过。**

Run: `rtk pnpm --filter @resume/browser-worker test -- observer.test.ts --run`

Expected: PASS，原生控件行为不变，自定义年月控件各自拥有独立字段 ID。

- [ ] **Step 5: 提交 Task 1。**

```powershell
rtk git add apps/browser-worker/src/observer.ts apps/browser-worker/src/dom-registry.ts apps/browser-worker/src/observer.test.ts
rtk git commit -m "feat: observe custom application controls"
```

### Task 2: 日期组件投影和选项匹配

**Files:**
- Modify: `apps/api/src/applications/production-field-resolver.ts`
- Modify: `apps/api/src/applications/entry-field-semantics.ts`
- Create: `apps/api/src/applications/control-value.ts`
- Test: `apps/api/src/production-dependencies.test.ts`
- Test: `apps/api/src/applications/control-value.test.ts`

**Interfaces:**
- Consumes: `FormField`, canonical profile date strings such as `2026-04-12`, and visible option labels.
- Produces: `projectDateComponent(field, semantic, value)` and `matchControlOption(value, options)`；日期字段只输出当前子控件所需分量。

- [ ] **Step 1: 写失败测试覆盖年月、非标准值和 option 显示文本。**

```ts
it("projects a canonical date to the requested component", () => {
  expect(projectDateComponent(field("开始时间 年"), "work[0].startDate", "2026-04-12")).toBe("2026");
  expect(projectDateComponent(field("开始时间 月"), "work[0].startDate", "2026-04-12")).toBe("04");
  expect(projectDateComponent(field("开始时间"), "work[0].startDate", "2026-04-12")).toBe("2026-04-12");
});

it("matches padded and unpadded month options without accepting a full date", () => {
  expect(matchControlOption("04", ["1", "2", "4", "5"])).toBe("4");
  expect(matchControlOption("2026-04-12", ["2026", "2027"])).toBeUndefined();
});
```

- [ ] **Step 2: 运行测试确认失败或补足当前暴露边界。**

Run: `rtk pnpm --filter @resume/api test -- src/applications/control-value.test.ts src/production-dependencies.test.ts --run`

Expected: 新增的 option 匹配测试 FAIL；已有日期投影测试必须保留原有失败信息作为回归基线。

- [ ] **Step 3: 实现结构化日期投影和安全 option 匹配。**

将日期解析限制为 `YYYY-MM-DD`；仅当字段标签明确包含“年/月份/日”时投影。`matchControlOption` 按原文、去前导零、去除日期单位后的值匹配，禁止把完整日期匹配到年月候选项。未找到候选项返回 `undefined`，不猜测。

- [ ] **Step 4: 运行 API 单测确认通过。**

Run: `rtk pnpm --filter @resume/api test -- src/applications/control-value.test.ts src/production-dependencies.test.ts --run`

Expected: PASS。

- [ ] **Step 5: 提交 Task 2。**

```powershell
rtk git add apps/api/src/applications/production-field-resolver.ts apps/api/src/applications/entry-field-semantics.ts apps/api/src/applications/control-value.ts apps/api/src/applications/control-value.test.ts apps/api/src/production-dependencies.test.ts
rtk git commit -m "fix: project dates into matched control options"
```

### Task 3: 自定义下拉执行和读回恢复

**Files:**
- Modify: `packages/contracts/src/browser.ts`
- Modify: `apps/browser-worker/src/executor.ts`
- Create: `apps/browser-worker/src/control-adapters.ts`
- Test: `apps/browser-worker/src/executor.test.ts`
- Test: `apps/browser-worker/src/control-adapters.test.ts`

**Interfaces:**
- Consumes: registered field Locator, field type/options, command value, and current page snapshot.
- Produces: `ExecutionResponse` with `status`, `actualValue`, `errors`, plus non-blocking recovery metadata consumed by the API service.

- [ ] **Step 1: 写失败测试覆盖三种执行路径。**

```ts
it("selects a custom year and month control by opening its visible options", async () => {
  const result = await executeFixture("custom-date-selects", {
    year: "2026",
    month: "04"
  });
  expect(result.status).toBe("applied");
  expect(result.snapshot.fields.find((field) => field.label === "起止时间 年")?.currentValue).toBe("2026");
  expect(result.snapshot.fields.find((field) => field.label === "起止时间 月")?.currentValue).toMatch(/^(04|4)$/);
});

it("retries an option after readback mismatch and returns a warning instead of throwing", async () => {
  const result = await executeFixture("delayed-custom-select", { month: "04" });
  expect(result.status).toBe("applied");
  expect(result.warnings).toContain("control_recovered_after_readback_mismatch");
});
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `rtk pnpm --filter @resume/browser-worker test -- control-adapters.test.ts executor.test.ts --run`

Expected: FAIL，因为当前执行器对自定义 Locator 直接调用 `selectOption`，且响应没有恢复警告。

- [ ] **Step 3: 实现控制器适配器。**

在 `control-adapters.ts` 中实现 `selectControlOption(locator, expected, options)`：原生 `select` 使用 `selectOption`；ARIA/custom 控件先点击触发器，读取可见 `[role=option]` 或选项文本，按 `matchControlOption` 选择，再等待控件当前文本稳定。每次恢复最多执行两次，禁止坐标盲点。

- [ ] **Step 4: 接入 Executor 并保留安全读回。**

`executor.ts` 对 `select` 调用适配器；成功但经历恢复时返回 `warnings`，最终 `actualValue` 仍来自新的页面快照。无法确认读回时返回字段级失败，不执行下一次危险操作。

- [ ] **Step 5: 运行 Worker 测试确认通过。**

Run: `rtk pnpm --filter @resume/browser-worker test -- control-adapters.test.ts executor.test.ts --run`

Expected: PASS，原生 checkbox/date/select、上传和中间操作回归测试全部保持通过。

- [ ] **Step 6: 提交 Task 3。**

```powershell
rtk git add apps/browser-worker/src/executor.ts apps/browser-worker/src/control-adapters.ts apps/browser-worker/src/control-adapters.test.ts apps/browser-worker/src/executor.test.ts packages/contracts/src/browser.ts
rtk git commit -m "feat: recover custom select execution"
```

### Task 4: 字段级失败继续执行与最终审核展示

**Files:**
- Modify: `packages/contracts/src/application.ts`
- Modify: `apps/api/src/applications/application-service.ts`
- Modify: `apps/api/src/applications/field-coverage.ts`
- Modify: `apps/web/src/applications/FieldCoveragePanel.tsx`
- Test: `apps/api/src/applications/application-machine.test.ts`
- Test: `apps/api/src/applications/field-coverage.test.ts`
- Test: `apps/web/src/applications/FieldCoveragePanel.test.tsx`

**Interfaces:**
- Consumes: execution result `warnings/errors` and current snapshot.
- Produces: coverage items with `filled`, `review`, `missing`, `unsupported`；普通填写失败会记录原因并继续下一字段，最终页面集中显示风险字段。

- [ ] **Step 1: 写失败测试证明普通字段失败不会暂停整页。**

```ts
it("continues filling later fields after a recoverable field failure", async () => {
  const browser = fixtureBrowser({ firstExecution: { status: "failed", errors: ["option_not_found"] } });
  await service.runUntilPause("task-1");
  expect(browser.execute).toHaveBeenCalledTimes(2);
  expect(service.fieldCoverage("task-1")?.fields).toEqual(expect.arrayContaining([
    expect.objectContaining({ fieldId: "field-month", status: "review" }),
    expect.objectContaining({ fieldId: "field-email", status: "filled" })
  ]));
});
```

- [ ] **Step 2: 运行测试确认当前实现失败。**

Run: `rtk pnpm --filter @resume/api test -- src/applications/application-machine.test.ts src/applications/field-coverage.test.ts --run`

Expected: FAIL，因为当前 `applyVerified` 在第一个非 applied 结果上调用 `pauseAfterExecutionFailure` 并立即返回。

- [ ] **Step 3: 扩展应用协议保存非阻塞执行风险。**

在 `ApplicationFieldAssessment` 增加可选 `execution` 对象：`status: "clean" | "recovered" | "failed"`、`warnings: string[]`、`attempts: number`。`field-coverage.ts` 提供 `markExecutionReview`，将已成功恢复的字段保持为 `review`，将无法填写的字段保持为 `missing`，并保留失败原因。

- [ ] **Step 4: 修改 `applyVerified` 的失败策略。**

将普通 `failed`、`blocked`（不含终态安全阻断）记录到当前字段并继续；只有 `terminal_submission_blocked`、`unsafe_intermediate_navigation`、`execution_invalidated` 等安全/生命周期错误才立即停止。每次继续前保存最新快照，避免后续命令使用旧 `snapshotId`。

- [ ] **Step 5: 更新最终审核面板。**

`FieldCoveragePanel` 增加“自动恢复”和“待人工补充”分组；字段显示中文原因、尝试次数和实际读回值，不展示 selector、原始 DOM 或密钥。页面仍保留现有“打开受控浏览器”和“最终提交被禁止”提示。

- [ ] **Step 6: 运行 API、Web 测试确认通过。**

Run: `rtk pnpm --filter @resume/api test -- src/applications/application-machine.test.ts src/applications/field-coverage.test.ts --run`

Run: `rtk pnpm --filter @resume/web test -- FieldCoveragePanel.test.tsx --run`

Expected: PASS，字段失败会继续，最终审核能看到风险。

- [ ] **Step 7: 提交 Task 4。**

```powershell
rtk git add packages/contracts/src/application.ts apps/api/src/applications/application-service.ts apps/api/src/applications/field-coverage.ts apps/web/src/applications/FieldCoveragePanel.tsx apps/api/src/applications/application-machine.test.ts apps/api/src/applications/field-coverage.test.ts apps/web/src/applications/FieldCoveragePanel.test.tsx
rtk git commit -m "feat: continue autofill and surface field risks"
```

### Task 5: 集成回归与真实页面安全验证

**Files:**
- Verify: `tests/browser/mokahr-high-coverage.spec.ts`
- Verify: `tests/browser/application-stability.spec.ts`
- Verify: `apps/api/src/production-dependencies.test.ts`
- Verify: `apps/browser-worker/src/executor.test.ts`

- [ ] **Step 1: 运行受影响包测试。**

```powershell
rtk pnpm --filter @resume/contracts test -- --run
rtk pnpm --filter @resume/form-semantics test -- --run
rtk pnpm --filter @resume/browser-worker test -- --run
rtk pnpm --filter @resume/api test -- --run
rtk pnpm --filter @resume/web test -- --run
```

- [ ] **Step 2: 运行类型检查和构建。**

```powershell
rtk pnpm typecheck
rtk pnpm --filter @resume/api build
rtk pnpm --filter @resume/web build
rtk git diff --check HEAD~5..HEAD
```

- [ ] **Step 3: 执行真实 DJI/Moka 安全流程。**

使用已登录浏览器实例进入申请页，验证实习经历的年、月分别被选择，邮箱、公司、职位和职责继续填写；制造一个不可匹配月份，确认后续字段仍继续填写，最终审核展示该月份待补充；验证没有提交按钮点击、没有非 GET 提交请求。

- [ ] **Step 4: 重启本地服务并进行只读健康检查。**

```powershell
rtk pnpm --filter @resume/api start
rtk curl http://127.0.0.1:43120/api/health/adapters
```

Expected: API 健康检查返回 200；任务仍停在最终审核或待补充状态，不进入 success/提交状态。

- [ ] **Step 5: 记录最终状态。**

```powershell
rtk git status --short --branch
```

Expected: 仅保留用户原有 `.superpowers/sdd/*.md` 修改；数据库、日志和构建产物不进入 Git。
