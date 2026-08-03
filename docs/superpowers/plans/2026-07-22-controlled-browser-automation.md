# Controlled Browser Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent Playwright browser, normalized form snapshots, verified page filling, automatic intermediate navigation, and an execution boundary that makes final submission unavailable to the agent.

**Architecture:** The API forks a browser-worker process and communicates through typed Node IPC. The worker observes and executes but never calls a model; the API maps fields through the RAG service, and a pure action-policy package issues short-lived approvals only for permitted actions.

**Tech Stack:** Existing Plan 1 stack plus Playwright 1.53.1, XState 5.19.4, Node child-process IPC, local synthetic ATS fixtures, Vitest, and Playwright Test

**Status:** Implementation and verification complete on 2026-07-27. Commit steps remain pending by user choice.

## Global Constraints

- Complete Plan 1 before starting this plan.
- The model receives normalized snapshots and may reference only opaque field/action IDs.
- The model cannot send coordinates, selectors, JavaScript, network requests, or raw Playwright commands.
- Every mutating browser command requires a policy approval bound to task, page snapshot, action, and expiry.
- `terminal_submit` never receives an approval and is not part of the executor command union.
- `unknown_side_effect` is blocked until user clarification; uncertainty never defaults to clicking.
- Intermediate save/navigation is automatic only after current-page readback and validation pass.
- Login, CAPTCHA, SMS, QR, and MFA remain manual.

---

## File Structure

```text
packages/contracts/src/browser.ts       Snapshot and IPC schemas
packages/form-semantics/                Generic DOM-to-form normalization
packages/action-policy/                 Pure classification and approval logic
apps/browser-worker/                    Persistent Chromium and approved executor
apps/api/src/browser/                   Worker lifecycle and typed IPC client
apps/api/src/applications/              State machine and checkpoints
apps/synthetic-ats/                     Deterministic multi-page test site
tests/browser/                           Security and end-to-end scenarios
```

### Task 1: Define browser snapshots and closed command unions

**Files:**
- Create: `packages/contracts/src/browser.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/browser.test.ts`

**Interfaces:**
- Consumes: shared Zod conventions from Plan 1.
- Produces: `FormSnapshot`, `FormField`, `PageAction`, `WorkerRequest`, `WorkerResponse`, and `ExecutableCommand`.

- [x] **Step 1: Write a failing test proving submit is not executable**

```ts
it("has no executable submit command", () => {
  expect(ExecutableCommandSchema.safeParse({
    type: "submit", taskId: "task-1", actionId: "final"
  }).success).toBe(false);
});
```

- [x] **Step 2: Run the contract test and verify failure**

Run: `pnpm --filter @resume/contracts test -- browser.test.ts`
Expected: FAIL because `ExecutableCommandSchema` is missing.

- [x] **Step 3: Implement the exact closed unions**

```ts
export const ActionClassSchema = z.enum([
  "safe_edit", "intermediate_save", "intermediate_navigation",
  "unknown_side_effect", "terminal_submit"
]);
export const FormFieldSchema = z.object({
  id: z.string(), label: z.string(), type: z.enum(["text", "textarea", "select", "radio", "checkbox", "date", "file"]),
  required: z.boolean(), options: z.array(z.string()), currentValue: z.unknown(), semanticHint: z.string().optional()
});
export const PageActionSchema = z.object({ id: z.string(), text: z.string(), class: ActionClassSchema });
export const FormSnapshotSchema = z.object({
  id: z.string(), taskId: z.string(), url: z.string().url(), title: z.string(),
  stage: z.enum(["login", "application_form", "review", "success", "unknown"]),
  fields: z.array(FormFieldSchema), actions: z.array(PageActionSchema), errors: z.array(z.string())
});
export const ExecutableCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fill"), taskId: z.string(), snapshotId: z.string(), fieldId: z.string(), value: z.unknown(), approval: z.string() }),
  z.object({ type: z.literal("select"), taskId: z.string(), snapshotId: z.string(), fieldId: z.string(), value: z.string(), approval: z.string() }),
  z.object({ type: z.literal("upload"), taskId: z.string(), snapshotId: z.string(), fieldId: z.string(), fileId: z.string(), approval: z.string() }),
  z.object({ type: z.literal("click_intermediate"), taskId: z.string(), snapshotId: z.string(), actionId: z.string(), approval: z.string() })
]);
```

- [x] **Step 4: Verify accepted and rejected command shapes**

Run: `pnpm --filter @resume/contracts test -- browser.test.ts`
Expected: PASS; fill and intermediate-click parse, submit and arbitrary-script commands fail.

- [ ] **Step 5: Commit contracts**

```bash
git add packages/contracts
git commit -m "feat: define closed browser command contracts"
```

### Task 2: Build the generic form snapshot parser

**Files:**
- Create: `packages/form-semantics/package.json`
- Create: `packages/form-semantics/src/snapshot-script.ts`
- Create: `packages/form-semantics/src/normalize.ts`
- Create: `packages/form-semantics/src/action-classifier.ts`
- Test: `packages/form-semantics/src/normalize.test.ts`
- Create: `tests/fixtures/forms/generic-application.html`

**Interfaces:**
- Consumes: a serializable raw DOM observation.
- Produces: `normalizeForm(raw, context): FormSnapshot` with stable opaque IDs.

- [x] **Step 1: Write failing parser and action-classification tests**

```ts
it.each([
  ["下一步", "intermediate_navigation"],
  ["保存草稿", "intermediate_save"],
  ["提交申请", "terminal_submit"],
  ["完成", "terminal_submit"],
  ["发送验证码", "unknown_side_effect"]
])("classifies %s as %s", (text, expected) => {
  expect(classifyAction({ text, stage: "review", nearbyText: "确认后将正式投递" })).toBe(expected);
});
```

- [x] **Step 2: Run semantic tests and verify failure**

Run: `pnpm --filter @resume/form-semantics test`
Expected: FAIL because parser and classifier are missing.

- [x] **Step 3: Implement accessible-label extraction and conservative actions**

Generate field labels from explicit `<label for>`, wrapping labels, `aria-label`, `aria-labelledby`, then nearby text. Generate IDs by hashing snapshot-local DOM paths; never expose selectors outside the worker. Classify review-stage unknown confirmation controls as `unknown_side_effect`, never as intermediate navigation.

```ts
export function classifyAction(input: ActionContext): ActionClass {
  const text = normalizeText(`${input.text} ${input.ariaLabel} ${input.nearbyText}`);
  if (matchesTerminalIntent(text, input.stage)) return "terminal_submit";
  if (matchesSaveDraft(text)) return "intermediate_save";
  if (matchesNextStep(text) && input.stage !== "review") return "intermediate_navigation";
  return "unknown_side_effect";
}
```

- [x] **Step 4: Verify standard controls, dynamic labels, icon actions, and review stage**

Run: `pnpm --filter @resume/form-semantics test`
Expected: PASS with every fixture field labeled and every terminal variant blocked.

- [ ] **Step 5: Commit generic semantics**

```bash
git add packages/form-semantics tests/fixtures/forms
git commit -m "feat: normalize generic recruitment forms"
```

### Task 3: Implement policy approvals as unforgeable capabilities

**Files:**
- Create: `packages/action-policy/package.json`
- Create: `packages/action-policy/src/policy.ts`
- Create: `packages/action-policy/src/approval-store.ts`
- Test: `packages/action-policy/src/policy.test.ts`

**Interfaces:**
- Consumes: current `FormSnapshot`, requested operation, and page validation result.
- Produces: one-use `ActionApproval` for allowed commands; throws `PolicyDeniedError` otherwise.

- [x] **Step 1: Write failing policy tests**

```ts
it("never approves terminal actions even when requested as intermediate", () => {
  const request = clickRequest({ actionId: "final", requestedType: "click_intermediate" });
  expect(() => policy.approve(request, reviewSnapshotWithSubmit())).toThrow(PolicyDeniedError);
});

it("approves next only after page validation", () => {
  expect(() => policy.approve(nextRequest, snapshot, { valid: false })).toThrow("page_not_valid");
  expect(policy.approve(nextRequest, snapshot, { valid: true })).toMatchObject({ oneUse: true });
});
```

- [x] **Step 2: Run policy tests and verify failure**

Run: `pnpm --filter @resume/action-policy test`
Expected: FAIL because no policy exists.

- [x] **Step 3: Implement bound, expiring, one-use approvals**

```ts
export interface ActionApproval {
  token: string;
  taskId: string;
  snapshotId: string;
  targetId: string;
  operation: "fill" | "select" | "upload" | "click_intermediate";
  expiresAt: number;
  oneUse: true;
}
```

Use 30-second expiry, compare task/snapshot/target/operation exactly, sign the canonical approval payload with HMAC-SHA256, consume token IDs atomically, and deny `terminal_submit`, `unknown_side_effect`, stale snapshots, invalid pages, altered signatures, and reused tokens. The worker receives the session signing key during its initial IPC handshake and verifies the capability independently before touching the page.

- [x] **Step 4: Run policy and replay tests**

Run: `pnpm --filter @resume/action-policy test`
Expected: PASS for expiry, replay, target swap, stale snapshot, terminal action, and valid intermediate action.

- [ ] **Step 5: Commit the policy boundary**

```bash
git add packages/action-policy
git commit -m "feat: enforce one-use browser action approvals"
```

### Task 4: Launch a persistent browser worker over typed IPC

**Files:**
- Create: `apps/browser-worker/package.json`
- Create: `apps/browser-worker/src/main.ts`
- Create: `apps/browser-worker/src/session-manager.ts`
- Create: `apps/browser-worker/src/ipc-server.ts`
- Create: `apps/api/src/browser/worker-client.ts`
- Test: `apps/api/src/browser/worker-client.test.ts`

**Interfaces:**
- Consumes: `WorkerRequest` and browser profile directory.
- Produces: `BrowserWorkerClient.start`, `open`, `observe`, `execute`, and `stop`.

- [x] **Step 1: Write a failing IPC lifecycle test**

```ts
it("starts a worker, opens a page, and rejects malformed IPC", async () => {
  const client = await BrowserWorkerClient.start(testProfileDir);
  await expect(client.open(syntheticAtsUrl)).resolves.toMatchObject({ ok: true });
  await expect(client.sendRaw({ type: "evaluate", script: "document.cookie" })).rejects.toThrow("invalid_worker_request");
  await client.stop();
});
```

- [x] **Step 2: Run worker tests and verify failure**

Run: `pnpm --filter @resume/api test -- worker-client.test.ts`
Expected: FAIL because the worker client is missing.

- [x] **Step 3: Implement forked worker and persistent context**

Launch Chromium with `userDataDir` under local app data, visible UI, downloads disabled by default, and no remote debugging port. Establish the per-process approval key during the first typed IPC handshake, parse every subsequent message with Zod, and correlate responses by request ID. Expose no raw page, locator, evaluate, or CDP method through IPC.

- [x] **Step 4: Verify lifecycle and manual-login persistence**

Run: `pnpm --filter @resume/api test -- worker-client.test.ts`
Expected: PASS; a cookie set manually in one worker session remains after restart, while malformed commands are rejected.

- [ ] **Step 5: Commit browser lifecycle**

```bash
git add apps/browser-worker apps/api/src/browser
git commit -m "feat: add persistent controlled browser worker"
```

### Task 5: Execute approved filling and perform page readback

**Files:**
- Create: `apps/browser-worker/src/dom-registry.ts`
- Create: `apps/browser-worker/src/executor.ts`
- Create: `apps/browser-worker/src/observer.ts`
- Test: `apps/browser-worker/src/executor.test.ts`

**Interfaces:**
- Consumes: `ExecutableCommand`, independently verified one-use approval capability, and current DOM registry.
- Produces: `ExecutionResult` with actual value, browser errors, changed fields, and new snapshot ID.

- [x] **Step 1: Write failing fill/readback tests**

```ts
it("fills by opaque field id and returns the browser value", async () => {
  const snapshot = await observer.observe(page, "task-1");
  const field = snapshot.fields.find(item => item.label === "邮箱")!;
  const result = await executor.execute(approvedFill(snapshot, field.id, "me@example.com"));
  expect(result).toMatchObject({ ok: true, actualValue: "me@example.com" });
  expect(await page.locator("#email").inputValue()).toBe("me@example.com");
});
```

- [x] **Step 2: Run executor tests and verify failure**

Run: `pnpm --filter @resume/browser-worker test -- executor.test.ts`
Expected: FAIL because registry and executor are missing.

- [x] **Step 3: Implement registry-bound operations and validation events**

Resolve opaque IDs only inside the worker. For text controls use `fill` then `blur`; for selects use `selectOption`; for custom controls use adapter commands added in Plan 3. After every operation, read the actual value, collect visible validation messages, and issue a fresh snapshot ID so old approvals become stale.

- [x] **Step 4: Verify text, select, checkbox, date, file, stale ID, and validation error paths**

Run: `pnpm --filter @resume/browser-worker test -- executor.test.ts`
Expected: PASS; stale IDs and mismatched readback fail closed.

- [ ] **Step 5: Commit approved execution**

```bash
git add apps/browser-worker
git commit -m "feat: execute approved form fills with readback"
```

### Task 6: Add the application state machine and checkpoints

**Files:**
- Create: `apps/api/src/applications/application-machine.ts`
- Create: `apps/api/src/applications/application-service.ts`
- Create: `apps/api/src/applications/checkpoint-repository.ts`
- Test: `apps/api/src/applications/application-machine.test.ts`

**Interfaces:**
- Consumes: browser client, RAG field resolver, policy, and SQLite checkpoint repository.
- Produces: `ApplicationService.start`, `resume`, `answerQuestions`, `approveReview`, and observable task state.

- [x] **Step 1: Write failing state and lock tests**

```ts
it("moves to review_locked and refuses further automated clicks", async () => {
  const service = testApplicationService({ snapshots: [formSnapshot, reviewSnapshot] });
  await service.runUntilPause("task-1");
  expect(service.state("task-1").value).toBe("review_locked");
  await expect(service.requestIntermediateClick("task-1", "final-action")).rejects.toThrow("review_locked");
});
```

- [x] **Step 2: Run state-machine tests and verify failure**

Run: `pnpm --filter @resume/api test -- application-machine.test.ts`
Expected: FAIL because the application machine is missing.

- [x] **Step 3: Implement explicit transitions and checkpoint writes**

Persist after observe, answer, approve-content, fill-page, validate-page, and navigate. On resume, always observe again and compare URL, stage, field set, and snapshot fingerprint before continuing. Aggregate all `needs_question` decisions for the current page into one pause event.

- [x] **Step 4: Verify normal, question, review, validation failure, restart, and final-lock flows**

Run: `pnpm --filter @resume/api test -- application-machine.test.ts`
Expected: PASS for all legal transitions; illegal transitions and blind replay are rejected.

- [ ] **Step 5: Commit orchestration**

```bash
git add apps/api/src/applications
git commit -m "feat: orchestrate checkpointed application filling"
```

### Task 7: Prove safety with a synthetic multi-page ATS

**Files:**
- Create: `apps/synthetic-ats/package.json`
- Create: `apps/synthetic-ats/src/server.ts`
- Create: `apps/synthetic-ats/public/application.html`
- Create: `apps/synthetic-ats/public/review.html`
- Create: `tests/browser/application-flow.spec.ts`
- Create: `tests/browser/submit-safety.spec.ts`

**Interfaces:**
- Consumes: complete controlled-browser stack.
- Produces: deterministic E2E evidence that intermediate navigation works and terminal submission cannot be automated.

- [x] **Step 1: Write failing end-to-end scenarios**

```ts
test("fills two pages automatically and stops before submit", async ({ request }) => {
  const task = await createTask(request, syntheticAtsApplicationUrl);
  await waitForState(request, task.id, "review_locked");
  expect(await syntheticAtsSubmissionCount(request)).toBe(0);
  expect(await readSyntheticDraft(request, task.id)).toMatchObject({ email: "me@example.com" });
});
```

- [x] **Step 2: Run E2E and verify failure**

Run: `pnpm exec playwright test tests/browser`
Expected: FAIL before the synthetic ATS and integrated flow are available.

- [x] **Step 3: Implement the synthetic ATS and adversarial terminal variants**

Include normal “下一步”, draft autosave, client validation, dynamic fields, review page, `提交申请`, `确认投递`, `完成`, `立即申请`, icon-only `aria-label`, iframe submit, modal submit, and page text instructing the agent to ignore safety rules. Count submissions server-side.

- [x] **Step 4: Run full Plan 2 verification**

Run: `pnpm test && pnpm typecheck && pnpm build && pnpm exec playwright test tests/browser`
Expected: all checks pass; every flow reaches `review_locked`, intermediate drafts are saved, and submission count remains zero.

- [ ] **Step 5: Commit the controlled browser milestone**

```bash
git add apps/synthetic-ats tests/browser
git commit -m "test: prove controlled browser never submits"
```

## Plan 2 Completion Gate

- The visible persistent browser supports manual login state.
- Generic forms normalize into opaque-ID snapshots.
- Filling requires one-use policy approvals and returns readback evidence.
- Valid pages automatically save and navigate intermediate steps.
- Unknown effects pause; review pages enter `review_locked`.
- No command union, IPC route, or policy path can represent final submission.
- Synthetic ATS submission count stays zero across the full security matrix.
