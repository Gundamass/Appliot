# ATS Runtime Node Identity and Readback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace index-based DOM rebinding with document-scoped node identity, then report a field as applied only after two stable local readbacks and periodic full-page audits.

**Architecture:** A page runtime assigns opaque node IDs and a monotonically increasing mutation epoch. `NodeRegistry` captures validated Playwright `ElementHandle`s during observation; commands and approvals bind to the resulting `NodeRef`, and execution never queries a replacement node. `ControlledExecutor` performs one apply followed by two 300 ms stable windows and direct readbacks, while `ApplicationService` runs full-page audits after each eight successes and at phase boundaries.

**Tech Stack:** TypeScript 5.8, Zod, Vitest, Playwright Core 1.53, XState 5.19, pnpm 10.

## Global Constraints

- Execute this plan before `2026-08-15-challenge-and-dom-boundaries.md`; the Challenge plan consumes `NodeRef`, `NodeRegistry.release()` and execution invalidation from this plan.
- Work in the current repository and preserve every pre-existing modified or untracked path; stage only files explicitly changed by the current task.
- Write each failing test first, run it and observe the expected failure before editing production code.
- Every shell command starts with `rtk`; every manual edit uses `apply_patch`.
- A stale node may only fail with a stable reason code; it must never be rebound by field ID, selector, CSS path or DOM index.
- `apply` executes at most once per transaction. Existing stable business-key retry accounting remains capped at two automatic applies and is not reset by DOM mutation.
- Each stable window requires 300 ms with no relevant mutation and is capped at 2 seconds.
- Full-page audit runs after each eight successful fields, at deterministic/semantic phase boundaries and before final review.
- Terminal submission controls remain excluded from the executable registry, and every browser regression asserts `submissionCount === 0`.
- Do not add BM25, BGE-Reranker, Langfuse, Browser-Use or LangGraph.

## File Structure

- `packages/contracts/src/browser.ts`: `FrameRef`, `NodeRef`, mutation epoch, command and result reason-code contracts.
- `packages/action-policy/src/policy.ts`: signs and verifies node identity together with the existing task/snapshot/operation binding.
- `packages/form-semantics/src/snapshot-script.ts`: preserves opaque node references through normalization.
- `apps/browser-worker/src/dom-runtime.ts`: installs the document ID, opaque node allocator and relevant-mutation clock.
- `apps/browser-worker/src/node-registry.ts`: owns observed `ElementHandle`s and rejects stale or role-changed nodes.
- `apps/browser-worker/src/observer.ts`: creates a consistent observation from runtime metadata and captured handles.
- `apps/browser-worker/src/control-adapters.ts`: accepts prepared handles without selector rebinding.
- `apps/browser-worker/src/runtime-trace.ts`: emits bounded, value-free transaction phase/result diagnostics.
- `apps/browser-worker/src/executor.ts`: implements prepare/apply/settle/readback/settle/readback.
- `apps/browser-worker/src/session-manager.ts`: installs the runtime before observation and releases registries on page/task changes.
- `apps/api/src/applications/application-service.ts`: carries node refs into approvals/commands and schedules full-page audits.
- `apps/synthetic-ats/public/runtime-p0.html`: deterministic insertion, replacement, reorder and delayed rollback fixtures.
- `tests/browser/ats-runtime-p0.spec.ts`: browser-level identity/readback/audit/submit-safety regression.

---

### Task 1: Bind contracts and approvals to NodeRef

**Files:**
- Modify: `packages/contracts/src/browser.ts`
- Modify: `packages/contracts/src/browser.test.ts`
- Modify: `packages/action-policy/src/policy.ts`
- Modify: `packages/action-policy/src/policy.test.ts`
- Modify: `apps/api/src/applications/application-service.ts`
- Modify: `apps/api/src/applications/application-machine.test.ts`
- Modify: `apps/api/src/applications/dji-field-catalog.test.ts`
- Modify: `apps/api/src/applications/repeated-section-planner.test.ts`
- Modify: `apps/api/src/production-dependencies.test.ts`
- Modify: `apps/browser-worker/src/executor.test.ts`

**Interfaces:**
- Produces: `FrameRef = { documentId: string; kind: "main" }`.
- Produces: `NodeRef = { documentId: string; nodeId: string; observedAt: number }`.
- Extends: every `FormField` and `PageAction` with required `nodeRef`; every `FormSnapshot` with required `frameRef` and `mutationEpoch`.
- Extends: each `ExecutableCommand` with the target `nodeRef` and `executionEpoch`.
- Extends: `ApprovalRequest` and signed `ApprovalPayload` with `nodeRef` and `executionEpoch`.

- [ ] **Step 1: Write failing contract tests**

Add strict parsing assertions in `packages/contracts/src/browser.test.ts`:

```ts
const nodeRef = {
  documentId: "document-00000001",
  nodeId: "node-000000000001",
  observedAt: 7
};
expect(FormSnapshotSchema.parse({
  ...snapshot,
  frameRef: { documentId: "document-00000001", kind: "main" },
  mutationEpoch: 7,
  fields: [{ ...snapshot.fields[0]!, nodeRef }],
  actions: snapshot.actions.map((action) => ({ ...action, nodeRef }))
}).fields[0]!.nodeRef).toEqual(nodeRef);

expect(ExecutableCommandSchema.parse({
  type: "fill", taskId: "task-1", snapshotId: "snapshot-1",
  fieldId: "field-1", nodeRef, executionEpoch: 11, value: "Ada", approval: "token"
}).nodeRef).toEqual(nodeRef);
```

- [ ] **Step 2: Write failing approval replay/rebinding tests**

In `policy.test.ts`, approve `node-a`, replace only the command node ref with `node-b`, and assert:

```ts
expect(() => verifyAndConsumeApproval({ ...command, nodeRef: replacement }, key, store))
  .toThrowError(expect.objectContaining({ code: "approval_node_mismatch" }));
```

Also assert a changed `observedAt` fails with the same code, a changed execution epoch fails with `approval_execution_epoch_mismatch`, and the original command still succeeds once.

- [ ] **Step 3: Run the focused tests and confirm RED**

```text
rtk pnpm --filter @resume/contracts test -- browser.test.ts
rtk pnpm --filter @resume/action-policy test -- policy.test.ts
```

Expected: FAIL because `nodeRef`, `frameRef` and `mutationEpoch` are rejected or missing and approval tokens do not bind node identity.

- [ ] **Step 4: Add the strict schemas and command properties**

Add to `browser.ts` and reuse the schemas in fields, actions, snapshots and every command branch:

```ts
export const FrameRefSchema = z.object({
  documentId: z.string().min(16).max(128),
  kind: z.literal("main")
}).strict();

export const NodeRefSchema = z.object({
  documentId: FrameRefSchema.shape.documentId,
  nodeId: z.string().min(16).max(128),
  observedAt: z.number().int().nonnegative()
}).strict();
```

Use `nodeRef: NodeRefSchema` rather than an optional migration field: all in-process producers and fixtures must migrate in the same task.

Update snapshot/field/command fixtures in `application-machine.test.ts`, `dji-field-catalog.test.ts`, `repeated-section-planner.test.ts`, `production-dependencies.test.ts`, `executor.test.ts` and `policy.test.ts` with deterministic test-only document/node IDs and execution epochs. Do not make production schemas optional to preserve old fixtures.

- [ ] **Step 5: Sign and verify the complete node binding**

Extend `ApprovalRequest` with `nodeRef: NodeRef` and `executionEpoch: number`. In `verifyAndConsumeApproval()`, compare all node properties and the execution epoch before consuming the token:

```ts
if (payload.nodeRef.documentId !== command.nodeRef.documentId
  || payload.nodeRef.nodeId !== command.nodeRef.nodeId
  || payload.nodeRef.observedAt !== command.nodeRef.observedAt) {
  throw new PolicyDeniedError("approval_node_mismatch");
}
if (payload.executionEpoch !== command.executionEpoch) {
  throw new PolicyDeniedError("approval_execution_epoch_mismatch");
}
```

Update `decodeAndVerifyToken()` to parse the payload with `NodeRefSchema` instead of unchecked casts.

- [ ] **Step 6: Carry the observed ref into approval and command construction**

Where `ApplicationService` creates an operation, allocate the execution epoch first, resolve the current field/action once, and use both values for approval and command construction:

```ts
const nodeRef = target.nodeRef;
const executionEpoch = nextExecutionEpoch(taskId);
const approval = dependencies.approve({
  taskId, snapshotId: snapshot.id, targetId: target.id, operation, nodeRef, executionEpoch
}, snapshot);
const command = {
  ...commandInput, taskId, snapshotId: snapshot.id, nodeRef, executionEpoch, approval
};
await dependencies.browser.execute(command, executionEpoch);
```

Do not look up `nodeRef` again or allocate a newer execution epoch after approval. Replace `executeWithFreshEpoch()` with an execution helper that uses the already signed `command.executionEpoch`.

- [ ] **Step 7: Run contract, policy and application tests and commit**

```text
rtk pnpm --filter @resume/contracts test -- browser.test.ts
rtk pnpm --filter @resume/action-policy test -- policy.test.ts
rtk pnpm --filter @resume/api test -- application-machine.test.ts
rtk git add packages/contracts/src/browser.ts packages/contracts/src/browser.test.ts packages/action-policy/src/policy.ts packages/action-policy/src/policy.test.ts apps/api/src/applications/application-service.ts apps/api/src/applications/application-machine.test.ts apps/api/src/applications/dji-field-catalog.test.ts apps/api/src/applications/repeated-section-planner.test.ts apps/api/src/production-dependencies.test.ts apps/browser-worker/src/executor.test.ts
rtk git commit -m "feat: bind browser commands to observed nodes"
```

Expected: PASS; commit contains only the listed files.

---

### Task 2: Install the document runtime and capture ElementHandles

**Files:**
- Create: `apps/browser-worker/src/dom-runtime.ts`
- Create: `apps/browser-worker/src/dom-runtime.test.ts`
- Create: `apps/browser-worker/src/node-registry.ts`
- Create: `apps/browser-worker/src/node-registry.test.ts`
- Delete: `apps/browser-worker/src/dom-registry.ts`
- Modify: `apps/browser-worker/src/observer.ts`
- Modify: `apps/browser-worker/src/observer.test.ts`
- Modify: `packages/form-semantics/src/snapshot-script.ts`
- Modify: `packages/form-semantics/src/normalize.ts`
- Modify: `packages/form-semantics/src/normalize.test.ts`
- Modify: `apps/browser-worker/src/session-manager.ts`

**Interfaces:**
- Produces: `installDomRuntime(page: Page): Promise<void>`; it is idempotent and also registered with `page.addInitScript()`.
- Produces: `readDomRuntime(page: Page): Promise<{ documentId: string; epoch: number }>`.
- Produces: `NodeRegistry.capture(snapshot, page, bindings): Promise<NodeRegistry>`.
- Produces: `prepare(ref, expectedEpoch, role): Promise<PreparedNode>` and `release(): Promise<void>`.
- Consumes: the schemas created by Task 1.

- [ ] **Step 1: Write page-runtime identity and epoch tests**

Use a real Playwright page in `dom-runtime.test.ts` and assert:

```ts
await installDomRuntime(page);
const first = await readDomRuntime(page);
await page.locator("body").evaluate((body) => body.append(document.createElement("input")));
await expect.poll(async () => (await readDomRuntime(page)).epoch).toBeGreaterThan(first.epoch);
await page.reload();
expect((await readDomRuntime(page)).documentId).not.toBe(first.documentId);
```

Also mutate only an irrelevant text node outside a form and assert the epoch does not advance.

- [ ] **Step 2: Write NodeRegistry stale/replacement tests**

Capture two inputs, insert a new input before the target, and assert the original handle is retained but the old epoch is rejected. Remove the target and insert a visually identical replacement at the same index; assert:

```ts
await expect(registry.prepare(oldRef, oldRef.observedAt, "field"))
  .rejects.toMatchObject({ code: "stale_node_ref" });
expect(await replacement.inputValue()).toBe("");
```

Add a role-change case that replaces a text field with a select and returns `node_role_changed`.

- [ ] **Step 3: Run browser-worker tests and confirm RED**

```text
rtk pnpm --filter @resume/browser-worker test -- dom-runtime.test.ts node-registry.test.ts observer.test.ts
```

Expected: FAIL because the runtime and registry do not exist and observation still uses `nth(index)`.

- [ ] **Step 4: Implement the isolated page runtime**

Define a non-enumerable `window.__resumeDomRuntime` installed by a string/function passed to both `addInitScript` and `evaluate`. Its public shape is limited to:

```ts
interface PageDomRuntime {
  documentId: string;
  epoch: number;
  ids: WeakMap<Element, string>;
  lastRelevantMutationAt: WeakMap<Element, number>;
  nodeId(element: Element): string;
}
```

Use `crypto.randomUUID()` for IDs. The `MutationObserver` increments `epoch` for `childList` changes and identity-bearing attributes (`type`, `role`, `name`, `aria-*`, `disabled`, `readonly`) involving a form control, action or nearest form container. It must never write IDs into DOM attributes.

- [ ] **Step 5: Preserve node IDs through normalization**

Add `nodeId`, `documentId` and `mutationEpoch` to the raw observation context. Construct normalized refs exactly once:

```ts
nodeRef: {
  documentId: context.documentId,
  nodeId: raw.nodeId,
  observedAt: context.mutationEpoch
}
```

All fields and actions from one snapshot must share the snapshot's `documentId` and epoch.

- [ ] **Step 6: Capture and validate handles without rebinding**

Implement `NodeRegistry.capture()` by taking `elementHandle()` from each locator only during observation, immediately evaluating its runtime node ID, and accepting it only when it equals the raw binding's expected ID. If the DOM changes during capture, release all handles and throw `observation_changed`; `BrowserObserver.observe()` retries the entire observation up to two times.

`prepare()` validates document, current epoch, stored ID, `isConnected`, and role. It returns the stored handle and never calls `page.locator()`, `nth()`, CSS or text lookup.

- [ ] **Step 7: Install before every current and future document**

In `BrowserSessionManager.bindPage()`, call `page.addInitScript(DOM_RUNTIME_SCRIPT)` and `installDomRuntime(page)` before constructing `BrowserObserver`. Replace `DomRegistry` with `NodeRegistry`, and call `release()` whenever an observation is superseded, a page is rebound, a task is released or the manager stops.

- [ ] **Step 8: Run focused tests, typecheck and commit**

```text
rtk pnpm --filter @resume/browser-worker test -- dom-runtime.test.ts node-registry.test.ts observer.test.ts
rtk pnpm --filter @resume/form-semantics test -- normalize.test.ts
rtk pnpm typecheck
rtk git add apps/browser-worker/src/dom-runtime.ts apps/browser-worker/src/dom-runtime.test.ts apps/browser-worker/src/node-registry.ts apps/browser-worker/src/node-registry.test.ts apps/browser-worker/src/dom-registry.ts apps/browser-worker/src/observer.ts apps/browser-worker/src/observer.test.ts apps/browser-worker/src/session-manager.ts packages/form-semantics/src/snapshot-script.ts packages/form-semantics/src/normalize.ts packages/form-semantics/src/normalize.test.ts
rtk git commit -m "feat: capture document-scoped browser nodes"
```

Expected: PASS and no reference to `DomRegistry` or `.nth(indices` remains.

---

### Task 3: Execute one write with two stable local readbacks

**Files:**
- Modify: `apps/browser-worker/src/node-registry.ts`
- Modify: `apps/browser-worker/src/node-registry.test.ts`
- Modify: `apps/browser-worker/src/control-adapters.ts`
- Create: `apps/browser-worker/src/control-adapters.test.ts`
- Modify: `apps/browser-worker/src/executor.ts`
- Modify: `apps/browser-worker/src/executor.test.ts`
- Create: `apps/browser-worker/src/runtime-trace.ts`
- Create: `apps/browser-worker/src/runtime-trace.test.ts`
- Modify: `apps/browser-worker/src/session-manager.ts`
- Modify: `apps/browser-worker/src/session-manager.test.ts`
- Modify: `packages/contracts/src/browser.ts`
- Modify: `packages/contracts/src/browser.test.ts`

**Interfaces:**
- Produces: `PreparedNode.waitForStableWindow(stableMs, capMs, isCurrent)`.
- Produces: `PreparedNode.readValue(): Promise<unknown>` from the original handle.
- Produces stable execution errors: `control_unstable`, `controlled_value_reverted`, `stale_node_ref`, `node_role_changed`.
- Produces: `RuntimeTraceSink.record(event)` with only task/snapshot/document/node hashes, phase, elapsed milliseconds and result code.

- [ ] **Step 1: Write fake-timer transaction tests**

Add tests that count the underlying write call and model a delayed rollback:

```ts
expect(apply).toHaveBeenCalledTimes(1);
expect(result).toMatchObject({ status: "failed", errors: ["controlled_value_reverted"] });
```

Cover these timelines: stable/stable => `applied`; first stable then 500 ms rollback => `controlled_value_reverted`; continuous mutation for 2 seconds => `control_unstable`; handle disconnect between reads => `stale_node_ref`; invalidation during either wait => `execution_invalidated`.

Add trace assertions that phases are ordered `prepare`, `apply`, `settle-1`, `readback-1`, `settle-2`, `readback-2`, and that serialized events contain neither the written value nor field label, selector, DOM or candidate input.

- [ ] **Step 2: Run executor tests and confirm RED**

```text
rtk pnpm --filter @resume/browser-worker test -- executor.test.ts node-registry.test.ts control-adapters.test.ts
```

Expected: FAIL because the executor performs one immediate full observation and has no stable-window/readback phases.

- [ ] **Step 3: Add local stability and readback to PreparedNode**

Track the most recent relevant mutation timestamp for the target and its nearest form container in the page runtime. `waitForStableWindow()` polls without performing a full-page scan:

```ts
while (Date.now() < deadline) {
  if (!await this.isConnected()) throw new NodeRegistryError("stale_node_ref");
  if (Date.now() - await this.lastRelevantMutationAt() >= stableMs) return;
  await delay(Math.min(50, stableMs));
}
throw new NodeRegistryError("control_unstable");
```

`readValue()` normalizes checkbox/radio checked state, select value, input value and custom-control accessible selection directly from the stored handle.

- [ ] **Step 4: Implement bounded Runtime tracing**

Define and inject this sink into `ControlledExecutor`:

```ts
export interface RuntimeTraceEvent {
  taskIdHash: string;
  snapshotId: string;
  documentId: string;
  mutationEpoch: number;
  nodeRefHash: string;
  phase: "prepare" | "apply" | "settle-1" | "readback-1" | "settle-2" | "readback-2";
  elapsedMs: number;
  resultCode: string;
}
export interface RuntimeTraceSink { record(event: RuntimeTraceEvent): void; }
```

Hash task and node IDs with SHA-256 before emitting. Never add target value, field label, selector, coordinates or DOM to this type. Add `BoundedRuntimeTraceBuffer` with a fixed 1,000-event FIFO cap; `BrowserSessionManager` owns one buffer for the Worker lifetime and injects it into each executor. Tests verify the oldest event is evicted at 1,001 and no sensitive values are retained.

- [ ] **Step 5: Generalize adapters to prepared handles**

Introduce the minimal structural `ControlTarget` interface used by adapters rather than accepting `Locator`:

```ts
export interface ControlTarget {
  evaluate<R, A>(fn: (element: Element, arg: A) => R | Promise<R>, arg: A): Promise<R>;
  click(options?: { force?: boolean }): Promise<void>;
  fill(value: string): Promise<void>;
}
```

Add only the methods actually used by existing search/select/date logic; do not recover by constructing a new locator from labels or indexes.

- [ ] **Step 6: Refactor `ControlledExecutor.execute()` into explicit phases**

The normal field path must be:

```ts
const prepared = await current.registry.prepare(command.nodeRef, command.nodeRef.observedAt, "field");
await applyOnce(prepared, command);
await prepared.waitForStableWindow(300, 2_000, isCurrent);
const first = await prepared.readValue();
await prepared.waitForStableWindow(300, 2_000, isCurrent);
const second = await prepared.readValue();
return resultForTwoReadbacks(command, expectedReadback, first, second, current.snapshot);
```

If the first value mismatches, return the existing type-specific mismatch. If the first matches and second differs, return `controlled_value_reverted`. Do not call `observer.observe()` between apply and the second local readback. Upload retains its parsing wait but starts from a prepared file handle and remains execution-epoch guarded.

- [ ] **Step 7: Run focused and regression tests and commit**

```text
rtk pnpm --filter @resume/browser-worker test -- executor.test.ts node-registry.test.ts control-adapters.test.ts runtime-trace.test.ts session-manager.test.ts
rtk pnpm --filter @resume/contracts test -- browser.test.ts
rtk pnpm --filter @resume/api test -- application-machine.test.ts
rtk pnpm typecheck
rtk git add apps/browser-worker/src/node-registry.ts apps/browser-worker/src/node-registry.test.ts apps/browser-worker/src/control-adapters.ts apps/browser-worker/src/control-adapters.test.ts apps/browser-worker/src/executor.ts apps/browser-worker/src/executor.test.ts apps/browser-worker/src/runtime-trace.ts apps/browser-worker/src/runtime-trace.test.ts apps/browser-worker/src/session-manager.ts apps/browser-worker/src/session-manager.test.ts packages/contracts/src/browser.ts packages/contracts/src/browser.test.ts
rtk git commit -m "feat: verify browser writes across stable windows"
```

Expected: PASS; each tested transaction records exactly one apply.

---

### Task 4: Add periodic full-page audit without silent refill

**Files:**
- Create: `apps/api/src/applications/full-page-audit.ts`
- Create: `apps/api/src/applications/full-page-audit.test.ts`
- Modify: `apps/api/src/applications/application-service.ts`
- Modify: `apps/api/src/applications/application-machine.test.ts`
- Modify: `apps/api/src/applications/field-coverage.ts`
- Modify: `apps/api/src/applications/field-coverage.test.ts`

**Interfaces:**
- Produces: `FullPageAuditCoordinator.recordApplied(operationKey, expectedValue)`.
- Produces: `shouldAudit(reason: "field_applied" | "phase_boundary" | "final_review"): boolean`.
- Produces: `audit(snapshot): AuditMismatch[]`; it compares by stable business key and never issues writes.

- [ ] **Step 1: Write coordinator threshold and mismatch tests**

```ts
for (let index = 0; index < 7; index += 1) coordinator.recordApplied(`field-${index}`, "ok");
expect(coordinator.shouldAudit("field_applied")).toBe(false);
coordinator.recordApplied("field-7", "ok");
expect(coordinator.shouldAudit("field_applied")).toBe(true);
expect(coordinator.shouldAudit("phase_boundary")).toBe(true);
```

Assert a changed observed value returns one mismatch and does not call any browser execution fake.

- [ ] **Step 2: Run API tests and confirm RED**

```text
rtk pnpm --filter @resume/api test -- full-page-audit.test.ts application-machine.test.ts field-coverage.test.ts
```

Expected: FAIL because there is no audit coordinator and phase boundaries do not force an audit.

- [ ] **Step 3: Implement the task-local audit ledger**

Store expected values by `fieldOperationKey`, plus the field's type/semantic/section identity required to find the corresponding newly observed field. Normalize date and boolean values with the same helpers used for execution readback. Reset only after a successful audit; never reset stable retry counts.

- [ ] **Step 4: Wire audit points into ApplicationService**

After an applied result, record it and audit when the count reaches eight. Before moving deterministic -> semantic, semantic -> validation and validation -> final review, call `browser.observe()`, derive the snapshot, run the audit and persist it. On mismatch:

```ts
fieldCoverageStore.markFailed(taskId, {
  fieldId: mismatch.fieldId,
  reason: "controlled_value_reverted"
});
progress.recordFailure(mismatch.operation, "READBACK_MISMATCH");
```

Do not enqueue or invoke a replacement command from the audit path.

- [ ] **Step 5: Run API regression and commit**

```text
rtk pnpm --filter @resume/api test -- full-page-audit.test.ts application-machine.test.ts field-coverage.test.ts application-progress.test.ts
rtk git add apps/api/src/applications/full-page-audit.ts apps/api/src/applications/full-page-audit.test.ts apps/api/src/applications/application-service.ts apps/api/src/applications/application-machine.test.ts apps/api/src/applications/field-coverage.ts apps/api/src/applications/field-coverage.test.ts
rtk git commit -m "feat: audit applied fields at runtime boundaries"
```

Expected: PASS and audit mismatches increase failed count without additional `browser.execute()` calls.

---

### Task 5: Add synthetic Runtime P0 regression and final verification

**Files:**
- Create: `apps/synthetic-ats/public/runtime-p0.html`
- Modify: `apps/synthetic-ats/src/server.ts`
- Modify: `apps/synthetic-ats/src/server.test.ts`
- Create: `tests/browser/ats-runtime-p0.spec.ts`
- Modify: `tests/browser/test-harness.ts`
- Create: `docs/testing/ats-runtime-p0-regression.md`

**Interfaces:**
- Produces deterministic routes/modes: `insert-before`, `replace-same-index`, `reorder`, `rollback-500ms`, `continuous-mutation`.
- Preserves: synthetic server `submissionCount` accounting.

- [ ] **Step 1: Write failing server and browser scenarios**

The browser spec must assert:

```ts
expect(await harness.value("replacement")).toBe("");
expect(await harness.lastError()).toBe("stale_node_ref");
expect(await harness.state()).toMatchObject({ submissionCount: 0 });
```

For delayed rollback, assert `controlled_value_reverted`; for a stable field, assert one write and `applied`; after eight stable writes, assert the audit endpoint counter increments once.

- [ ] **Step 2: Run the new tests and confirm RED**

```text
rtk pnpm --filter @resume/synthetic-ats test -- server.test.ts
rtk pnpm test:e2e -- ats-runtime-p0.spec.ts
```

Expected: FAIL because the Runtime P0 fixture and routes do not exist.

- [ ] **Step 3: Implement the deterministic fixture**

Use plain DOM timers and counters. Every mode must expose state through the existing synthetic state endpoint; the only submit handler increments `submissionCount`, and the test never invokes it. Avoid framework dependencies so mutation timing remains deterministic.

- [ ] **Step 4: Run the complete Runtime verification matrix**

```text
rtk pnpm --filter @resume/contracts test
rtk pnpm --filter @resume/action-policy test
rtk pnpm --filter @resume/form-semantics test
rtk pnpm --filter @resume/browser-worker test
rtk pnpm --filter @resume/api test
rtk pnpm test:e2e -- ats-runtime-p0.spec.ts ats-autofill-stability.spec.ts submit-safety.spec.ts
rtk pnpm typecheck
```

Expected: all commands PASS and every synthetic state reports `submissionCount === 0`.

- [ ] **Step 5: Record sanitized regression evidence and commit**

The report must list command, pass count, Runtime reason codes observed and `submissionCount: 0`; it must not contain DOM dumps, selectors, candidate data or browser-profile paths.

```text
rtk git add apps/synthetic-ats/public/runtime-p0.html apps/synthetic-ats/src/server.ts apps/synthetic-ats/src/server.test.ts tests/browser/ats-runtime-p0.spec.ts tests/browser/test-harness.ts docs/testing/ats-runtime-p0-regression.md
rtk git commit -m "test: cover ATS runtime P0 stability"
```

Expected: the commit contains only the fixture, harness, test and sanitized report.
