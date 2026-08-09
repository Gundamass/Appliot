# 国内 ATS 优先稳定化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在绝不提交的前提下，优先提升 DJI/Moka 及国内常见 ATS 的复杂控件填写成功率，并修复跨站点回归中发现的任务崩溃、动态等待、语义映射和过度追问问题。

**Architecture:** 保留现有应用服务、浏览器 Worker 和 RAG 分层。浏览器层统一发现和执行原生/自定义控件，国内 ATS 规则只补充页面阶段和局部结构；应用服务先做确定性填写，再对有证据的剩余字段做受阈值限制的语义填充，最终进入用户审核。

**Tech Stack:** TypeScript, Playwright Core, Vitest, XState, Zod, pnpm workspace, Playwright browser regression.

## Global Constraints

- 优先级：DJI/Moka -> 国内常见 ATS 结构 -> Greenhouse/Lever/Workday/Ashby。
- 不得新增或暴露任何最终提交命令；`Submit Application` 和等价提交请求必须继续被策略层阻断。
- 搜索型下拉必须先输入候选值再选择，不得把全量选项放进任务响应。
- 敏感人口信息只能使用用户显式保存的答案，禁止推断；法律确认框不得自动勾选。
- 非必填且没有可靠档案资料的字段静默跳过；缺少资料的必填字段才生成追问。
- 每次填写、选择和上传都必须回读验证；失败必须保留可诊断错误。
- 不回退用户已有未提交文件：`.superpowers/sdd/*` 和 `.runtime/cross-site-audit/*` 不在本计划范围内。

### Task 1: 建模国内常见复杂控件并限制选项体积

**Files:**
- Modify: `packages/contracts/src/browser.ts`
- Modify: `packages/form-semantics/src/snapshot-script.ts`
- Modify: `packages/form-semantics/src/normalize.ts`
- Modify: `apps/browser-worker/src/observer.ts`
- Test: `apps/browser-worker/src/observer.test.ts`
- Test: `packages/form-semantics/src/mokahr-adapter.test.ts`

**Interfaces:**
- `RawFormField` 继续向 `normalizeForm` 提供 `controlKind`, `options`, `nearbyText` 和字段标签来源。
- `FormField` 增加可选的诊断元数据，至少能表示 `optionsTruncated` 和 `interactionMode: "native" | "search" | "choice_group" | "date_group" | "file"`。
- 既有 `DomRegistry` 的 field 索引映射必须保持兼容。

- [ ] **Step 1: 写失败测试**

在 `observer.test.ts` 增加真实 DOM 夹具，覆盖：Moka 风格学校搜索框、按钮式 Yes/No、ARIA radio group、复选框、年月日控件、上传包装器。断言观察结果包含上层问题标签、选项组字段和正确交互模式；断言 2,000 个 option 最多暴露 100 个并标记截断。

```ts
it("models domestic searchable controls without serializing the full school list", async () => {
  const snapshot = await observeFixture(domWithMokahrControls({ schoolOptions: 2000 }));
  expect(snapshot.fields.find((field) => field.label === "毕业院校")?.interactionMode).toBe("search");
  expect(snapshot.fields.find((field) => field.label === "毕业院校")?.options).toHaveLength(100);
  expect(snapshot.fields.find((field) => field.label === "毕业院校")?.optionsTruncated).toBe(true);
});
```

- [ ] **Step 2: 运行测试确认失败**

运行 `corepack pnpm --filter @resume/browser-worker test -- observer.test.ts` 和 `corepack pnpm --filter @resume/form-semantics test -- mokahr-adapter.test.ts`。预期新增断言失败，原因是按钮组未成为字段且选项未截断。

- [ ] **Step 3: 实现最小改动**

在快照脚本中把具有共同问题容器、相同 `name` 或 ARIA group 的 radio/choice button 聚合为一个字段；从问题容器提取标签；识别可输入的 combobox 为 `search`；对静态 options 做 100 项上限截断并传递诊断标记；清理文件字段的包装器文案并按真实 input 去重。在 `normalize.ts` 中将新元数据映射到合同类型。

- [ ] **Step 4: 运行测试确认通过**

运行上述两个定向测试，再运行 `corepack pnpm --filter @resume/form-semantics typecheck` 和 `corepack pnpm --filter @resume/browser-worker typecheck`。预期全部通过。

- [ ] **Step 5: 提交**

```powershell
git add packages/contracts/src/browser.ts packages/form-semantics/src/snapshot-script.ts packages/form-semantics/src/normalize.ts apps/browser-worker/src/observer.ts apps/browser-worker/src/observer.test.ts packages/form-semantics/src/mokahr-adapter.test.ts
git commit -m "feat: model domestic ATS complex controls"
```

### Task 2: 实现搜索型下拉的输入、筛选、选择和回读

**Files:**
- Modify: `apps/browser-worker/src/executor.ts`
- Modify: `apps/browser-worker/src/dom-registry.ts`
- Test: `apps/browser-worker/src/executor.test.ts`
- Test: `tests/browser/application-stability.spec.ts`

**Interfaces:**
- `selectCustomControl(locator, value)` 接收字段的 `interactionMode` 和目标值，返回 `{ selectedValue: string | boolean; recovered: boolean }`。
- 现有 `ExecutableCommand` 的 `select` 命令保持不变，不引入提交类命令。

- [ ] **Step 1: 写失败测试**

增加测试：输入“同济大学”后只在筛选结果中选择完全匹配项；无候选或多个候选时返回明确的 `search_option_not_found` 或 `search_option_ambiguous`；选择后页面回读值与目标一致才返回 `applied`。

```ts
it("filters a searchable school control before selecting the exact option", async () => {
  const result = await executeSelect("毕业院校", "同济大学");
  expect(result.status).toBe("applied");
  expect(result.actualValue).toBe("同济大学");
  expect(page.locator("[data-school-option]")).toHaveCount(1);
});
```

- [ ] **Step 2: 运行测试确认失败**

运行 `corepack pnpm --filter @resume/browser-worker test -- executor.test.ts`。预期当前实现把自定义控件当作普通点击选择，无法稳定筛选或回读。

- [ ] **Step 3: 实现最小改动**

先定位控件内部可输入 textbox，填入规范化目标值并等待候选 DOM 稳定；候选文本规范化后完全匹配时点击唯一候选；必要时支持 Moka 的级联控件先选择上级再加载下级；候选不唯一时阻断该字段而不是枚举全量选项。补充 `select` 错误码到执行结果，保证应用服务能展示字段级原因。

- [ ] **Step 4: 运行测试确认通过**

运行定向 executor 测试、`corepack pnpm --filter @resume/browser-worker typecheck` 和 `corepack pnpm test:e2e -- tests/browser/application-stability.spec.ts`。预期搜索成功、歧义阻断、原有 DJI 日期控件测试均通过。

- [ ] **Step 5: 提交**

```powershell
git add apps/browser-worker/src/executor.ts apps/browser-worker/src/dom-registry.ts apps/browser-worker/src/executor.test.ts tests/browser/application-stability.spec.ts
git commit -m "feat: select searchable ATS controls safely"
```

### Task 3: 修复动态页面等待和登录阶段识别

**Files:**
- Modify: `apps/browser-worker/src/observer.ts`
- Modify: `packages/form-semantics/src/action-classifier.ts`
- Modify: `apps/api/src/applications/application-service.ts`
- Test: `apps/browser-worker/src/observer.test.ts`
- Test: `apps/api/src/applications/application-machine.test.ts`

**Interfaces:**
- `BrowserObserver.observe` 在职位页、登录页和申请页统一返回稳定的 `stage`。
- 空字段页面只有在观察超时后才返回诊断错误，不得被当成可验证页面。

- [ ] **Step 1: 写失败测试**

增加 Workday 夹具：初始无字段，延迟出现 Apply；第二个夹具只有 Sign In、Sign in with Google、Sign in with email 按钮。断言前者最终为可导航职位页，后者为 `login` 并让应用状态进入 `awaiting_login`。

```ts
it("waits for a dynamic apply action before classifying a Workday page", async () => {
  const snapshot = await observeDynamicWorkdayFixture();
  expect(snapshot.actions.some((action) => action.text === "Apply")).toBe(true);
  expect(snapshot.stage).toBe("job");
});
```

- [ ] **Step 2: 运行测试确认失败**

运行 `corepack pnpm --filter @resume/browser-worker test -- observer.test.ts` 和 `corepack pnpm --filter @resume/api test -- application-machine.test.ts`。预期当前实现返回 `unknown` 或过早进入验证。

- [ ] **Step 3: 实现最小改动**

把“可观察信号”从“有字段”扩展为字段、登录入口、Apply/Continue/Next 安全动作或明确错误；使用条件轮询和总超时。补充按钮文案的登录阶段分类；应用服务遇到 `stage=login` 时发送 `LOGIN_REQUIRED`，空快照超时则使用结构化页面等待错误。

- [ ] **Step 4: 运行测试确认通过**

运行两个定向包测试、`corepack pnpm --filter @resume/api typecheck`、`corepack pnpm --filter @resume/browser-worker typecheck`，并确认 `tests/browser/mokahr-high-coverage.spec.ts` 通过。

- [ ] **Step 5: 提交**

```powershell
git add apps/browser-worker/src/observer.ts packages/form-semantics/src/action-classifier.ts apps/api/src/applications/application-service.ts apps/browser-worker/src/observer.test.ts apps/api/src/applications/application-machine.test.ts
git commit -m "fix: wait for dynamic ATS stages"
```

### Task 4: 补齐国内优先语义映射和低打扰追问策略

**Files:**
- Modify: `apps/api/src/applications/field-semantic-resolver.ts`
- Modify: `apps/api/src/applications/application-service.ts`
- Modify: `packages/rag/src/planner.ts`
- Test: `apps/api/src/applications/field-semantic-resolver.test.ts`
- Test: `apps/api/src/applications/application-machine.test.ts`
- Test: `packages/rag/src/rag-loop.test.ts`

**Interfaces:**
- 解析器继续返回现有 `FieldResolution`，通过 `phase="deterministic"` 和 `phase="semantic"` 区分两轮。
- 字段风险继续复用 RAG verifier；敏感字段答案来源必须带有用户显式确认标记。

- [ ] **Step 1: 写失败测试**

覆盖国内中文和常见英文标签到 `basics.name`、`basics.phone`、`basics.email`、`education[].institution`、`preferences.availability`、`preferences.currentLocation`、`preferences.willingToRelocate` 的映射；覆盖非必填未知字段不生成问题、必填未知字段生成问题、敏感字段不从普通事实推断。

```ts
it("maps common domestic and English ATS labels to the candidate profile", async () => {
  await expect(resolveField(field("Legal Name"), "deterministic")).resolves.toMatchObject({ fieldPath: "basics.name", status: "verified" });
  await expect(resolveField(field("毕业院校"), "deterministic")).resolves.toMatchObject({ fieldPath: "education[0].institution", status: "verified" });
});
```

- [ ] **Step 2: 运行测试确认失败**

运行 `corepack pnpm --filter @resume/api test -- field-semantic-resolver.test.ts application-machine.test.ts` 和 `corepack pnpm --filter @resume/rag test -- rag-loop.test.ts`。预期英文拆分字段、非必填未知字段和敏感字段断言失败。

- [ ] **Step 3: 实现最小改动**

扩充别名和姓名拆分规则；在第一轮后重新观察，只对空字段执行第二轮语义检索；重复区块先建立 `awards[index]` 等上下文，再让语义检索映射具体字段；字段执行失败时只允许一次稳定页面重观察和语义重解析，禁止上传、导航和提交动作自动重试；过滤非必填且无资料字段；把敏感字段限定为档案中的显式答案；将法律确认框标记为最终审核项而不是可执行填写命令。保留实习描述、项目亮点不生成自动微调内容。

- [ ] **Step 4: 运行测试确认通过**

运行上述定向测试，再运行 `corepack pnpm --filter @resume/api typecheck`、`corepack pnpm --filter @resume/rag typecheck` 和 `corepack pnpm --filter @resume/api test -- production-dependencies.test.ts routes.test.ts`。

- [ ] **Step 5: 提交**

```powershell
git add apps/api/src/applications/field-semantic-resolver.ts apps/api/src/applications/application-service.ts packages/rag/src/planner.ts apps/api/src/applications/field-semantic-resolver.test.ts apps/api/src/applications/application-machine.test.ts packages/rag/src/rag-loop.test.ts
git commit -m "feat: reduce ATS questions and expand field semantics"
```

### Task 5: 国内 ATS 真实回归与海外兼容回归

**Files:**
- Modify: `tests/browser/mokahr-high-coverage.spec.ts`
- Modify: `tests/browser/application-stability.spec.ts`
- Create: `tests/browser/cross-ats-fixtures.ts`
- Create: `docs/superpowers/reports/2026-08-07-domestic-first-ats-regression.md`

**Interfaces:**
- 回归夹具提供真实 DOM 结构和合成候选资料，不依赖用户私有资料。
- 所有真实 URL 测试必须使用隔离数据库、隔离浏览器配置和“禁止提交”保护。

- [ ] **Step 1: 写失败回归断言**

先加入 DJI/Moka 断言：姓名、电话、学校搜索、教育/实习/项目重复字段、年月拆分都能填写并回读；加入国内结构夹具和四类海外 ATS 夹具，断言任务创建、阶段识别和终端提交保护。

- [ ] **Step 2: 运行回归确认当前基线失败**

运行 `corepack pnpm test:e2e -- tests/browser/mokahr-high-coverage.spec.ts tests/browser/application-stability.spec.ts`，记录失败字段、阶段、错误码和未点击提交证据。

- [ ] **Step 3: 在前四个任务完成后运行回归**

按国内 ATS 优先顺序执行真实公开页面；每个站点只允许观察、填写、选择、上传和中间导航。对每个字段记录 `filled/review/missing/unsupported`、回读值和证据。

- [ ] **Step 4: 生成回归报告并确认无提交**

报告包含站点、页面阶段、字段覆盖率、失败原因、截图/快照位置、最终提交按钮仍存在且未触发的证据。测试结束取消并删除所有隔离任务，停止隔离 API/Worker，保留生产 Web/API 在线。

- [ ] **Step 5: 提交**

```powershell
git add tests/browser/mokahr-high-coverage.spec.ts tests/browser/application-stability.spec.ts tests/browser/cross-ats-fixtures.ts docs/superpowers/reports/2026-08-07-domestic-first-ats-regression.md
git commit -m "test: add domestic-first ATS regression coverage"
```

## 完成检查

- [ ] `corepack pnpm test` 全部通过。
- [ ] `corepack pnpm typecheck` 通过。
- [ ] DJI/Moka 真实回归通过且不回归已有日期控件。
- [ ] Lever 大选项页面可以创建任务并使用搜索选择。
- [ ] Workday 动态职位页和登录方式页不再误判失败。
- [ ] Ashby 复杂控件被观察并在支持的情况下正确填充。
- [ ] 所有站点都未触发最终提交。
