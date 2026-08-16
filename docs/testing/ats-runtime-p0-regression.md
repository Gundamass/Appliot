# ATS Runtime P0 Regression Evidence

Date: 2026-08-15

## Safety Boundary

- Every browser scenario stopped before terminal submission.
- Every synthetic task reported `submissionCount: 0`.
- Evidence is limited to commands, aggregate pass counts, stable reason codes, and submission counters.
- No DOM dumps, selectors, candidate data, credentials, tokens, or browser-profile paths are retained here.

## Verification Results

| Command | Result |
| --- | --- |
| `rtk pnpm --filter @resume/synthetic-ats test -- server.test.ts` | 3 tests passed |
| `rtk pnpm --filter @resume/contracts test` | 60 tests passed |
| `rtk pnpm --filter @resume/action-policy test` | 5 tests passed |
| `rtk pnpm --filter @resume/form-semantics test` | 35 tests passed |
| `rtk pnpm --filter @resume/browser-worker test` | 102 tests passed |
| `rtk pnpm --filter @resume/api test` | 447 tests passed |
| `rtk pnpm test:e2e -- ats-runtime-p0.spec.ts ats-autofill-stability.spec.ts submit-safety.spec.ts` | 10 tests passed |
| `rtk pnpm typecheck` | 0 errors |

The complete Runtime matrix passed 659 automated tests. The focused synthetic server contract adds 3 passing route/state tests.

## Runtime Outcomes

- `insert-before`, `replace-same-index`, and `reorder` produced `stale_node_ref` without writing a replacement control.
- A rollback after 500 ms produced `controlled_value_reverted` on the second local readback.
- Continuous relevant mutation produced `control_unstable` within the bounded wait.
- A stable control returned `applied` with exactly one underlying write.
- Eight stable writes triggered one full-page audit. The audit detected the deliberate post-readback rollback, recorded `READBACK_MISMATCH`, paused automation, and did not refill.
- The domestic ATS regression reached final review without exposing or activating terminal submission.
- All Runtime P0 and submit-safety states reported `submissionCount: 0`.
