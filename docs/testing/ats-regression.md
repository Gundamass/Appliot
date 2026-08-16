# Job Matching ATS Regression

Date: 2026-08-16

## Safety Boundary

- Browser automation may read job lists, job details, login boundaries, application-form boundaries, and finite Challenge signals.
- Tests may apply job-list filters, advance deterministic pagination, pause or continue reading, and confirm an explicit conflict selection.
- Tests must never click, approve, or invoke an ATS submission control.
- Every Synthetic ATS path must finish with `submissionCount === 0`.
- Production UI must not expose automatic-application or final-submission commands.
- Unknown requirements remain in recommendation ranking. Only explicit conflicts are shown in the separate conflict list.
- Stored evidence is limited to aggregate test results and synthetic identifiers. No resume content, credentials, tokens, cookies, browser profiles, or private DOM captures are retained.

## Synthetic Coverage

`tests/browser/job-matching.spec.ts` covers:

- Moka-style structured job cards and filter readback.
- Deterministic pagination, duplicate-safe job identity, and preserved task/query parameters.
- Deterministic content updates for the same job identity through `contentVersion=2`.
- Job-list, job-detail, application-form, login, and trusted-origin Challenge boundaries.
- Workspace entry creates a job-match session from confirmed profile expectations at a 320 px viewport.
- Application-form entry switches to direct application with a prefilled URL without creating an application task.
- Recommended and explicit-conflict result lists at a 320 px viewport without horizontal overflow.
- Inline conflict confirmation with current result version, posting content hash, and conflict summary hash.
- Pause/continue requests and fresh login/Challenge recovery projections.
- Fresh-to-stale result transition where rematching is the only available mutation.
- Zero ATS submissions across all paths.

## Required Commands

```text
rtk pnpm --filter @resume/synthetic-ats test -- src/server.test.ts
rtk pnpm test:e2e -- tests/browser/job-matching.spec.ts tests/browser/mokahr-high-coverage.spec.ts tests/browser/dji-coverage.spec.ts tests/browser/ats-runtime-p0.spec.ts
rtk pnpm test
rtk pnpm typecheck
rtk pnpm build
```

## Verification Record

| Scope | Result |
| --- | --- |
| Synthetic ATS server | 5 tests passed |
| Synthetic job matching E2E | 8 tests passed |
| Required browser regression matrix | 18 tests passed |
| Full unit/integration suite | 122 files, 1,331 tests passed |
| Typecheck | Passed |
| Build | Passed |
| Real Moka/DJI observation | Not run; do not claim as passed |

### 2026-08-16 Job Matching Entry

Command: `rtk pnpm test:e2e -- tests/browser/job-matching.spec.ts`

- Result: 8 tests passed.
- Workspace session creation and application redirect were both exercised through the production router.
- Application task creation requests during the redirect path: 0.
- Synthetic ATS `submissionCount`: 0 for every task used by the suite.
- Real Moka/DJI pages were not run and are not claimed as passed.

Final verification commands:

- `rtk pnpm test:e2e -- tests/browser/job-matching.spec.ts tests/browser/mokahr-high-coverage.spec.ts tests/browser/dji-coverage.spec.ts tests/browser/ats-runtime-p0.spec.ts`: 18 tests passed.
- `rtk pnpm test`: 122 files and 1,331 tests passed on the final run.
- `rtk pnpm typecheck`: passed with no TypeScript errors.
- `rtk pnpm build`: passed.

The first full-suite run timed out in two Browser Worker tests while workspace
packages were running concurrently. Both owning files passed when run alone
(`control-adapters.test.ts`: 1 test; `dom-runtime.test.ts`: 2 tests), the full
Browser Worker package then passed 12 files and 117 tests, and the final full
workspace run passed without changing production code or test timeouts.

Real ATS verification, when available, is observation-only and must stop at the final manual-review page. Record only redacted aggregate outcomes and keep `submissionCount` at zero.
