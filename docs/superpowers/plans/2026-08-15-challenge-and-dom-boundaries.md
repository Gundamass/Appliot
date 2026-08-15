# ATS Challenge and DOM Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect CAPTCHA, HTTP 403/429, device verification, risk-control pages and unsupported interactive DOM boundaries, persist a paused state, and resume only after an explicit user command starts a fresh observation/planning/authorization cycle.

**Architecture:** Browser Worker emits a sanitized `ChallengeDiagnostic` as part of each observation and never traverses unsupported iframe/Shadow DOM content. `ApplicationService` coordinates a persistent `awaiting_challenge` transition, advances the execution epoch and clears all browser-side execution state. A dedicated `resume_after_challenge` command is the sole exit and always observes a fresh page before planning.

**Tech Stack:** TypeScript 5.8, Zod, Vitest, Fastify 5, XState 5.19, React, Playwright Core 1.53, pnpm 10.

## Global Constraints

- Execute after `2026-08-15-runtime-node-identity-and-readback.md`; this plan requires `NodeRef`, `NodeRegistry.release()` and approval invalidation.
- Work in the current repository and preserve all pre-existing changes; stage only the files listed by the current task.
- Write and run a failing test before every production change.
- Every shell command starts with `rtk`; every manual edit uses `apply_patch`.
- Every CAPTCHA, 403, 429, device-verification, risk-control event or unsupported interactive DOM boundary enters `awaiting_challenge`.
- A page that merely looks normal must not resume automation. Only the user's explicit `resume_after_challenge` command may leave the paused state.
- Resume starts with fresh observation, planning and authorization; old execution epoch, NodeRefs, registries and unused approvals remain invalid.
- iframe and Shadow DOM content is diagnosed but never traversed or automated in this MVP.
- Challenge diagnostics contain only finite enums, timestamps, counts and sanitized reason codes; never store original DOM, selectors, coordinates, CAPTCHA text or user input.
- Formal page-rule support remains Moka/Mokahr Chinese main-document flows and DJI paths.
- Real ATS validation stops at final review and requires `submissionCount === 0`; never approve or click final submit.

## File Structure

- `packages/contracts/src/browser.ts`: challenge and boundary schemas carried by `FormSnapshot`.
- `packages/contracts/src/application.ts`: persistent application state, diagnostic projection and explicit resume command.
- `apps/browser-worker/src/challenge-detector.ts`: HTTP/page-signal classification and bounded boundary scan.
- `apps/browser-worker/src/observer.ts`: includes detector output in each observation.
- `apps/browser-worker/src/session-manager.ts`: tracks main-document 403/429 and clears executor state on invalidation.
- `apps/browser-worker/src/executor.ts`: rejects operations after invalidation and releases unused approvals/registry.
- `apps/api/src/applications/application-machine.ts`: owns `awaiting_challenge` and its sole resume transition.
- `apps/api/src/applications/checkpoint-repository.ts`: persists diagnostic through the existing checkpoint JSON.
- `apps/api/src/applications/challenge-coordinator.ts`: centralizes transition, invalidation and restart behavior.
- `apps/api/src/applications/application-service.ts`: invokes the coordinator before any planning or execution.
- `apps/api/src/applications/routes.ts`: exposes state/diagnostic and dispatches `resume_after_challenge`.
- `apps/web/src/applications/ApplicationTaskPage.tsx`: shows the finite reason and “继续填写” button.
- `apps/synthetic-ats/public/challenge-p0.html`: deterministic challenge/iframe/Shadow DOM fixtures.
- `tests/browser/ats-challenge-p0.spec.ts`: persistent pause, stale-token and no-submit regression.

---

### Task 1: Define sanitized Challenge and boundary contracts

**Files:**
- Modify: `packages/contracts/src/browser.ts`
- Modify: `packages/contracts/src/browser.test.ts`
- Modify: `packages/contracts/src/application.ts`
- Modify: `packages/contracts/src/application.test.ts`

**Interfaces:**
- Produces: `ChallengeKind` finite enum.
- Produces: `DomBoundary = { kind, visible, interactive, reasonCode }`.
- Produces: `ChallengeDiagnostic = { kind, detectedAt, reasonCode }`.
- Extends: `FormSnapshot` with `boundaries` and optional `challenge`.
- Extends: `ApplicationTaskState` with `awaiting_challenge`, `ApplicationTask` with optional `challenge`, and commands with `resume_after_challenge`.

- [ ] **Step 1: Write failing strict-schema tests**

Add these representative parses:

```ts
const challenge = {
  kind: "captcha",
  detectedAt: "2026-08-15T00:00:00.000Z",
  reasonCode: "moka_captcha_accessible_name"
};
expect(ChallengeDiagnosticSchema.parse(challenge)).toEqual(challenge);
expect(ApplicationTaskStateSchema.parse("awaiting_challenge")).toBe("awaiting_challenge");
expect(ApplicationCommandSchema.parse({ type: "resume_after_challenge" }))
  .toEqual({ type: "resume_after_challenge" });
```

Assert arbitrary `text`, `html`, `selector` and `coordinates` properties are rejected by `.strict()`.

- [ ] **Step 2: Run contracts tests and confirm RED**

```text
rtk pnpm --filter @resume/contracts test -- browser.test.ts application.test.ts
```

Expected: FAIL because the schemas, state and command do not exist.

- [ ] **Step 3: Add finite schemas**

Use these exact finite values:

```ts
export const ChallengeKindSchema = z.enum([
  "captcha", "access_denied", "rate_limited", "device_verification",
  "risk_control", "unsupported_iframe", "unsupported_shadow_dom"
]);

export const DomBoundarySchema = z.object({
  kind: z.enum(["iframe", "shadow_root", "closed_shadow_host"]),
  visible: z.boolean(),
  interactive: z.boolean(),
  reasonCode: z.string().min(1).max(128)
}).strict();

export const ChallengeDiagnosticSchema = z.object({
  kind: ChallengeKindSchema,
  detectedAt: z.string().datetime(),
  reasonCode: z.string().min(1).max(128)
}).strict();
```

Limit `FormSnapshot.boundaries` to 50 entries. `ApplicationTask.challenge` reuses `ChallengeDiagnosticSchema` rather than defining a divergent API type.

- [ ] **Step 4: Run tests, typecheck and commit**

```text
rtk pnpm --filter @resume/contracts test -- browser.test.ts application.test.ts
rtk pnpm typecheck
rtk git add packages/contracts/src/browser.ts packages/contracts/src/browser.test.ts packages/contracts/src/application.ts packages/contracts/src/application.test.ts
rtk git commit -m "feat: define ATS challenge contracts"
```

Expected: PASS and the contract rejects all non-finite diagnostic payloads.

---

### Task 2: Detect HTTP, page and unsupported-boundary challenges

**Files:**
- Create: `apps/browser-worker/src/challenge-detector.ts`
- Create: `apps/browser-worker/src/challenge-detector.test.ts`
- Modify: `apps/browser-worker/src/observer.ts`
- Modify: `apps/browser-worker/src/observer.test.ts`
- Modify: `apps/browser-worker/src/session-manager.ts`
- Modify: `apps/browser-worker/src/session-manager.test.ts`

**Interfaces:**
- Produces: `ChallengeDetector.start(page): void`, `inspect(): Promise<ChallengeInspection>`, `dispose(): void`.
- Produces: `ChallengeInspection = { boundaries: DomBoundary[]; challenge?: ChallengeDiagnostic }`.
- Consumes: current main-frame response events and bounded URL/title/accessibility signals.

- [ ] **Step 1: Write pure classification tests**

Cover the exact mapping:

```ts
expect(classifyHttpStatus(403)).toBe("access_denied");
expect(classifyHttpStatus(429)).toBe("rate_limited");
expect(classifyHttpStatus(200)).toBeUndefined();
```

Use sanitized Moka/DJI fixtures for CAPTCHA, device verification and risk control. Assert an unknown-site body containing the word “captcha” alone does not trigger a text-rule diagnosis.

- [ ] **Step 2: Write boundary scan tests**

Build pages containing: a visible interactive iframe; a visible noninteractive iframe; an invisible analytics iframe; an open Shadow Root with an input; an open Shadow Root without controls; and a visible button-like host with a closed root. Assert every visible iframe blocks conservatively, the hidden analytics iframe does not, only interactive Shadow boundaries block, and returned data has no DOM text or selectors.

- [ ] **Step 3: Run browser-worker tests and confirm RED**

```text
rtk pnpm --filter @resume/browser-worker test -- challenge-detector.test.ts observer.test.ts session-manager.test.ts
```

Expected: FAIL because response tracking and boundary diagnostics do not exist.

- [ ] **Step 4: Implement response tracking and finite rule classification**

Subscribe to `page.on("response")`; retain only the latest status when `response.request().isNavigationRequest()` and `response.frame() === page.mainFrame()`. Do not retain URL query strings or response bodies.

For Moka/Mokahr and DJI hosts, classify from normalized URL pathname, title and a capped set of accessible names. Return reason codes such as `moka_captcha_accessible_name`, `dji_device_verification_title` and `main_document_http_429`; never return the matched text.

- [ ] **Step 5: Scan only boundary hosts**

Evaluate main-document `iframe` and shadow hosts only. The browser function returns booleans and finite kinds:

```ts
type RawBoundary = {
  kind: "iframe" | "shadow_root" | "closed_shadow_host";
  visible: boolean;
  interactive: boolean;
};
```

Do not inspect iframe documents. Treat every visible iframe as blocking because its content cannot be proven safe without traversal; hidden analytics iframes remain nonblocking. For closed roots, mark a visible host interactive when its role/tag/tabindex/accessibility semantics indicate interaction. Convert a blocking iframe to `unsupported_iframe` and either shadow kind to `unsupported_shadow_dom`.

- [ ] **Step 6: Attach detector output to every observation**

`BrowserObserver.observe()` calls `detector.inspect()` before returning. If a challenge exists, it may return a snapshot with zero fields, but it still includes `frameRef`, `mutationEpoch`, `boundaries` and the challenge. Challenge inspection must occur on every retry of an empty page.

- [ ] **Step 7: Dispose listeners on page/task lifecycle and commit**

```text
rtk pnpm --filter @resume/browser-worker test -- challenge-detector.test.ts observer.test.ts session-manager.test.ts
rtk pnpm typecheck
rtk git add apps/browser-worker/src/challenge-detector.ts apps/browser-worker/src/challenge-detector.test.ts apps/browser-worker/src/observer.ts apps/browser-worker/src/observer.test.ts apps/browser-worker/src/session-manager.ts apps/browser-worker/src/session-manager.test.ts
rtk git commit -m "feat: detect ATS challenges and DOM boundaries"
```

Expected: PASS and listener-count tests show no accumulation after page rebind.

---

### Task 3: Persist `awaiting_challenge` and invalidate execution

**Files:**
- Create: `apps/api/src/applications/challenge-coordinator.ts`
- Create: `apps/api/src/applications/challenge-coordinator.test.ts`
- Modify: `apps/api/src/applications/application-machine.ts`
- Modify: `apps/api/src/applications/application-machine.test.ts`
- Modify: `apps/api/src/applications/checkpoint-repository.ts`
- Create: `apps/api/src/applications/checkpoint-repository.test.ts`
- Modify: `apps/api/src/applications/application-service.ts`
- Modify: `apps/browser-worker/src/executor.ts`
- Modify: `apps/browser-worker/src/executor.test.ts`
- Modify: `apps/browser-worker/src/session-manager.ts`
- Modify: `apps/browser-worker/src/session-manager.test.ts`

**Interfaces:**
- Produces machine events: `CHALLENGE_DETECTED` and `USER_RESUME_CHALLENGE`.
- Produces: `ApplicationService.resumeAfterChallenge(taskId): Promise<void>`.
- Produces: `ControlledExecutor.invalidate(taskId): Promise<void>` that releases the current observation/registry while the advanced signed execution epoch invalidates old approvals.
- Persists: diagnostic in the checkpoint snapshot and machine context.

- [ ] **Step 1: Write state-machine persistence tests**

From each active state (`observing`, `filling`, `validating`, `navigating`), send:

```ts
{ type: "CHALLENGE_DETECTED", challenge }
```

and assert `awaiting_challenge`. Assert `READY_TO_FILL`, `RECOVER`, `PAGE_VALID` and a second observation event cannot leave that state. Only `USER_RESUME_CHALLENGE` reaches `observing` and clears context challenge.

- [ ] **Step 2: Write service invalidation and restart tests**

Use browser fakes to assert this sequence:

```ts
expect(browser.invalidateExecution).toHaveBeenCalledWith(taskId, expect.any(Number));
expect(service.state(taskId).value).toBe("awaiting_challenge");
await service.resumeAfterChallenge(taskId);
expect(browser.observe).toHaveBeenCalledTimes(previousObserveCalls + 1);
expect(oldCommandExecution.errors).toContain("execution_invalidated");
```

Restore a new service from the latest checkpoint and assert it remains paused even when the next browser snapshot has no challenge. Also attempt to submit an unused pre-Challenge approval with the new execution epoch and assert `approval_execution_epoch_mismatch`; attempt its original epoch and assert `execution_invalidated`.

- [ ] **Step 3: Run focused API/worker tests and confirm RED**

```text
rtk pnpm --filter @resume/api test -- challenge-coordinator.test.ts application-machine.test.ts checkpoint-repository.test.ts
rtk pnpm --filter @resume/browser-worker test -- executor.test.ts session-manager.test.ts
```

Expected: FAIL because the state, coordinator and full invalidation do not exist.

- [ ] **Step 4: Add the machine state and context**

Extend context with `challenge?: ChallengeDiagnostic`. Add `CHALLENGE_DETECTED` transitions from all four active states with a `storeChallenge` action. Define:

```ts
awaiting_challenge: {
  on: {
    USER_RESUME_CHALLENGE: { target: "observing", actions: ["clearChallenge", "clearErrors"] }
  }
}
```

Do not add a generic `RECOVER` transition to this state.

- [ ] **Step 5: Implement ChallengeCoordinator ordering**

The entry order is fixed:

```ts
await invalidateExecution(taskId);
sendApplicationEvent(actor, { type: "CHALLENGE_DETECTED", challenge });
persist(actor, snapshot);
```

The resume order is also fixed: verify state, advance/invalidate epoch again, send `USER_RESUME_CHALLENGE`, call `browser.observe()`, reject any newly observed challenge back into the coordinator, then call `runUntilPauseInternal()` with that fresh snapshot. Never reuse `latestSnapshots.get(taskId)` for resume.

- [ ] **Step 6: Clear Worker execution state on invalidation**

`ControlledExecutor.invalidate(taskId)` releases the current registry when it belongs to the task and clears `current`. `BrowserSessionManager.invalidateExecution()` first advances its minimum accepted task epoch and then calls executor invalidation. Because Task 1 signs `executionEpoch` into every approval, an unused old approval cannot be rebound to the new epoch. Do not clear `ApprovalStore`'s consumed-ID set: clearing it would permit replay of already consumed approvals. An in-flight operation observes `isCurrent() === false` and returns `execution_invalidated`.

- [ ] **Step 7: Restore the persisted pause**

`requireActor()` restores `awaiting_challenge` by replaying `CHALLENGE_DETECTED` from `checkpoint.snapshot.challenge`. If the diagnostic is missing or invalid, fail closed with `challenge_checkpoint_invalid`; do not map it to observing.

- [ ] **Step 8: Run tests and commit**

```text
rtk pnpm --filter @resume/api test -- challenge-coordinator.test.ts application-machine.test.ts checkpoint-repository.test.ts
rtk pnpm --filter @resume/browser-worker test -- executor.test.ts session-manager.test.ts
rtk pnpm typecheck
rtk git add apps/api/src/applications/challenge-coordinator.ts apps/api/src/applications/challenge-coordinator.test.ts apps/api/src/applications/application-machine.ts apps/api/src/applications/application-machine.test.ts apps/api/src/applications/checkpoint-repository.ts apps/api/src/applications/checkpoint-repository.test.ts apps/api/src/applications/application-service.ts apps/browser-worker/src/executor.ts apps/browser-worker/src/executor.test.ts apps/browser-worker/src/session-manager.ts apps/browser-worker/src/session-manager.test.ts
rtk git commit -m "feat: persist ATS challenge pauses"
```

Expected: PASS; restart tests remain paused until explicit resume.

---

### Task 4: Expose the explicit resume command and Chinese UI

**Files:**
- Modify: `apps/api/src/applications/routes.ts`
- Modify: `apps/api/src/applications/routes.test.ts`
- Modify: `apps/web/src/applications/ApplicationTaskPage.tsx`
- Modify: `apps/web/src/applications/ApplicationTaskPage.test.tsx`
- Modify: `apps/web/src/applications/application-workbench.ts`
- Modify: `apps/web/src/applications/application-workbench.test.ts`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Maps: internal `awaiting_challenge` to API `awaiting_challenge`.
- Exposes only `cancel` and `resume_after_challenge` while paused.
- Renders finite Chinese copy from `ChallengeKind`, not from arbitrary reason text.

- [ ] **Step 1: Write route command/state tests**

Assert the paused task projection is:

```ts
expect(response.json()).toMatchObject({
  state: "awaiting_challenge",
  commands: ["cancel", "resume_after_challenge"],
  challenge: { kind: "captcha" }
});
```

Assert `resume`, `retry_current`, `manual_done` and `sync_profile` return a stable 4xx error while paused; `resume_after_challenge` calls only `service.resumeAfterChallenge()`.

- [ ] **Step 2: Write UI accessibility tests**

Render each finite kind and assert the reason heading, manual-action sentence and button:

```ts
expect(screen.getByRole("button", { name: "继续填写" })).toBeEnabled();
await user.click(screen.getByRole("button", { name: "继续填写" }));
expect(command).toHaveBeenCalledWith(task.id, { type: "resume_after_challenge" });
```

Assert the UI does not render `reasonCode` as free text.

- [ ] **Step 3: Run API/web tests and confirm RED**

```text
rtk pnpm --filter @resume/api test -- routes.test.ts
rtk pnpm --filter @resume/web test -- ApplicationTaskPage.test.tsx application-workbench.test.ts
```

Expected: FAIL because route mapping, command handling and UI do not exist.

- [ ] **Step 4: Add the route projection and dispatch**

Update `commandsForState()` and `executeCommand()` with an explicit case. Add `resume_after_challenge` to the visible-command set. Preserve `resume` exclusively for `waiting_for_login`.

- [ ] **Step 5: Render the paused work surface**

Use a finite map:

```ts
const CHALLENGE_LABELS: Record<ChallengeKind, string> = {
  captcha: "需要完成验证码",
  access_denied: "页面拒绝了当前访问",
  rate_limited: "页面请求过于频繁",
  device_verification: "需要完成设备验证",
  risk_control: "需要完成安全验证",
  unsupported_iframe: "表单包含暂不支持的嵌入区域",
  unsupported_shadow_dom: "表单包含暂不支持的交互区域"
};
```

Show “请在受控浏览器中完成处理，然后点击继续填写。” and one primary RotateCw icon button labelled “继续填写”. Do not expose internal reason codes, selectors or captured text.

- [ ] **Step 6: Run tests, typecheck and commit**

```text
rtk pnpm --filter @resume/api test -- routes.test.ts
rtk pnpm --filter @resume/web test -- ApplicationTaskPage.test.tsx application-workbench.test.ts
rtk pnpm typecheck
rtk git add apps/api/src/applications/routes.ts apps/api/src/applications/routes.test.ts apps/web/src/applications/ApplicationTaskPage.tsx apps/web/src/applications/ApplicationTaskPage.test.tsx apps/web/src/applications/application-workbench.ts apps/web/src/applications/application-workbench.test.ts apps/web/src/styles.css
rtk git commit -m "feat: add explicit challenge resume control"
```

Expected: PASS and the only automation-resume control in this state is “继续填写”.

---

### Task 5: Add synthetic Challenge P0 regression and verify no submission

**Files:**
- Create: `apps/synthetic-ats/public/challenge-p0.html`
- Modify: `apps/synthetic-ats/src/server.ts`
- Modify: `apps/synthetic-ats/src/server.test.ts`
- Create: `tests/browser/ats-challenge-p0.spec.ts`
- Modify: `tests/browser/test-harness.ts`
- Create: `docs/testing/ats-challenge-p0-regression.md`

**Interfaces:**
- Adds synthetic modes: `captcha`, `access-denied`, `rate-limited`, `device-verification`, `risk-control`, `interactive-iframe`, `open-shadow-input`, `closed-shadow-host`.
- Preserves: existing task state endpoint and `submissionCount`.

- [ ] **Step 1: Write failing scenario matrix**

For every mode, assert `awaiting_challenge`, the expected finite kind, no browser execute calls after detection and `submissionCount === 0`. For CAPTCHA, remove the challenge element without sending resume and wait one second; assert no filling occurs. Then click “继续填写” and assert the first worker call is a fresh observation.

- [ ] **Step 2: Run synthetic/browser tests and confirm RED**

```text
rtk pnpm --filter @resume/synthetic-ats test -- server.test.ts
rtk pnpm test:e2e -- ats-challenge-p0.spec.ts
```

Expected: FAIL because challenge routes and fixture modes do not exist.

- [ ] **Step 3: Implement sanitized deterministic fixtures**

The 403 and 429 modes return those statuses on a main-document navigation. Other modes use only stable Moka/DJI-like titles/accessibility names. iframe and shadow modes expose no candidate data. The state endpoint reports mode, fill count and submission count, never DOM contents.

- [ ] **Step 4: Run the complete Challenge verification matrix**

```text
rtk pnpm --filter @resume/contracts test
rtk pnpm --filter @resume/browser-worker test
rtk pnpm --filter @resume/api test
rtk pnpm --filter @resume/web test
rtk pnpm test:e2e -- ats-challenge-p0.spec.ts ats-runtime-p0.spec.ts submit-safety.spec.ts
rtk pnpm typecheck
```

Expected: all commands PASS; every scenario remains at `submissionCount === 0`.

- [ ] **Step 5: Record sanitized evidence and commit**

Record command results, finite challenge kinds, explicit-resume behavior and final submission count. Do not record raw challenge text, DOM, URLs with query strings or browser profile paths.

```text
rtk git add apps/synthetic-ats/public/challenge-p0.html apps/synthetic-ats/src/server.ts apps/synthetic-ats/src/server.test.ts tests/browser/ats-challenge-p0.spec.ts tests/browser/test-harness.ts docs/testing/ats-challenge-p0-regression.md
rtk git commit -m "test: cover ATS challenge pause and resume"
```

Expected: the commit contains only sanitized fixture/test/report changes.
