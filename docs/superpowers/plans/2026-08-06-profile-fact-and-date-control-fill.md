# Profile Fact And Date Control Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让已保存的候选人档案值通过严格验证链，并把规范日期安全投影到招聘网站拆分的年、月、日控件。

**Architecture:** 在档案仓库边界生成和兼容可验证的用户证据，不放宽 RAG 验证器；在表单规范化边界保留日期子控件信息，并在投递字段解析边界完成日期分量投影。Browser Worker、动作审批与最终提交边界保持不变。

**Tech Stack:** TypeScript 5.8、Vitest 3、Zod、Fastify、SQLite、Playwright Core、pnpm workspace

## Global Constraints

- 不降低语义相似度、证据、生命周期、作用域、类型或必填项验证标准。
- 历史兼容仅适用于 `user_corrected`、`user` 来源且严格匹配旧系统“用户补充：字段路径”格式的事实。
- 日期适配必须对教育、项目和工作经历通用，不增加 DJI/Moka 域名分支。
- 非日期语义、非标准日期值和没有明确日期分量的控件保持原行为。
- 工作职责和项目描述只使用档案原文，不生成、不改写。
- 系统仍禁止终态提交。

---

### Task 1: 可验证的用户档案事实

**Files:**
- Modify: `apps/api/src/profile/profile-repository.ts`
- Test: `apps/api/src/profile/profile-repository.test.ts`
- Test: `apps/api/src/production-dependencies.test.ts`

**Interfaces:**
- Consumes: `ProfileFactUpsertInputSchema`、`Evidence`、`ProfileFact`。
- Produces: `userValueEvidence(value: JsonValue): Evidence[]` 的内部行为；`createProfileRepository(...).resolveForTask()` 对新旧用户事实均返回可被 `evidenceSupportsValue()` 验证的证据。

- [ ] **Step 1: 写新保存事实的失败测试**

在 `profile-repository.test.ts` 的首个 `upsertUserFact` 测试中增加：

```ts
expect(fact.evidence).toEqual([{
  documentId: "user",
  page: 1,
  text: "Corrected value: \"深圳\"",
  extraction: "user"
}]);
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `rtk pnpm --filter @resume/api test -- src/profile/profile-repository.test.ts --run`

Expected: FAIL，实际证据仍为 `用户补充：preferences.targetCity`。

- [ ] **Step 3: 写历史兼容失败测试**

在同一测试文件中显式创建内存数据库并插入一个 `user_corrected` 事实，其证据为旧格式：

```ts
const database = new Database(":memory:");
migrateDatabase(database);
const repository = createProfileRepository(database);
const legacy = repository.upsertUserFact({
  fieldPath: "work[0].description",
  value: "负责接口优化"
});
database.prepare("UPDATE profile_facts SET evidence_json = ? WHERE id = ?")
  .run(JSON.stringify([{
    documentId: "user",
    page: 1,
    text: "用户补充：work[0].description",
    extraction: "user"
  }]), legacy.id);

expect(repository.resolveForTask("task-1", "work[0].description")?.evidence[0]?.text)
  .toBe("Corrected value: \"负责接口优化\"");
```

- [ ] **Step 4: 运行测试并确认第二个 RED**

Run: `rtk pnpm --filter @resume/api test -- src/profile/profile-repository.test.ts --run`

Expected: FAIL，读取结果仍保留旧格式证据。

- [ ] **Step 5: 实现最小证据生成与兼容**

在 `profile-repository.ts` 中加入内部函数：

```ts
function userValueEvidence(value: JsonValue): Evidence[] {
  return [{
    documentId: "user",
    page: 1,
    text: `Corrected value: ${JSON.stringify(value)}`,
    extraction: "user"
  }];
}

function normalizeLegacyUserEvidence(fact: ProfileFact): ProfileFact {
  if (fact.status !== "user_corrected") return fact;
  const legacyText = `用户补充：${fact.fieldPath}`;
  if (fact.evidence.length === 0 || !fact.evidence.every((item) =>
    item.extraction === "user" && item.text === legacyText
  )) return fact;
  return { ...fact, evidence: userValueEvidence(fact.value) };
}
```

让 `parseFact()` 返回规范化结果，并让 `upsertUserFact()` 使用 `userValueEvidence(parsed.value)`。

- [ ] **Step 6: 验证仓库和生产解析链**

Run: `rtk pnpm --filter @resume/api test -- src/profile/profile-repository.test.ts src/production-dependencies.test.ts --run`

Expected: PASS，且用户事实仍需通过原有 RAG 验证器。

- [ ] **Step 7: 提交 Task 1**

```powershell
rtk git add apps/api/src/profile/profile-repository.ts apps/api/src/profile/profile-repository.test.ts apps/api/src/production-dependencies.test.ts
rtk git commit -m "fix: verify user-authored profile facts"
```

### Task 2: 日期子控件语义与值投影

**Files:**
- Modify: `packages/form-semantics/src/normalize.ts`
- Test: `packages/form-semantics/src/normalize.test.ts`
- Modify: `apps/api/src/applications/production-field-resolver.ts`
- Test: `apps/api/src/production-dependencies.test.ts`

**Interfaces:**
- Consumes: `RawFormField.nearbyText`、`FormField.label`、规范日期字符串 `YYYY-MM-DD`。
- Produces: 标签限定形式 `开始时间 年`、`开始时间 月`、`结束时间 日`；内部函数 `projectDateComponent(field, semantic, value)` 返回字段所需分量或原值。

- [ ] **Step 1: 写表单标签失败测试**

在 `normalize.test.ts` 构造同一主标签下的两个原始字段：

```ts
const raw = observation([
  rawField({ path: "#start-year", explicitLabel: "开始时间", nearbyText: "年" }),
  rawField({ path: "#start-month", explicitLabel: "开始时间", nearbyText: "月" })
]);

expect(normalizeForm(raw, context).fields.map((field) => field.label))
  .toEqual(["开始时间 年", "开始时间 月"]);
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `rtk pnpm --filter @resume/form-semantics test -- src/normalize.test.ts --run`

Expected: FAIL，当前两个标签都是 `开始时间`。

- [ ] **Step 3: 最小实现日期分量标签**

在 `normalize.ts` 中仅对 `/^[年月日]$/u` 占位信息追加限定：

```ts
function fieldLabel(raw: RawFormField): string {
  const primary = [raw.explicitLabel, raw.wrappingLabel, raw.ariaLabel, raw.ariaLabelledBy, raw.name]
    .find((candidate) => candidate.trim() !== "") ?? (raw.nearbyText || "未命名字段");
  return /^[年月日]$/u.test(raw.nearbyText) && primary !== raw.nearbyText
    ? `${primary} ${raw.nearbyText}`
    : primary;
}
```

由 `normalizeField()` 调用 `fieldLabel(raw)`。

- [ ] **Step 4: 运行语义测试并确认 GREEN**

Run: `rtk pnpm --filter @resume/form-semantics test -- src/normalize.test.ts --run`

Expected: PASS。

- [ ] **Step 5: 写日期投影失败测试**

在 `production-dependencies.test.ts` 建立三个精确语义字段，分别使用标签 `开始时间 年`、`开始时间 月`、`开始时间`，档案值均为 `2026-04-12`，断言解析值分别为：

```ts
expect(yearDecision).toMatchObject({ status: "verified", value: "2026" });
expect(monthDecision).toMatchObject({ status: "verified", value: "04" });
expect(fullDecision).toMatchObject({ status: "verified", value: "2026-04-12" });
```

另加非标准日期 `2026/04`，断言保持原值，不猜测分量。

- [ ] **Step 6: 运行测试并确认 RED**

Run: `rtk pnpm --filter @resume/api test -- src/production-dependencies.test.ts --run`

Expected: FAIL，年/月字段都返回完整日期。

- [ ] **Step 7: 实现日期分量投影**

在 `production-field-resolver.ts` 对验证成功的 decision 应用：

```ts
function projectDateComponent(field: FormField, semantic: string, value: unknown): unknown {
  if (!/(?:startDate|endDate|birthDate|date)$/u.test(semantic)
    || typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  if (/\s年$/u.test(field.label)) return value.slice(0, 4);
  if (/\s月$/u.test(field.label)) return value.slice(5, 7);
  if (/\s日$/u.test(field.label)) return value.slice(8, 10);
  return value;
}
```

只在 `decision.status` 为 `verified_auto` 或 `needs_review` 且存在值时投影，不改变 evidence、confidence 和 fieldPath。

- [ ] **Step 8: 验证日期与职责解析链**

Run: `rtk pnpm --filter @resume/form-semantics test -- --run`

Run: `rtk pnpm --filter @resume/api test -- src/production-dependencies.test.ts src/applications/entry-field-semantics.test.ts --run`

Expected: PASS；`工作职责`仍映射 `work[0].description`，年月标签仍映射同一个规范日期语义。

- [ ] **Step 9: 提交 Task 2**

```powershell
rtk git add packages/form-semantics/src/normalize.ts packages/form-semantics/src/normalize.test.ts apps/api/src/applications/production-field-resolver.ts apps/api/src/production-dependencies.test.ts
rtk git commit -m "fix: fill split date controls from profile dates"
```

### Task 3: 集成验证与本地服务更新

**Files:**
- Verify: `apps/api/data/resume-assistant.sqlite`
- Verify: `apps/api/dist/server.js`
- Verify: `apps/api/dist/browser-worker.js`

**Interfaces:**
- Consumes: Task 1 的兼容事实输出和 Task 2 的日期分量解析。
- Produces: 当前 `master` 上通过测试的构建产物与重新启动的本地 API；不提交数据库和 `dist`。

- [ ] **Step 1: 运行受影响工作区测试**

Run: `rtk pnpm --filter @resume/form-semantics test -- --run`

Run: `rtk pnpm --filter @resume/contracts test -- --run`

Run: `rtk pnpm --filter @resume/api test -- --run`

Expected: 全部 PASS。若 Windows Chromium 临时目录出现 `EBUSY`，单独重跑失败的真实浏览器文件，并明确记录环境失败，不能把它当成功。

- [ ] **Step 2: 运行 Web 回归与静态检查**

Run: `rtk pnpm --filter @resume/web test -- --run`

Run: `rtk pnpm typecheck`

Run: `rtk git diff --check HEAD~2..HEAD`

Expected: 全部 PASS，无 TypeScript 错误和空白错误。

- [ ] **Step 3: 构建并重启本地 API**

Run: `rtk pnpm --filter @resume/api build`

仅终止监听 `127.0.0.1:43120` 的项目 API 及其 Browser Worker，然后使用隐藏窗口执行：

```powershell
corepack pnpm --filter @resume/api start
```

Expected: `GET http://127.0.0.1:43120/api/health/adapters` 返回 200。

- [ ] **Step 4: 用当前数据库验证历史兼容**

读取 `work[0].description`、`work[0].startDate` 和 `work[0].endDate`，通过生产 resolver 断言：

```ts
work[0].description -> verified
work[0].startDate + 年 -> "2026"
work[0].startDate + 月 -> "04"
work[0].endDate + 年 -> "2026"
work[0].endDate + 月 -> "08"
```

Expected: 所有值通过验证，不写入招聘网站。

- [ ] **Step 5: 真实页面只读复核**

打开当前任务详情，确认任务状态和缺失字段统计可读取；创建新任务前不复用旧任务快照。真实填写测试允许执行安全编辑和中间步骤，但不得执行最终提交。

- [ ] **Step 6: 最终状态检查**

Run: `rtk git status --short --branch`

Expected: 仅保留用户原有 `.superpowers/sdd/*.md` 修改；数据库、日志和构建产物不进入提交。
