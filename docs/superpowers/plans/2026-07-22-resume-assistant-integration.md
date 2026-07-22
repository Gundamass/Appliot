# Resume Assistant Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the verified profile and controlled browser into a polished local application, add Moka and Beisen adapters, harden recovery and privacy, and pass the complete MVP acceptance suite.

**Architecture:** The web client operates application tasks through typed HTTP and server-sent task events. Site adapters extend the generic snapshot/execution interfaces without bypassing policy. Checkpoints, redacted audit events, OS-protected provider credentials, and packaged local startup complete the single-user product.

**Tech Stack:** Existing Plans 1-2 stack plus React Router 7.6.2, TanStack Query 5.80.7, Server-Sent Events, keytar 7.9.0, Playwright Test, and platform packaging scripts

## Global Constraints

- Complete Plans 1 and 2 before starting this plan.
- Generic form semantics remain the fallback; adapters may enhance parsing and execution but cannot bypass action policy.
- Moka and Beisen adapter behavior is tested against versioned local fixtures; live-site checks are manual diagnostics, not the automated test source of truth.
- The application UI never renders a submit command.
- Final review transfers control to the visible browser while automation remains `review_locked`.
- Audit logs exclude passwords, cookies, CAPTCHA values, authorization headers, raw browser storage, and unrelated page content.
- Provider credentials use OS credential storage and never enter SQLite or source-controlled files.

---

## File Structure

```text
apps/api/src/applications/routes.ts       Task HTTP and event endpoints
apps/api/src/audit/                       Structured redacted audit log
apps/api/src/credentials/                 OS credential storage adapter
apps/web/src/applications/                Create, progress, questions, review UI
packages/site-adapters/src/moka/          Moka detection, parse, execute enhancements
packages/site-adapters/src/beisen/        Beisen detection, parse, execute enhancements
tests/fixtures/ats/                        Versioned sanitized ATS fixtures
tests/acceptance/                          Full MVP acceptance and recovery tests
scripts/                                   Local development and packaging commands
```

### Task 1: Expose typed application-task APIs and event streaming

**Files:**
- Create: `apps/api/src/applications/routes.ts`
- Create: `apps/api/src/applications/task-events.ts`
- Modify: `apps/api/src/app.ts`
- Create: `packages/contracts/src/application.ts`
- Test: `apps/api/src/applications/routes.test.ts`

**Interfaces:**
- Consumes: `ApplicationService` from Plan 2.
- Produces: task CRUD, answer/review commands, browser-open command, and `GET /api/applications/:id/events` SSE.

- [ ] **Step 1: Write failing route and event tests**

```ts
it("creates a task and emits state changes without exposing a submit command", async () => {
  const response = await app.inject({ method: "POST", url: "/api/applications", payload: validTaskInput });
  expect(response.statusCode).toBe(201);
  expect(response.json().commands).not.toContain("submit");
  expect(eventBus.history(response.json().id).map(event => event.state)).toContain("waiting_for_login");
});
```

- [ ] **Step 2: Run route tests and verify failure**

Run: `pnpm --filter @resume/api test -- routes.test.ts`
Expected: FAIL because application routes are not registered.

- [ ] **Step 3: Implement Zod-validated endpoints and replayable SSE**

Expose these commands only: create, cancel, open-browser, resume, answer-questions, approve-content, reject-content, and promote-answer-to-profile. Store monotonically increasing event IDs so reconnecting SSE clients pass `Last-Event-ID` and receive missed events.

```ts
export const ApplicationCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cancel") }),
  z.object({ type: z.literal("open_browser") }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("answer_questions"), answers: z.array(ApplicationAnswerSchema) }),
  z.object({ type: z.literal("approve_content"), reviewId: z.string(), editedValue: z.string().optional() }),
  z.object({ type: z.literal("reject_content"), reviewId: z.string() }),
  z.object({ type: z.literal("promote_answer_to_profile"), answerId: z.string() })
]);
```

- [ ] **Step 4: Verify authorization scope, reconnect, malformed commands, and missing tasks**

Run: `pnpm --filter @resume/api test -- routes.test.ts`
Expected: PASS with `201/200/400/404` behavior and no representable submit command.

- [ ] **Step 5: Commit task APIs**

```bash
git add apps/api/src/applications apps/api/src/app.ts packages/contracts
git commit -m "feat: expose application task api and events"
```

### Task 2: Build create-task and live progress views

**Files:**
- Create: `apps/web/src/router.tsx`
- Create: `apps/web/src/applications/NewApplicationPage.tsx`
- Create: `apps/web/src/applications/ApplicationTaskPage.tsx`
- Create: `apps/web/src/applications/useTaskEvents.ts`
- Test: `apps/web/src/applications/ApplicationTaskPage.test.tsx`

**Interfaces:**
- Consumes: Task APIs and SSE from Task 1.
- Produces: URL/job input, browser launch, manual-login waiting, state timeline, and connection recovery.

- [ ] **Step 1: Write failing task-page tests**

```tsx
it("shows manual login and advances from task events", async () => {
  renderTaskPage({ initialState: "waiting_for_login" });
  expect(screen.getByText("请在浏览器中完成登录")).toBeVisible();
  emitTaskEvent({ state: "observing_page", pageTitle: "个人信息" });
  expect(await screen.findByText("正在分析：个人信息")).toBeVisible();
  expect(screen.queryByRole("button", { name: /提交/ })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run task UI tests and verify failure**

Run: `pnpm --filter @resume/web test -- ApplicationTaskPage.test.tsx`
Expected: FAIL because the task page is missing.

- [ ] **Step 3: Implement operational task UI**

Use a restrained full-width work surface: compact task header, status timeline, current-page field progress, browser connection, and only context-valid commands. Reconnect SSE with backoff and display the last checkpoint while disconnected. Do not place instructional feature copy or a submit control in the application.

- [ ] **Step 4: Verify create, login, reconnect, cancel, and narrow layout**

Run: `pnpm --filter @resume/web test -- ApplicationTaskPage.test.tsx NewApplicationPage.test.tsx && pnpm --filter @resume/web build`
Expected: PASS and production build completes.

- [ ] **Step 5: Commit task UI**

```bash
git add apps/web/src
git commit -m "feat: add live application task workspace"
```

### Task 3: Add aggregated questions and content review

**Files:**
- Create: `apps/web/src/applications/QuestionPanel.tsx`
- Create: `apps/web/src/applications/ContentReviewPage.tsx`
- Create: `apps/web/src/applications/EvidenceList.tsx`
- Test: `apps/web/src/applications/QuestionPanel.test.tsx`
- Test: `apps/web/src/applications/ContentReviewPage.test.tsx`

**Interfaces:**
- Consumes: grouped `needs_question` decisions and self-evaluation drafts.
- Produces: one page-level answer command and explicit adopt/edit/reject review commands.

- [ ] **Step 1: Write failing grouped-question and review tests**

```tsx
it("sends all current-page answers in one command", async () => {
  render(<QuestionPanel questions={twoQuestions} onSubmit={submit} />);
  await userEvent.type(screen.getByLabelText("可入职时间"), "2026-08-15");
  await userEvent.click(screen.getByLabelText("接受出差"));
  await userEvent.click(screen.getByRole("button", { name: "继续填写" }));
  expect(submit).toHaveBeenCalledWith(expect.arrayContaining([
    expect.objectContaining({ scope: "application" })
  ]));
});
```

- [ ] **Step 2: Run review UI tests and verify failure**

Run: `pnpm --filter @resume/web test -- QuestionPanel.test.tsx ContentReviewPage.test.tsx`
Expected: FAIL because review components are absent.

- [ ] **Step 3: Implement answer scope and side-by-side content diff**

Question answers default to application scope and require a separate checkbox to save as a profile default. The review page shows original, draft, editable final text, reasons, evidence, and unsupported-claim warnings. `blocked` drafts have no approve command.

- [ ] **Step 4: Verify editing, rejection, evidence inspection, and scope promotion**

Run: `pnpm --filter @resume/web test -- QuestionPanel.test.tsx ContentReviewPage.test.tsx`
Expected: PASS; no draft is approved implicitly.

- [ ] **Step 5: Commit questions and reviews**

```bash
git add apps/web/src/applications
git commit -m "feat: review questions and tailored content"
```

### Task 4: Add Moka adapter behind the generic interface

**Files:**
- Create: `packages/site-adapters/package.json`
- Create: `packages/site-adapters/src/adapter.ts`
- Create: `packages/site-adapters/src/registry.ts`
- Create: `packages/site-adapters/src/moka/detect.ts`
- Create: `packages/site-adapters/src/moka/observe.ts`
- Create: `packages/site-adapters/src/moka/execute.ts`
- Create: `tests/fixtures/ats/moka/application.html`
- Test: `packages/site-adapters/src/moka/moka.test.ts`

**Interfaces:**
- Consumes: generic raw observation and worker-internal element registry.
- Produces: `SiteAdapter.detect`, `enhanceSnapshot`, and `executeCustomControl`; policy remains external.

- [ ] **Step 1: Write failing Moka fixture tests**

```ts
it("normalizes Moka repeatable experience and cascaded location controls", async () => {
  const snapshot = await observeFixture("moka/application.html", mokaAdapter);
  expect(snapshot.fields.map(field => field.semanticHint)).toEqual(expect.arrayContaining([
    "work_experience[0].company", "work_experience[0].start_date", "basics.location"
  ]));
});
```

- [ ] **Step 2: Run adapter tests and verify failure**

Run: `pnpm --filter @resume/site-adapters test -- moka.test.ts`
Expected: FAIL because the adapter package is missing.

- [ ] **Step 3: Implement detection and custom controls without policy bypass**

```ts
export interface SiteAdapter {
  id: "moka" | "beisen";
  detect(input: AdapterDetectionInput): boolean;
  enhanceSnapshot(input: RawObservation, base: FormSnapshot): FormSnapshot;
  executeCustomControl(input: ApprovedAdapterCommand, registry: ElementRegistry): Promise<ExecutionResult>;
}
```

Detection uses stable host/DOM fingerprints from sanitized fixtures. Custom execution accepts only an already approved field operation and returns normal readback results.

- [ ] **Step 4: Verify Moka dates, location, repeat groups, upload, and terminal actions**

Run: `pnpm --filter @resume/site-adapters test -- moka.test.ts`
Expected: PASS; final actions retain `terminal_submit` classification.

- [ ] **Step 5: Commit Moka adapter**

```bash
git add packages/site-adapters tests/fixtures/ats/moka
git commit -m "feat: support Moka application forms"
```

### Task 5: Add Beisen adapter behind the same interface

**Files:**
- Create: `packages/site-adapters/src/beisen/detect.ts`
- Create: `packages/site-adapters/src/beisen/observe.ts`
- Create: `packages/site-adapters/src/beisen/execute.ts`
- Create: `tests/fixtures/ats/beisen/application.html`
- Test: `packages/site-adapters/src/beisen/beisen.test.ts`

**Interfaces:**
- Consumes: `SiteAdapter` contract from Task 4.
- Produces: Beisen dynamic section, date, select, and upload support.

- [ ] **Step 1: Write failing Beisen fixture tests**

```ts
it("keeps Beisen dynamic education rows distinct", async () => {
  const snapshot = await observeFixture("beisen/application.html", beisenAdapter);
  expect(snapshot.fields.filter(field => field.semanticHint?.startsWith("education[0]"))).not.toHaveLength(0);
  expect(snapshot.fields.filter(field => field.semanticHint?.startsWith("education[1]"))).not.toHaveLength(0);
});
```

- [ ] **Step 2: Run Beisen tests and verify failure**

Run: `pnpm --filter @resume/site-adapters test -- beisen.test.ts`
Expected: FAIL because Beisen adapter is missing.

- [ ] **Step 3: Implement Beisen detection, normalization, and approved custom execution**

Register Beisen after exact detection and before generic fallback. Preserve repeat-group indexes, map custom select display values to available options, and return `needs_question` rather than guessing when no option matches.

- [ ] **Step 4: Verify all Beisen fixture states**

Run: `pnpm --filter @resume/site-adapters test -- beisen.test.ts`
Expected: PASS for repeat groups, date controls, selects, uploads, validation, and final-action blocking.

- [ ] **Step 5: Commit Beisen adapter**

```bash
git add packages/site-adapters/src/beisen tests/fixtures/ats/beisen
git commit -m "feat: support Beisen application forms"
```

### Task 6: Implement final review, recovery, audit redaction, and credentials

**Files:**
- Create: `apps/web/src/applications/FinalReviewPage.tsx`
- Create: `apps/api/src/audit/audit-event.ts`
- Create: `apps/api/src/audit/redact.ts`
- Create: `apps/api/src/credentials/credential-store.ts`
- Create: `apps/api/src/credentials/keytar-store.ts`
- Test: `apps/web/src/applications/FinalReviewPage.test.tsx`
- Test: `apps/api/src/audit/redact.test.ts`
- Test: `apps/api/src/applications/recovery.test.ts`
- Test: `apps/api/src/credentials/model-payload.test.ts`

**Interfaces:**
- Consumes: review-locked task summary, checkpoints, audit events, and model provider settings.
- Produces: final audit UI, safe recovery, redacted logs, and OS-protected API key storage.

- [ ] **Step 1: Write failing safety and recovery tests**

```tsx
it("offers browser review without an application submit control", () => {
  render(<FinalReviewPage summary={completeSummary} />);
  expect(screen.getByRole("button", { name: "切换到浏览器审核" })).toBeVisible();
  expect(screen.queryByRole("button", { name: /提交|投递|发送/ })).not.toBeInTheDocument();
});
```

```ts
it("redacts secrets and re-observes before recovery", async () => {
  expect(redactAudit({ cookie: "secret", authorization: "Bearer x", fieldLabel: "邮箱" }))
    .toEqual({ cookie: "[REDACTED]", authorization: "[REDACTED]", fieldLabel: "邮箱" });
  await recovery.resume("task-1");
  expect(browser.observe).toHaveBeenCalledBefore(browser.execute);
});

it("sends only field-scoped evidence to the model", async () => {
  await modelGateway.resolveField(emailFieldRequest);
  expect(provider.lastPayload).toMatchObject({ fieldLabel: "邮箱", evidence: [expect.any(String)] });
  expect(JSON.stringify(provider.lastPayload)).not.toMatch(/cookie|authorization|localStorage|password/i);
});
```

- [ ] **Step 2: Run final-review and recovery tests and verify failure**

Run: `pnpm --filter @resume/web test -- FinalReviewPage.test.tsx && pnpm --filter @resume/api test -- redact.test.ts recovery.test.ts model-payload.test.ts`
Expected: FAIL because final review, redaction, and recovery composition are missing.

- [ ] **Step 3: Implement safe review and local secret storage**

Show every filled field, evidence source, task answer, tailored-text diff, page error, unresolved item, and policy denial. The only primary command switches focus to the visible browser. Store provider API keys under service `resume-assistant` and account `model-provider`; expose only `get`, `set`, and `delete` through `CredentialStore`.

- [ ] **Step 4: Verify redaction matrix, restart recovery, final-page recovery, and credential round trip**

Run: `pnpm --filter @resume/api test -- redact.test.ts recovery.test.ts credential-store.test.ts model-payload.test.ts && pnpm --filter @resume/web test -- FinalReviewPage.test.tsx`
Expected: PASS; final-page recovery enters `review_locked` immediately and logs contain no secret values.

- [ ] **Step 5: Commit hardening**

```bash
git add apps/api/src/audit apps/api/src/credentials apps/api/src/applications apps/web/src/applications
git commit -m "feat: harden final review and task recovery"
```

### Task 7: Add local startup, packaging, and complete acceptance tests

**Files:**
- Create: `scripts/dev.mjs`
- Create: `scripts/start.mjs`
- Create: `scripts/preflight.mjs`
- Modify: `package.json`
- Create: `tests/acceptance/profile-and-rag.spec.ts`
- Create: `tests/acceptance/generic-ats.spec.ts`
- Create: `tests/acceptance/adapters.spec.ts`
- Create: `tests/acceptance/recovery-and-safety.spec.ts`
- Create: `README.md`

**Interfaces:**
- Consumes: complete MVP.
- Produces: one local start command, preflight diagnostics, and executable acceptance evidence.

- [ ] **Step 1: Write the failing acceptance matrix**

Add named tests for all 12 acceptance criteria from the design specification. The terminal-safety test must assert both zero server-side submissions and a `policy_denied` audit event for each terminal variant.

```ts
test("AC11: automation cannot submit any terminal variant", async ({ request }) => {
  for (const variant of terminalVariants) {
    const task = await runApplicationToReview(request, variant.url);
    expect(task.state).toBe("review_locked");
    expect(await variant.submissionCount()).toBe(0);
    expect(await auditContains(task.id, "policy_denied", variant.actionId)).toBe(true);
  }
});
```

- [ ] **Step 2: Run acceptance tests and verify failure**

Run: `pnpm exec playwright test tests/acceptance`
Expected: FAIL until startup orchestration and all acceptance fixtures are wired.

- [ ] **Step 3: Implement preflight and one-command local startup**

`pnpm dev` starts API, Web, browser worker on demand, and synthetic ATS with coordinated shutdown. `pnpm start` serves the production web build and loopback API. Preflight verifies Node version, Playwright Chromium, writable app-data directories, SQLite FTS5, OCR language data, provider credential presence, and free ports without printing secrets.

- [ ] **Step 4: Run the complete release gate**

Run: `pnpm typecheck && pnpm test && pnpm build && pnpm exec playwright test tests/browser tests/acceptance`
Expected: every command exits 0; all 12 acceptance criteria pass; synthetic ATS submission count is zero.

- [ ] **Step 5: Perform local smoke test and commit the MVP**

Run: `pnpm start`
Expected: output includes `Web: http://127.0.0.1:43110` and `API: http://127.0.0.1:43120`; importing a fixture resume reaches profile review, and a synthetic application reaches final review without submitting.

```bash
git add package.json scripts tests/acceptance README.md
git commit -m "feat: complete local resume application assistant mvp"
```

## Plan 3 Completion Gate

- The local web app supports profile, task, questions, content review, and final review workflows.
- Generic, Moka, and Beisen fixtures fill correctly through the same policy boundary.
- Browser and application restarts recover from checkpoints only after re-observation.
- Logs and model calls exclude browser secrets and unrelated page content.
- The UI exposes no submit command and automation remains locked at final review.
- All 12 design acceptance criteria pass under the release-gate command.
