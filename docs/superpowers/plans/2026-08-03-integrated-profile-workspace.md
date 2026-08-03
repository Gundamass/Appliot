# 档案与投递统一工作区 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 将候选人档案、新建投递和投递审核收进一个根路径工作区，并让补全后的长期档案可靠提升招聘字段映射覆盖率。

**Architecture:** 现有 ProfileFact 继续作为唯一长期资料存储；新增受字段注册表约束的用户资料 upsert 与完整度投影。React 根路由改为工作区容器，具体任务页保留现有实时控制职责；任务恢复只重新观察并处理页面中仍为空的字段。

**Tech Stack:** React 18、TypeScript、React Router、Fastify、SQLite、Zod、Vitest、Playwright、XState、Lucide。

**Implementation status (2026-08-03):** Tasks 1-7 are complete in the current workspace without a Git commit. Fresh verification passed: `pnpm typecheck`, `pnpm test`, `pnpm test:e2e` (15/15), and responsive browser inspection for profile, apply, reviews, and task-workbench views. The profile-completion retry regression confirms that a profile fact added through the profile API is used after fresh page observation, existing values remain unchanged, and terminal submission remains blocked.

## Global Constraints

- 不创建隔离工作树，不提交 Git，不重置或覆盖现有用户改动。
- 所有终端命令使用 rtk 前缀。
- 每个行为先写失败测试并确认失败，再写最小实现。
- 根路径缺少或包含未知 view 参数时回退到 profile。
- 官网已有值绝不覆盖；所有自动填写均必须页面回读成功。
- 自动化永不执行提交、投递、确认申请或语义等价动作。
- 项目要点和实习描述不由模型生成或重写；自我评价微调必须进入用户审核。
- 敏感信息不进入向量检索、模型请求或活动日志。

---

## 文件结构

| 路径 | 职责 |
| --- | --- |
| packages/contracts/src/profile.ts | 档案写入与完整度 API 契约。 |
| packages/form-semantics/src/field-registry.ts | 标准字段、栏目、别名与重复经历上下文。 |
| apps/api/src/profile/profile-repository.ts | 用户补充事实的原子 upsert 和既有版本语义。 |
| apps/api/src/profile/profile-completeness.ts | 从已确认事实计算档案栏目完整度。 |
| apps/api/src/profile/profile-routes.ts | 档案 upsert、完整度 HTTP 端点。 |
| apps/web/src/workspace/ProfileApplicationWorkspace.tsx | 根路径统一工作区与 URL view 投影。 |
| apps/web/src/profile/CandidateProfileCenter.tsx | 长表单档案中心。 |
| apps/web/src/profile/RepeatedEntryEditor.tsx | 教育、工作、项目、获奖等重复经历编辑器。 |
| apps/web/src/applications/ApplicationStartPanel.tsx | 同页新建投递及投递前检查。 |
| apps/web/src/applications/ApplicationReviewInbox.tsx | 待人工处理任务摘要。 |
| apps/api/src/applications/application-service.ts | 从已补全档案恢复任务。 |

### Task 1: 扩展字段注册表并定义档案完整度契约

**Files:**
- Modify: packages/form-semantics/src/field-registry.ts
- Modify: packages/form-semantics/src/field-registry.test.ts
- Modify: packages/contracts/src/profile.ts
- Modify: packages/contracts/src/profile.test.ts
- Modify: packages/contracts/src/index.ts

**Interfaces:**
- Produces: ProfileFactUpsertInputSchema, ProfileFactUpsertInput。
- Produces: ProfileCompletenessSchema, ProfileCompleteness。
- Produces: profileSectionFor(fieldPath) and PROFILE_SECTION_DEFINITIONS。
- Preserves: FIELD_DEFINITIONS and semanticLookupPaths compatibility.

- [ ] **Step 1: Write the failing field-registry and contract tests**

~~~ts
it("keeps award level inside the same repeated award entry", () => {
  expect(resolveDeterministicSemantic({
    label: "奖项级别",
    type: "select",
    entryContext: "awards[1]"
  })?.semantic).toBe("awards[1].level");
});

it("rejects a profile upsert with an empty field path", () => {
  expect(ProfileFactUpsertInputSchema.safeParse({ fieldPath: "", value: "深圳" }).success).toBe(false);
});

it("accepts a completeness projection with missing profile paths", () => {
  expect(ProfileCompletenessSchema.parse({
    completed: 1,
    total: 2,
    sections: [{ id: "preferences", label: "求职偏好", completed: 0, total: 1, missing: ["preferences.targetCity"] }]
  }).sections[0]?.missing).toEqual(["preferences.targetCity"]);
});
~~~

- [ ] **Step 2: Run the focused tests and verify RED**

Run: rtk pnpm --filter @resume/form-semantics test -- field-registry.test.ts

Run: rtk pnpm --filter @resume/contracts test -- profile.test.ts

Expected: FAIL because awards[].level and the new profile schemas do not exist.

- [ ] **Step 3: Add the minimum registry and contracts**

~~~ts
export const ProfileFactUpsertInputSchema = z.object({
  fieldPath: z.string().min(1).max(256),
  value: JsonValueSchema
}).strict();

export const ProfileCompletenessSchema = z.object({
  completed: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  sections: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    completed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    missing: z.array(z.string().min(1))
  }).strict())
}).strict();
~~~

Add the field definition:

~~~ts
repeated(
  "awards[].level",
  "奖项级别",
  ["获奖级别", "荣誉级别", "奖项等级"],
  ["select", "radio", "text"],
  "awards",
  "国家级、省级、市级、校级、院级或其他奖项级别"
)
~~~

Export a data-only section definition with IDs basics, preferences, education, work, projects, campus, awards, publications, certificates and self. profileSectionFor must derive its answer from a canonical semantic path, including indexed repeated paths such as awards[1].level.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: rtk pnpm --filter @resume/form-semantics test -- field-registry.test.ts

Run: rtk pnpm --filter @resume/contracts test -- profile.test.ts

Expected: PASS.

- [ ] **Step 5: Record completion without committing**

Run: rtk git diff --check

Expected: exit code 0. Do not create a Git commit.

### Task 2: 用户资料 upsert 与完整度 API

**Files:**
- Create: apps/api/src/profile/profile-completeness.ts
- Create: apps/api/src/profile/profile-completeness.test.ts
- Modify: apps/api/src/profile/profile-repository.ts
- Modify: apps/api/src/profile/profile-repository.test.ts
- Modify: apps/api/src/profile/profile-routes.ts
- Modify: apps/api/src/profile/profile-routes.test.ts

**Interfaces:**
- Produces: calculateProfileCompleteness(facts: ProfileFact[]): ProfileCompleteness。
- Adds: ProfileRepository.upsertUserFact(input: ProfileFactUpsertInput): ProfileFact。
- Adds: POST /api/profile/facts and GET /api/profile/completeness。
- Preserves: PUT-like correction history, evidence and supersession behavior.

- [ ] **Step 1: Write the failing repository and completeness tests**

~~~ts
it("creates a user-corrected fact when a missing field is supplied", () => {
  const fact = repository.upsertUserFact({
    fieldPath: "preferences.targetCity",
    value: "深圳"
  });

  expect(fact).toMatchObject({
    fieldPath: "preferences.targetCity",
    value: "深圳",
    status: "user_corrected",
    scope: "profile"
  });
  expect(fact.evidence[0]).toMatchObject({ documentId: "user", extraction: "user" });
});

it("updates the reviewed semantic equivalent instead of creating a competing city fact", () => {
  const first = repository.upsertUserFact({ fieldPath: "preferences.targetCity", value: "深圳" });
  const second = repository.upsertUserFact({ fieldPath: "preferences.targetCity", value: "上海" });

  expect(second.id).toBe(first.id);
  expect(second.revision).toBe(2);
  expect(repository.listActive().filter((fact) => fact.fieldPath === "preferences.targetCity")).toHaveLength(1);
});

it("counts only confirmed or corrected profile facts as complete", () => {
  const result = calculateProfileCompleteness([
    extracted("basics.name", "陈同学"),
    confirmed("preferences.targetRole", "Java 后端开发实习")
  ]);
  expect(result.sections.find((section) => section.id === "preferences")).toMatchObject({
    completed: 1,
    missing: expect.arrayContaining(["preferences.targetCity"])
  });
});
~~~

- [ ] **Step 2: Run the focused tests and verify RED**

Run: rtk pnpm --filter @resume/api test -- profile-repository.test.ts profile-completeness.test.ts profile-routes.test.ts

Expected: FAIL because upsertUserFact, calculateProfileCompleteness and the routes are absent.

- [ ] **Step 3: Implement atomic user upsert and the completeness projection**

Add the repository method:

~~~ts
upsertUserFact(input) {
  const parsed = ProfileFactUpsertInputSchema.parse(input);
  const existing = findReviewedProfileFact(parsed.fieldPath);
  const evidence: Evidence[] = [{
    documentId: "user",
    page: 1,
    text: "用户补充：" + parsed.fieldPath,
    extraction: "user"
  }];
  return existing
    ? correct(existing.id, parsed.value, evidence)
    : insertUserCorrectedFact(parsed.fieldPath, parsed.value, evidence);
}
~~~

findReviewedProfileFact must search every semanticLookupPaths result, prefer user_corrected over user_confirmed, and return one deterministic record. insertUserCorrectedFact must use a UUID, confidence 1, scope profile, status user_corrected and revision 1; it must call supersedeReviewedAlternatives before returning.

calculateProfileCompleteness must:

1. Ignore application-scope and superseded facts.
2. Count a definition complete only if resolve-style lookup finds a user_confirmed or user_corrected value.
3. Treat repeated sections as complete per known entry rather than demanding an imaginary entry.
4. Return a stable section order from PROFILE_SECTION_DEFINITIONS.

Register these routes:

~~~ts
app.post("/api/profile/facts", async (request, reply) => {
  const body = ProfileFactUpsertInputSchema.safeParse(request.body);
  if (!body.success) return sendError(reply, 400, "Invalid request");
  return reply.code(200).send(ProfileFactSchema.parse(
    dependencies.profileRepository.upsertUserFact(body.data)
  ));
});

app.get("/api/profile/completeness", async (_request, reply) =>
  reply.code(200).send(ProfileCompletenessSchema.parse(
    calculateProfileCompleteness(dependencies.profileRepository.listActive())
  ))
);
~~~

- [ ] **Step 4: Add HTTP behavior tests**

~~~ts
const saved = await app.inject({
  method: "POST",
  url: "/api/profile/facts",
  payload: { fieldPath: "preferences.targetCity", value: "深圳" }
});
expect(saved.statusCode).toBe(200);

const completeness = await app.inject({ method: "GET", url: "/api/profile/completeness" });
expect(completeness.statusCode).toBe(200);
expect(completeness.json().sections).toEqual(expect.arrayContaining([
  expect.objectContaining({ id: "preferences" })
]));
~~~

- [ ] **Step 5: Run focused tests and record completion**

Run: rtk pnpm --filter @resume/api test -- profile-repository.test.ts profile-completeness.test.ts profile-routes.test.ts

Expected: PASS. Do not create a Git commit.

### Task 3: 浏览器客户端与应用任务列表 API

**Files:**
- Modify: apps/web/src/api/client.ts
- Modify: apps/web/src/api/client.test.ts
- Modify: apps/web/src/applications/api.ts
- Modify: apps/web/src/applications/api.test.ts

**Interfaces:**
- Adds: ProfileApi.upsert(fieldPath: string, value: unknown): Promise<ProfileFact>。
- Adds: ProfileApi.getCompleteness(): Promise<ProfileCompleteness>。
- Adds: ApplicationApi.list(): Promise<ApplicationTask[]>。

- [ ] **Step 1: Write failing client tests**

~~~ts
await createProfileApi().upsert("awards[0].level", "国家级");
expect(fetchMock).toHaveBeenCalledWith("/api/profile/facts", expect.objectContaining({
  method: "POST",
  body: JSON.stringify({ fieldPath: "awards[0].level", value: "国家级" })
}));

await expect(createProfileApi().getCompleteness()).resolves.toMatchObject({ completed: 2, total: 3 });

await expect(createApplicationApi().list()).resolves.toEqual([task]);
expect(fetchMock).toHaveBeenLastCalledWith("/api/applications", { method: "GET" });
~~~

- [ ] **Step 2: Run the focused tests and verify RED**

Run: rtk pnpm --filter @resume/web test -- client.test.ts applications/api.test.ts

Expected: FAIL because the client methods are not exposed.

- [ ] **Step 3: Implement schema-validated requests**

~~~ts
async upsert(fieldPath, value) {
  return ProfileFactSchema.parse(await readResponse(await fetch(baseUrl + "/api/profile/facts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ProfileFactUpsertInputSchema.parse({ fieldPath, value }))
  })));
},
async getCompleteness() {
  return ProfileCompletenessSchema.parse(await readResponse(
    await fetch(baseUrl + "/api/profile/completeness", { method: "GET" })
  ));
}
~~~

Use z.array(ApplicationTaskSchema) for ApplicationApi.list. Keep existing ApplicationApiError handling unchanged.

- [ ] **Step 4: Run focused tests and record completion**

Run: rtk pnpm --filter @resume/web test -- client.test.ts applications/api.test.ts

Expected: PASS. Do not create a Git commit.

### Task 4: 根路径统一工作区与兼容重定向

**Files:**
- Create: apps/web/src/workspace/ProfileApplicationWorkspace.tsx
- Create: apps/web/src/workspace/ProfileApplicationWorkspace.test.tsx
- Modify: apps/web/src/router.tsx
- Modify: apps/web/src/router.test.tsx
- Modify: apps/web/src/profile/ProfilePage.tsx
- Modify: apps/web/src/profile/ProfilePage.test.tsx
- Modify: apps/web/src/styles.css

**Interfaces:**
- Produces: ProfileApplicationWorkspace({ profileApi, applicationApi, healthApi, reviewApi, ragApi })。
- Consumes: URL query view = profile | apply | reviews。
- Preserves: ProfilePage data loading, PDF import, evidence drawer, self-evaluation review and RAG workspace.

- [ ] **Step 1: Write failing workspace and route tests**

~~~tsx
it("opens the candidate profile at the root and moves the URL to the apply view", async () => {
  render(<AppRouter applicationApi={applicationApi} />);
  expect(await screen.findByRole("heading", { name: "候选人档案" })).toBeVisible();

  await userEvent.setup().click(screen.getByRole("button", { name: "新建投递" }));
  expect(screen.getByRole("heading", { name: "新建投递" })).toBeVisible();
  expect(new URLSearchParams(window.location.search).get("view")).toBe("apply");
});

it("redirects the legacy creation route without rendering a second page shell", async () => {
  window.history.pushState({}, "", "/applications/new");
  render(<AppRouter applicationApi={applicationApi} />);
  expect(await screen.findByRole("heading", { name: "新建投递" })).toBeVisible();
  expect(window.location.pathname).toBe("/");
  expect(window.location.search).toBe("?view=apply");
});

it("falls back from an unknown view to profile", async () => {
  window.history.pushState({}, "", "/?view=unknown");
  render(<AppRouter applicationApi={applicationApi} />);
  expect(await screen.findByRole("heading", { name: "候选人档案" })).toBeVisible();
});
~~~

- [ ] **Step 2: Run the focused tests and verify RED**

Run: rtk pnpm --filter @resume/web test -- router.test.tsx workspace/ProfileApplicationWorkspace.test.tsx

Expected: FAIL because the workspace and view parsing do not exist.

- [ ] **Step 3: Implement one shared workspace shell**

Implement the route shape:

~~~tsx
<Route path="/" element={<WorkspaceRoute applicationApi={applicationApi} />} />
<Route path="/applications/new" element={<Navigate replace to="/?view=apply" />} />
<Route path="/applications/:taskId" element={<ApplicationTaskRoute api={applicationApi} />} />
~~~

WorkspaceRoute must render ProfileApplicationWorkspace and must not render NewApplicationPage. ProfileApplicationWorkspace must use URLSearchParams, permit only profile, apply and reviews, and navigate by replacing only the view query. ProfilePage gains an embedded mode that suppresses its outer app header while retaining PDF upload, fact editing, source evidence, self-evaluation review and RAG behavior.

The workspace shell uses the selected design: compact left navigation on desktop, horizontally scrollable navigation under 720px, low-saturation teal for confirmed state and amber for missing/review state. Reuse existing Lucide imports and CSS variables; do not add gradients or a second page-level card shell.

- [ ] **Step 4: Run component and responsive tests**

Run: rtk pnpm --filter @resume/web test -- router.test.tsx workspace/ProfileApplicationWorkspace.test.tsx profile/ProfilePage.test.tsx

Expected: PASS.

- [ ] **Step 5: Record completion without committing**

Run: rtk git diff --check

Expected: exit code 0. Do not create a Git commit.

### Task 5: 候选人完整长表单与独立获奖经历

**Files:**
- Create: apps/web/src/profile/CandidateProfileCenter.tsx
- Create: apps/web/src/profile/CandidateProfileCenter.test.tsx
- Create: apps/web/src/profile/RepeatedEntryEditor.tsx
- Create: apps/web/src/profile/RepeatedEntryEditor.test.tsx
- Modify: apps/web/src/profile/ProfilePage.tsx
- Modify: apps/web/src/styles.css

**Interfaces:**
- Produces: CandidateProfileCenter({ api, facts, completeness, onFactsChanged })。
- Produces: RepeatedEntryEditor({ section, entries, onSave })。
- Consumes: ProfileApi.upsert and ProfileApi.getCompleteness。
- Preserves: PDF provenance and FactEditor behavior for extracted facts.

- [ ] **Step 1: Write failing long-form tests**

~~~tsx
it("shows a missing preference where it can be added to the long form", async () => {
  render(<CandidateProfileCenter api={api} facts={[confirmed("basics.name", "陈同学")]} completeness={incompletePreferences} />);
  expect(screen.getByLabelText("期望工作地点")).toHaveValue("");
  expect(screen.getByText("缺失，可减少追问")).toBeVisible();
});

it("creates a separate award record with level and description", async () => {
  render(<CandidateProfileCenter api={api} facts={[]} completeness={emptyCompleteness} />);
  await user.click(screen.getByRole("button", { name: "新增获奖经历" }));
  await user.type(screen.getByLabelText("获奖名称"), "国家奖学金");
  await user.selectOptions(screen.getByLabelText("奖项级别"), "国家级");
  await user.click(screen.getByRole("button", { name: "保存获奖经历" }));

  expect(api.upsert).toHaveBeenCalledWith("awards[0].name", "国家奖学金");
  expect(api.upsert).toHaveBeenCalledWith("awards[0].level", "国家级");
});

it("keeps project highlights and work responsibilities as user-authored fields", async () => {
  render(<CandidateProfileCenter api={api} facts={projectAndWorkFacts} completeness={complete} />);
  expect(screen.getByLabelText("项目要点")).toHaveValue("负责缓存设计与压测");
  expect(screen.queryByRole("button", { name: /生成项目要点/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /生成实习描述/ })).not.toBeInTheDocument();
});
~~~

- [ ] **Step 2: Run the focused tests and verify RED**

Run: rtk pnpm --filter @resume/web test -- profile/CandidateProfileCenter.test.tsx profile/RepeatedEntryEditor.test.tsx

Expected: FAIL because the long-form components do not exist.

- [ ] **Step 3: Implement field grouping and stable repeated entries**

Build field groups from FIELD_DEFINITIONS, not from string literals duplicated in the UI. CandidateProfileCenter must render:

1. Basic information and preferences as scalar controls.
2. Education, work, projects, campus, awards, publications and certificates with RepeatedEntryEditor.
3. Awards in a dedicated section, with name, date, level and description controls.
4. Self evaluation as original text plus its existing review entry point, never as a silently rewritten value.

For a repeated root, derive displayed entry indexes from existing fact paths and add the smallest non-used nonnegative index. Save only changed leaf values:

~~~ts
const pending = fields
  .filter((field) => values[field.path] !== initial[field.path])
  .map((field) => api.upsert(field.path, values[field.path]));
await Promise.all(pending);
await onFactsChanged();
~~~

Use the expected project order name, start date, end date, description, technologies, highlights. Use the expected work order company, position, employment type, start date, end date, description. Do not coalesce separate projects, work entries, educations or awards.

- [ ] **Step 4: Add interaction and evidence coverage**

Extend ProfilePage tests to prove embedded mode still renders upload, confirmation and “查看来源” controls. Add tests that a user-created field exposes user evidence, while a PDF field still opens the existing EvidenceDrawer.

- [ ] **Step 5: Run focused tests and record completion**

Run: rtk pnpm --filter @resume/web test -- profile/CandidateProfileCenter.test.tsx profile/RepeatedEntryEditor.test.tsx profile/ProfilePage.test.tsx

Expected: PASS. Do not create a Git commit.

### Task 6: 同页新建投递与投递审核收件箱

**Files:**
- Create: apps/web/src/applications/ApplicationStartPanel.tsx
- Create: apps/web/src/applications/ApplicationStartPanel.test.tsx
- Create: apps/web/src/applications/ApplicationReviewInbox.tsx
- Create: apps/web/src/applications/ApplicationReviewInbox.test.tsx
- Modify: apps/web/src/workspace/ProfileApplicationWorkspace.tsx
- Modify: apps/web/src/applications/api.ts
- Modify: apps/web/src/applications/api.test.ts
- Modify: apps/web/src/styles.css

**Interfaces:**
- Produces: ApplicationStartPanel({ profileCompleteness, applicationApi, onTaskCreated })。
- Produces: ApplicationReviewInbox({ tasks, onOpenTask })。
- Consumes: ApplicationApi.create and ApplicationApi.list。

- [ ] **Step 1: Write failing start-panel and review-inbox tests**

~~~tsx
it("shows relevant missing profile fields before creating a task", async () => {
  render(<ApplicationStartPanel profileCompleteness={missingPreferences} applicationApi={api} onTaskCreated={onTaskCreated} />);
  expect(screen.getByText("期望工作地点")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "补全档案" }));
  expect(onViewChange).toHaveBeenCalledWith("profile");
});

it("creates one task and navigates to its real-time task page", async () => {
  api.create.mockResolvedValue(task);
  render(<ApplicationStartPanel profileCompleteness={complete} applicationApi={api} onTaskCreated={onTaskCreated} />);
  await user.type(screen.getByLabelText("投递官网链接"), task.applicationUrl);
  await user.click(screen.getByRole("button", { name: "开始识别并填写" }));
  expect(onTaskCreated).toHaveBeenCalledWith(task.id);
});

it("lists only tasks that need a user decision", async () => {
  render(<ApplicationReviewInbox tasks={[reviewLockedTask, fillingTask, questionTask]} onOpenTask={onOpenTask} />);
  expect(screen.getByText(reviewLockedTask.applicationUrl)).toBeVisible();
  expect(screen.getByText(questionTask.applicationUrl)).toBeVisible();
  expect(screen.queryByText(fillingTask.applicationUrl)).not.toBeInTheDocument();
});
~~~

- [ ] **Step 2: Run the focused tests and verify RED**

Run: rtk pnpm --filter @resume/web test -- applications/ApplicationStartPanel.test.tsx applications/ApplicationReviewInbox.test.tsx

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement the two workspace views**

ApplicationStartPanel must show the profile completeness summary and its missing field labels before the URL input. It must retain NewApplicationPage validation and browser_task_in_use recovery behavior exactly, then call onTaskCreated and navigate to /applications/:taskId.

ApplicationReviewInbox must call ApplicationApi.list when its view becomes active and render only needs_questions, awaiting_content_review, review_locked, failed and waiting_for_login tasks. It must use each task host as the visible title, state-specific Chinese copy, and a single “进入任务” action. It must never render a submit control.

Move the existing NewApplicationPage form behavior into ApplicationStartPanel, then delete the unused page only after router and component tests prove no imports remain.

- [ ] **Step 4: Run focused tests and record completion**

Run: rtk pnpm --filter @resume/web test -- applications/ApplicationStartPanel.test.tsx applications/ApplicationReviewInbox.test.tsx router.test.tsx

Expected: PASS. Do not create a Git commit.

### Task 7: 补档案后的增量任务恢复与端到端回归

**Files:**
- Modify: packages/contracts/src/application.ts
- Modify: packages/contracts/src/application.test.ts
- Modify: apps/api/src/applications/application-machine.ts
- Modify: apps/api/src/applications/application-machine.test.ts
- Modify: apps/api/src/applications/application-service.ts
- Modify: apps/api/src/applications/routes.ts
- Modify: apps/api/src/applications/routes.test.ts
- Modify: apps/web/src/applications/ApplicationTaskPage.tsx
- Modify: apps/web/src/applications/ApplicationTaskPage.test.tsx
- Create: tests/browser/profile-completion-retry.spec.ts
- Modify: apps/synthetic-ats/

**Interfaces:**
- Adds: ApplicationCommand type resume_with_profile.
- Adds: ApplicationService.resumeWithProfile(taskId: string): Promise<void>.
- Adds: PROFILE_UPDATED state-machine event from needs_questions to observing.
- Preserves: no terminal submission command and all browser action-policy checks.

- [ ] **Step 1: Write failing state, route and E2E tests**

~~~ts
it("returns from a missing-profile question to observing without writing an answer", () => {
  const actor = createActor(applicationMachine, { input }).start();
  sendApplicationEvent(actor, { type: "START" });
  sendApplicationEvent(actor, { type: "QUESTIONS_REQUIRED", questions: [missingCityQuestion] });
  sendApplicationEvent(actor, { type: "PROFILE_UPDATED" });
  expect(actor.getSnapshot().value).toBe("observing");
  expect(actor.getSnapshot().context.questions).toEqual([]);
});

it("allows resume_with_profile only while questions are waiting", async () => {
  await expect(command(taskId, { type: "resume_with_profile" })).resolves.toMatchObject({ state: "observing_page" });
  await expect(command(reviewTaskId, { type: "resume_with_profile" })).rejects.toMatchObject({ statusCode: 409 });
});
~~~

The Playwright test must create a synthetic form with name already filled, city empty and a terminal submit button. It must add preferences.targetCity through the profile API, resume the task, assert city becomes filled, assert name remains unchanged, and assert the fixture submission counter remains 0.

- [ ] **Step 2: Run focused tests and verify RED**

Run: rtk pnpm --filter @resume/api test -- applications/application-machine.test.ts applications/routes.test.ts

Run: rtk playwright test tests/browser/profile-completion-retry.spec.ts

Expected: FAIL because PROFILE_UPDATED and resume_with_profile are unavailable.

- [ ] **Step 3: Implement guarded profile-based resumption**

Add the command contract:

~~~ts
z.object({ type: z.literal("resume_with_profile") }).strict()
~~~

Add the state transition:

~~~ts
needs_questions: {
  on: {
    ANSWERS_PROVIDED: { target: "observing", actions: "clearQuestions" },
    PROFILE_UPDATED: { target: "observing", actions: "clearQuestions" }
  }
}
~~~

ApplicationService.resumeWithProfile must require that the current state is needs_questions, send PROFILE_UPDATED, observe the current browser page and call runUntilPause with that snapshot. It must not write application answers, must not issue a browser command before a fresh observation, and relies on the existing currentValue checks so already-filled fields are skipped.

Expose it from the route command switch and only include resume_with_profile in commandsForState for needs_questions. In ApplicationTaskPage, show the action as “我已补全档案，重新匹配” only when this typed command exists. The action is a task retry, not a submission.

- [ ] **Step 4: Run focused and full verification**

Run: rtk pnpm --filter @resume/api test -- applications/application-machine.test.ts applications/routes.test.ts

Run: rtk pnpm --filter @resume/web test -- applications/ApplicationTaskPage.test.tsx

Run: rtk playwright test tests/browser/profile-completion-retry.spec.ts tests/browser/mokahr-high-coverage.spec.ts tests/browser/cascaded-semantic-autofill.spec.ts

Expected: PASS and submission counters remain 0.

- [ ] **Step 5: Run repository-wide verification and record completion**

Run: rtk pnpm typecheck

Run: rtk pnpm test

Run: rtk pnpm test:e2e

Run: rtk git diff --check

Expected: all commands exit with code 0. Do not create a Git commit.

## Plan Self-Review

### Spec coverage

- 统一根路径与兼容跳转：Task 4。
- 完整档案、独立获奖经历、用户补充和完整度：Tasks 1、2、5。
- 同页创建投递和投递审核收件箱：Tasks 3、6。
- 精确优先、语义兜底与补全后的增量恢复：Task 7，且复用既有两阶段编排。
- 本地资料优先、无自动提交与不覆盖官网已有值：全局约束及 Task 7。
- 响应式视觉与证据保留：Tasks 4、5、6。

### 一致性检查

- 前端和后端使用相同的 ProfileFactUpsertInput、ProfileCompleteness 和 resume_with_profile 名称。
- 任务恢复从 needs_questions 进入 observing，不绕过现有 ApplicationService.runUntilPause、页面观察或浏览器安全策略。
- 所有新用户资料经 ProfileRepository 进入既有 revision、evidence 和 supersession 机制。

### 范围检查

该计划按七个独立验收任务逐步交付；Task 7 只增加“已补档案后重新观察”的入口，不重新实现现有确定性和语义映射引擎。
