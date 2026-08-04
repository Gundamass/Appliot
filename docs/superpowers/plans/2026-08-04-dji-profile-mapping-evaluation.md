# 大疆候选人档案字段覆盖与映射评测实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为大疆招聘页面生成可追溯的字段覆盖报告，并将精确映射、受约束语义映射、追问和人工审核整合进投递任务工作台。

**Architecture:** 复用现有 `FIELD_DEFINITIONS`、`FieldSemanticResolver` 和 RAG 验证器；新增 DJI 页面字段目录来补充站点稳定语义和枚举规则。生产字段解析器把每次决策转换为可持久化的字段评测，应用服务在观察、填写和重新观察后更新评测，任务 API 将其返回给 React 工作台。

**Tech Stack:** TypeScript、Zod、Vitest、Fastify、SQLite、XState、React、Playwright、现有远程 Embedding Provider。

## Global Constraints

- 永不执行提交、投递、发送申请或语义等价的终态动作；所有流程必须停在审核锁。
- 先写失败测试并确认 RED，再写最小实现并确认 GREEN。
- 只填写当前页面可见、可编辑且为空的字段，绝不覆盖官网已有值或用户手动输入。
- 决策顺序固定为：DJI 稳定目录和精确路径、别名和枚举转换、语义检索、验证、人工审核或追问。
- 语义置信度低于 `0.90`、证据冲突、无法唯一匹配选项、敏感信息或求职承诺，均不得自动填写。
- 项目描述、实习描述和项目亮点保持用户原文，不生成、不静默改写。
- 用户回答默认仅保存到本次任务；只有现有的明确“保存到长期档案”选择才允许回写档案。
- 使用现有分支和工作目录；不得修改未暂存的 `.superpowers/sdd/*` 工作记录。

---

## 文件结构

- `apps/api/src/applications/dji-field-catalog.ts`：仅描述 DJI 已确认页面字段的站点标签、标准语义、可接受字段类型与选项归一化。
- `apps/api/src/applications/dji-field-catalog.test.ts`：验证目录只在 DJI URL 和兼容字段结构下生效，未知字段不被猜测。
- `packages/contracts/src/application.ts`：定义 API 可见的字段评测、覆盖汇总和任务响应字段。
- `apps/api/src/applications/checkpoint-repository.ts`：将当前字段评测随检查点持久化和恢复。
- `apps/api/src/db/migrate.ts`：为 `application_checkpoints` 增加可空的 `field_coverage_json` 列，并兼容已有数据库。
- `apps/api/src/applications/field-coverage.ts`：把字段解析结果和回读状态归并为稳定、可展示的覆盖报告。
- `apps/api/src/applications/application-service.ts`：在两阶段解析、重新观察和用户接管后维护字段覆盖报告。
- `apps/api/src/production-dependencies.ts`：将目录命中、语义解析和 RAG 校验转换为带证据的字段评测。
- `apps/api/src/applications/routes.ts`：把当前覆盖报告返回到 `ApplicationTask`。
- `apps/web/src/applications/FieldCoveragePanel.tsx`：紧凑展示覆盖汇总和待处理字段的证据、置信度与原因。
- `apps/web/src/applications/FieldCoveragePanel.test.tsx`：验证摘要、待审核项、证据和移动端语义结构。
- `apps/web/src/applications/ApplicationTaskPage.tsx`：把字段覆盖面板放入真实投递任务，不再依赖独立 RAG 演示页。
- `apps/web/src/styles.css`：增加覆盖面板的响应式、非嵌套卡片布局。
- `apps/synthetic-ats/src/server.ts` 与 `tests/browser/dji-coverage.spec.ts`：提供 DJI 风格字段场景，验证端到端决策和提交拦截。

## Task 1: DJI 字段目录和页面语义标注

**Files:**
- Create: `apps/api/src/applications/dji-field-catalog.ts`
- Create: `apps/api/src/applications/dji-field-catalog.test.ts`
- Modify: `apps/api/src/applications/application-service.ts`
- Test: `apps/api/src/applications/entry-field-semantics.test.ts`

**Interfaces:**
- Produces: `isDjiApplicationUrl(url: string): boolean`
- Produces: `annotateDjiFields(snapshot: FormSnapshot): FormSnapshot`
- Produces: `DjiCatalogMatch { semantic: string; source: "dji_catalog"; optionAliases?: Record<string, string> }`
- Consumes: `FormSnapshot`, `FormField` and existing `deriveEntrySemanticHints(fields)`.

- [ ] **Step 1: 写失败测试，覆盖稳定字段和保守未知字段**

在 `dji-field-catalog.test.ts` 构造字段快照，断言：

```ts
expect(annotateDjiFields(djiSnapshot).fields).toContainEqual(expect.objectContaining({
  label: "毕业院校",
  semanticHint: "education[0].institution"
}));
expect(annotateDjiFields(nonDjiSnapshot).fields[0]?.semanticHint).toBeUndefined();
expect(annotateDjiFields(djiUnknownFieldSnapshot).fields[0]?.semanticHint).toBeUndefined();
```

目录测试还必须覆盖：`姓名 -> basics.name`、`手机号码 -> basics.phone`、`项目名称 -> projects[0].name`、`获奖级别 -> awards[0].level`，以及不兼容的字段类型不会命中目录。

- [ ] **Step 2: 运行测试确认 RED**

Run: `rtk pnpm --filter @resume/api exec vitest run src/applications/dji-field-catalog.test.ts`

Expected: FAIL，因为 `dji-field-catalog.ts` 尚不存在。

- [ ] **Step 3: 实现目录和标注函数**

在 `dji-field-catalog.ts` 定义不可变目录和纯函数：

```ts
export interface DjiCatalogMatch {
  semantic: string;
  source: "dji_catalog";
  optionAliases?: Record<string, string>;
}

export function annotateDjiFields(snapshot: FormSnapshot): FormSnapshot {
  if (!isDjiApplicationUrl(snapshot.url)) return snapshot;
  return {
    ...snapshot,
    fields: snapshot.fields.map((field) => {
      const match = matchDjiField(field);
      return match === undefined ? field : { ...field, semanticHint: match.semantic };
    })
  };
}
```

匹配键必须包含归一化标签、字段类型和必要的选项集合；不使用“最相近标签”猜测。`application-service.ts` 的 `withDerivedEntrySemantics` 先调用 `annotateDjiFields`，再调用既有 `deriveEntrySemanticHints`，确保目录语义不被通用重复条目推断覆盖。

- [ ] **Step 4: 运行聚焦测试确认 GREEN**

Run: `rtk pnpm --filter @resume/api exec vitest run src/applications/dji-field-catalog.test.ts src/applications/entry-field-semantics.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交任务**

```powershell
rtk git add apps/api/src/applications/dji-field-catalog.ts apps/api/src/applications/dji-field-catalog.test.ts apps/api/src/applications/application-service.ts apps/api/src/applications/entry-field-semantics.test.ts
rtk git commit -m "feat: annotate dji application fields"
```

## Task 2: 字段覆盖合同和检查点持久化

**Files:**
- Modify: `packages/contracts/src/application.ts`
- Modify: `packages/contracts/src/application.test.ts`
- Modify: `apps/api/src/db/migrate.ts`
- Modify: `apps/api/src/applications/checkpoint-repository.ts`
- Modify: `apps/api/src/applications/checkpoint-repository.test.ts`

**Interfaces:**
- Produces: `ApplicationFieldAssessmentSchema`
- Produces: `ApplicationFieldCoverageSchema`
- Adds: optional `fieldCoverage` to `ApplicationTaskSchema` and `ApplicationCheckpointInput`.

- [ ] **Step 1: 写失败合同和仓库测试**

定义并测试下列最小公开模型：

```ts
const ApplicationFieldAssessmentSchema = z.object({
  fieldId: z.string(),
  label: z.string(),
  semantic: z.string().optional(),
  status: z.enum(["ready", "review", "missing", "unsupported", "filled"]),
  source: z.enum(["dji_catalog", "exact", "semantic", "user", "none"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  evidence: z.array(EvidenceSchema)
}).strict();

const ApplicationFieldCoverageSchema = z.object({
  total: z.number().int().nonnegative(),
  ready: z.number().int().nonnegative(),
  review: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  unsupported: z.number().int().nonnegative(),
  filled: z.number().int().nonnegative(),
  fields: z.array(ApplicationFieldAssessmentSchema)
}).strict();
```

仓库测试应保存带 `fieldCoverage` 的检查点，重新创建仓库后断言完整对象被恢复；保存旧格式检查点时，断言 `fieldCoverage` 仍为 `undefined`。

- [ ] **Step 2: 运行测试确认 RED**

Run: `rtk pnpm --filter @resume/contracts exec vitest run src/application.test.ts`

Run: `rtk pnpm --filter @resume/api exec vitest run src/applications/checkpoint-repository.test.ts`

Expected: FAIL，因为合同字段和数据库列尚不存在。

- [ ] **Step 3: 实现 Zod 合同、迁移和仓库映射**

在迁移中使用 SQLite 兼容的列检测后执行：

```sql
ALTER TABLE application_checkpoints ADD COLUMN field_coverage_json TEXT;
```

只有列不存在时执行。`checkpoint-repository.ts` 的 `CheckpointRow`、插入语句、`saveTransaction` 和 `fromRow` 都加入 `field_coverage_json`；写入时序列化为 JSON，读取时用 `ApplicationFieldCoverageSchema.parse` 校验。旧行 `NULL` 保持为 `undefined`。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `rtk pnpm --filter @resume/contracts exec vitest run src/application.test.ts`

Run: `rtk pnpm --filter @resume/api exec vitest run src/applications/checkpoint-repository.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交任务**

```powershell
rtk git add packages/contracts/src/application.ts packages/contracts/src/application.test.ts apps/api/src/db/migrate.ts apps/api/src/applications/checkpoint-repository.ts apps/api/src/applications/checkpoint-repository.test.ts
rtk git commit -m "feat: persist application field coverage"
```

## Task 3: 生产映射决策和服务端覆盖报告

**Files:**
- Create: `apps/api/src/applications/field-coverage.ts`
- Create: `apps/api/src/applications/field-coverage.test.ts`
- Modify: `apps/api/src/production-dependencies.ts`
- Modify: `apps/api/src/production-dependencies.test.ts`
- Modify: `apps/api/src/applications/application-service.ts`
- Modify: `apps/api/src/applications/application-machine.test.ts`

**Interfaces:**
- Produces: `summarizeFieldCoverage(fields: ApplicationFieldAssessment[]): ApplicationFieldCoverage`
- Extends internal `FieldResolution` with `assessment: ApplicationFieldAssessment`.
- Adds `fieldCoverage(taskId: string): ApplicationFieldCoverage | undefined` to `ApplicationService`.

- [ ] **Step 1: 写失败测试，验证决策分类和持久化时机**

`field-coverage.test.ts` 必须断言汇总计数正确，并且同一字段的新决策会替换旧决策。`production-dependencies.test.ts` 必须覆盖：

```ts
expect(resolution.assessment).toMatchObject({
  semantic: "education[0].institution",
  status: "ready",
  source: "dji_catalog",
  confidence: 1
});
expect(lowConfidenceResolution.assessment.status).toBe("review");
expect(noEvidenceResolution.assessment.status).toBe("missing");
expect(commitmentResolution.assessment.status).toBe("review");
```

`application-machine.test.ts` 必须证明：解析出的安全字段在回读成功后变为 `filled`；用户已有值变为 `filled` 且 `source: "user"`；重新观察后消失的字段从报告移除；包含终态提交按钮时状态仍为 `review_locked`，不生成提交命令。

- [ ] **Step 2: 运行测试确认 RED**

Run: `rtk pnpm --filter @resume/api exec vitest run src/applications/field-coverage.test.ts src/production-dependencies.test.ts src/applications/application-machine.test.ts`

Expected: FAIL，因为评测对象和 `fieldCoverage` 服务接口尚不存在。

- [ ] **Step 3: 实现评测归并和决策转换**

`field-coverage.ts` 只负责纯数据归并：按 `fieldId` 去重，按状态计数，并使用稳定顺序输出 `fields`。在 `createProductionFieldResolver` 中，将已有目录命中、精确路径、语义解析和 RAG 决策转成同一个 `assessment`：

- 通过验证且自动填写安全：`ready`
- RAG `needs_review`、风险字段或语义置信度不足：`review`
- `needs_question` 或没有证据：`missing`
- 文件、未知控件或不支持类型：`unsupported`

所有 `review`、`missing` 和 `unsupported` 均使用 `source: "none"` 或真实来源，但不得伪造置信度或证据。对于下拉、单选和布尔字段，候选值必须通过现有 RAG 验证器的选项校验，否则分类为 `review`。

`application-service.ts` 保存 `Map<taskId, Map<fieldId, ApplicationFieldAssessment>>`；在每个 `resolvePass` 后记录评测，在每次执行结果回读后把对应字段更新为 `filled`，在新的页面快照到达后按当前 `fieldIds` 删除过期项。`persist` 把 `summarizeFieldCoverage` 传入检查点，`requireActor` 从检查点恢复。用户手动填写的非空字段加入 `source: "user"`，不调用模型。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `rtk pnpm --filter @resume/api exec vitest run src/applications/field-coverage.test.ts src/production-dependencies.test.ts src/applications/application-machine.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交任务**

```powershell
rtk git add apps/api/src/applications/field-coverage.ts apps/api/src/applications/field-coverage.test.ts apps/api/src/production-dependencies.ts apps/api/src/production-dependencies.test.ts apps/api/src/applications/application-service.ts apps/api/src/applications/application-machine.test.ts
rtk git commit -m "feat: assess application field coverage"
```

## Task 4: 任务 API 与紧凑字段审核面板

**Files:**
- Modify: `apps/api/src/applications/routes.ts`
- Modify: `apps/api/src/applications/routes.test.ts`
- Create: `apps/web/src/applications/FieldCoveragePanel.tsx`
- Create: `apps/web/src/applications/FieldCoveragePanel.test.tsx`
- Modify: `apps/web/src/applications/ApplicationTaskPage.tsx`
- Modify: `apps/web/src/applications/ApplicationTaskPage.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- API response: `ApplicationTask.fieldCoverage?: ApplicationFieldCoverage`.
- UI component: `FieldCoveragePanel({ coverage }: { coverage: ApplicationFieldCoverage })`.
- Consumes existing `QuestionPanel` for task-only answers and explicit profile promotion;不新增静默档案写回操作。

- [ ] **Step 1: 写失败 API 和 UI 测试**

路由测试断言 `GET /api/applications/:id` 返回已持久化的 `fieldCoverage`。组件测试使用一份包含 `filled`、`review`、`missing`、`unsupported` 的合同对象，断言：

```tsx
expect(screen.getByText("已填写 3")).toBeVisible();
expect(screen.getByText("待审核 1")).toBeVisible();
expect(screen.getByText("缺少资料 1")).toBeVisible();
expect(screen.getByRole("button", { name: "查看待处理字段" })).toBeVisible();
```

展开后仅渲染 `review`、`missing`、`unsupported` 字段，并显示标签、系统理解、匹配方式、置信度、原因和 `EvidenceList`；`filled` 字段只计入摘要。测试还应断言组件不包含“提交”或“发送申请”按钮。

- [ ] **Step 2: 运行测试确认 RED**

Run: `rtk pnpm --filter @resume/api exec vitest run src/applications/routes.test.ts`

Run: `rtk pnpm --filter @resume/web exec vitest run src/applications/FieldCoveragePanel.test.tsx src/applications/ApplicationTaskPage.test.tsx`

Expected: FAIL，因为 API 字段和组件尚未实现。

- [ ] **Step 3: 实现路由和工作台面板**

`routes.ts` 的 `taskResponse` 读取 `applicationService.fieldCoverage(task.id)`，有值时放入 `ApplicationTaskSchema.parse`。`FieldCoveragePanel` 使用一个摘要行和可折叠的待处理列表：

```tsx
<section className="field-coverage" aria-labelledby="field-coverage-title">
  <header><h2 id="field-coverage-title">字段匹配</h2><CoverageSummary coverage={coverage} /></header>
  <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
    {expanded ? "收起待处理字段" : "查看待处理字段"}
  </button>
  {expanded && <ul>{attention.map((item) => <CoverageItem key={item.fieldId} item={item} />)}</ul>}
</section>
```

在 `ApplicationTaskPage` 的阶段摘要下方、追问面板上方渲染该组件。样式使用单列响应式布局，320px 下文本换行且无横向滚动；评测项是平铺列表，不能嵌套卡片或引入营销式页面区块。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `rtk pnpm --filter @resume/api exec vitest run src/applications/routes.test.ts`

Run: `rtk pnpm --filter @resume/web exec vitest run src/applications/FieldCoveragePanel.test.tsx src/applications/ApplicationTaskPage.test.tsx`

Expected: PASS。

- [ ] **Step 5: 提交任务**

```powershell
rtk git add apps/api/src/applications/routes.ts apps/api/src/applications/routes.test.ts apps/web/src/applications/FieldCoveragePanel.tsx apps/web/src/applications/FieldCoveragePanel.test.tsx apps/web/src/applications/ApplicationTaskPage.tsx apps/web/src/applications/ApplicationTaskPage.test.tsx apps/web/src/styles.css
rtk git commit -m "feat: show field coverage in application tasks"
```

## Task 5: DJI 风格端到端回归和最终验证

**Files:**
- Modify: `apps/synthetic-ats/src/server.ts`
- Create: `tests/browser/dji-coverage.spec.ts`
- Modify: `tests/browser/mokahr-high-coverage.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Synthetic ATS produces a DJI-style form with education、project、award、unknown、low-confidence and terminal-submit controls.
- `dji-coverage.spec.ts` reads the real task API response and browser DOM; it never calls an actual DJI submission endpoint.

- [ ] **Step 1: 写失败 Playwright 场景**

新增大疆风格表单，至少包含：`毕业院校`、`项目名称`、`获奖级别`、一个无证据必填字段、一个歧义字段和一个终态“提交申请”按钮。测试应断言：

```ts
expect(task.fieldCoverage).toMatchObject({ ready: expect.any(Number), missing: 1, review: 1 });
expect(task.fieldCoverage?.fields).toContainEqual(expect.objectContaining({ label: "毕业院校", status: "filled" }));
expect(task.fieldCoverage?.fields).toContainEqual(expect.objectContaining({ label: "未命名字段", status: "missing" }));
expect(await harness.serverState()).toMatchObject({ submissionCount: 0 });
```

测试还要检查工作台可展开待处理字段，用户输入任务答案后页面回读值正确，最终状态为 `review_locked`。

- [ ] **Step 2: 运行端到端测试确认 RED**

Run: `rtk pnpm exec playwright test tests/browser/dji-coverage.spec.ts`

Expected: FAIL，因为 DJI 风格场景和覆盖 API 尚未完整接入。

- [ ] **Step 3: 实现最小合成页面与回归断言**

只扩展合成 ATS，不请求外网。页面字段必须使用真实浏览器观察路径，并保留服务器端 `submissionCount` 计数。`mokahr-high-coverage.spec.ts` 补充断言：已有的 Mokahr 覆盖流程仍不提交，任务 API 在存在覆盖报告时保持合同兼容。

- [ ] **Step 4: 运行最终验证**

Run: `rtk pnpm --filter @resume/contracts test`

Run: `rtk pnpm --filter @resume/api test`

Run: `rtk pnpm --filter @resume/web test`

Run: `rtk pnpm typecheck`

Run: `rtk pnpm test:e2e`

Run: `rtk git diff --check`

Expected: 所有命令以 `0` 退出；端到端输出显示全部通过；任一测试场景的 `submissionCount` 均为 `0`。

- [ ] **Step 5: 更新启动与验证说明并提交任务**

在 `README.md` 的投递流程说明中增加“字段匹配”说明：精确匹配优先、低置信度不自动填写、用户可在任务追问中选择是否保存到长期档案、系统不提交申请。

```powershell
rtk git add apps/synthetic-ats/src/server.ts tests/browser/dji-coverage.spec.ts tests/browser/mokahr-high-coverage.spec.ts README.md
rtk git commit -m "test: cover dji field mapping review flow"
```

