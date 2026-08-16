# Task 6 Report: Synthetic ATS Stability Acceptance

## Status

Infinite-loop regression fixed in the direct workspace. No commit or worktree was created.

## Diagnosis

The default Synthetic ATS application page rendered a hidden but required phone input. Native browser validation blocked the intermediate form submission, while the observer intentionally filtered the hidden field. `ControlledExecutor` then reported the unchanged click as `applied`, and `ApplicationService.runUntilPause()` recursively processed the same page.

## TDD Evidence

RED was confirmed independently at both production boundaries:

- Synthetic ATS test failed because onboarding HTML still contained `name="phone"`.
- Browser Worker test received `applied` instead of `failed` for a click with no observable change.
- Application Service test observed two execute calls instead of one, proving the same-page rerun.

## Fix

- Synthetic ATS renders the required phone control only for the explicit `stuck-control` scenario.
- `ControlledExecutor` compares URL, stage, title, field IDs, action IDs, and visible errors after `click_intermediate`; an unchanged page returns `failed` with `intermediate_no_progress`.
- `ApplicationService` independently rejects an `applied` intermediate result without observable progress, transitions to `failed`, and does not recurse.
- Terminal submit classification and execution contracts were not changed.

## Verification

```text
Synthetic ATS scenario test: 1/1 passed
Browser Worker executor tests: 5/5 passed
API application machine/service tests: 28/28 passed
Browser Worker and API typecheck: passed
submit-safety E2E: 1/1 passed in 3.9s
```

E2E command:

```text
corepack pnpm test:e2e -- --timeout=30000 --global-timeout=120000 tests/browser/submit-safety.spec.ts
```

The E2E reached a Playwright verdict and confirmed every terminal action remains refused.

## Final Stability Acceptance

The complete synthetic stability specification now passes after the activity-monitor and login-resume fixes:

```text
application-stability.spec.ts: 3/3 passed
```

It covers manual job selection and login, manual invalid-email correction with a visible error and safe readback, duplicate-page fingerprint/model-call deduplication, and a timed-out phone field repaired manually before automatic continuation. Every scenario finishes at `review_locked`; the synthetic submission counter remains zero.

The full browser suite also passed:

```text
tests/browser: 8/8 passed
```

This includes the original automatic two-page flow, desktop/mobile task UI checks, terminal-submit refusal, and isolated Playwright output configuration. Playwright artifacts now use `playwright-artifacts`, separate from the running API's `test-results` log directory.

Final repository verification passed:

```text
pnpm test: passed
pnpm typecheck: passed
pnpm build: passed
git diff --check: passed
```

## Concerns

None for the Task 6 scope.

## 2026-07-29 Final Safety Follow-up

Four final-review findings were resolved without weakening the no-submit boundary:

- Every Worker execute request carries an execution epoch. Cancellation or confirmed user activity sends an immediate, non-queued invalidation IPC request; the Worker checks freshness before each browser mutation and after delayed file resolution.
- Visible ordinary button/link clicks are reported as privacy-safe opaque user activities. Once a page snapshot exists, user activity pauses automation; pre-automation manual job selection/login remains observable without being treated as an interruption.
- Intermediate clicks now require objective safety and have defense-in-depth native-submit, non-GET request, and cross-origin-navigation guards. A synthetic ATS `继续` submit control is blocked and produces zero submissions.
- Unexpected activity-handling failures become visible `PAGE_ERROR` recovery pauses rather than being silently swallowed.

Fresh final verification:

```text
pnpm test: passed
pnpm test:e2e -- tests/browser: 9/9 passed
pnpm typecheck: passed
pnpm build: passed
git diff --check: passed
```

Hard preemption remains impossible once an individual Playwright mutation has already entered its atomic call. The epoch protocol prevents queued and pre-mutation actions, invalidates delayed uploads, and prevents all subsequent automation.
## 2026-07-29 普通操作点击活动验证

- `activity-monitor.test.ts`：15/15 通过。
- `git diff --check`：通过。
- Browser Worker typecheck：失败；现有未完成测试改动仍包含类型错误，位置为 `application-machine.test.ts:973,982`、`executor.test.ts:469,472`、`observer.test.ts:161`。本轮未修改这些范围。
