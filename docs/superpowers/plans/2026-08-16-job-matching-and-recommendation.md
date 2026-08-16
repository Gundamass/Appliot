# 岗位匹配与推荐实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立独立、持久化且可恢复的 `JobMatchSession`，从 Moka/Mokahr 中文岗位页和 DJI 招聘路径读取筛选后的全部岗位，生成可解释推荐，并只在用户确认后创建待审阅 `ApplicationTask`。

**Architecture:** `packages/job-matching` 承载纯领域规则、Adapter 和确定性评分，`apps/api/src/job-matching` 承载持久化、状态编排、检索边界和 HTTP API，Browser Worker 只通过有限结构化快照执行页面观察与筛选。岗位匹配与投递共享全局浏览器租约，但不进入 `ApplicationService`；两条流程只在幂等转换为待审阅投递任务时相接。

**Tech Stack:** TypeScript 5.8、Zod、Vitest、Fastify、XState、React、Playwright、better-sqlite3、Drizzle ORM、pnpm 10。

## Global Constraints

- 首期正式支持仅限 Moka/Mokahr 中文岗位页面和 DJI 招聘路径。
- 当前工作区保留所有已有修改，不创建 worktree，不委派子任务，不提交 commit；每个任务结束只做限定路径的 `git diff` 审阅。
- 每项功能严格 TDD：先写失败测试并确认预期失败，再写最小实现，最后运行 owning tests。
- 所有 Shell 命令使用 `rtk` 前缀；手工编辑使用 `apply_patch`。
- 不读取 `.env.local`、真实数据库、简历文件、浏览器配置或隐私日志；测试只使用脱敏固定夹具和临时数据库。
- 岗位发现、提取、匹配和选岗不得进入 `ApplicationService`。
- 仅双方信息明确且互斥时产生 `conflict`；信息不足必须为 `unknown`，并继续参与正常排序但降低置信度。
- 冲突岗位只进入“最接近但有冲突”列表，必须二次确认；未知岗位不得被淘汰。
- 评分版本固定为 `job-match-v1`；DeepSeek 不得修改分数、排名、列表归属或硬冲突。
- Embedding 故障时只降级规则和 Trigram，DeepSeek 调用次数必须为 0。
- 单次读取预算固定上限为 100 页、15 分钟、2,000 个新增唯一岗位；连续 2 页无新增时正常停止。
- 只读导航/提取最多“初始请求 + 1 次重试”；筛选写入、选岗和转换不盲目重试。
- Browser Snapshot、事件和 trace 不包含原始 DOM、selector、完整岗位正文、完整档案、提示正文或认证信息。
- 用户选岗前不得创建 `ApplicationTask`；转换只创建待审阅任务。
- ActionPolicy 与 Browser Worker 的最终提交双重禁止保持不变；所有 ATS 验收均断言 `submissionCount === 0`。

## File Structure

- `packages/contracts/src/job-matching.ts`: JobMatch API、领域 DTO、Browser Job Snapshot 和 mutation guard 的 Zod 契约。
- `packages/job-matching/src/machine.ts`: 纯 `JobMatchSession` 状态迁移及非法迁移拒绝。
- `packages/job-matching/src/adapters/`: Moka 与 DJI 的版本化入口识别、筛选映射、列表和详情提取。
- `packages/job-matching/src/scoring-v1.ts`: 三态评估、固定权重、确定性分数和稳定排序。
- `packages/job-matching/src/advisory.ts`: 健康召回后的 Top-3 DeepSeek 咨询校验边界。
- `apps/api/src/job-matching/job-match-repository.ts`: 会话、快照、岗位、结果、游标、事件和幂等操作的事务仓储。
- `apps/api/src/job-matching/browser-lease.ts`: 岗位匹配与投递共享的单所有者浏览器租约。
- `apps/api/src/job-matching/extraction-coordinator.ts`: 分页去重、预算、逐页保存、重试和恢复。
- `apps/api/src/job-matching/match-coordinator.ts`: 档案证据召回、确定性评分、降级和咨询编排。
- `apps/api/src/job-matching/job-match-service.ts`: 状态、浏览器、仓储和 `ApplicationTask` 转换的应用服务。
- `apps/api/src/job-matching/routes.ts`: `/job-match-sessions` 资源路由和稳定错误映射。
- `apps/api/src/observability/job-match-trace.ts`: 仅记录哈希、阶段、计数、耗时和稳定错误码的脱敏 TraceSink。
- `apps/web/src/job-matching/`: API client、轮询 hook 和三段式岗位匹配工作台。
- `apps/synthetic-ats/public/job-list.html`: 可分页、可筛选、可挑战且记录提交次数的脱敏 ATS 夹具。
- `tests/browser/job-matching.spec.ts`: 列表、详情、直达表单、恢复、冲突确认和零提交 E2E。

---

### Task 1: 岗位匹配公共契约

**Files:**
- Create: `packages/contracts/src/job-matching.ts`
- Create: `packages/contracts/src/job-matching.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Produces: `JobMatchSessionStateSchema`，包含规格中的 15 个正常、辅助和终止状态。
- Produces: `JobExpectationSnapshotSchema`、`JobPostingSchema`、`JobRequirementSchema`、`JobMatchResultSchema`。
- Produces: `JobPageSnapshotSchema`、`FilterPlanSchema`、`ExtractedJobPageSchema`、`JobPostingDraftSchema`。
- Produces: `JobMatchMutationGuardSchema` 以及选岗、冲突选岗、转换请求 schema。

- [ ] **Step 1: 写失败契约测试**

```ts
expect(JobMatchSessionStateSchema.parse("awaiting_job_selection")).toBe("awaiting_job_selection");
expect(RequirementOutcomeSchema.parse("unknown")).toBe("unknown");
expect(() => JobPageSnapshotSchema.parse({ ...validSnapshot, rawDom: "<html>" })).toThrow();
expect(() => JobMatchMutationGuardSchema.parse({ sessionVersion: 1, idempotencyKey: "" })).toThrow();
expect(JobMatchResultSchema.parse(validResult).scoringVersion).toBe("job-match-v1");
```

- [ ] **Step 2: 确认测试因导出不存在而失败**

Run: `rtk pnpm --filter @resume/contracts test -- job-matching.test.ts`  
Expected: FAIL，提示 `job-matching.js` 或目标 schema 未定义。

- [ ] **Step 3: 实现严格 Zod 契约并统一导出**

```ts
export const RequirementOutcomeSchema = z.enum(["satisfied", "conflict", "unknown"]);
export const JobEntryKindSchema = z.enum(["job_list", "job_detail", "application_form"]);
export const JobMatchMutationGuardSchema = z.object({
  sessionVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1).max(128)
}).strict();
export const ScoringVersionSchema = z.literal("job-match-v1");
```

所有对象使用 `.strict()`；证据片段设置有限长度；Browser 快照只允许页面种类、脱敏文本字段、筛选回读、分页和有限挑战诊断。将全部 schema 与推导类型从 `index.ts` 导出。

- [ ] **Step 4: 运行 owning tests 并审阅差异**

Run: `rtk pnpm --filter @resume/contracts test -- job-matching.test.ts`  
Expected: PASS。  
Review: `rtk git diff -- packages/contracts/src/job-matching.ts packages/contracts/src/job-matching.test.ts packages/contracts/src/index.ts`

---

### Task 2: 数据库迁移与持久化 schema

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/db/migrate.ts`
- Modify: `apps/api/src/db/migrate.test.ts`

**Interfaces:**
- Produces: `job_match_sessions`、`job_match_expectation_snapshots`、`job_postings`、`job_match_results`、`job_extraction_cursors`、`job_match_events`。
- Produces: 选岗/转换幂等键唯一约束、岗位身份与内容版本索引、`session_id + sequence` 事件唯一约束。

- [ ] **Step 1: 写失败迁移测试**

```ts
expect(tableNames(db)).toEqual(expect.arrayContaining([
  "job_match_sessions", "job_match_expectation_snapshots", "job_postings",
  "job_match_results", "job_extraction_cursors", "job_match_events"
]));
expect(indexNames(db)).toContain("job_match_results_identity_unique");
expect(foreignKeys(db, "job_match_results")).toContainEqual(expect.objectContaining({ table: "job_match_sessions" }));
```

- [ ] **Step 2: 确认迁移测试失败**

Run: `rtk pnpm --filter @resume/api test -- src/db/migrate.test.ts`  
Expected: FAIL，缺少 `job_match_sessions`。

- [ ] **Step 3: 添加幂等迁移和 Drizzle 表定义**

迁移列必须保存 `version`、`state`、`entry_kind`、依赖 revision、选中结果/岗位哈希/冲突摘要、`application_task_id`、游标预算和 JSON 结构化载荷；所有 JSON 读取由 Task 1 schema 校验。更新迁移版本时保持现有旧库升级路径，不删除或重建用户表。

- [ ] **Step 4: 验证新库与重复迁移**

Run: `rtk pnpm --filter @resume/api test -- src/db/migrate.test.ts`  
Expected: PASS，包括对同一临时数据库连续运行两次迁移。  
Review: `rtk git diff -- apps/api/src/db/schema.ts apps/api/src/db/migrate.ts apps/api/src/db/migrate.test.ts`

---

### Task 3: 事务仓储、乐观并发与幂等

**Files:**
- Create: `apps/api/src/job-matching/job-match-repository.ts`
- Create: `apps/api/src/job-matching/job-match-repository.test.ts`

**Interfaces:**
- Produces: `JobMatchRepository.create(input)`、`get(sessionId)`、`mutate(sessionId, expectedVersion, mutation)`。
- Produces: `saveExtractionPage(...)`，原子保存去重岗位、事件和下一游标。
- Produces: `saveResults(...)`、`markResultsStale(...)`、`rememberIdempotentResult(...)`。
- Throws: 稳定代码 `job_match_version_conflict`、`job_match_session_not_found`。

- [ ] **Step 1: 写失败仓储测试**

```ts
const created = repository.create(seedSession);
expect(repository.mutate(created.id, 0, draft => ({ ...draft, state: "opening_job_page" })).version).toBe(1);
expect(() => repository.mutate(created.id, 0, draft => draft)).toThrow("job_match_version_conflict");
repository.saveExtractionPage(created.id, pageOne);
repository.saveExtractionPage(created.id, pageOne);
expect(repository.get(created.id).postings).toHaveLength(pageOne.postings.length);
expect(repository.get(created.id).events.filter(e => e.idempotencyKey === "page-1")).toHaveLength(1);
```

- [ ] **Step 2: 确认测试失败**

Run: `rtk pnpm --filter @resume/api test -- src/job-matching/job-match-repository.test.ts`  
Expected: FAIL，模块不存在。

- [ ] **Step 3: 用单个 SQLite transaction 实现写入**

`mutate` 使用 `UPDATE ... WHERE id = ? AND version = ?` 并检查 changes；`saveExtractionPage` 以来源岗位 ID 优先、规范 URL 次之去重，同身份新 `contentHash` 写新岗位版本；事件仅保存允许字段。所有读出 JSON 均经 contracts schema 解析。

- [ ] **Step 4: 验证重启恢复、并发和幂等**

Run: `rtk pnpm --filter @resume/api test -- src/job-matching/job-match-repository.test.ts`  
Expected: PASS，包括关闭并重开同一临时数据库后结果、游标和事件不重复。  
Review: `rtk git diff -- apps/api/src/job-matching/job-match-repository.ts apps/api/src/job-matching/job-match-repository.test.ts`

---

### Task 4: JobMatchSession 状态机

**Files:**
- Create: `packages/job-matching/package.json`
- Create: `packages/job-matching/src/index.ts`
- Create: `packages/job-matching/src/machine.ts`
- Create: `packages/job-matching/src/machine.test.ts`

**Interfaces:**
- Produces: `createJobMatchMachine(input)`、`sendJobMatchEvent(actor, event)`。
- Produces: 正常流、列表/详情分支、暂停、登录、Challenge、取消、失败、过期和转换迁移。

- [ ] **Step 1: 用表驱动测试写出全部合法与非法迁移**

```ts
expect(transition("created", { type: "ENTRY_IDENTIFIED", entryKind: "job_list" })).toBe("awaiting_filter_confirmation");
expect(transition("created", { type: "ENTRY_IDENTIFIED", entryKind: "job_detail" })).toBe("opening_job_page");
expect(() => transition("created", { type: "SELECT", resultId: "r1" })).toThrow(/不允许/);
expect(transition("extracting_jobs", { type: "BUDGET_EXHAUSTED", reason: "page_limit" })).toBe("paused");
expect(transition("selected", { type: "APPLICATION_CONVERTED", taskId: "a1" })).toBe("converted_to_application");
```

- [ ] **Step 2: 确认状态测试失败**

Run: `rtk pnpm --filter @resume/job-matching test -- machine.test.ts`  
Expected: FAIL，包或 machine 不存在。

- [ ] **Step 3: 实现最小 XState 状态机**

恢复事件只能从 `awaiting_login`、`awaiting_challenge` 和 `paused` 回到新的观察流程；暂停、Challenge、取消和终态通过 action 清除 lease/epoch 上下文。`application_form` 返回显式 redirect outcome，不伪造匹配会话。

- [ ] **Step 4: 运行状态机测试**

Run: `rtk pnpm --filter @resume/job-matching test -- machine.test.ts`  
Expected: PASS。  
Review: `rtk git diff -- packages/job-matching`

---

### Task 5: Browser Job Snapshot 与 IPC

**Files:**
- Modify: `packages/contracts/src/browser.ts`
- Modify: `packages/contracts/src/browser.test.ts`
- Modify: `apps/api/src/browser/worker-client.ts`
- Modify: `apps/api/src/browser/worker-client.test.ts`
- Modify: `apps/browser-worker/src/ipc-server.ts`
- Modify: `apps/browser-worker/src/ipc-server.test.ts`
- Modify: `apps/browser-worker/src/session-manager.ts`
- Modify: `apps/browser-worker/src/session-manager.test.ts`
- Create: `apps/browser-worker/src/job-observer.ts`
- Create: `apps/browser-worker/src/job-observer.test.ts`

**Interfaces:**
- Adds Worker requests: `capture_job_snapshot`、`apply_job_filters`、`advance_job_page`。
- Adds Worker responses: `job_snapshot`、`job_filter_result`、`job_page_advanced`。
- Produces client methods: `observeJob(ownerId)`、`applyJobFilters(ownerId, plan, epoch)`、`advanceJobPage(ownerId, cursor, epoch)`。

- [ ] **Step 1: 写严格协议和脱敏观察失败测试**

```ts
expect(WorkerRequestSchema.parse({ type: "capture_job_snapshot", ownerId: "jm-1" })).toBeTruthy();
expect(() => JobPageSnapshotSchema.parse({ ...snapshot, selectors: ["#submit"] })).toThrow();
expect(await client.observeJob("jm-1")).toEqual(snapshot);
```

- [ ] **Step 2: 确认 contracts、client 和 worker tests 失败**

Run: `rtk pnpm --filter @resume/contracts test -- browser.test.ts`  
Run: `rtk pnpm --filter @resume/api test -- src/browser/worker-client.test.ts`  
Run: `rtk pnpm --filter @resume/browser-worker test -- job-observer.test.ts ipc-server.test.ts session-manager.test.ts`  
Expected: FAIL，缺少岗位协议分支。

- [ ] **Step 3: 实现有限快照与筛选稳定回读**

`job-observer.ts` 只输出 Adapter 所需可见文本、规范 URL、有限岗位卡片、分页和挑战诊断；筛选操作按 execution epoch 授权，写后重新观察并返回结构化 filter state。iframe/Shadow DOM 未支持边界返回 challenge，不解释为空列表。

- [ ] **Step 4: 运行 owning tests**

Run: `rtk pnpm --filter @resume/contracts test -- browser.test.ts`  
Run: `rtk pnpm --filter @resume/api test -- src/browser/worker-client.test.ts`  
Run: `rtk pnpm --filter @resume/browser-worker test -- job-observer.test.ts ipc-server.test.ts session-manager.test.ts`  
Expected: 全部 PASS。  
Review: `rtk git diff -- packages/contracts/src/browser.ts apps/api/src/browser apps/browser-worker/src`

---

### Task 6: 全局浏览器租约

**Files:**
- Create: `apps/api/src/browser/browser-ownership-lease.ts`
- Create: `apps/api/src/browser/browser-ownership-lease.test.ts`
- Modify: `apps/api/src/applications/application-service.ts`
- Modify: `apps/api/src/applications/application-machine.test.ts`
- Modify: `apps/api/src/production-dependencies.ts`
- Modify: `apps/api/src/production-dependencies.test.ts`

**Interfaces:**
- Produces: `BrowserOwnershipLease.acquire({ ownerKind, ownerId })`、`assertOwner(...)`、`release(...)`、`current()`。
- Owner type: `{ ownerKind: "job_match" | "application"; ownerId: string; executionEpoch: number }`。
- Throws: `browser_lease_in_use`；lease transfer increments epoch and invalidates prior Worker execution.

- [ ] **Step 1: 写竞争、释放和 epoch 失效测试**

```ts
lease.acquire({ ownerKind: "job_match", ownerId: "jm-1" });
expect(() => lease.acquire({ ownerKind: "application", ownerId: "app-1" })).toThrow("browser_lease_in_use");
lease.release({ ownerKind: "job_match", ownerId: "jm-1" });
expect(lease.acquire({ ownerKind: "application", ownerId: "app-1" }).executionEpoch).toBe(2);
```

- [ ] **Step 2: 确认测试失败**

Run: `rtk pnpm --filter @resume/api test -- src/browser/browser-ownership-lease.test.ts src/applications/application-machine.test.ts src/production-dependencies.test.ts`  
Expected: FAIL，尚无共享租约且投递仍使用内部单任务变量。

- [ ] **Step 3: 注入共享租约并保持投递行为不变**

用租约替换 `ApplicationService` 内部 `activeBrowserTaskId` 所有权判断；在取消、`review_locked`、失败和释放任务时归还租约。`createProductionDependencies` 创建一个实例，同时注入 application 与后续 job-match service。

- [ ] **Step 4: 运行租约与现有投递回归**

Run: `rtk pnpm --filter @resume/api test -- src/browser/browser-ownership-lease.test.ts src/applications/application-machine.test.ts src/applications/routes.test.ts src/production-dependencies.test.ts`  
Expected: PASS，现有 `browser_task_in_use` 对外语义保持兼容。  
Review: `rtk git diff -- apps/api/src/browser/browser-ownership-lease.ts apps/api/src/applications/application-service.ts apps/api/src/production-dependencies.ts`

---

### Task 7: Moka 与 DJI Job Adapter

**Files:**
- Create: `packages/job-matching/src/adapters/types.ts`
- Create: `packages/job-matching/src/adapters/moka-job-adapter.ts`
- Create: `packages/job-matching/src/adapters/moka-job-adapter.test.ts`
- Create: `packages/job-matching/src/adapters/dji-job-adapter.ts`
- Create: `packages/job-matching/src/adapters/dji-job-adapter.test.ts`
- Create: `packages/job-matching/src/adapters/fixtures.ts`
- Modify: `packages/job-matching/src/index.ts`

**Interfaces:**
- Produces exact `JobAdapter` interface from the approved spec.
- Adapter versions: `moka-job-v1` and `dji-job-v1`.
- Throws: `unsupported_job_entry` and `job_adapter_contract_mismatch` only at explicit boundaries.

- [ ] **Step 1: 写列表、详情、表单、登录、挑战和漂移夹具测试**

```ts
expect(moka.identify(mokaList)).toBe("job_list");
expect(dji.identify(djiDetail)).toBe("job_detail");
expect(moka.identify(mokaApplication)).toBe("application_form");
expect(moka.mapFilters(expectation).localOnly).toContainEqual(expect.objectContaining({ kind: "salary" }));
expect(() => moka.extractList(contractDrift)).toThrow("job_adapter_contract_mismatch");
```

- [ ] **Step 2: 确认 Adapter tests 失败**

Run: `rtk pnpm --filter @resume/job-matching test -- adapters`  
Expected: FAIL，Adapter 不存在。

- [ ] **Step 3: 实现确定性 Adapter**

岗位 `contentHash` 覆盖标题、组织、地点、雇佣类型、描述和归一化要求；`sourceEvidence` 截断到契约上限。无法稳定映射的网站条件放入 `localOnly`，不得从缺失字段猜测入口或要求。

- [ ] **Step 4: 运行 Adapter tests**

Run: `rtk pnpm --filter @resume/job-matching test -- adapters`  
Expected: PASS。  
Review: `rtk git diff -- packages/job-matching/src/adapters`

---

### Task 8: 筛选确认与分页提取协调器

**Files:**
- Create: `apps/api/src/job-matching/extraction-coordinator.ts`
- Create: `apps/api/src/job-matching/extraction-coordinator.test.ts`

**Interfaces:**
- Produces: `confirmFilters(sessionId, snapshot, guard)`；确认前绝不调用 Browser 写操作。
- Produces: `runExtraction(sessionId, budget = DEFAULT_EXTRACTION_BUDGET)`。
- Constants: `{ maxPages: 100, maxDurationMs: 900_000, maxNewJobs: 2_000, maxConsecutiveNoNewPages: 2, readAttempts: 2 }`。

- [ ] **Step 1: 写预算、重试、去重和恢复失败测试**

```ts
expect(browser.applyJobFilters).not.toHaveBeenCalled();
await coordinator.confirmFilters(id, editedExpectation, guard);
expect(browser.applyJobFilters).toHaveBeenCalledTimes(1);
expect(await runWithPages([pageA, pageA])).toMatchObject({ stopReason: "no_new_jobs", pagesRead: 2 });
expect(await runWithBudget({ maxPages: 1 })).toMatchObject({ state: "paused", stopReason: "page_limit" });
expect(browser.advanceJobPage).toHaveBeenCalledTimes(2); // initial + one retry only
```

- [ ] **Step 2: 确认测试失败**

Run: `rtk pnpm --filter @resume/api test -- src/job-matching/extraction-coordinator.test.ts`  
Expected: FAIL，协调器不存在。

- [ ] **Step 3: 实现逐页事务保存和新预算恢复**

每页先提取、按 `sourceJobId`/规范 URL 去重，再调用 `saveExtractionPage` 原子保存岗位、事件、累计值和下一游标。达到任一阈值进入 `paused`；用户继续时从持久化游标启动全新同等预算，历史岗位不计为新增。筛选回读不一致直接失败且不重试。

- [ ] **Step 4: 运行提取测试**

Run: `rtk pnpm --filter @resume/api test -- src/job-matching/extraction-coordinator.test.ts src/job-matching/job-match-repository.test.ts`  
Expected: PASS，包括进程重建后从下一游标继续。  
Review: `rtk git diff -- apps/api/src/job-matching/extraction-coordinator.ts apps/api/src/job-matching/extraction-coordinator.test.ts`

---

### Task 9: 三态判断与 job-match-v1 评分

**Files:**
- Create: `packages/job-matching/src/scoring-v1.ts`
- Create: `packages/job-matching/src/scoring-v1.test.ts`
- Modify: `packages/job-matching/src/index.ts`

**Interfaces:**
- Produces: `assessRequirement(requirement, evidence, expectation): RequirementAssessment`。
- Produces: `scoreJobMatch(input): JobMatchResultDraft`、`sortJobMatches(results)`。
- Constants: dimensions `35/25/20/10/10` and evidence qualities `1.0/0.8/0.6/0`。

- [ ] **Step 1: 用固定数值夹具写失败测试**

```ts
expect(assessRequirement(explicitMismatch, confirmedEvidence, expectation).outcome).toBe("conflict");
expect(assessRequirement(requiredDegree, [], expectation).outcome).toBe("unknown");
expect(scoreJobMatch(fixture)).toMatchObject({ fitScore: 75, confidence: 65.5, rankingScore: 68.53 });
expect(sortJobMatches(tied).map(item => item.canonicalUrl)).toEqual(["https://a.example", "https://b.example"]);
```

- [ ] **Step 2: 确认评分测试失败**

Run: `rtk pnpm --filter @resume/job-matching test -- scoring-v1.test.ts`  
Expected: FAIL，评分实现不存在。

- [ ] **Step 3: 实现固定公式**

只为岗位实际出现维度重新归一化权重，同维度要求均分；三态分为 `1/0/0.5`。按规格计算 `knownCoverage`、最佳合法证据质量、`fitScore`、`confidence`、`rankingScore` 并四舍五入两位。正常与冲突列表分别排序，稳定 tie-break 为 ranking、fit、confidence 降序和 canonical URL 升序。

- [ ] **Step 4: 运行评分测试**

Run: `rtk pnpm --filter @resume/job-matching test -- scoring-v1.test.ts`  
Expected: PASS，并对同一输入循环 100 次得到逐字节相同结果。  
Review: `rtk git diff -- packages/job-matching/src/scoring-v1.ts packages/job-matching/src/scoring-v1.test.ts`

---

### Task 10: 混合召回与 DeepSeek 咨询边界

**Files:**
- Create: `apps/api/src/job-matching/match-coordinator.ts`
- Create: `apps/api/src/job-matching/match-coordinator.test.ts`
- Create: `packages/job-matching/src/advisory.ts`
- Create: `packages/job-matching/src/advisory.test.ts`
- Modify: `packages/job-matching/src/index.ts`

**Interfaces:**
- Consumes: 现有 Trigram、`fact-embedding-search` 和受控 model provider。
- Produces: `MatchCoordinator.match(sessionId, postings)`。
- Produces: `validateAdvisory(requirement, top3EvidenceIds, response)`；越界统一返回 `unknown`。

- [ ] **Step 1: 写健康、降级和越界失败测试**

```ts
expect(advisor).toHaveBeenCalledWith(expect.objectContaining({ evidence: expect.any(Array) }));
expect(advisor.mock.calls[0][0].evidence).toHaveLength(3);
embedding.reject(new Error("offline"));
await coordinator.match(sessionId, postings);
expect(advisor).not.toHaveBeenCalled();
expect(validateAdvisory(req, ["e1", "e2"], { outcome: "satisfied", confidence: .95, evidenceIds: ["e9"] }).outcome).toBe("unknown");
```

- [ ] **Step 2: 确认测试失败**

Run: `rtk pnpm --filter @resume/job-matching test -- advisory.test.ts`  
Run: `rtk pnpm --filter @resume/api test -- src/job-matching/match-coordinator.test.ts`  
Expected: FAIL，咨询和协调器不存在。

- [ ] **Step 3: 实现受限召回和只读咨询**

只把单个结构化要求、最多 Top-3 不透明证据 ID 和必要类别交给 advisor；`confidence < 0.9`、格式错误、越界 ID 和异常均为 `unknown` advisory。先持久化确定性分数，再附加咨询说明，断言 advisory 不进入评分函数输入。

- [ ] **Step 4: 运行匹配测试**

Run: `rtk pnpm --filter @resume/job-matching test -- scoring-v1.test.ts advisory.test.ts`  
Run: `rtk pnpm --filter @resume/api test -- src/job-matching/match-coordinator.test.ts src/rag/fact-embedding-search.test.ts`  
Expected: PASS。  
Review: `rtk git diff -- packages/job-matching/src apps/api/src/job-matching/match-coordinator.ts`

---

### Task 11: JobMatchService、选岗与投递转换

**Files:**
- Create: `apps/api/src/job-matching/job-match-service.ts`
- Create: `apps/api/src/job-matching/job-match-service.test.ts`
- Create: `apps/api/src/observability/job-match-trace.ts`
- Create: `apps/api/src/observability/job-match-trace.test.ts`
- Modify: `apps/api/src/applications/application-task-repository.ts`
- Modify: `apps/api/src/applications/application-task-repository.test.ts`
- Modify: `apps/api/src/production-dependencies.ts`
- Modify: `apps/api/src/production-dependencies.test.ts`

**Interfaces:**
- Produces: create/get/confirmFilters/pause/resume/continueExtraction/rematch/select/selectConflict/convert/cancel。
- Conversion validates session version, result version, posting hash and conflict summary hash.
- Conversion key returns the same `ApplicationTask` and advances state once.
- Produces: `JobMatchTraceSink.record(event)`；事件只允许会话 ID 哈希、来源、Adapter/评分版本、阶段、数量、耗时、错误码和内容哈希。

- [ ] **Step 1: 写入口、过期、选岗和转换失败测试**

```ts
expect(await service.create({ url: listUrl })).toMatchObject({ state: "awaiting_filter_confirmation" });
expect(await service.create({ url: detailUrl })).toMatchObject({ state: "opening_job_page" });
expect(await service.create({ url: formUrl })).toMatchObject({ redirect: "application" });
expect(() => service.selectConflict(id, staleConflictGuard)).toThrow("job_match_conflict_confirmation_stale");
const first = await service.convert(id, guard);
expect(await service.convert(id, guard)).toEqual(first);
expect(applicationTasks.list()).toHaveLength(1);
expect(trace.events[0]).not.toHaveProperty("description");
expect(trace.events[0]).not.toHaveProperty("profile");
```

- [ ] **Step 2: 确认 service tests 失败**

Run: `rtk pnpm --filter @resume/api test -- src/job-matching/job-match-service.test.ts src/observability/job-match-trace.test.ts`  
Expected: FAIL，service 不存在。

- [ ] **Step 3: 实现应用编排**

所有 mutation 先校验 `sessionVersion` 和幂等键，再校验状态。resume 必须重新观察、识别并申请新 epoch；依赖 revision/hash 变化只标记旧结果 `stale`。选择冲突结果必须匹配当前冲突摘要哈希。转换仅写入待打开/待审阅 ApplicationTask，不调用 Browser 写能力。

- [ ] **Step 4: 运行 service 与投递仓储测试**

Run: `rtk pnpm --filter @resume/api test -- src/job-matching/job-match-service.test.ts src/observability/job-match-trace.test.ts src/applications/application-task-repository.test.ts src/production-dependencies.test.ts`  
Expected: PASS，且测试中的 browser execute 与 submission count 均为 0。  
Review: `rtk git diff -- apps/api/src/job-matching/job-match-service.ts apps/api/src/observability/job-match-trace.ts apps/api/src/applications/application-task-repository.ts apps/api/src/production-dependencies.ts`

---

### Task 12: HTTP API 与并发错误

**Files:**
- Create: `apps/api/src/job-matching/routes.ts`
- Create: `apps/api/src/job-matching/routes.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/server.test.ts`

**Interfaces:**
- Adds `/api/job-match-sessions` and all approved subresources.
- Maps stable conflicts to HTTP 409；not found to 404；contract errors to 400；unsupported entry to 422。
- GET is read-only and never advances state.

- [ ] **Step 1: 写所有路由和非法请求失败测试**

```ts
expect((await app.inject({ method: "POST", url: "/api/job-match-sessions", payload: { url } })).statusCode).toBe(201);
expect((await app.inject({ method: "GET", url: `/api/job-match-sessions/${id}` })).json().version).toBe(0);
expect((await staleMutation()).statusCode).toBe(409);
expect((await conflictSelectionWithoutHash()).statusCode).toBe(400);
```

- [ ] **Step 2: 确认路由测试失败**

Run: `rtk pnpm --filter @resume/api test -- src/job-matching/routes.test.ts src/server.test.ts`  
Expected: FAIL，路由返回 404。

- [ ] **Step 3: 注册独立路由并校验每个 payload**

每个 mutation 使用 Task 1 schema；错误体沿用现有 `ErrorResponseSchema`。禁止通过 UI 缺少按钮代替服务端状态、版本和哈希验证。轮询 GET 只调用 repository snapshot。

- [ ] **Step 4: 运行 API tests**

Run: `rtk pnpm --filter @resume/api test -- src/job-matching/routes.test.ts src/server.test.ts src/applications/routes.test.ts`  
Expected: PASS，现有 applications 路由无回归。  
Review: `rtk git diff -- apps/api/src/job-matching/routes.ts apps/api/src/app.ts`

---

### Task 13: 三段式岗位匹配工作台

**Files:**
- Create: `apps/web/src/job-matching/api.ts`
- Create: `apps/web/src/job-matching/api.test.ts`
- Create: `apps/web/src/job-matching/useJobMatchSession.ts`
- Create: `apps/web/src/job-matching/useJobMatchSession.test.tsx`
- Create: `apps/web/src/job-matching/JobMatchWorkbench.tsx`
- Create: `apps/web/src/job-matching/JobMatchWorkbench.test.tsx`
- Modify: `apps/web/src/router.tsx`
- Modify: `apps/web/src/router.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Adds route `/job-match-sessions/:sessionId` and API client methods matching Task 12.
- Polling is finite-frequency, pauses in terminal/stable user-action states and never mutates session.

- [ ] **Step 1: 写工作台状态和窄屏失败测试**

```tsx
expect(screen.getByText("已确认筛选条件")).toBeVisible();
expect(screen.getByText("推荐岗位")).toBeVisible();
expect(screen.getByText("最接近但有冲突")).toBeVisible();
expect(screen.getByText("未知")).toBeVisible();
expect(screen.queryByText(/自动申请|最终提交/)).not.toBeInTheDocument();
expect(screen.getByRole("button", { name: "继续读取" })).toBeEnabled();
```

- [ ] **Step 2: 确认 UI tests 失败**

Run: `rtk pnpm --filter @resume/web test -- src/job-matching src/router.test.tsx`  
Expected: FAIL，组件与路由不存在。

- [ ] **Step 3: 实现三段布局和受状态约束动作**

顶部显示可编辑筛选、网站映射/本地判断和预算进度；中部正常推荐与独立冲突列表；详情显示分数、置信度、满足/未知/冲突、证据和差距。冲突选择内联二次确认并提交当前 hash；stale 只显示“重新匹配”；selected 显示“已选择，尚未创建投递任务”。

- [ ] **Step 4: 验证组件与 320px CSS 约束**

Run: `rtk pnpm --filter @resume/web test -- src/job-matching src/router.test.tsx src/styles.test.ts`  
Expected: PASS，无横向溢出断言，按钮和长岗位名可换行。  
Review: `rtk git diff -- apps/web/src/job-matching apps/web/src/router.tsx apps/web/src/styles.css`

---

### Task 14: Synthetic ATS 与 Browser E2E 安全验收

**Files:**
- Create: `apps/synthetic-ats/public/job-list.html`
- Modify: `apps/synthetic-ats/src/server.ts`
- Modify: `apps/synthetic-ats/src/server.test.ts`
- Create: `tests/browser/job-matching.spec.ts`
- Modify: `tests/browser/test-harness.ts`
- Modify: `docs/testing/ats-regression.md`

**Interfaces:**
- Synthetic fixture exposes read-only diagnostics including `submissionCount` and deterministic pagination/challenge toggles.
- Browser E2E covers list, detail, application-form redirect, login, challenge, pause/continue, stale result and conflict confirmation.

- [ ] **Step 1: 写失败的 Synthetic ATS server 与 Browser tests**

```ts
expect((await request("/job-list.html?page=1")).status).toBe(200);
await expect(page.getByText("推荐岗位")).toBeVisible();
expect(await readDiagnostics(page)).toMatchObject({ submissionCount: 0 });
```

- [ ] **Step 2: 确认夹具或页面不存在导致失败**

Run: `rtk pnpm --filter @resume/synthetic-ats test -- src/server.test.ts`  
Run: `rtk pnpm test:e2e -- tests/browser/job-matching.spec.ts`  
Expected: FAIL，缺少 `/job-list.html` 或岗位工作台。

- [ ] **Step 3: 实现脱敏夹具和完整流程**

夹具提供 Moka/DJI 风格列表、详情、筛选回读、分页重复项、内容更新、登录和 challenge；最终提交控件只用于验证策略阻断，测试绝不点击或批准它。真实 Moka/DJI 审计仅观察到最终人工审核页。

- [ ] **Step 4: 运行 Browser、Moka/DJI 和零提交回归**

Run: `rtk pnpm --filter @resume/synthetic-ats test -- src/server.test.ts`  
Run: `rtk pnpm test:e2e -- tests/browser/job-matching.spec.ts tests/browser/mokahr-high-coverage.spec.ts tests/browser/dji-coverage.spec.ts tests/browser/ats-runtime-p0.spec.ts`  
Expected: PASS；每条路径末尾 `submissionCount === 0`。

- [ ] **Step 5: 运行最终验证矩阵**

Run: `rtk pnpm test`  
Run: `rtk pnpm typecheck`  
Run: `rtk pnpm build`  
Expected: 全部 exit 0。若真实 ATS 不可访问，Synthetic E2E 仍必须通过，并在验证记录中明确真实页面测试未运行，不能宣称已通过。

- [ ] **Step 6: 审阅全部限定差异，不提交**

Run: `rtk git status --short`  
Run: `rtk git diff -- docs/superpowers/specs/2026-08-16-job-matching-and-recommendation-design.md docs/superpowers/plans/2026-08-16-job-matching-and-recommendation.md packages/contracts/src/job-matching.ts packages/job-matching apps/api/src/job-matching apps/api/src/browser/browser-ownership-lease.ts apps/web/src/job-matching apps/synthetic-ats/public/job-list.html tests/browser/job-matching.spec.ts`  
Expected: 只审阅本功能差异；不执行 `git add` 或 `git commit`。
