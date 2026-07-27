# Plan 2 Task 1 Report: Browser Contracts

## RED Evidence

Command: `corepack pnpm --filter @resume/contracts test -- browser.test.ts`

Result: failed with `Cannot find module './browser.js' imported from 'src/browser.test.ts'`. The initial test specified that `{ type: "submit", taskId: "task-1", actionId: "final" }` must not be executable.

## GREEN Evidence

- Focused command: `corepack pnpm --filter @resume/contracts exec vitest run src/browser.test.ts`
  - Result: 3 tests passed.
- Package command: `corepack pnpm --filter @resume/contracts test`
  - Result: 5 test files and 15 tests passed.
- Typecheck command: `corepack pnpm --filter @resume/contracts typecheck`
  - Result: passed.

## Files Changed

- `packages/contracts/src/browser.ts`
- `packages/contracts/src/browser.test.ts`
- `packages/contracts/src/index.ts`
- `.superpowers/sdd/plan2-task-1-report.md`

## Commit

Implementation commit: `6a102c5b62fbe36a9129f57479bad8b30cf61072`

## Self-Review

- `ExecutableCommandSchema` is closed to fill, select, upload, and intermediate click commands only.
- Submit and arbitrary scripting cannot parse, and commands contain no selectors, coordinates, JavaScript, CDP, network-request, or raw Playwright path.
- Form and worker schemas are strict and expose only normalized snapshots and opaque IDs.
- Every executable variant requires an opaque `approval` capability. Binding the capability to task, snapshot, action, and expiry is the responsibility of the policy issuer and worker verifier.

## Concerns

None for this contract boundary. Runtime verification of approval binding and validation/readback gates belongs to the later persistent worker and policy implementation.
