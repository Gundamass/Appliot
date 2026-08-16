# 岗位匹配创建入口实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有“新建投递”页面补齐岗位匹配创建入口，让用户先核对并保存知识库岗位期望，再创建 `JobMatchSession`；投递表单入口只回填直接投递，不自动创建或提交任务。

**Architecture:** `packages/form-semantics` 统一岗位期望字段路径，`packages/job-matching` 提供 Web 与 API 共用的事实投影，API 在获取浏览器租约前执行权威空期望校验。Web 新增独立 `JobMatchStartPanel`，由工作区管理岗位匹配/直接投递模式和路由分流；会话工作台只读展示 Adapter 网站筛选映射。

**Tech Stack:** TypeScript 5.8、React 19、React Router 7、Zod 3、Vitest 3、Testing Library、Fastify、Playwright 1.53、pnpm 10。

## Global Constraints

- 保留当前脏工作区中的所有用户修改；不创建 worktree，不委派子任务，不执行 commit、reset、checkout 或 clean。
- 所有 Shell 命令必须以 `rtk` 开头；手工编辑只使用 `apply_patch`。
- 每项行为改动严格 TDD：先写失败测试并确认失败原因，再写最小实现。
- 不读取 `.env.local`、真实数据库、简历文件、浏览器配置或隐私日志。
- 不访问或提交真实 ATS；浏览器验收只使用 Synthetic ATS，且始终断言 `submissionCount === 0`。
- `JobMatchSession` 与 `ApplicationTask` 保持分离；用户确认岗位前不得创建投递任务。
- 仅正式支持 Moka/Mokahr 中文岗位页和 DJI 招聘路径。
- 仅明确冲突进入冲突列表；信息不足继续参与推荐排序。本增量不得改变评分、排序或冲突规则。
- 后端空岗位期望校验必须发生在浏览器租约获取、页面打开和会话写入之前。
- 设计依据：`docs/superpowers/specs/2026-08-16-job-match-entry-design.md`。

## File Structure

- `packages/form-semantics/src/field-registry.ts`: 注册六类岗位期望规范字段，并把旧 `preferences.location` 声明为地点别名。
- `packages/job-matching/src/expectation.ts`: 事实到岗位期望草稿/快照的唯一确定性投影。
- `apps/api/src/production-dependencies.ts`: 使用共享投影生成生产会话快照。
- `apps/api/src/job-matching/job-match-service.ts`: 在浏览器操作前拒绝空岗位期望，并为工作台投影只读 FilterPlan。
- `apps/api/src/job-matching/routes.ts`: 将 `job_expectation_required` 映射为稳定 422 响应。
- `apps/web/src/job-matching/JobMatchStartPanel.tsx`: 核对、保存岗位期望并创建会话。
- `apps/web/src/applications/ApplicationStartPanel.tsx`: 接收投递表单分流产生的预填链接。
- `apps/web/src/workspace/ProfileApplicationWorkspace.tsx`: 管理页内分段模式和创建结果分流。
- `apps/web/src/router.tsx`: 向工作区注入 `JobMatchApi` 并完成会话导航。
- `apps/web/src/job-matching/JobMatchWorkbench.tsx`: 只读展示网站映射和本地判断。
- `apps/web/src/styles.css`: 创建入口及只读映射的响应式样式。
- `tests/browser/job-matching.spec.ts`: 从主界面开始的 Synthetic ATS 安全 E2E。

---

### Task 1: 统一六类岗位期望字段

**Files:**
- Modify: `packages/form-semantics/src/field-registry.ts`
- Modify: `packages/form-semantics/src/field-registry.test.ts`

**Interfaces:**
- Produces: 规范路径 `preferences.targetRole`、`preferences.targetCity`、`preferences.employmentType`、`preferences.industry`、`preferences.workMode`、`preferences.salary`。
- Produces: `semanticLookupPaths("preferences.targetCity")` 包含旧别名 `preferences.location`。
- Preserves: 新写入始终使用 `preferences.targetCity`，旧地点事实仅作为读取兼容。

- [ ] **Step 1: 写失败的字段注册表测试**

在 `field-registry.test.ts` 增加：

```ts
it("registers every job expectation field and keeps the legacy location alias readable", () => {
  const expected = [
    "preferences.targetRole",
    "preferences.targetCity",
    "preferences.employmentType",
    "preferences.industry",
    "preferences.workMode",
    "preferences.salary"
  ];
  for (const semantic of expected) {
    expect(FIELD_DEFINITIONS.find((field) => field.semantic === semantic)).toMatchObject({
      sections: ["preferences"]
    });
  }
  expect(semanticLookupPaths("preferences.targetCity")).toEqual([
    "preferences.targetCity",
    "preferences.location"
  ]);
});
```

- [ ] **Step 2: 运行测试确认按预期失败**

Run: `rtk pnpm --filter @resume/form-semantics test -- src/field-registry.test.ts`  
Expected: FAIL，缺少 `industry`、`workMode`、`salary` 定义，且地点没有旧别名。

- [ ] **Step 3: 添加最小字段定义**

在现有 preferences 定义旁加入以下语义，并给 `targetCity` 增加 legacy semantics：

```ts
definition(
  "preferences.targetCity",
  "期望工作地点",
  ["意向城市", "目标城市", "工作城市"],
  TEXT_SELECT_TYPES,
  ["preferences"],
  "候选人的目标工作城市",
  "normal",
  ["preferences.location"]
),
definition("preferences.industry", "期望行业", ["目标行业", "意向行业"], TEXT_SELECT_TYPES, ["preferences"], "候选人的目标行业"),
definition("preferences.workMode", "期望办公方式", ["办公方式", "工作方式"], TEXT_SELECT_TYPES, ["preferences"], "现场、混合或远程办公偏好"),
definition("preferences.salary", "期望薪资", ["薪资期望", "期望月薪"], TEXT_TYPES, ["preferences"], "候选人的薪资范围")
```

把本地工厂签名精确扩展为：

```ts
function definition(
  semantic: string,
  label: string,
  aliases: readonly string[],
  types: readonly SemanticFieldType[],
  sections: readonly FieldSection[],
  description: string,
  risk: FieldDefinition["risk"] = "normal",
  legacySemantics: readonly string[] = []
): Omit<FieldDefinition, "profileControl" | "profileOptions"> {
  return {
    semantic,
    label,
    aliases,
    types,
    sections,
    risk,
    description,
    ...(legacySemantics.length === 0 ? {} : { legacySemantics })
  };
}
```

该新增参数位于现有 `risk` 之后，所以全部旧调用行为保持不变。为三类新增字段补充 `PROFILE_FIELD_METADATA`：行业和办公方式使用 `suggestion`，薪资使用 `text`。

- [ ] **Step 4: 运行字段注册表回归**

Run: `rtk pnpm --filter @resume/form-semantics test -- src/field-registry.test.ts`  
Expected: PASS。

- [ ] **Step 5: 审阅限定 diff**

Run: `rtk git diff -- packages/form-semantics/src/field-registry.ts packages/form-semantics/src/field-registry.test.ts`  
Expected: 只包含六类期望字段和旧地点别名支持，不改变其他 ATS 字段。

---

### Task 2: 建立共享岗位期望事实投影

**Files:**
- Create: `packages/job-matching/src/expectation.ts`
- Create: `packages/job-matching/src/expectation.test.ts`
- Modify: `packages/job-matching/src/index.ts`
- Modify: `apps/api/src/production-dependencies.ts`
- Modify: `apps/api/src/production-dependencies.test.ts`

**Interfaces:**
- Consumes: `ProfileFact`、`JobExpectationCriterion["kind"]`、`JobExpectationSnapshot`。
- Produces: `JOB_EXPECTATION_FIELDS`。
- Produces: `projectJobExpectations(facts): ProjectedJobExpectation[]`。
- Produces: `jobExpectationSnapshot(facts, revision, confirmedAt): JobExpectationSnapshot`。
- Produces: `hasUsableJobExpectation(facts): boolean`。

- [ ] **Step 1: 写投影优先级失败测试**

覆盖用户核对优先、规范路径优先、revision 优先和空值过滤：

```ts
it("projects canonical reviewed facts ahead of extracted and legacy alternatives", () => {
  const projected = projectJobExpectations([
    fact("legacy", "preferences.location", "上海", "user_confirmed", 5),
    fact("canonical-extracted", "preferences.targetCity", "北京", "extracted", 9),
    fact("canonical-reviewed", "preferences.targetCity", "深圳", "user_corrected", 2),
    fact("empty", "preferences.industry", "   ", "user_corrected", 1)
  ]);
  expect(projected).toContainEqual(expect.objectContaining({
    kind: "location",
    canonicalPath: "preferences.targetCity",
    values: ["深圳"],
    factId: "canonical-reviewed",
    needsConfirmation: false
  }));
  expect(projected.some((item) => item.kind === "industry")).toBe(false);
});

it("marks extracted values for confirmation and builds snapshots only from reviewed facts", () => {
  const facts = [fact("role", "preferences.targetRole", "Java", "extracted", 1)];
  expect(projectJobExpectations(facts)[0]?.needsConfirmation).toBe(true);
  expect(hasUsableJobExpectation(facts)).toBe(false);
  expect(jobExpectationSnapshot(facts, 4, "2026-08-16T00:00:00.000Z").criteria).toEqual([]);
});
```

- [ ] **Step 2: 运行测试确认模块不存在**

Run: `rtk pnpm --filter @resume/job-matching test -- src/expectation.test.ts`  
Expected: FAIL，`expectation.ts` 或导出不存在。

- [ ] **Step 3: 实现纯投影**

定义稳定字段元数据：

```ts
export const JOB_EXPECTATION_FIELDS = [
  { canonicalPath: "preferences.targetRole", kind: "target_role", label: "目标岗位", legacyPaths: [] },
  { canonicalPath: "preferences.targetCity", kind: "location", label: "地点", legacyPaths: ["preferences.location"] },
  { canonicalPath: "preferences.employmentType", kind: "employment_type", label: "用工类型", legacyPaths: [] },
  { canonicalPath: "preferences.industry", kind: "industry", label: "行业", legacyPaths: [] },
  { canonicalPath: "preferences.workMode", kind: "work_mode", label: "办公方式", legacyPaths: [] },
  { canonicalPath: "preferences.salary", kind: "salary", label: "薪资", legacyPaths: [] }
] as const;

export interface ProjectedJobExpectation {
  canonicalPath: typeof JOB_EXPECTATION_FIELDS[number]["canonicalPath"];
  fieldPath: string;
  kind: JobExpectationCriterion["kind"];
  label: string;
  values: string[];
  factId: string;
  status: ProfileFact["status"];
  needsConfirmation: boolean;
}
```

只考虑 `scope === "profile"` 且非 `superseded` 的事实。排序键固定为：reviewed status 在前、canonical path 在前、revision 降序、id 升序。字符串 trim 后转单值数组；字符串数组逐项 trim、去空并保持首次出现顺序。`jobExpectationSnapshot()` 只纳入 `user_confirmed` 或 `user_corrected` 的投影，strength 固定为 `required`。

- [ ] **Step 4: 导出并运行包测试**

在 `index.ts` 增加：

```ts
export {
  JOB_EXPECTATION_FIELDS,
  hasUsableJobExpectation,
  jobExpectationSnapshot,
  projectJobExpectations,
  type ProjectedJobExpectation
} from "./expectation.js";
```

Run: `rtk pnpm --filter @resume/job-matching test -- src/expectation.test.ts`  
Expected: PASS。

- [ ] **Step 5: 用共享投影替换生产私有 helper**

删除 `production-dependencies.ts` 中私有 `expectationSnapshotFromProfile()` 和 `expectationValues()`，改为：

```ts
expectationSnapshot: () => jobExpectationSnapshot(
  profileRepository.listActive(),
  profileRepository.currentRevision(),
  new Date().toISOString()
)
```

在 `production-dependencies.test.ts` 增加 `targetCity`、旧 `location` 和新增字段的快照断言，确认规范路径值胜出。

- [ ] **Step 6: 运行领域与生产依赖测试**

Run: `rtk pnpm --filter @resume/job-matching test -- src/expectation.test.ts`  
Expected: PASS。  
Run: `rtk pnpm --filter @resume/api test -- src/production-dependencies.test.ts`  
Expected: PASS。

---

### Task 3: 在浏览器操作前强制岗位期望前置条件

**Files:**
- Modify: `apps/api/src/job-matching/job-match-service.ts`
- Modify: `apps/api/src/job-matching/job-match-service.test.ts`
- Modify: `apps/api/src/job-matching/routes.ts`
- Modify: `apps/api/src/job-matching/routes.test.ts`

**Interfaces:**
- Consumes: `expectationSnapshot(): JobExpectationSnapshot`。
- Produces: 空 criteria 时抛出 `job_expectation_required`。
- Produces: HTTP 422 `{ error, code: "job_expectation_required" }`。

- [ ] **Step 1: 写服务层顺序失败测试**

让 harness 支持空快照，并加入：

```ts
it("rejects an empty expectation before acquiring or opening the browser", async () => {
  const value = harness("job_list", 7, { ...expectation, criteria: [] });
  await expect(value.service.create({ url: "https://jobs.example/list" }))
    .rejects.toThrow("job_expectation_required");
  expect(value.browserOwnershipLease.current()).toBeUndefined();
  expect(value.browser.open).not.toHaveBeenCalled();
  expect(value.browser.observeJob).not.toHaveBeenCalled();
  expect(value.repository.get("session-1")).toBeUndefined();
  expect(value.trace.snapshot()).toHaveLength(0);
});
```

将 harness 签名改为 `harness(entryHint = "job_list", profileRevision = 7, expectationSnapshot = expectation)`；创建局部 `const browserOwnershipLease = new BrowserOwnershipLease()`，同时注入 service 并随 harness 返回，`expectationSnapshot` 依赖返回第三个参数。

- [ ] **Step 2: 运行服务测试确认失败**

Run: `rtk pnpm --filter @resume/api test -- src/job-matching/job-match-service.test.ts`  
Expected: FAIL，当前 create 仍获取租约或打开浏览器。

- [ ] **Step 3: 在 create 的第一个副作用前校验**

在 URL 校验之后、`createId()` 和 `browserOwnershipLease.acquire()` 之前执行：

```ts
const expectation = dependencies.expectationSnapshot();
if (expectation.criteria.length === 0) throw new Error("job_expectation_required");
```

后续 repository create 复用该 `expectation` 局部变量，不再次读取知识库，保证一个会话使用同一快照。

- [ ] **Step 4: 写路由稳定错误测试**

```ts
it("maps a missing job expectation to a recoverable 422 response", async () => {
  const service = { create: vi.fn().mockRejectedValue(new Error("job_expectation_required")) };
  const app = Fastify();
  registerJobMatchRoutes(app, { service: service as never });
  const response = await app.inject({
    method: "POST",
    url: "/api/job-match-sessions",
    payload: { url: "https://acme.mokahr.com/jobs" }
  });
  expect(response.statusCode).toBe(422);
  expect(response.json()).toMatchObject({ code: "job_expectation_required" });
});
```

- [ ] **Step 5: 映射错误并运行 API 测试**

在 `mapJobMatchError()` 中加入：

```ts
if (code === "job_expectation_required") {
  return { statusCode: 422, error: "Job expectation is required", code };
}
```

Run: `rtk pnpm --filter @resume/api test -- src/job-matching/job-match-service.test.ts src/job-matching/routes.test.ts src/production-dependencies.test.ts`  
Expected: PASS。

---

### Task 4: 新增岗位匹配创建面板

**Files:**
- Create: `apps/web/src/job-matching/JobMatchStartPanel.tsx`
- Create: `apps/web/src/job-matching/JobMatchStartPanel.test.tsx`
- Modify: `apps/web/package.json`

**Interfaces:**
- Consumes: `profileApi: Pick<ProfileApi, "listFacts" | "confirm" | "upsert">`。
- Consumes: `jobMatchApi: Pick<JobMatchApi, "create">`。
- Produces: `onSessionCreated(sessionId: string): void`。
- Produces: `onApplicationForm(applicationUrl: string): void`。
- Produces: `onOpenProfile(): void`。
- Produces: `onBusyChange?(busy: boolean): void`，供工作区在事实写入或会话创建期间锁定模式切换。

- [ ] **Step 1: 让 Web 显式依赖共享投影包**

在 `apps/web/package.json` dependencies 增加：

```json
"@resume/job-matching": "workspace:*"
```

- [ ] **Step 2: 写加载与核对失败测试**

```tsx
it("prefills extracted expectations, confirms them, then creates a session", async () => {
  const profileApi = {
    listFacts: vi.fn().mockResolvedValue([extractedFact("preferences.targetRole", "Java 技术负责人")]),
    confirm: vi.fn().mockResolvedValue(reviewedFact("preferences.targetRole", "Java 技术负责人")),
    upsert: vi.fn()
  };
  const jobMatchApi = { create: vi.fn().mockResolvedValue({ id: "session-1" }) };
  const onSessionCreated = vi.fn();
  render(<JobMatchStartPanel
    profileApi={profileApi as never}
    jobMatchApi={jobMatchApi as never}
    onSessionCreated={onSessionCreated}
    onApplicationForm={vi.fn()}
    onOpenProfile={vi.fn()}
  />);
  expect(await screen.findByDisplayValue("Java 技术负责人")).toBeVisible();
  expect(screen.getByText("来自简历，待确认")).toBeVisible();
  await userEvent.type(screen.getByLabelText("招聘链接"), "https://acme.mokahr.com/jobs");
  await userEvent.click(screen.getByRole("button", { name: "确认岗位期望并开始匹配" }));
  expect(profileApi.confirm).toHaveBeenCalledTimes(1);
  expect(jobMatchApi.create).toHaveBeenCalledWith("https://acme.mokahr.com/jobs");
  expect(onSessionCreated).toHaveBeenCalledWith("session-1");
});
```

同时添加行为测试：档案读取失败可重试；六项全空时聚焦第一个期望字段；修改值调用 `upsert(canonicalPath, value)` 而不是 confirm；旧别名 extracted 值未修改时也写入规范路径；某字段保存失败时不调用 create 且保留全部草稿；连续点击只产生一组事实写入和一次 create；组件卸载后已完成的请求不触发回调。

- [ ] **Step 3: 运行组件测试确认模块不存在**

Run: `rtk pnpm --filter @resume/web test -- src/job-matching/JobMatchStartPanel.test.tsx`  
Expected: FAIL，组件不存在。

- [ ] **Step 4: 实现加载和草稿模型**

使用 `projectJobExpectations()` 初始化六个固定字段。每个草稿保存 `canonicalPath`、来源 `fieldPath`、原始 fact id、原始值、`needsConfirmation`、当前值和 `settled` 状态。加载失败显示“岗位期望加载失败，请重试”，禁止主操作。用递增 request generation/ref 保护加载、保存和创建结果；重试或卸载后，旧 generation 不得写 state 或触发成功回调。

本地 URL 校验固定为：

```ts
function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: 实现逐字段保存和创建分流**

提交顺序固定为：校验至少一个非空值 -> 校验 URL -> 对每个未 settled 非空字段执行 confirm/upsert -> 重新确认至少一个已核对字段 -> create。只有“规范路径上的 extracted 事实且值未修改”调用 `confirm(factId)`；旧别名上的 extracted 事实即使值未修改也调用 `upsert(canonicalPath, value)`，修改值和新值同样调用 `upsert`，确保确认后的新写入只使用规范路径。已核对且未修改的事实不写入。

```ts
const result = await jobMatchApi.create(url);
if ("redirect" in result) onApplicationForm(result.applicationUrl);
else onSessionCreated(result.id);
```

每个成功写入返回的事实立即替换该草稿的 source fact 并标记 settled；失败时不重放 settled 字段。提交中禁用输入、模式相关回调和主按钮。

错误码映射至少覆盖：

```ts
const messages: Record<string, string> = {
  job_expectation_required: "请先确认至少一项岗位期望",
  browser_task_in_use: "受控浏览器正在处理另一个投递或匹配任务，请先完成当前任务。",
  unsupported_job_entry: "当前仅支持 Moka/Mokahr 中文岗位页和 DJI 招聘路径。"
};
```

捕获 `JobMatchApiError.code === "job_expectation_required"` 时重新调用 `profileApi.listFacts()`，只刷新来源 fact、确认状态和 settled 标记，不覆盖用户当前草稿与链接，然后显示同一条“请先确认至少一项岗位期望”引导。事实写入或 create 开始时调用 `onBusyChange?.(true)`，在当前 generation 的 `finally` 中恢复为 false。

- [ ] **Step 6: 运行完整面板测试**

Run: `rtk pnpm --filter @resume/web test -- src/job-matching/JobMatchStartPanel.test.tsx src/job-matching/api.test.ts`  
Expected: PASS。

---

### Task 5: 接入工作区分段模式与投递链接回填

**Files:**
- Modify: `apps/web/src/applications/ApplicationStartPanel.tsx`
- Modify: `apps/web/src/applications/ApplicationStartPanel.test.tsx`
- Modify: `apps/web/src/workspace/ProfileApplicationWorkspace.tsx`
- Modify: `apps/web/src/workspace/ProfileApplicationWorkspace.test.tsx`
- Modify: `apps/web/src/router.tsx`
- Modify: `apps/web/src/router.test.tsx`

**Interfaces:**
- Consumes: Task 4 的 `JobMatchStartPanel`。
- Produces: 默认 `job_match`、备用 `direct_application` 页内模式。
- Produces: `ApplicationStartPanel.initialApplicationUrl?: string`。
- Produces: 创建会话后导航 `/job-match-sessions/:sessionId`。

- [ ] **Step 1: 写直接投递预填失败测试**

```tsx
it("prefills a redirected application URL without creating a task", () => {
  const create = vi.fn();
  render(<ApplicationStartPanel
    profileCompleteness={complete}
    applicationApi={{ create } as never}
    initialApplicationUrl="https://jobs.example/apply"
    onTaskCreated={vi.fn()}
  />);
  expect(screen.getByLabelText("投递官网链接")).toHaveValue("https://jobs.example/apply");
  expect(create).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 实现受控初始链接**

新增 prop：

```ts
initialApplicationUrl?: string;
```

组件首次挂载或该 prop 变为新的非空 URL 时更新 `applicationUrl`，并在用户尚未修改任务名称时复用现有 `suggestApplicationTaskName()`。任何 prop 变化都不得调用 `applicationApi.create()`。

- [ ] **Step 3: 写工作区分段与分流失败测试**

在工作区测试中注入 `jobMatchApi`，断言：默认看到“岗位匹配”；切换“直接投递”显示现有表单；create 返回 session 时导航；返回 application redirect 时切换并预填链接。

```tsx
expect(screen.getByRole("button", { name: "岗位匹配" })).toHaveAttribute("aria-pressed", "true");
await user.click(screen.getByRole("button", { name: "直接投递" }));
expect(screen.getByLabelText("任务名称")).toBeVisible();
```

- [ ] **Step 4: 运行工作区测试确认失败**

Run: `rtk pnpm --filter @resume/web test -- src/applications/ApplicationStartPanel.test.tsx src/workspace/ProfileApplicationWorkspace.test.tsx src/router.test.tsx`  
Expected: FAIL，尚无分段模式、jobMatchApi 注入或 initialApplicationUrl。

- [ ] **Step 5: 实现工作区状态和路由接线**

`ProfileApplicationWorkspaceProps` 增加 `jobMatchApi: Pick<JobMatchApi, "create">`。在 apply 视图内管理：

```ts
const [applicationMode, setApplicationMode] = useState<"job_match" | "direct_application">("job_match");
const [prefilledApplicationUrl, setPrefilledApplicationUrl] = useState<string>();
const [jobMatchBusy, setJobMatchBusy] = useState(false);
```

分段按钮使用 `aria-pressed`，并在 `jobMatchBusy` 时全部 disabled；`JobMatchStartPanel.onBusyChange` 连接 `setJobMatchBusy`。`onSessionCreated` 调用 `navigate(`/job-match-sessions/${sessionId}`)`；`onApplicationForm` 设置预填链接并切换 direct mode；`onOpenProfile` 调用现有 `selectView("profile")`。

`AppRouter` 的 `WorkspaceRoute` 同时接收并传递 `jobMatchApi`：

```tsx
<Route path="/" element={<WorkspaceRoute applicationApi={applicationApi} jobMatchApi={jobMatchApi} />} />
```

- [ ] **Step 6: 运行 Web 接线测试**

Run: `rtk pnpm --filter @resume/web test -- src/applications/ApplicationStartPanel.test.tsx src/job-matching/JobMatchStartPanel.test.tsx src/workspace/ProfileApplicationWorkspace.test.tsx src/router.test.tsx`  
Expected: PASS。

---

### Task 6: 将网站筛选确认改为只读映射

**Files:**
- Modify: `apps/web/src/job-matching/api.ts`
- Modify: `apps/web/src/job-matching/JobMatchWorkbench.tsx`
- Modify: `apps/web/src/job-matching/JobMatchWorkbench.test.tsx`
- Modify: `apps/web/src/router.tsx`
- Modify: `apps/api/src/job-matching/job-match-service.ts`
- Modify: `apps/api/src/job-matching/job-match-service.test.ts`

**Interfaces:**
- Produces: `PresentedJobMatchSession = JobMatchAggregate & { filterPlan?: FilterPlan }`，只作为服务响应投影，不写入 repository。
- Produces: Web `JobMatchSession.filterPlan?: FilterPlan` 只读展示投影。
- Changes: `JobMatchWorkbench.onConfirmFilters?(): void` 不再接收可编辑 values。
- Preserves: API `confirmFilters()` 继续接收创建时的不可变 `session.expectation`。

- [ ] **Step 1: 写工作台只读失败测试**

给 fixture 增加：

```ts
filterPlan: {
  source: "moka",
  adapterVersion: "moka-job-v1",
  mapped: [{ criterionIndex: 0, key: "job", values: ["Java 技术负责人"] }],
  localOnly: [{ criterionIndex: 1, reasonCode: "unsupported_filter" }]
}
```

断言没有 textbox，显示“网站筛选：Java 技术负责人”“仅本地判断：深圳”，点击“确认筛选并读取岗位”只调用无参数 `onConfirmFilters`。

- [ ] **Step 2: 运行工作台测试确认失败**

Run: `rtk pnpm --filter @resume/web test -- src/job-matching/JobMatchWorkbench.test.tsx src/router.test.tsx`  
Expected: FAIL，当前筛选条件可编辑且 session 没有 filterPlan。

- [ ] **Step 3: 为 create/get 响应增加确定性 FilterPlan 投影**

在 `JobMatchService` 内增加无副作用 presenter：

```ts
type PresentedJobMatchSession = JobMatchAggregate & { filterPlan?: FilterPlan };

const present = (aggregate: JobMatchAggregate): PresentedJobMatchSession => {
  const adapter = aggregate.source === undefined
    ? undefined
    : dependencies.adapters.find((candidate) => candidate.source === aggregate.source
      && candidate.version === aggregate.adapterVersion);
  return adapter === undefined
    ? aggregate
    : { ...aggregate, filterPlan: adapter.mapFilters(aggregate.expectation) };
};
```

把 `JobMatchCreateResult` 的会话分支改为 `PresentedJobMatchSession`，把内部 `get()` 返回类型改为 `PresentedJobMatchSession`。`create()` 返回新会话和 `get()` 返回 aggregate 时经过 `present()`；投递表单 redirect 不变，repository 的 `JobMatchAggregate`、schema 和数据库均不增加 `filterPlan`。新增服务测试断言 presenter 不调用 browser.execute，且 `filterPlan` 与 extraction coordinator 使用同一 Adapter 结果。

- [ ] **Step 4: 更新 Web 会话类型和工作台**

`JobMatchSession` 增加：

```ts
filterPlan?: FilterPlan;
```

删除 `filterValues` state 和筛选输入。按 `criterionIndex` 将 mapped/localOnly 与 `session.expectation.criteria` 关联；mapped 显示网站 key 和值，localOnly 显示“仅本地判断”及原条件值。缺少 filterPlan 时显示不可编辑的岗位期望和“网站映射暂不可用”，不得恢复编辑框。

Router 确认时原样提交创建时的不可变快照，不改 criteria、`confirmedAt` 或 revision：

```ts
void api.confirmFilters(session.id, session.expectation, guard()).then(loaded.refresh);
```

- [ ] **Step 5: 运行服务与工作台测试**

Run: `rtk pnpm --filter @resume/api test -- src/job-matching/job-match-service.test.ts src/job-matching/extraction-coordinator.test.ts`  
Expected: PASS。  
Run: `rtk pnpm --filter @resume/web test -- src/job-matching/JobMatchWorkbench.test.tsx src/job-matching/api.test.ts src/router.test.tsx`  
Expected: PASS。

---

### Task 7: 响应式、Synthetic ATS 入口 E2E 与最终回归

**Files:**
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/styles.test.ts`
- Modify: `tests/browser/job-matching.spec.ts`
- Modify: `docs/testing/ats-regression.md`

**Interfaces:**
- Verifies: 320px 下分段控件、六类期望、链接输入和错误信息无横向溢出。
- Verifies: 从主界面创建会话或回填直接投递的完整分流。
- Verifies: 所有 Synthetic ATS 路径 `submissionCount === 0`。

- [ ] **Step 1: 写样式约束失败测试**

扩展 `styles.test.ts`：

```ts
expect(css).toContain(".application-mode-switch");
expect(css).toContain(".job-match-start-panel");
expect(css).toMatch(/\.job-match-expectation-grid[^}]*minmax\(0,\s*1fr\)/su);
expect(css).toMatch(/\.job-match-start-panel[^}]*overflow-wrap:\s*anywhere/su);
```

- [ ] **Step 2: 添加克制的响应式样式**

分段控件使用稳定的两列 grid；期望字段桌面两列、窄屏一列；所有 grid child 设置 `min-width: 0`；链接和错误文本 `overflow-wrap: anywhere`。卡片圆角不超过 8px，不引入渐变、装饰性背景或嵌套卡片。

- [ ] **Step 3: 写主界面 E2E 失败路径**

在现有 Vite route mock 中覆盖 profile facts、confirm/upsert 和 job-match create。新增测试：

```ts
test("starts job matching from the workspace and never submits the ATS", async ({ page }) => {
  const taskId = "job-match-entry-flow";
  await mockProfileAndCreateSession(page, taskId, ats.baseUrl);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${webBaseUrl}/?view=apply`);
  await expect(page.getByRole("button", { name: "岗位匹配" })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("招聘链接").fill(`${ats.baseUrl}/job-list.html?page=1&taskId=${taskId}`);
  await page.getByRole("button", { name: "确认岗位期望并开始匹配" }).click();
  await expect(page).toHaveURL(new RegExp(`/job-match-sessions/${sessionId}$`, "u"));
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  expect(ats.state(taskId).submissionCount).toBe(0);
});
```

再加一个 application form redirect 测试，断言切换到“直接投递”、链接已预填、任务名称仍可编辑、application create 请求数为 0、`submissionCount === 0`。

- [ ] **Step 4: 运行 Web 和岗位匹配 E2E**

Run: `rtk pnpm --filter @resume/web test -- src/job-matching src/applications/ApplicationStartPanel.test.tsx src/workspace/ProfileApplicationWorkspace.test.tsx src/router.test.tsx src/styles.test.ts`  
Expected: PASS。  
Run: `rtk pnpm test:e2e -- tests/browser/job-matching.spec.ts`  
Expected: PASS，所有相关 taskId 的 `submissionCount` 均为 0。

- [ ] **Step 5: 更新回归记录**

在 `docs/testing/ats-regression.md` 记录：执行日期、精确命令、通过用例数、Synthetic ATS 零提交结果，以及“真实 Moka/DJI 未运行，不得宣称通过”。

- [ ] **Step 6: 运行全量验证**

Run: `rtk pnpm test`  
Expected: 全部测试通过。  
Run: `rtk pnpm typecheck`  
Expected: exit 0。  
Run: `rtk pnpm build`  
Expected: exit 0。

- [ ] **Step 7: 检查限定路径和禁用文案**

Run: `rtk git diff --check -- packages/form-semantics packages/job-matching apps/api/src/job-matching apps/api/src/production-dependencies.ts apps/web/src/job-matching apps/web/src/applications/ApplicationStartPanel.tsx apps/web/src/workspace/ProfileApplicationWorkspace.tsx apps/web/src/router.tsx apps/web/src/styles.css tests/browser/job-matching.spec.ts docs/testing/ats-regression.md`  
Expected: 无输出。  
Run: `rtk rg -n "自动申请|最终提交" apps/web/src --glob "!**/*.test.*"`  
Expected: 无匹配。  
Run: `rtk git status --short`  
Expected: 显示本增量和用户原有修改；不得清理或覆盖无关文件。
