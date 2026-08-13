# 审查后稳定化修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复字段抽取契约、生产依赖和候选人档案热同步问题，并验证整个投递系统仍符合“自动填写、用户审核、永不提交”。

**Architecture:** 抽取模块直接复用 `@resume/form-semantics` 的字段注册表，先生成允许抽取的路径模板，再以 Zod 和路径解析双重校验模型输出。档案同步通过 SQLite 持久修订号和任务 checkpoint 的最后应用修订实现幂等恢复；现有 application actor 仍负责浏览器状态机。依赖升级按依赖族分批完成，每批独立测试和审计。

**Tech Stack:** TypeScript、Zod、Vitest、Fastify、Drizzle/better-sqlite3、XState、React、pnpm、Playwright。

## Global Constraints

- 本轮不实现本地档案、PDF、头像加密。
- 本轮不调整敏感资料发送至 DeepSeek 或向量服务的策略。
- 必须先写失败测试、确认失败，再写生产代码。
- 既有页面非空值和用户手动输入不可覆盖。
- 自动化始终停在最终审核前，禁止提交招聘申请。
- 不撤销工作区已有 `.superpowers/sdd/*.md` 或其他用户修改。
- 每条命令使用 `rtk` 前缀；手工编辑使用 `apply_patch`。

---

### Task 1: 统一简历抽取字段契约

**Files:**
- Modify: `packages/form-semantics/src/field-registry.ts`
- Modify: `packages/form-semantics/src/index.ts`
- Create: `packages/form-semantics/src/extraction-field-paths.test.ts`
- Modify: `packages/profile-domain/package.json`
- Modify: `packages/profile-domain/src/extraction/extraction-schema.ts`
- Modify: `packages/profile-domain/src/extraction/extract-facts.ts`
- Modify: `packages/profile-domain/src/extraction/extract-facts.test.ts`

**Interfaces:**
- `listExtractableFieldPathTemplates(): readonly string[]` returns every registered profile leaf template whose semantic is valid for PDF evidence extraction.
- `isAllowedExtractedFieldPath(path: string): boolean` accepts concrete paths such as `awards[0].name` and rejects unknown roots, unknown leaves, malformed indexes and non-profile paths.
- `ExtractionCandidateSchema` refines `fieldPath` with the allowed-path predicate after parsing the string.

- [ ] **Step 1: Write failing registry tests**

Add tests proving the exported templates include `awards[].name`, `awards[].date`, `campus[].name`, `publications[].title`, and existing `projects[].url`; prove concrete indexed paths pass and `awards[0].unknown`, `awards[-1].name`, `awards[x].name`, and `application.jobSpecific` fail.

- [ ] **Step 2: Run registry tests and confirm the expected failure**

Run:

```text
rtk pnpm --filter @resume/form-semantics test -- extraction-field-paths.test.ts
```

Expected: FAIL because the extraction-path exports do not exist.

- [ ] **Step 3: Implement the registry path exports**

Derive templates from `FIELD_DEFINITIONS`, normalize the `[]` wildcard to a concrete non-negative integer matcher, and export the two functions through `packages/form-semantics/src/index.ts`. Keep legacy ATS aliases out of the extraction contract; only canonical profile paths are allowed.

- [ ] **Step 4: Run registry tests and confirm they pass**

Run the same command. Expected: all new registry tests PASS.

- [ ] **Step 5: Write failing extraction tests**

Extend `extract-facts.test.ts` with a provider response containing valid award, campus, publication facts and one unknown path. Assert valid facts are produced for the valid-only case and the mixed response rejects before any fact is returned. Assert the prompt contains the newly generated canonical path templates.

- [ ] **Step 6: Run extraction tests and confirm the expected failure**

Run:

```text
rtk pnpm --filter @resume/profile-domain test -- src/extraction/extract-facts.test.ts
```

Expected: FAIL because the current schema accepts arbitrary paths and the prompt omits the new sections.

- [ ] **Step 7: Implement minimal extraction validation**

Add `@resume/form-semantics` as a workspace dependency. Build `EXTRACTION_RULES` from `listExtractableFieldPathTemplates()`, refine `ExtractionSchema` with `isAllowedExtractedFieldPath`, and preserve current evidence/page validation. Add the new repeated-section names to the scan instruction. Do not change DeepSeek retry behavior.

- [ ] **Step 8: Run extraction and related tests**

Run:

```text
rtk pnpm --filter @resume/profile-domain test -- src/extraction/extract-facts.test.ts
rtk pnpm --filter @resume/form-semantics test
```

Expected: PASS with no unrelated failures.

- [ ] **Step 9: Commit the extraction contract**

```text
rtk git add packages/form-semantics packages/profile-domain
rtk git commit -m "fix: enforce profile extraction field contract"
```

---

### Task 2: 生产依赖安全升级

**Files:**
- Modify: `apps/api/package.json`
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: any source files required by confirmed package API changes
- Test: affected package tests and the full workspace test suite

**Interfaces:**
- Preserve Fastify route registration and reply behavior.
- Preserve Drizzle database initialization and schema exports.
- Preserve React Router route paths and browser history behavior.

- [ ] **Step 1: Capture the baseline audit**

Run:

```text
rtk pnpm audit --prod --audit-level high
```

Record direct and transitive findings in the task report, distinguishing fixable findings from findings without an available patched version.

- [ ] **Step 2: Upgrade one dependency family at a time**

Use `pnpm update` or explicit `pnpm add` only for the affected direct package family, starting with Fastify, then Drizzle, then React Router. After each update inspect the lockfile diff and do not add a broad override.

- [ ] **Step 3: Run focused tests after each family**

Run the owning tests:

```text
rtk pnpm --filter @resume/api test
rtk pnpm --filter @resume/web test
```

If a package API changed, add a failing compatibility test first, then make the smallest adapter change and rerun it.

- [ ] **Step 4: Run typecheck and build**

```text
rtk pnpm typecheck
rtk pnpm build
```

Expected: exit code 0.

- [ ] **Step 5: Re-run production audit**

```text
rtk pnpm audit --prod --audit-level high
```

Document remaining findings if no patched version exists; do not claim they are fixed.

- [ ] **Step 6: Commit dependency changes**

```text
rtk git add apps/api/package.json apps/web/package.json pnpm-lock.yaml
rtk git commit -m "chore: upgrade vulnerable production dependencies"
```

---

### Task 3: 持久化档案修订与同步结果

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/db/client.ts` or the project migration mechanism
- Modify: `apps/api/src/profile/profile-repository.ts`
- Modify: `apps/api/src/profile/profile-routes.ts`
- Modify: `apps/api/src/applications/application-task-repository.ts`
- Modify: `apps/api/src/applications/application-service.ts`
- Modify: `apps/api/src/applications/routes.ts`
- Modify: `apps/api/src/production-dependencies.ts`
- Modify: `packages/contracts/src/application.ts` and generated/consumer types if required
- Create or modify: corresponding API/application/profile tests

**Interfaces:**
- Profile repository exposes `currentRevision(): number` and increments it only after a successful profile mutation.
- Application task persistence stores `profileRevisionApplied` and `profileSyncStatus` (`current`, `pending`, `failed`) with an optional public error code/message.
- Application service exposes `refreshFromProfile(): Promise<ProfileSyncSummary>` and can lazily restore eligible tasks from checkpoints/task persistence.
- Profile routes return `{ fact, profileSync }` only through an additive response field or an equivalent response header/diagnostic endpoint; existing fact response parsing remains compatible.

- [ ] **Step 1: Write failing revision and task repository tests**

Test that a profile mutation increments the revision exactly once; a no-op delete does not. Test a task starts with revision `0`, can record an applied revision, and never moves backward.

- [ ] **Step 2: Run focused repository tests and confirm failure**

```text
rtk pnpm --filter @resume/api test -- src/profile/profile-repository.test.ts src/applications/application-task-repository.test.ts
```

Expected: FAIL because the revision and task metadata interfaces do not exist.

- [ ] **Step 3: Add the additive database schema and idempotent migration**

Add profile metadata and task sync columns using the repository's existing migration convention. Existing rows receive revision `0` and `current` status. Migration must be rerunnable without duplicate-column errors.

- [ ] **Step 4: Implement repository revision tracking**

Wrap each successful upsert/confirm/correct/remove mutation in the existing SQLite transaction style. Increment the profile revision only when the active profile data changes; preserve fact status precedence and existing conflict rules.

- [ ] **Step 5: Run repository tests and confirm they pass**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 6: Write failing service synchronization tests**

Cover four behaviors: profile refresh only targets active non-terminal tasks; a task that is not in memory can be restored from its checkpoint; repeated refresh at the same revision is a no-op; a browser synchronization failure is persisted and exposed as `failed` without changing the task into a submit-capable state.

- [ ] **Step 7: Run synchronization tests and confirm failure**

```text
rtk pnpm --filter @resume/api test -- src/applications/application-service.test.ts src/profile/profile-routes.test.ts
```

Expected: FAIL because refresh only sees current actors and errors are swallowed.

- [ ] **Step 8: Implement the synchronization coordinator**

Have `production-dependencies.ts` pass task listing and actor restoration dependencies into the service. `refreshFromProfile` loads eligible persisted tasks, calls the existing `resumeWithProfile`/refresh logic only for revisions newer than the task's applied revision, and records success or failure. Profile routes await the callback, return a structured sync summary, and emit a task event on failure. Keep synchronization out of terminal review and submission paths.

- [ ] **Step 9: Add front-end visible sync status and retry**

Extend the profile API response type and save state so the profile page shows “档案已保存，投递同步失败，可重试” when synchronization fails. Add a retry action that invokes the existing application refresh/recovery endpoint. Keep the normal save success path concise.

- [ ] **Step 10: Run API, web, and E2E synchronization tests**

```text
rtk pnpm --filter @resume/api test
rtk pnpm --filter @resume/web test
rtk pnpm test:e2e
```

Expected: all tests PASS and no final-submit action appears in any test trace.

- [ ] **Step 11: Commit synchronization changes**

```text
rtk git add apps/api packages/contracts apps/web
rtk git commit -m "fix: persist profile synchronization state"
```

---

### Task 4: 全系统功能回归

**Files:**
- Test only unless a regression is found; regression fixes must follow a new red-green cycle.
- Update: `.superpowers/sdd/task-5-report.md` with command output and residual risks.

- [ ] **Step 1: Run all workspace tests**

```text
rtk pnpm test
```

- [ ] **Step 2: Run typecheck, build, diff check, and audit**

```text
rtk pnpm typecheck
rtk pnpm build
rtk git diff --check
rtk pnpm audit --prod --audit-level high
```

- [ ] **Step 3: Run browser regression suites**

```text
rtk pnpm test:e2e
```

Verify PDF import, profile save, exact fill, second semantic fill, select option readback, date component fill, repeated project/education/award sections, task cancel/delete, recovery, profile refresh, and review lock.

- [ ] **Step 4: Run the real DJI/Mokahr flow in controlled browser mode**

Use the existing local browser harness and the user-provided DJI URL. Let the user select the position and reach the resume/application form. Verify the worker observes the page, fills only evidence-backed profile values, rereads controls, pauses at review, and never clicks submit/confirm application.

- [ ] **Step 5: Record results and residual risks**

Record exact pass/fail counts, audit findings without available fixes, environmental prerequisites, and any remaining manual review items. Do not describe unresolved findings as complete.

- [ ] **Step 6: Commit the regression report**

```text
rtk git add .superpowers/sdd/task-5-report.md
rtk git commit -m "test: record post-review system regression"
```

---

## Self-review

- Spec coverage: extraction contract is Task 1; dependency audit is Task 2; persistent revision, recovery, visible failure and retry are Task 3; complete functional and safety validation is Task 4.
- Privacy scope is explicitly excluded in Global Constraints and the design document; no task silently implements it.
- Every production behavior has a preceding failing-test step.
- No task grants or introduces a submit action; review lock remains the terminal automation boundary.
- Existing API response compatibility is preserved by additive sync metadata.
