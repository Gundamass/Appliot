# ATS 自动填写稳定化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让国内 ATS 自动填写能够正确区分栏目与重复经历、最多尝试两次并完成下拉框和日期回读，同时把确定性填写、受限语义补全、校验和最终审核的真实状态展示给用户。

**Architecture:** 浏览器观察层为每个字段附加稳定的页面栏目上下文，API 再结合候选人档案中的用工类型生成具体档案路径；确定性映射先执行，剩余字段只在当前栏目和控件类型内做语义路径检索。执行层使用不依赖 DOM ID 的业务键限制两次尝试，并以点击提交状态和页面回读作为成功依据；后端持久化阶段快照，前端只渲染后端事实。

**Tech Stack:** TypeScript 5.8、Zod、Vitest、Fastify、XState、React、Playwright、better-sqlite3、pnpm 10。

## Global Constraints

- 在当前本地会话内按顺序实施，不创建隔离工作树，不委派子任务。
- 工作区已有未提交修改均视为用户工作；每个任务只暂存该任务明确列出的文件，不撤销或覆盖无关修改。
- 必须先写失败测试并确认失败，再修改生产代码。
- 所有搜索型控件在同一投递任务内最多执行两次，DOM 重渲染不得重置次数。
- 第一次使用档案原值；第二次只允许使用不改变事实含义的保守归一化值。
- RAG 只负责将未知页面字段映射到结构化档案路径，不得从整个档案任意挑选值或生成候选人事实。
- 实习记录只进入实习栏目；明确全职或正式工作的记录只进入工作栏目；未知用工类型不自动进入任一独立栏目。
- 不生成或微调实习描述、项目描述、项目亮点和其他候选人事实。
- 用户在受控浏览器中已有的非空值优先，自动化不得覆盖。
- 不自动选择岗位，不点击最终提交，不把失败字段计入已完成。
- 本计划不修复本地长期档案加密，也不调整敏感资料发送至 DeepSeek 或向量服务的策略。
- 新增用户可见文案、状态和错误说明全部使用中文。
- Shell 命令使用 `rtk` 前缀；手工编辑使用 `apply_patch`。

## File Structure

- `packages/contracts/src/browser.ts`: 定义浏览器字段的有限栏目上下文契约。
- `packages/form-semantics/src/snapshot-script.ts`: 承载浏览器原始字段中的栏目文本。
- `packages/form-semantics/src/normalize.ts`: 将原始栏目文本归一化为有限 `sectionHint`。
- `apps/browser-worker/src/observer.ts`: 从字段最近的标题或区块容器提取栏目。
- `packages/form-semantics/src/mokahr-adapter.ts`: 识别 Moka 类页面的工作、实习和合并栏目。
- `apps/api/src/applications/experience-routing.ts`: 根据 `employmentType` 计算页面记录与 `work[n]` 档案记录的兼容关系。
- `apps/api/src/applications/repeated-section-planner.ts`: 只为当前栏目中有兼容档案的记录规划“新增”。
- `apps/api/src/applications/entry-field-semantics.ts`: 把页面重复项映射到正确的具体档案索引。
- `packages/form-semantics/src/field-registry.ts`: 注册语言能力档案栏目及四个叶子字段。
- `apps/api/src/applications/field-semantic-resolver.ts`: 在栏目、重复项和控件类型边界内解析语义路径。
- `apps/api/src/applications/field-operation-key.ts`: 生成跨 DOM 重渲染稳定的执行与重试键。
- `apps/api/src/applications/application-progress.ts`: 持久化重试次数、当前尝试和真实阶段快照。
- `apps/browser-worker/src/control-adapters.ts`: 完成搜索下拉、日期组件的候选点击和提交确认。
- `packages/contracts/src/application.ts`: 定义阶段、统计、尝试次数和字段失败状态的 API/SSE 契约。
- `apps/web/src/applications/TaskStageStepper.tsx`: 展示后端阶段状态。
- `apps/web/src/applications/ApplicationTaskPage.tsx`: 展示当前动作、`1/2` 次尝试、统计和可展开明细。
- `apps/synthetic-ats/public/stability.html`: 提供国内 ATS 复杂控件的可重复回归页面。
- `tests/browser/ats-autofill-stability.spec.ts`: 贯穿档案、两轮映射、控件执行、回读和禁止提交的端到端测试。

---

### Task 1: 字段栏目上下文

**Files:**
- Modify: `packages/contracts/src/browser.ts`
- Modify: `packages/contracts/src/browser.test.ts`
- Modify: `packages/form-semantics/src/snapshot-script.ts`
- Modify: `packages/form-semantics/src/normalize.ts`
- Modify: `packages/form-semantics/src/normalize.test.ts`
- Modify: `packages/form-semantics/src/mokahr-adapter.ts`
- Modify: `packages/form-semantics/src/mokahr-adapter.test.ts`
- Modify: `apps/browser-worker/src/observer.ts`
- Modify: `apps/browser-worker/src/observer.test.ts`

**Interfaces:**
- Produces: `PageSectionHint = "basics" | "preferences" | "education" | "work" | "internship" | "work_combined" | "projects" | "campus" | "awards" | "languages" | "publications" | "certificates" | "self"`.
- Produces: optional `FormField.sectionHint?: PageSectionHint` preserved from DOM observation through `normalizeForm()`.
- Produces: `sectionHintForText(value: string): PageSectionHint | undefined` for Moka action and field classification.
- Extends: `MokahrSection` with `work | internship | work_combined | languages`; language “新增” actions therefore participate in repeated-section planning.
- Consumes: existing `RawFormField`, `FormFieldSchema`, `normalizeForm()` and observer DOM script.

- [ ] **Step 1: Write failing contract and normalization tests**

Add assertions equivalent to:

```ts
expect(FormFieldSchema.parse({
  id: "company", label: "公司名称", type: "text", required: false,
  options: [], currentValue: "", sectionHint: "internship"
}).sectionHint).toBe("internship");

expect(normalizeForm({
  fields: [rawField({ nearbyText: "公司名称", sectionHint: "实习经历" })],
  actions: [], errors: []
}, context).fields[0]?.sectionHint).toBe("internship");
```

In `mokahr-adapter.test.ts`, assert `实习经历` becomes `internship`, `正式工作经历` becomes `work`, and `工作/实习经历` becomes `work_combined`.

- [ ] **Step 2: Run focused tests and verify failure**

```text
rtk pnpm --filter @resume/contracts test -- browser.test.ts
rtk pnpm --filter @resume/form-semantics test -- normalize.test.ts mokahr-adapter.test.ts
```

Expected: FAIL because `sectionHint` and separate experience sections do not exist.

- [ ] **Step 3: Add the finite section contract and normalizer**

Add this schema in `browser.ts` and the optional property to `FormFieldSchema`:

```ts
export const PageSectionHintSchema = z.enum([
  "basics", "preferences", "education", "work", "internship", "work_combined",
  "projects", "campus", "awards", "languages", "publications", "certificates", "self"
]);
export type PageSectionHint = z.infer<typeof PageSectionHintSchema>;

sectionHint: PageSectionHintSchema.optional(),
```

Add `sectionHint?: string` to `RawFormField`; in `normalizeField()` call `sectionHintForText(raw.sectionHint)` and omit the property when no finite match exists. Order the experience patterns from most specific to least specific so `工作/实习经历` cannot be swallowed by `工作经历`.

- [ ] **Step 4: Extract the nearest field section in the observer**

Inside `BROWSER_OBSERVATION_SCRIPT`, add a helper that walks ancestors and only accepts a single direct/nearest heading:

```js
const sectionText = (element) => {
  const pattern = /工作\s*[/／或]\s*实习经历|正式工作经历|工作经历|实习经历|教育经历|项目经历|在校实践|实验室经历|获奖经历|赛事经历|语言能力|证书|论文|自我评价/u;
  let ancestor = formItem(element) ?? element.parentElement;
  while (ancestor && ancestor !== document.body) {
    const heading = normalized(ancestor.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > legend, :scope > [role=heading], :scope > [class*='blockTitle']")?.textContent);
    const match = heading.match(pattern)?.[0];
    if (match) return match;
    ancestor = ancestor.parentElement;
  }
  return "";
};
```

Include `sectionHint: sectionText(element)` in every native radio、ARIA radio、custom select and ordinary field observation branch. Add observer fixtures with adjacent work and internship blocks and assert each field receives the nearest block only.

- [ ] **Step 5: Run all owning tests**

```text
rtk pnpm --filter @resume/contracts test -- browser.test.ts
rtk pnpm --filter @resume/form-semantics test -- normalize.test.ts mokahr-adapter.test.ts
rtk pnpm --filter @resume/browser-worker test -- observer.test.ts
```

Expected: all listed tests PASS.

- [ ] **Step 6: Commit only section-context files**

```text
rtk git add packages/contracts/src/browser.ts packages/contracts/src/browser.test.ts packages/form-semantics/src/snapshot-script.ts packages/form-semantics/src/normalize.ts packages/form-semantics/src/normalize.test.ts packages/form-semantics/src/mokahr-adapter.ts packages/form-semantics/src/mokahr-adapter.test.ts apps/browser-worker/src/observer.ts apps/browser-worker/src/observer.test.ts
rtk git commit -m "feat: observe ATS field section context"
```

---

### Task 2: 工作与实习分流

**Files:**
- Create: `apps/api/src/applications/experience-routing.ts`
- Create: `apps/api/src/applications/experience-routing.test.ts`
- Modify: `apps/api/src/applications/repeated-section-planner.ts`
- Modify: `apps/api/src/applications/repeated-section-planner.test.ts`
- Modify: `apps/api/src/applications/entry-field-semantics.ts`
- Modify: `apps/api/src/applications/entry-field-semantics.test.ts`
- Modify: `apps/api/src/applications/application-service.ts`
- Modify: `apps/api/src/applications/application-machine.test.ts`

**Interfaces:**
- Produces: `classifyEmploymentType(value: unknown): "work" | "internship" | "unknown"`.
- Produces: `compatibleExperienceIndexes(facts: readonly ProfileFact[], section: "work" | "internship" | "work_combined"): number[]`.
- Produces: `RepeatedSectionPlan.profileIndexes: number[]`; `missingEntries` remains available for the service loop.
- Produces: `deriveEntrySemanticHints(fields, { experienceIndexesBySection })` that can map page entry `0` to a nonzero profile index such as `work[2]`.
- Consumes: `FormField.sectionHint` from Task 1 and confirmed profile facts from `listProfileFacts()`.

- [ ] **Step 1: Write failing experience-routing tests**

```ts
expect(classifyEmploymentType("Java 后端实习")).toBe("internship");
expect(classifyEmploymentType("全职")).toBe("work");
expect(classifyEmploymentType(undefined)).toBe("unknown");
expect(compatibleExperienceIndexes(facts, "internship")).toEqual([0, 2]);
expect(compatibleExperienceIndexes(facts, "work")).toEqual([1]);
expect(compatibleExperienceIndexes(facts, "work_combined")).toEqual([0, 1, 2]);
```

Build `facts` with `work[0].employmentType = 实习`, `work[1].employmentType = 全职`, `work[2].employmentType = Java 后端实习`, and `work[3]` without a type. Assert index `3` is excluded from every automatic route.

- [ ] **Step 2: Run the new test and verify failure**

```text
rtk pnpm --filter @resume/api test -- src/applications/experience-routing.test.ts
```

Expected: FAIL because `experience-routing.ts` does not exist.

- [ ] **Step 3: Implement conservative employment classification**

Use normalized exact category signals rather than fuzzy similarity:

```ts
const INTERNSHIP = /实习|intern(?:ship)?/iu;
const FORMAL = /正式|全职|full[ -]?time/iu;

export function classifyEmploymentType(value: unknown): ExperienceKind {
  if (typeof value !== "string") return "unknown";
  const normalized = value.normalize("NFKC").trim();
  if (INTERNSHIP.test(normalized)) return "internship";
  if (FORMAL.test(normalized)) return "work";
  return "unknown";
}
```

Only read confirmed, non-superseded `work[n].employmentType` facts. Preserve profile index order.

- [ ] **Step 4: Write failing planner and semantic-index tests**

Assert an internship-only profile:

```ts
expect(planRepeatedSectionActions(workPage, internshipFacts)).toEqual([]);
expect(planRepeatedSectionActions(internshipPage, internshipFacts)).toEqual([
  { section: "internship", actionId: "add-internship", missingEntries: 1, profileIndexes: [0, 2] }
]);
```

Also assert an internship page's first company field becomes `work[2].company` when routing provides `[2]`, while a combined page with `[0, 1]` keeps both in profile order.

- [ ] **Step 5: Run planner tests and verify failure**

```text
rtk pnpm --filter @resume/api test -- src/applications/repeated-section-planner.test.ts src/applications/entry-field-semantics.test.ts
```

Expected: FAIL because every `work[n]` fact is currently counted for every work-like section.

- [ ] **Step 6: Route additions and concrete semantics through compatible indexes**

Change the planner to count only `compatibleExperienceIndexes()` for experience actions and include `languages[n]` in non-experience repeated roots. Pass the same routing into `withDerivedEntrySemantics(snapshot, profileFacts)` on every observation/result path in `application-service.ts`; never use page entry index as a profile index for separated work/internship sections. Replace the hard-coded repeated-action display category `项目经历` with a section-to-Chinese-category mapping.

- [ ] **Step 7: Verify service behavior**

```text
rtk pnpm --filter @resume/api test -- src/applications/experience-routing.test.ts src/applications/repeated-section-planner.test.ts src/applications/entry-field-semantics.test.ts src/applications/application-machine.test.ts
```

Expected: PASS; the internship-only fixture does not click “新增工作经历”, and no empty formal-work record appears.

- [ ] **Step 8: Commit experience routing**

```text
rtk git add apps/api/src/applications/experience-routing.ts apps/api/src/applications/experience-routing.test.ts apps/api/src/applications/repeated-section-planner.ts apps/api/src/applications/repeated-section-planner.test.ts apps/api/src/applications/entry-field-semantics.ts apps/api/src/applications/entry-field-semantics.test.ts apps/api/src/applications/application-service.ts apps/api/src/applications/application-machine.test.ts
rtk git commit -m "fix: separate work and internship autofill"
```

---

### Task 3: 语言能力档案

**Files:**
- Modify: `packages/form-semantics/src/field-registry.ts`
- Modify: `packages/form-semantics/src/field-registry.test.ts`
- Modify: `packages/form-semantics/src/extraction-field-paths.test.ts`
- Modify: `packages/profile-domain/src/extraction/extract-facts.ts`
- Modify: `packages/profile-domain/src/extraction/extract-facts.test.ts`
- Modify: `apps/api/src/profile/profile-completeness.test.ts`
- Modify: `apps/web/src/profile/RepeatedEntryEditor.tsx`
- Modify: `apps/web/src/profile/RepeatedEntryEditor.test.tsx`
- Modify: `apps/web/src/profile/CandidateProfileCenter.test.tsx`

**Interfaces:**
- Extends: `FieldSection` with `languages`.
- Produces: canonical paths `languages[].name`, `languages[].proficiency`, `languages[].speakingListening`, `languages[].readingWriting`.
- Keeps: CET、IELTS and other certificate names/scores under `certificates[]`; no automatic migration between the two sections.
- Consumes: registry-driven profile rendering and completeness calculation.

- [ ] **Step 1: Write failing registry, extraction and completeness tests**

```ts
expect(PROFILE_SECTION_DEFINITIONS).toContainEqual({ id: "languages", label: "语言能力", repeatable: true });
expect(FIELD_DEFINITIONS.filter((field) => field.sections.includes("languages")).map((field) => field.semantic)).toEqual([
  "languages[].name",
  "languages[].proficiency",
  "languages[].speakingListening",
  "languages[].readingWriting"
]);
expect(isAllowedExtractedFieldPath("languages[0].name")).toBe(true);
```

For completeness, create four confirmed language facts and assert the language section is `4/4`; assert a certificate fact alone does not complete language ability.

- [ ] **Step 2: Run tests and verify failure**

```text
rtk pnpm --filter @resume/form-semantics test -- field-registry.test.ts extraction-field-paths.test.ts
rtk pnpm --filter @resume/profile-domain test -- src/extraction/extract-facts.test.ts
rtk pnpm --filter @resume/api test -- src/profile/profile-completeness.test.ts
```

Expected: FAIL because `languages` is not registered or extractable.

- [ ] **Step 3: Register the language section and fields**

Add the section between publications and certificates and define:

```ts
repeated("languages[].name", "语言名称", ["语种", "外语名称", "language"], TEXT_SELECT_TYPES, "languages", "候选人掌握的语言名称"),
repeated("languages[].proficiency", "掌握程度", ["语言水平", "熟练程度", "proficiency"], TEXT_SELECT_TYPES, "languages", "候选人对该语言的综合掌握程度"),
repeated("languages[].speakingListening", "听说能力", ["口语能力", "听力能力", "听说水平"], TEXT_SELECT_TYPES, "languages", "候选人对该语言的听说能力"),
repeated("languages[].readingWriting", "读写能力", ["阅读能力", "写作能力", "读写水平"], TEXT_SELECT_TYPES, "languages", "候选人对该语言的读写能力"),
```

Use `suggestion` profile controls for all four fields so the档案 can retain real ATS wording without being limited to a guessed yes/no option set. Extend `contextFromHint()` and extraction index instructions with `languages`.

- [ ] **Step 4: Add the repeatable profile editor presentation**

Set `SECTION_NAMES.languages = "语言能力"`, field order to `name -> proficiency -> speakingListening -> readingWriting`, and entry title to `languages[n].name`. The generic `CandidateProfileCenter` must add、remove、save and reload language entries without a special page.

- [ ] **Step 5: Add and run UI tests**

```ts
render(<RepeatedEntryEditor section="languages" entries={[entry]} onChange={onChange} onAdd={onAdd} onRemove={onRemove} />);
expect(screen.getByLabelText("语言名称")).toHaveValue("英语");
expect(screen.getByLabelText("听说能力")).toHaveValue("熟练");
```

```text
rtk pnpm --filter @resume/web test -- RepeatedEntryEditor.test.tsx CandidateProfileCenter.test.tsx
rtk pnpm --filter @resume/form-semantics test
rtk pnpm --filter @resume/profile-domain test -- src/extraction/extract-facts.test.ts
rtk pnpm --filter @resume/api test -- src/profile/profile-completeness.test.ts
```

Expected: all listed tests PASS.

- [ ] **Step 6: Commit language profile support**

```text
rtk git add packages/form-semantics/src/field-registry.ts packages/form-semantics/src/field-registry.test.ts packages/form-semantics/src/extraction-field-paths.test.ts packages/profile-domain/src/extraction/extract-facts.ts packages/profile-domain/src/extraction/extract-facts.test.ts apps/api/src/profile/profile-completeness.test.ts apps/web/src/profile/RepeatedEntryEditor.tsx apps/web/src/profile/RepeatedEntryEditor.test.tsx apps/web/src/profile/CandidateProfileCenter.test.tsx
rtk git commit -m "feat: add structured language profile records"
```

---

### Task 4: 栏目受限语义补全

**Files:**
- Modify: `apps/api/src/applications/field-semantic-resolver.ts`
- Modify: `apps/api/src/applications/field-semantic-resolver.test.ts`
- Modify: `apps/api/src/applications/production-field-resolver.ts`
- Modify: `apps/api/src/production-dependencies.test.ts`
- Modify: `apps/api/src/applications/field-coverage.ts`
- Modify: `apps/api/src/applications/field-coverage.test.ts`

**Interfaces:**
- Extends: `FieldSemanticContext` with observed `sectionHint` and concrete `entryContext`.
- Produces: `semanticContextForField(field)` that uses `sectionHint` even when `semanticHint` is absent.
- Guarantees: semantic candidates share current profile section, repeated entry index and compatible control type.
- Guarantees: a semantic path can be auto-filled only when `profileRepository.resolveForTask(taskId, path)` returns a confirmed fact.
- Consumes: Task 1 section hints, Task 2 concrete `work[n]` routing, Task 3 language definitions.

- [ ] **Step 1: Write failing cross-domain rejection tests**

Add resolver cases proving:

```ts
await expect(resolveSemantic(field({ label: "语言水平", sectionHint: "languages" }))).resolves.toMatchObject({
  status: "resolved", semantic: "languages[0].proficiency"
});
await expect(resolveSemantic(field({ label: "语言水平", sectionHint: "languages" }), definitionsForBasicsOnly)).resolves.toMatchObject({
  status: "unresolved"
});
```

Also assert “赛事名称” in `awards` cannot map to `projects[0].name`; “微信号” cannot satisfy a language field; “现居地” cannot satisfy salary; a text control cannot map to a file-only definition.
Add a missing `projects[0].highlights[0]` case and assert it remains `missing`, `ragService.resolveField` is not asked to invent a value, and no project or internship description is rewritten.

- [ ] **Step 2: Run semantic tests and verify failure**

```text
rtk pnpm --filter @resume/api test -- src/applications/field-semantic-resolver.test.ts src/production-dependencies.test.ts
```

Expected: at least one unknown field is evaluated without the observed section boundary.

- [ ] **Step 3: Constrain exact, embedding and DeepSeek candidate sets**

Before scoring or model fallback, filter definitions with one shared predicate:

```ts
const eligible = definitions.filter((definition) =>
  (!context.section || definition.sections.includes(context.section))
  && controlTypesCompatible(field.type, definition.types)
  && entryCompatible(context.entryContext, definition.semantic)
);
```

Map page `internship`, `work` and `work_combined` to profile section `work`; map page `languages` to profile section `languages`. For repeated sections require a materialized path with the same concrete index. If `sectionHint` is absent, permit global lookup only for a deterministic exact alias; semantic-phase embedding/DeepSeek lookup remains unresolved.

- [ ] **Step 4: Require an existing fact after path resolution**

In `production-field-resolver.ts`, resolve the exact semantic path first. If no confirmed profile/application fact exists, return `missing` without calling value-generating logic. Continue to call `ragService.resolveField()` only with that one semantic path for validation and control projection; do not pass an unconstrained profile candidate list. Change the remaining English reason to:

```ts
reason: "该值由已确认的候选人档案事实推导"
```

- [ ] **Step 5: Verify deterministic pass then semantic pass accounting**

Add a service fixture where an exact alias fills in pass one, a section-safe embedding match fills in pass two, and an unsafe cross-section candidate remains blank. Assert field coverage sources are respectively `exact`, `semantic`, and `none`.

```text
rtk pnpm --filter @resume/api test -- src/applications/field-semantic-resolver.test.ts src/applications/field-coverage.test.ts src/production-dependencies.test.ts src/applications/application-machine.test.ts
```

Expected: PASS; the semantic resolver is invoked only for fields deferred by the deterministic pass.

- [ ] **Step 6: Commit constrained semantic mapping**

```text
rtk git add apps/api/src/applications/field-semantic-resolver.ts apps/api/src/applications/field-semantic-resolver.test.ts apps/api/src/applications/production-field-resolver.ts apps/api/src/production-dependencies.test.ts apps/api/src/applications/field-coverage.ts apps/api/src/applications/field-coverage.test.ts
rtk git commit -m "fix: constrain semantic autofill to field sections"
```

---

### Task 5: 稳定两次尝试策略

**Files:**
- Create: `apps/api/src/applications/field-operation-key.ts`
- Create: `apps/api/src/applications/field-operation-key.test.ts`
- Modify: `apps/api/src/applications/application-progress.ts`
- Modify: `apps/api/src/applications/application-progress.test.ts`
- Modify: `apps/api/src/applications/checkpoint-repository.ts`
- Modify: `apps/api/src/applications/application-service.ts`
- Modify: `apps/api/src/applications/application-machine.test.ts`

**Interfaces:**
- Produces: `fieldOperationKey(input: { taskId; sectionHint; entryIndex; semanticPath; controlRole }): string`.
- Extends: `StartOperationInput` with `retryKey?: string`.
- Changes: `runWithPolicy<T>(input, operation: (attempt: 1 | 2) => Promise<T>, options?)` so browser commands use the same attempt number that progress persists.
- Extends: `ApplicationTaskProgress` with `attempt?: number` and `maxAttempts?: 2` in Task 7; internally the coordinator computes the same values immediately.
- Extends: `ApplicationProgressSnapshot` with `attemptCountsByKey?: Record<string, number>` while retaining `retryCountsByField?` only for backward-compatible restore.

- [ ] **Step 1: Write failing stable-key tests**

```ts
const first = fieldOperationKey({ taskId, sectionHint: "education", entryIndex: 0, semanticPath: "education[0].major", controlRole: "search" });
const rerendered = fieldOperationKey({ taskId, sectionHint: "education", entryIndex: 0, semanticPath: "education[0].major", controlRole: "search" });
expect(first).toBe(rerendered);
expect(first).not.toContain("field_");
```

Assert section、entry index、semantic path or control role changes produce different keys.

- [ ] **Step 2: Write failing coordinator tests for a third attempt**

Call `runWithPolicy()` twice with different `fieldId` values but the same `retryKey`, force both attempts to fail, then call it a third time after restore. Assert the third operation callback is never invoked and the stable key remains at two attempts.

```text
rtk pnpm --filter @resume/api test -- src/applications/field-operation-key.test.ts src/applications/application-progress.test.ts
```

Expected: FAIL because retries are currently keyed by `fieldId` and rerendering resets the budget.

- [ ] **Step 3: Implement stable attempt accounting**

Store total attempts, not retry count, under `retryKey ?? fieldId`. Increment immediately before each automatic operation and pass the resulting `1 | 2` value into the operation callback. Reject an operation with `automatic_attempt_limit_reached` once the count is `2`; do not wait for another browser call. Public snapshots expose `attemptCountsByKey` while accepting old `retryCountsByField` maps during restore.

```ts
const key = input.retryKey ?? input.fieldId;
const attempts = task.attemptCountsByKey.get(key) ?? 0;
if (attempts >= 2) throw new Error("automatic_attempt_limit_reached");
task.attemptCountsByKey.set(key, attempts + 1);
```

- [ ] **Step 4: Generate the key from resolved field identity**

For every fill/select operation in `application-service.ts`, use `decision.fieldPath`, `field.sectionHint`, the index parsed from the path, and `field.interactionMode ?? field.type`. During retry observation, locate the rerendered field by this identity instead of `candidate.id === field.id`. Build the browser command inside the `(attempt) => ...` callback so attempt `1` uses the original value and attempt `2` can use the conservative fallback. Observe/upload/navigate callbacks may ignore the attempt argument and keep their existing behavior.

- [ ] **Step 5: Limit the second search value to conservative normalization**

Build at most two values:

```ts
function conservativeSearchValues(value: string, semanticPath: string): [string, string?] {
  const normalized = value.normalize("NFKC").trim();
  const fallback = /\.major$/u.test(semanticPath) ? normalized.replace(/专业$/u, "") : normalized;
  return fallback !== normalized && fallback !== "" ? [normalized, fallback] : [normalized];
}
```

Do not remove arbitrary suffixes or rewrite names. Attempt one uses index `0`; attempt two uses index `1` only when present, otherwise repeats no search and records `无可用的保守归一化值`.

- [ ] **Step 6: Run retry and service regressions**

```text
rtk pnpm --filter @resume/api test -- src/applications/field-operation-key.test.ts src/applications/application-progress.test.ts src/applications/application-machine.test.ts
```

Expected: PASS; `软件工程专业` searches once, `软件工程` searches once, and a rerender cannot trigger a third search.

- [ ] **Step 7: Commit stable retry behavior**

```text
rtk git add apps/api/src/applications/field-operation-key.ts apps/api/src/applications/field-operation-key.test.ts apps/api/src/applications/application-progress.ts apps/api/src/applications/application-progress.test.ts apps/api/src/applications/checkpoint-repository.ts apps/api/src/applications/application-service.ts apps/api/src/applications/application-machine.test.ts
rtk git commit -m "fix: cap searchable controls at two attempts"
```

---

### Task 6: 下拉框与日期提交回读

**Files:**
- Modify: `apps/browser-worker/src/control-adapters.ts`
- Modify: `apps/browser-worker/src/executor.ts`
- Modify: `apps/browser-worker/src/executor.test.ts`
- Modify: `apps/api/src/applications/control-value.ts`
- Modify: `apps/api/src/applications/control-value.test.ts`

**Interfaces:**
- Produces: successful custom selection only after candidate click, popup/selected-state commit, and normalized readback match.
- Produces: split date projection `year | month | day` from one canonical date without writing the full date into each component.
- Emits: stable error codes `custom_option_not_found`, `custom_option_ambiguous`, `custom_selection_not_committed`, `custom_readback_mismatch`, `date_component_readback_mismatch`.
- Consumes: Task 5 first/second search values and existing `ExecutableCommand` select execution.

- [ ] **Step 1: Add failing custom-select tests**

Create Playwright fixture controls where typing shows one option but does not commit until click. Assert typing alone fails, one unique clicked option passes, two normalized-equal candidates fail as ambiguous, and a popup that stays open fails as uncommitted.

```text
rtk pnpm --filter @resume/browser-worker test -- executor.test.ts
```

Expected: at least the delayed-commit or rerendered-option case FAILS.

- [ ] **Step 2: Centralize exact option selection and readback**

After input, wait for visible options, normalize the candidate text, require exactly one match, click it, then wait for either popup disappearance or selected-state evidence. Reacquire the control after DOM rerender and compare its committed display value with the intended value. Returning from `selectCustomControl()` before this sequence completes is forbidden.

- [ ] **Step 3: Add failing split-date tests**

```ts
expect(projectDateComponent("开始时间 年", "projects[0].startDate", "2022-10")).toBe("2022");
expect(projectDateComponent("开始时间 月", "projects[0].startDate", "2022-10")).toBe("10");
expect(projectDateComponent("开始时间 日", "projects[0].startDate", "2022-10-03")).toBe("03");
```

Add an executor fixture whose year/month controls only persist after option click. Assert both values remain selected after a fresh observation.

- [ ] **Step 4: Implement component-specific execution and exact readback**

Keep `projectDateComponent()` as the only source of component values. For custom year/month/day selects, send only the projected component to the adapter; after each click observe the component again and compare normalized numbers (`08` equals `8`, but `2022-10` never equals `2022`). A failed component records `date_component_readback_mismatch` and processing continues to the next independent field under semantic-pass defer policy.

- [ ] **Step 5: Run worker and API control tests**

```text
rtk pnpm --filter @resume/browser-worker test -- executor.test.ts
rtk pnpm --filter @resume/api test -- src/applications/control-value.test.ts src/applications/application-machine.test.ts
```

Expected: PASS; typing without selection is never reported as success, and year/month persist independently.

- [ ] **Step 6: Commit control execution hardening**

```text
rtk git add apps/browser-worker/src/control-adapters.ts apps/browser-worker/src/executor.ts apps/browser-worker/src/executor.test.ts apps/api/src/applications/control-value.ts apps/api/src/applications/control-value.test.ts
rtk git commit -m "fix: verify ATS select and date commits"
```

---

### Task 7: 后端真实阶段状态

**Files:**
- Modify: `packages/contracts/src/application.ts`
- Modify: `packages/contracts/src/application.test.ts`
- Modify: `apps/api/src/applications/application-progress.ts`
- Modify: `apps/api/src/applications/application-progress.test.ts`
- Modify: `apps/api/src/applications/checkpoint-repository.ts`
- Modify: `apps/api/src/applications/application-service.ts`
- Modify: `apps/api/src/applications/routes.ts`
- Modify: `apps/api/src/applications/routes.test.ts`
- Modify: `apps/api/src/applications/task-events.ts`
- Modify: `apps/api/src/applications/task-events.test.ts`
- Modify: `apps/api/src/applications/field-coverage.ts`
- Modify: `apps/api/src/applications/field-coverage.test.ts`

**Interfaces:**
- Produces: `ApplicationAutofillPhase = "waiting_for_form" | "deterministic_fill" | "semantic_fill" | "readback_validation" | "final_review"`.
- Produces: phase status `pending | running | completed | skipped | failed`.
- Produces: `ApplicationExecutionProgress` on `ApplicationTask` and an `execution_progress_changed` SSE event.
- Produces: counts `{ exact; semantic; user; missing; failed }` and current `{ action; fieldId?; attempt?; maxAttempts: 2 }`.
- Consumes: persisted `ApplicationProgressSnapshot`, field coverage sources/statuses, and Task 5 attempt count.

- [ ] **Step 1: Write failing contract tests**

Add a strict schema case:

```ts
const progress = {
  currentPhase: "semantic_fill",
  phases: [
    { phase: "deterministic_fill", status: "completed" },
    { phase: "semantic_fill", status: "running" },
    { phase: "readback_validation", status: "pending" },
    { phase: "final_review", status: "pending" }
  ],
  current: { action: "正在选择：本科专业", fieldId: "major", attempt: 1, maxAttempts: 2 },
  counts: { exact: 5, semantic: 1, user: 2, missing: 1, failed: 0 }
};
expect(ApplicationExecutionProgressSchema.parse(progress)).toEqual(progress);
```

Assert `ApplicationTaskSchema` accepts `executionProgress` and the SSE union accepts `execution_progress_changed`.

- [ ] **Step 2: Run contract tests and verify failure**

```text
rtk pnpm --filter @resume/contracts test -- application.test.ts
```

Expected: FAIL because no explicit execution-progress contract exists.

- [ ] **Step 3: Implement strict schemas and coverage failure count**

Add the phase, phase-state, counts and execution-progress schemas. Extend assessment status with `failed` and `ApplicationFieldCoverageSchema` with `failed`; update `field-coverage.ts` so execution failures increment `failed` and never `filled`.

- [ ] **Step 4: Add coordinator phase transitions with persistence**

Add coordinator methods:

```ts
setPhase(taskId: string, phase: ApplicationAutofillPhase, status: ApplicationPhaseStatus): void;
setCurrentAction(taskId: string, input: { action: string; fieldId?: string; attempt?: number; maxAttempts: 2 }): void;
setCounts(taskId: string, counts: ApplicationExecutionCounts): void;
```

Every method persists the snapshot and emits `execution_progress_changed`. `restore()` supplies a backward-compatible default: `waiting_for_form` before an application form, otherwise the phase matching the stored operation.

- [ ] **Step 5: Drive phases from the application service**

Use this transition order:

```text
未进入 application_form -> waiting_for_form/running（文案：等待进入简历填写页）
确定性 resolvePass 开始/结束 -> deterministic_fill running/completed
语义 resolvePass 开始/结束 -> semantic_fill running/completed 或 skipped
页面字段执行后统一观察 -> readback_validation running/completed 或 failed
review/success 阶段 -> final_review running
```

Set the current action from the actual field label and command verb; set attempt from Task 5. Publish counts from the latest field coverage after every assessment/fill/failure.

- [ ] **Step 6: Expose progress through HTTP and SSE**

In `routes.ts`, set `executionProgress: applicationService.progress(task.id).executionProgress` in `taskResponse()`. Extend `task-events.ts` storage/serialization and route tests so a reconnect receives the latest explicit phase event without reconstructing it from operation history.

- [ ] **Step 7: Run backend progress tests**

```text
rtk pnpm --filter @resume/contracts test -- application.test.ts
rtk pnpm --filter @resume/api test -- src/applications/application-progress.test.ts src/applications/field-coverage.test.ts src/applications/task-events.test.ts src/applications/routes.test.ts src/applications/application-machine.test.ts
```

Expected: PASS; checkpoint restore retains phase and attempts, and semantic misses are not counted as semantic completions.

- [ ] **Step 8: Commit backend progress state**

```text
rtk git add packages/contracts/src/application.ts packages/contracts/src/application.test.ts apps/api/src/applications/application-progress.ts apps/api/src/applications/application-progress.test.ts apps/api/src/applications/checkpoint-repository.ts apps/api/src/applications/application-service.ts apps/api/src/applications/routes.ts apps/api/src/applications/routes.test.ts apps/api/src/applications/task-events.ts apps/api/src/applications/task-events.test.ts apps/api/src/applications/field-coverage.ts apps/api/src/applications/field-coverage.test.ts
rtk git commit -m "feat: persist autofill execution phases"
```

---

### Task 8: 紧凑真实进度界面

**Files:**
- Modify: `apps/web/src/applications/application-workbench.ts`
- Modify: `apps/web/src/applications/application-workbench.test.ts`
- Modify: `apps/web/src/applications/TaskStageStepper.tsx`
- Modify: `apps/web/src/applications/ApplicationTaskPage.tsx`
- Modify: `apps/web/src/applications/ApplicationTaskPage.test.tsx`
- Modify: `apps/web/src/applications/ProgressSummary.test.tsx`
- Modify: `apps/web/src/applications/FieldCoveragePanel.tsx`
- Modify: `apps/web/src/applications/FieldCoveragePanel.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `task.executionProgress` and latest `execution_progress_changed` event from Task 7.
- Removes: phase inference from latest operation kind in `deriveDisplayPhase()` and `currentPhase()`.
- Displays: current phase/action, attempt `1/2`, five counts, and an expandable field-detail panel.

- [ ] **Step 1: Write failing source-of-truth tests**

Construct a task whose machine state is `filling`, latest operation looks deterministic, but backend `executionProgress.currentPhase` is `semantic_fill`. Assert the UI shows `语义补全` and does not derive `确定性填写` from the operation event.

Assert a task without application-form progress shows exactly `等待进入简历填写页`.

- [ ] **Step 2: Run UI tests and verify failure**

```text
rtk pnpm --filter @resume/web test -- application-workbench.test.ts ApplicationTaskPage.test.tsx ProgressSummary.test.tsx
```

Expected: FAIL because the current UI derives phase from recent operation events.

- [ ] **Step 3: Render compact backend-owned progress**

`TaskStageStepper` receives the complete phase array, not one inferred phase. In `ProgressSummary`, render:

```text
当前：语义补全
正在选择：本科专业                    尝试 1/2
精确 12   语义 3   用户已有 4   未匹配 2   失败 1
查看填写明细
```

Use the existing restrained application-workbench palette; no nested cards, no decorative gradients, no oversized typography. Keep phase rows and counters stable in width at desktop and allow two rows on mobile without text overlap.

- [ ] **Step 4: Move detailed evidence behind one disclosure**

The default view contains only the phase/action/attempt/counts. Reuse `FieldCoveragePanel` inside `<details>` labelled `查看填写明细`, grouped by page section. Each row shows label、semantic path、source、result or Chinese reason; a RAG miss reads `已跳过：当前栏目没有达到阈值的档案字段`.

- [ ] **Step 5: Run UI and visual tests**

```text
rtk pnpm --filter @resume/web test -- application-workbench.test.ts ApplicationTaskPage.test.tsx ProgressSummary.test.tsx FieldCoveragePanel.test.tsx
rtk pnpm test:e2e -- tests/browser/application-workbench-visual.spec.ts
```

Expected: PASS at desktop and mobile viewports; screenshots contain no overlapping controls or clipped Chinese text.

- [ ] **Step 6: Commit the compact progress UI**

```text
rtk git add apps/web/src/applications/application-workbench.ts apps/web/src/applications/application-workbench.test.ts apps/web/src/applications/TaskStageStepper.tsx apps/web/src/applications/ApplicationTaskPage.tsx apps/web/src/applications/ApplicationTaskPage.test.tsx apps/web/src/applications/ProgressSummary.test.tsx apps/web/src/applications/FieldCoveragePanel.tsx apps/web/src/applications/FieldCoveragePanel.test.tsx apps/web/src/styles.css
rtk git commit -m "feat: show backend-owned autofill progress"
```

---

### Task 9: 国内 ATS 端到端回归

**Files:**
- Modify: `apps/synthetic-ats/src/server.ts`
- Create: `apps/synthetic-ats/public/stability.html`
- Create: `tests/browser/ats-autofill-stability.spec.ts`
- Modify: `tests/browser/mokahr-high-coverage.spec.ts`
- Create: `docs/testing/domestic-ats-regression.md`

**Interfaces:**
- Produces: deterministic synthetic route `/stability` with separate work/internship, searchable major, split dates, language ability, repeated projects, semantic-only award labels and a terminal submit counter.
- Verifies: exact pass、semantic pass、two-attempt cap、repeat additions、selection commit、readback、user-value preservation and `submissionCount === 0`.
- Documents: real DJI/Moka and other domestic ATS manual regression evidence without storing login credentials or candidate private data.

- [ ] **Step 1: Add the synthetic stability page**

The page must expose these independent behaviors:

```text
正式工作经历：initial 1 row + 新增 button
实习经历：initial 1 row + 新增 button
专业：search input; 软件工程专业 returns no option, 软件工程 returns one clickable option
赛事名称/赛事时间：labels differ from awards profile paths
项目经历：initial 1 row + 新增 button
语言能力：语言名称、掌握程度、听说能力、读写能力
日期：separate year and month custom selects that only commit on option click
提交申请：increments submissionCount and is never approved by automation
```

Expose server state for option search counts、add counts、committed values and submission count.

- [ ] **Step 2: Write the failing end-to-end test**

Seed profile facts with one internship、no formal work、two projects、one award and one complete language entry. Run the real `createProductionFieldResolver`, real RAG service, `ApplicationService`, browser worker and action policy. Assert:

```ts
expect(state.workAddCount).toBe(0);
expect(state.internshipAddCount).toBe(0);
expect(state.projectAddCount).toBe(1);
expect(state.searches.major).toEqual(["软件工程专业", "软件工程"]);
expect(state.draft.awardName).toBe("全国大学生软件测试大赛");
expect(state.draft.startYear).toBe("2022");
expect(state.draft.startMonth).toBe("10");
expect(state.draft.languageName).toBe("英语");
expect(state.submissionCount).toBe(0);
```

- [ ] **Step 3: Run the new regression and fix only exposed integration defects**

```text
rtk pnpm test:e2e -- tests/browser/ats-autofill-stability.spec.ts
```

Expected before final integration: FAIL on at least one new scenario. Use the owning task's module for each correction and add a focused unit regression before changing it; do not add site-wide hard-coded values.

- [ ] **Step 4: Run existing Moka and safety regressions**

```text
rtk pnpm test:e2e -- tests/browser/ats-autofill-stability.spec.ts tests/browser/mokahr-high-coverage.spec.ts tests/browser/dji-coverage.spec.ts tests/browser/submit-safety.spec.ts
```

Expected: PASS; every server state reports `submissionCount: 0`.

- [ ] **Step 5: Run the full workspace verification**

```text
rtk pnpm test
rtk pnpm typecheck
rtk pnpm build
```

Expected: all commands exit with code 0.

- [ ] **Step 6: Perform real domestic ATS regression before submission**

Start local services, create a fresh task, let the user choose the job and reach the application form, then observe the real page through the controlled browser. Verify separate work/internship behavior、major search limit、date commits、RAG award mapping、language fields、progress phases and field details. Stop at the final review page; do not click or approve the terminal submit control. Record only selectors/categories、counts、reason codes and redacted screenshots in `docs/testing/domestic-ats-regression.md`.

```text
rtk pnpm services:start
rtk pnpm services:status
```

Expected: API、Web、browser worker and configured model/OCR dependencies report healthy before the real-page run.

- [ ] **Step 7: Commit regression assets and report**

```text
rtk git add apps/synthetic-ats/src/server.ts apps/synthetic-ats/public/stability.html tests/browser/ats-autofill-stability.spec.ts tests/browser/mokahr-high-coverage.spec.ts docs/testing/domestic-ats-regression.md
rtk git commit -m "test: cover domestic ATS autofill stability"
```

---

## Final Acceptance Checklist

- [ ] 只有实习资料时，不创建空的正式工作记录。
- [ ] 未知 `employmentType` 不自动归入工作或实习栏目。
- [ ] 合并工作/实习栏目按原档案索引接受两类明确记录。
- [ ] 页面栏目、重复项序号和具体档案索引在 DOM 重渲染后保持一致。
- [ ] 所有搜索型控件最多执行两次，第三次浏览器调用不会发生。
- [ ] 自定义下拉必须点击唯一候选项并通过回读；输入文字本身不算成功。
- [ ] 年、月、日分别填写并回读，不把完整年月写进单一组件。
- [ ] 语言能力四字段可新增、保存、重载、抽取和自动填写。
- [ ] RAG 只映射当前栏目中的结构化路径，语言、联系方式、薪资和地址不会跨域错填。
- [ ] 后端阶段依次对应确定性填写、语义补全、回读校验和最终审核。
- [ ] 进度默认视图只显示当前动作、尝试次数和五类统计，明细按需展开。
- [ ] 用户已有页面值不被覆盖，失败和未匹配字段不计入完成。
- [ ] 合成 ATS、现有 Moka/DJI 回归、全量测试、类型检查和构建全部通过。
- [ ] 真实页面测试停在最终审核前，提交计数始终为零。
