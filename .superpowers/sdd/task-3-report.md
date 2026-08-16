# Task 3 Report: Worker IPC Activity Channel

## Status

Complete in the direct workspace. No worktree or Git commit was created, per user request.

## Scope

Implemented only Task 3 from `docs/superpowers/plans/2026-07-28-application-stability-observability-plan.md`:

- Added a validated `activity` branch to `WorkerResponseSchema`, based exclusively on the existing redacted `WorkerActivitySchema`.
- Added an unsolicited IPC activity envelope with no `requestId`.
- Added `BrowserWorkerClient.onActivity(listener)`, returning an unsubscribe function.
- Added finite-code worker-disconnect notifications for the last active task.
- Kept activity messages out of pending-request correlation and did not change command execution or submission safety.

## TDD Evidence

### RED

First added tests in the requested locations:

- `apps/api/src/browser/worker-client.test.ts`: a Worker activity must reach subscribers while a snapshot request remains pending and later resolves normally.
- `apps/browser-worker/src/ipc-server.test.ts`: the IPC server must forward a valid activity and reject a payload containing a typed value.

Observed expected failures:

```text
client.onActivity is not a function
(0 , createIpcServer) is not a function
```

### GREEN

Implemented the smallest typed message split needed for those tests:

- `WorkerResponseSchema` now accepts `{ type: "activity", activity }` only when `activity` satisfies `WorkerActivitySchema`.
- `createIpcServer()` provides an injectable IPC channel for direct server tests; `startIpcServer()` still binds production code to `process`.
- Worker activities use `safeParse`; malformed data is not sent to the API process.
- `BrowserWorkerClient.handleMessage()` parses activity envelopes before response envelopes and calls subscribers without reading or changing `pending`.
- Child `disconnect` and `exit` emit one contract-defined `worker_disconnected` event when a task has been observed/opened/executed.

## Files Changed

- `packages/contracts/src/browser.ts`
- `packages/contracts/src/browser.test.ts`
- `apps/browser-worker/src/ipc-server.ts`
- `apps/browser-worker/src/ipc-server.test.ts`
- `apps/api/src/browser/worker-client.ts`
- `apps/api/src/browser/worker-client.test.ts`
- `apps/api/src/browser/fixtures/activity-worker.ts`

## Verification

```text
corepack pnpm --filter @resume/api exec vitest run src/browser/worker-client.test.ts
PASS: 1 file, 5 tests

corepack pnpm --filter @resume/browser-worker exec vitest run src/ipc-server.test.ts
PASS: 1 file, 1 test

corepack pnpm --filter @resume/contracts exec vitest run src/browser.test.ts
PASS: 1 file, 14 tests

corepack pnpm --filter @resume/browser-worker test
PASS: 5 files, 21 tests

corepack pnpm --filter @resume/api typecheck
PASS

corepack pnpm --filter @resume/browser-worker typecheck
PASS

corepack pnpm --filter @resume/contracts typecheck
PASS

git diff --check
PASS
```

## Local Review Notes

- Activity payloads are Zod-validated at both Worker emission and API receipt boundaries.
- Rejected activity payloads cannot contain values, credentials, CAPTCHA data, raw labels, selectors, coordinates, or scripts because all activity variants are strict contract objects.
- Valid activity events cannot resolve, reject, clear, or otherwise mutate a pending request correlation.
- No API coordinator, recovery handling, UI behavior, action policy, command shape, or terminal-submit behavior was modified.

## Concerns

- Independent task review is still pending. Task 4 remains responsible for consuming these subscriptions in the application progress coordinator.

## Review Fixes

### RED

Added focused API client regressions in `apps/api/src/browser/worker-client.test.ts` and a forged `requestId`-bound activity fixture:

- A forged `{ requestId, response: { type: "activity" } }` must not resolve the pending `observe()` request.
- A throwing activity listener must not prevent the next listener from receiving the valid activity or leak an unhandled process error.

```text
corepack pnpm --filter @resume/api exec vitest run src/browser/worker-client.test.ts
FAIL: 3 tests failed
- observe() rejected with "浏览器 Worker 返回了意外响应：activity"
- listener failure surfaced as an unhandled exception
```

### GREEN

- The API client now explicitly discards any request-bound activity envelope before normal response correlation, so activity remains request-ID-free and cannot mutate `pending` state.
- Each activity listener is isolated with a local error boundary, so a failing observer cannot interrupt IPC handling or other observers.

```text
corepack pnpm --filter @resume/api exec vitest run src/browser/worker-client.test.ts
PASS: 1 file, 6 tests

corepack pnpm --filter @resume/api typecheck
PASS

git diff --check
PASS
```
