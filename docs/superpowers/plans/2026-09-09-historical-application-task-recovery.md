# Historical Application Task Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve complete application targets (including SPA hash routes), repair historical URLs polluted by trailing prose, keep Runtime persistence consistent, and let users restart a failed task from the corrected target without losing its audit history.

**Architecture:** Reuse the existing deterministic URL boundary extractor rather than add site-specific keywords. Make the public-HTTPS guard preserve valid URL fragments because SPA recruitment systems use them as executable routes. Repair task and Runtime application-state rows in one SQLite transaction during repository reads; failed execution history remains immutable. Add one idempotent restart API that creates a new Runtime-owned task, and make the UI prefer terminal API state over stale SSE projection.

**Tech Stack:** TypeScript, Fastify, SQLite/better-sqlite3, React, Vitest, Playwright-compatible browser Worker.

## Global Constraints

- Only trim a suffix when `extractConversationUrlInput()` reports `recovered_encoded_suffix`.
- Preserve valid encoded paths and legitimate Chinese query-parameter values unchanged.
- Preserve valid hash fragments such as Mokahr `#/job/<id>/apply`; URL validation must not reduce them to a recruitment-site landing page.
- Do not delete or rewrite historical events, checkpoints, TraceSink records, or the failed source task.
- Restart creates a deterministic new task and retains final-submit, login, CAPTCHA, and challenge gates.
- Do not touch stash or untracked user files.

---

### Task 1: Preserve SPA application routes and repair historical URLs

**Files:**
- Modify: `apps/api/src/recruitment-search/public-https-url.ts`
- Modify: `apps/api/src/recruitment-search/public-https-url.test.ts`
- Modify: `apps/api/src/conversations/conversation-e2e.test.ts`
- Modify: `apps/api/src/applications/application-task-repository.ts`
- Modify: `apps/api/src/applications/application-task-repository.test.ts`

**Interfaces:**
- Consumes: `extractConversationUrlInput(value: string): ConversationUrlInput | undefined`.
- Produces: URL validation returns the complete safe HTTPS URL, including a valid fragment.
- Produces: existing `ApplicationTaskRepository.get()` and `list()` return repaired tasks and persist the repair atomically.

- [ ] **Step 1: Write failing URL-boundary and repository tests**

First pass the exact Mokahr URL `https://app.mokahr.com/campus-recruitment/whfhtx/73922#/job/a6cadf99-015c-42f6-a170-3252b540dae6/apply` through the public URL guard and conversation confirmation flow. Assert the fragment survives validation, confirmation, and task creation.

Seed the exact Wondershare URL ending in encoded `这个页面可以投递吗`, plus a matching `agent_runtime_application_states` row. Assert `get()` returns the clean URL ending in `userId=125079440`, both database rows are updated, and a legitimate `candidateId=abc%E5%BC%A0%E4%B8%89` remains unchanged.

```ts
expect(repository.get(taskId)?.applicationUrl).toBe(cleanUrl);
expect(readTaskUrl(taskId)).toBe(cleanUrl);
expect(readRuntimeState(runId).applicationUrl).toBe(cleanUrl);
expect(repository.get(legitimateTaskId)?.applicationUrl).toBe(legitimateChineseUrl);
expect(createdMokahrTask.applicationUrl).toBe(mokahrHashRoute);
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
corepack pnpm --filter @resume/api exec vitest run src/recruitment-search/public-https-url.test.ts src/conversations/conversation-e2e.test.ts src/applications/application-task-repository.test.ts
```

Expected: FAIL because `validatePublicHttpsUrl()` currently clears `parsed.hash` and `fromRow()` returns `row.application_url` unchanged.

- [ ] **Step 3: Implement the minimal transaction**

Stop clearing `parsed.hash` in the public HTTPS validator; the existing protocol, credentials, hostname, DNS, and private-address checks remain unchanged. Prepare task/runtime update statements and repair only a recovered encoded suffix:

```ts
const extracted = extractConversationUrlInput(row.application_url);
if (extracted?.boundary !== "recovered_encoded_suffix") return row;

repairStoredTarget({
  taskId: row.id,
  previousUrl: row.application_url,
  applicationUrl: extracted.url
});
return { ...row, application_url: extracted.url };
```

Inside one `database.transaction`, update `application_tasks` and parse/update only Runtime rows whose `taskId` and previous `applicationUrl` both match. Abort the transaction if a stored Runtime payload fails schema-compatible JSON parsing.

- [ ] **Step 4: Verify GREEN**

Run the repository test command again. Expected: all tests pass.

- [ ] **Step 5: Commit**

```powershell
git add apps/api/src/recruitment-search/public-https-url.ts apps/api/src/recruitment-search/public-https-url.test.ts apps/api/src/conversations/conversation-e2e.test.ts apps/api/src/applications/application-task-repository.ts apps/api/src/applications/application-task-repository.test.ts
git commit -m "fix: preserve and repair application targets"
```

### Task 2: Idempotent restart API for failed tasks

**Files:**
- Modify: `packages/contracts/src/application.ts`
- Modify: `packages/contracts/src/application.test.ts`
- Modify: `apps/api/src/applications/routes.ts`
- Modify: `apps/api/src/applications/routes.test.ts`

**Interfaces:**
- Produces: `POST /api/applications/:id/restart` returning the new `ApplicationTask`.
- Uses: `prepareApplicationTarget(task.applicationUrl, \`restart:${task.id}\`)` and existing `createFromJob/start/openBrowser/runUntilPause` flow.

- [ ] **Step 1: Write failing contract and route tests**

Assert restart is accepted only for `failed`/`cancelled` source tasks, derives the same new UUID on replay, preserves the source task, and starts the corrected URL. Assert active-browser conflict and failed startup return existing stable error envelopes without deleting the source task.

```ts
const response = await app.inject({ method: "POST", url: `/api/applications/${sourceId}/restart` });
expect(response.statusCode).toBe(201);
expect(response.json()).toMatchObject({ applicationUrl: cleanUrl, state: "observing_page" });
expect(tasks.get(sourceId)).toBeDefined();
```

- [ ] **Step 2: Verify RED**

Run the contract test and the focused route test. Expected: 404 for the missing restart route or missing response schema.

- [ ] **Step 3: Implement minimal restart orchestration**

Add a strict empty-body restart route. Reuse a private `startPreparedTask()` helper shared with task creation so browser locking, cleanup, event emission, and idempotency stay identical. Return `200` when the deterministic restarted task already exists and `201` when newly created.

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
corepack pnpm --filter @resume/contracts test
corepack pnpm --filter @resume/api exec vitest run src/applications/routes.test.ts
```

Expected: both suites pass.

- [ ] **Step 5: Commit**

```powershell
git add packages/contracts/src/application.ts packages/contracts/src/application.test.ts apps/api/src/applications/routes.ts apps/api/src/applications/routes.test.ts
git commit -m "feat: restart failed application tasks safely"
```

### Task 3: Terminal-state reconciliation and recovery UI

**Files:**
- Modify: `apps/web/src/applications/api.ts`
- Modify: `apps/web/src/applications/api.test.ts`
- Modify: `apps/web/src/applications/ApplicationTaskPage.tsx`
- Modify: `apps/web/src/applications/ApplicationTaskPage.test.tsx`

**Interfaces:**
- Produces: `ApplicationApi.restart(taskId: string): Promise<ApplicationTask>`.
- Consumes: restart endpoint from Task 2 and existing `onNavigate(path)`.

- [ ] **Step 1: Write failing UI tests**

Cover an old SSE `observing_page` event arriving before a GET response whose state is `failed`; assert the rendered state is “任务失败”, not “等待进入简历填写页面”. For a failed task, assert the page explains that no form was recognized and provides “使用修正地址重新开始”; clicking calls `api.restart()` and navigates to the returned task ID.

```tsx
expect(screen.getByText("任务失败")).toBeInTheDocument();
await user.click(screen.getByRole("button", { name: "使用修正地址重新开始" }));
expect(api.restart).toHaveBeenCalledWith(sourceId);
expect(onNavigate).toHaveBeenCalledWith(`/applications/${restarted.id}`);
```

- [ ] **Step 2: Verify RED**

Run the API client and task-page tests. Expected: stale SSE state wins and the restart method/button do not exist.

- [ ] **Step 3: Implement minimal UI behavior**

When loading a task, make terminal API states authoritative:

```ts
const terminal = new Set(["failed", "cancelled", "review_locked"]);
const projectedState = terminal.has(next.state)
  ? next.state
  : latestEventState.current ?? next.state;
```

Add the restart client call and failed-state action. Keep the source task visible for audit and navigate only after a successful response.

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
corepack pnpm --filter @resume/web exec vitest run src/applications/api.test.ts src/applications/ApplicationTaskPage.test.tsx
```

Expected: all focused web tests pass.

- [ ] **Step 5: Commit**

```powershell
git add apps/web/src/applications/api.ts apps/web/src/applications/api.test.ts apps/web/src/applications/ApplicationTaskPage.tsx apps/web/src/applications/ApplicationTaskPage.test.tsx
git commit -m "fix: reconcile failed application task state"
```

### Task 4: Real-data migration and regression

**Files:**
- Verify only: `apps/api/data/resume-assistant.sqlite`
- Verify: all files changed in Tasks 1–3

**Interfaces:**
- Consumes: repository repair, restart API, and UI behavior from previous tasks.
- Produces: repaired historical task URL and a new auditable task only when the restart action is explicitly invoked.

- [ ] **Step 1: Back up the database and record current evidence**

Copy the SQLite database plus `-wal`/`-shm` files, if present, into a timestamped directory under `.runtime/backups/`. Record the source task URL, state, Runtime URL, and latest event ID without recording profile facts or credentials.

- [ ] **Step 2: Run complete verification**

```powershell
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

Expected: all tests, typecheck, and build pass.

- [ ] **Step 3: Restart local API/Web and verify migration**

GET source task `a0b682fc-7d1d-5b39-b090-1efa4d8bca42`; expect `failed` plus the clean URL. Query the read-only database and expect both task and Runtime application-state URLs to match.

- [ ] **Step 4: Exercise the recovery path in the real browser**

Open the source task, verify the UI shows failure and the restart action, invoke restart once, and confirm the new task navigates to the clean Wondershare URL. Stop at login, CAPTCHA, unsupported boundary, or final review; never submit an application.

Create a fresh task from the exact Mokahr hash-route URL and verify the stored target and controlled browser both retain `#/job/a6cadf99-015c-42f6-a170-3252b540dae6/apply`. Keep historical truncated task `b53a26fc-27bb-5128-8af1-5b03838341f4` as immutable audit evidence; do not infer its lost fragment from the truncated task row.

- [ ] **Step 5: Commit any verification-only fixture updates, then push `main`**

If no tracked verification artifacts changed, create no extra commit. Push with a normal fast-forward push only after `git diff --check`, clean tracked status, and remote ancestry checks pass.
