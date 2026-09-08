# Conversation Job Recommendation Browser Lease Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct confirmation messages, release the controlled browser after recommendations are generated, and surface browser contention accurately so sequential company recommendations work.

**Architecture:** Keep confirmation copy local to the web and API conversation boundaries, with the API-persisted message as the durable source of truth. Release the single-browser ownership lease only after a job match reaches `awaiting_job_selection`, when all data needed for selection is persisted. Preserve Baidu entry normalization and add focused regression coverage at each boundary.

**Tech Stack:** TypeScript, React, Fastify, Vitest, Testing Library, Playwright, SQLite, pnpm workspace.

## Global Constraints

- Preserve all unrelated uncommitted changes in the current feature branch.
- Do not introduce a browser pool or cancel existing job-match sessions automatically.
- Do not change scoring, the six-result recommendation limit, or application approval policy.
- Do not execute a real job application during browser regression.
- Every production change must be preceded by a failing regression test.

---

### Task 1: Action-specific confirmation messages

**Files:**
- Modify: `apps/web/src/conversation/ChatHome.test.tsx`
- Modify: `apps/web/src/conversation/ChatHome.tsx`
- Modify: `apps/api/src/conversations/conversation-service.test.ts`
- Modify: `apps/api/src/conversations/conversation-service.ts`

**Interfaces:**
- Consumes: `ConversationConfirmation["action"]`, `pendingConfirmation`, and the API repository's pending confirmation.
- Produces: local `confirmationDecisionText(action, approved)` helpers returning the approved or rejected user-visible message.

- [x] **Step 1: Add failing web tests for entry and recommendation confirmation copy**

Extend the existing follow-up recruitment test so it inspects each optimistic user turn before resolving the corresponding API promise:

```tsx
expect(within(await screen.findByTestId("conversation-turn-3"))
  .getByText("确认使用此入口")).toBeVisible();

expect(within(await screen.findByTestId("conversation-turn-5"))
  .getByText("开始岗位推荐")).toBeVisible();
```

Keep the existing `start_application` assertion for `确认开始投递` as the fallback action coverage.

- [x] **Step 2: Run the web test and verify RED**

Run:

```powershell
corepack pnpm --filter @resume/web test -- src/conversation/ChatHome.test.tsx
```

Expected: FAIL because both recruitment confirmations currently render `确认开始投递`.

- [x] **Step 3: Add failing API persistence tests**

In `conversation-service.test.ts`, exercise `confirm_recruitment_site` and `request_job_recommendations`, then assert the persisted user turns:

```ts
expect(repository.getMessages(session.id).filter((message) => message.role === "user")
  .map((message) => message.text))
  .toEqual(["帮我投递百度校园招聘", "确认使用此入口", "开始岗位推荐"]);
```

Retain an assertion that `start_application` persists `确认开始投递`.

- [x] **Step 4: Run the API test and verify RED**

Run:

```powershell
corepack pnpm --filter @resume/api test -- src/conversations/conversation-service.test.ts
```

Expected: FAIL because the service currently persists `确认开始投递` for every action.

- [x] **Step 5: Implement minimal action-specific helpers**

Add equivalent local helpers in `ChatHome.tsx` and `conversation-service.ts`:

```ts
function confirmationDecisionText(
  action: ConversationConfirmation["action"],
  approved: boolean
): string {
  if (action === "confirm_recruitment_site") {
    return approved ? "确认使用此入口" : "暂不使用此入口";
  }
  if (action === "request_job_recommendations") {
    return approved ? "开始岗位推荐" : "暂不推荐";
  }
  return approved ? "确认开始投递" : "取消开始投递";
}
```

The web handler resolves the action from the matching `pendingConfirmation`; the API service passes `pending.action` directly.

- [x] **Step 6: Run focused web and API tests and verify GREEN**

Run both commands from Steps 2 and 4. Expected: PASS with no new warnings.

- [x] **Step 7: Commit only the confirmation-copy hunks**

```powershell
git add -p -- apps/web/src/conversation/ChatHome.tsx apps/web/src/conversation/ChatHome.test.tsx apps/api/src/conversations/conversation-service.ts apps/api/src/conversations/conversation-service.test.ts
git diff --cached --check
git diff --cached
git commit -m "fix: label conversation confirmations by action"
```

Stage only hunks introduced by this task; reject pre-existing hunks already present before execution.

---

### Task 2: Release browser ownership after recommendation generation

**Files:**
- Modify: `apps/api/src/job-matching/job-match-service.test.ts`
- Modify: `apps/api/src/job-matching/job-match-service.ts`

**Interfaces:**
- Consumes: `releaseOwner(dependencies, sessionId)` and optional `JobMatchBrowserPort.releaseTask(ownerId)`.
- Produces: `finalizeMatching(sessionId)` that returns `awaiting_job_selection` data while leaving `BrowserOwnershipLease.current()` undefined.

- [x] **Step 1: Add a failing lease-release regression test**

Extend `extracts and matches immediately after filter confirmation` with:

```ts
expect(value.browserOwnershipLease.current()).toBeUndefined();
expect(value.browser.releaseTask).toHaveBeenCalledWith("session-1");
expect(() => value.browserOwnershipLease.acquire({
  ownerKind: "job_match",
  ownerId: "session-2"
})).not.toThrow();
```

This proves another recommendation can acquire the single controlled browser after the first reaches selection.

- [x] **Step 2: Run the job-match service test and verify RED**

Run:

```powershell
corepack pnpm --filter @resume/api test -- src/job-matching/job-match-service.test.ts
```

Expected: FAIL because `finalizeMatching` leaves the first session as the current browser owner and never calls `releaseTask`.

- [x] **Step 3: Release only after the successful terminal transition**

Change `finalizeMatching` after the state mutation:

```ts
const completed = dependencies.repository.get(sessionId, { required: true });
releaseOwner(dependencies, sessionId);
await dependencies.browser.releaseTask?.(sessionId).catch(() => undefined);
return completed;
```

Do not release in `awaiting_filter_confirmation`, `awaiting_login`, or `awaiting_challenge` states.

- [x] **Step 4: Run the focused job-match tests and verify GREEN**

Run the command from Step 2. Expected: PASS, including the existing pause, cancel, conversion, and Baidu normalization tests.

- [ ] **Step 5: Commit only the lease lifecycle hunks**

```powershell
git add -p -- apps/api/src/job-matching/job-match-service.ts apps/api/src/job-matching/job-match-service.test.ts
git diff --cached --check
git diff --cached
git commit -m "fix: release browser after job recommendations"
```

Stage only the new release assertions and successful-terminal release logic; reject pre-existing recommendation-limit, normalization, or retry hunks.

---

### Task 3: Surface controlled-browser contention

**Files:**
- Modify: `apps/api/src/conversations/conversation-graph.test.ts`
- Modify: `apps/api/src/conversations/conversation-graph.ts`

**Interfaces:**
- Consumes: `userFacingError(code)` with `browser_lease_in_use` or `browser_task_in_use`.
- Produces: a specific retryable assistant message while preserving the original audit reason code.

- [x] **Step 1: Add a failing graph regression test**

Clone the existing normalized job-match failure scenario, make `jobMatchService.create` throw `new Error("browser_lease_in_use")`, and assert:

```ts
expect(failed.response.message.text).toBe(
  "受控浏览器正在处理其他岗位匹配或投递任务，请等待当前任务完成或先暂停它后再试。"
);
expect(failed.traceIds).not.toHaveLength(0);
```

- [x] **Step 2: Run the graph test and verify RED**

Run:

```powershell
corepack pnpm --filter @resume/api test -- src/conversations/conversation-graph.test.ts
```

Expected: FAIL because `browser_lease_in_use` currently falls through to the generic message.

- [x] **Step 3: Implement the explicit mapping**

Add this branch to `userFacingError`:

```ts
if (code === "browser_lease_in_use" || code === "browser_task_in_use") {
  return "受控浏览器正在处理其他岗位匹配或投递任务，请等待当前任务完成或先暂停它后再试。";
}
```

- [x] **Step 4: Run the graph test and verify GREEN**

Run the command from Step 2. Expected: PASS and existing `unsupported_job_entry` behavior remains unchanged.

- [ ] **Step 5: Commit only the error-copy hunks**

```powershell
git add -p -- apps/api/src/conversations/conversation-graph.ts apps/api/src/conversations/conversation-graph.test.ts
git diff --cached --check
git diff --cached
git commit -m "fix: explain controlled browser contention"
```

Stage only the `browser_lease_in_use`/`browser_task_in_use` mapping and its regression test.

---

### Task 4: Integrated regression and real Baidu smoke test

**Files:**
- Verify: `tests/browser/conversation-job-match-flow.spec.ts`
- Verify: `packages/job-matching/src/adapters/baidu-job-adapter.ts`
- Verify: `apps/browser-worker/src/job-observer.ts`
- Create: `docs/testing/2026-09-06-job-recommendation-browser-lease-regression.md`

**Interfaces:**
- Consumes: the full conversation API, job-match service, browser worker, and web UI.
- Produces: evidence that sequential recommendation flows no longer fail because of a stale lease.

- [x] **Step 1: Run focused package regressions**

```powershell
corepack pnpm --filter @resume/job-matching test
corepack pnpm --filter @resume/api test -- src/conversations/conversation-service.test.ts src/conversations/conversation-graph.test.ts src/job-matching/job-match-service.test.ts
corepack pnpm --filter @resume/web test -- src/conversation/ChatHome.test.tsx
```

Expected: all focused suites PASS.

- [x] **Step 2: Run type checks and the full workspace test suite**

```powershell
corepack pnpm -r --workspace-concurrency=1 typecheck
corepack pnpm -r --workspace-concurrency=1 test
```

Expected: all workspaces PASS. If a pre-existing failure appears, record it separately and do not mask it.

- [x] **Step 3: Restart local services and verify readiness**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/service-control.ps1 restart
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/service-control.ps1 status
```

Expected: API/browser worker and web report `就绪`; `http://localhost:5173` and API health return success.

Observed: the service supervisor has a separately tracked degraded-startup defect, so this regression used the newly built API artifact directly and retained the existing Vite process. `http://127.0.0.1:43120/api/health/adapters` returned HTTP 200 and the real UI flow completed at `http://127.0.0.1:5173`.

- [x] **Step 4: Run local browser regression without real submission**

```powershell
corepack pnpm test:e2e -- tests/browser/conversation-job-match-flow.spec.ts
```

Expected: PASS. The test must stop before any real application submission.

- [x] **Step 5: Perform the real Baidu recommendation smoke test**

In the local UI:

1. Start a new conversation with `百度`.
2. Select the official `talent.baidu.com` entry.
3. Confirm the visible user turns are `确认使用此入口` and `开始岗位推荐`.
4. Confirm the backend opens the normalized Baidu job-list URL rather than failing with `browser_lease_in_use`.
5. Stop at the recommendation/filter stage; do not create or submit an application.

Expected: no generic error, no stale browser lease, and any external Baidu page incompatibility is reported as `unsupported_job_entry` with its dedicated message.

- [x] **Step 6: Record implementation results**

Create the regression report with these exact sections and fill them from command output:

```markdown
# 岗位推荐浏览器租约回归记录

## 自动化验证

- 聚焦单元测试：命令、通过数量、失败数量
- 工作区类型检查：命令、结果
- 工作区完整测试：命令、通过数量、失败数量
- 浏览器回归：命令、通过数量、失败数量

## 百度真实冒烟测试

- 招聘入口
- 实际标准化地址
- 确认消息文案
- 岗位推荐结果或外部页面限制
- 是否触发真实投递：否
```

Commit the new report without staging unrelated progress-document changes:

```powershell
git add docs/testing/2026-09-06-job-recommendation-browser-lease-regression.md
git diff --cached --check
git commit -m "docs: record browser lease regression results"
```

---

### Task 5: Align Baidu entry and filter semantics with the live site

**Status:** Implemented with TDD and verified against the live Baidu site on 2026-09-06.

**Live evidence (2026-09-06):**

- The controlled browser opens `https://talent.baidu.com/jobs/list?projectType=4&recruitType=GRADUATE`, so the flow has reached a job-list page rather than the company home page.
- Baidu currently defines `projectType=1` as `校招`, `projectType=3` as `AIDU项目`, and `projectType=4` as `管培生项目`.
- The live page exposes the role category `技术`, not `开发`; passing the raw expectation value therefore raises `job_filter_value_missing:postType`.
- `employment_type=全职` is not a Baidu `projectType`; mapping it to that control is semantically incorrect.
- The live endpoint reports 145 positions for the generic campus URL with `projectType=1`.

**Files:**

- Modify: `packages/job-matching/src/adapters/baidu-job-adapter.test.ts`
- Modify: `packages/job-matching/src/adapters/baidu-job-adapter.ts`
- Modify: `apps/browser-worker/src/job-observer.test.ts`
- Modify: `apps/browser-worker/src/job-observer.ts`
- Modify: `apps/api/src/job-matching/job-match-service.test.ts`
- Verify: `tests/browser/conversation-job-match-flow.spec.ts`

**Design:**

1. Normalize a generic Baidu recruitment entry to the ordinary campus project (`projectType=1`), not the management-trainee project.
2. Keep the adapter boundary semantic: map recognizable target roles to Baidu's current category labels (`技术`, `产品`, `政企`, `销售`, `综合`). Unknown roles remain `localOnly` instead of causing a destructive or unverifiable click.
3. Treat `employment_type` as `localOnly`; Baidu's `projectType` describes campus programs, not full-time/part-time employment.
4. Keep location labels such as `全国` in the filter plan. The worker expands the location control when needed and the observer converts URL codes such as `9000` back to labels before readback validation.
5. Preserve fail-closed behavior: missing controls, missing values, or mismatched readback still fail and never proceed to selection or application creation.

- [x] **Step 1: Add failing adapter tests for the live Baidu contract**

Assert that a generic official entry normalizes to:

```text
https://talent.baidu.com/jobs/list?projectType=1&recruitType=GRADUATE
```

Assert that an expectation containing `开发 / 全国 / 全职` produces:

```ts
mapped: [
  { criterionIndex: 0, key: "postType", values: ["技术"] },
  { criterionIndex: 1, key: "workPlace", values: ["全国"] }
]
localOnly: [
  { criterionIndex: 2, reasonCode: "unsupported_employment_type" }
]
```

- [x] **Step 2: Run the adapter test and verify RED**

```powershell
corepack pnpm --filter @resume/job-matching test -- src/adapters/baidu-job-adapter.test.ts
```

Expected: FAIL because the current adapter uses `projectType=4`, passes `开发` unchanged, and maps `全职` to `projectType`.

- [x] **Step 3: Implement the minimal adapter mapping**

Add a small deterministic role-category mapper. It must not call a model or infer an unsupported site option. Unrecognized role values remain local-only.

- [x] **Step 4: Add failing browser-worker tests for Baidu navigation loss, official API filtering, and pagination**

Start with a current-structure fixture and change it from `history.replaceState` to a real navigation so the test reproduces the live failure:

```text
page.evaluate: Execution context was destroyed, most likely because of a navigation
```

Then require the worker to query Baidu's public job-list endpoint, preserve semantic filter readback, avoid `page.goto`, and advance with an opaque second-page cursor. Mock `globalThis.fetch` only at the network boundary; keep the browser/page lifecycle real.

- [x] **Step 5: Run the browser-worker test and verify RED**

```powershell
corepack pnpm --filter @resume/browser-worker test -- src/job-observer.test.ts
```

Expected and observed RED sequence:

1. context-destroyed failure after the Baidu page navigates;
2. failure while the worker still relies on `page.goto`;
3. failure while the worker does not POST to `getPostListNew`;
4. empty results while the request uses bracket-array form encoding.

- [x] **Step 6: Implement official Baidu list snapshots and labeled readback**

Cache the confirmed Baidu entry and semantic filter state in the worker, then query:

```text
POST https://talent.baidu.com/httservice/getPostListNew
```

Use scalar `postType=1`, omit `workPlace` for the `全国` semantic value, omit `projectType=1` for the ordinary graduate list API, and keep `pageSize=10`. Convert the response to the bounded observer snapshot contract and use `curPage` for pagination. The controlled page remains the user-visible official entry, while extraction no longer depends on a page execution context that Baidu destroys during filtering.

- [x] **Step 7: Add a service regression proving extraction starts only after verified readback**

Cover the exact `开发 / 全国 / 全职` expectation and assert that:

- `confirmFilters` reaches extraction with version-safe state transitions;
- generated recommendations are limited to six;
- scores are presented as percentages;
- browser ownership is released after `awaiting_job_selection`;
- no application task or submission is created.

- [x] **Step 8: Run focused GREEN verification**

```powershell
corepack pnpm --filter @resume/job-matching test -- src/adapters/baidu-job-adapter.test.ts
corepack pnpm --filter @resume/browser-worker test -- src/job-observer.test.ts
corepack pnpm --filter @resume/api test -- src/job-matching/job-match-service.test.ts src/conversations/conversation-job-match-service.test.ts
corepack pnpm --filter @resume/web test -- src/conversation/ConversationCards.test.tsx src/conversation/ChatHome.test.tsx
```

- [x] **Step 9: Repeat the real Baidu smoke test**

Run the same conversation flow through filter confirmation and verify that one to six recommendation cards are shown with percentage labels. Stop before creating an application task.

**Observed result:** the fresh conversation flow selected `talent.baidu.com`, displayed `确认使用此入口` and `开始岗位推荐`, generated exactly six Baidu technical-role cards with 44%/41% labels, and stopped before any application task or submission. The detailed command and live-site evidence is recorded in `docs/testing/2026-09-06-job-recommendation-browser-lease-regression.md`.

- [x] **Step 10: Apply code-review hardening with RED/GREEN coverage**

The completion review identified four valid fail-closed gaps and one lifecycle concern. Add regressions and minimal fixes for:

1. deriving filter readback from URL codes and validating every returned job's `postType`/`workPlace`, instead of echoing the requested plan;
2. rejecting a response whose `pageNum` differs from the requested cursor;
3. rejecting malformed entries inside an otherwise valid `data.list`;
4. normalizing the worker's supported city aliases and retaining unknown locations as `localOnly`;
5. proving at `BrowserSessionManager` level that `releaseTask` destroys the old `JobObserver` and the next task receives a fresh instance.

Expected and observed: the new adapter and worker assertions fail before implementation, then the focused adapter, job-observer, and session-manager suites pass after the minimal changes.

- [x] **Step 11: Scope conversation action idempotency keys by job-match session**

The final same-conversation smoke test exposed `conversation_idempotency_conflict`: every filter confirmation at session version 0 reused `inline-job-match:confirm_filters:0`, so a second recommendation session in the same conversation was rejected before execution.

Add failing component assertions for filter confirmation, pause/continue/rematch, normal selection and conflict selection. Generate keys as:

```text
inline-job-match:<sessionId>:<action>:<sessionVersion>[:<resultId>]
```

Keep the 128-character contract bound without directly truncating the identity: preserve the action/version suffix and use a stable 128-bit digest when the raw key is too long. Rebuild the static web bundle, reload the existing conversation, and repeat the same-session Baidu flow. Expected and observed: the second recommendation reaches `awaiting_job_selection`, reads 93 real technical postings, renders only six percentage cards, and creates no application task.

---

## Independently discovered follow-up defects

These are intentionally not folded into Task 5 because they affect different subsystems and require separate designs:

1. Opening the web root without a valid conversation causes repeated conversation creation due to an unstable `onSessionResolved` effect dependency. Use a stable callback/ref boundary and add a router-level create-once regression test.
2. The service supervisor starts remote/tunnel dependencies before local API/Web; a remote startup failure aborts local startup while stale state still reports readiness. Local services should start in degraded mode and status must validate live process/probe state.
