# Task 2 Report: Make fit scoring conservative and authoritative

## Status

Complete. Commit `9ae60e4e0925392c58375b37e4f0ef7413db4b8d` (`feat: make job fit scoring conservative`) contains only the two authorized scoring files.

## Implementation

- Changed unknown requirement contribution from half credit to zero; only `satisfied` requirements earn their normalized requirement weight. Existing conflict behavior remains zero credit.
- Added an authoritative backend `scoreBreakdown` generated from the same requirement weight map and outcomes as `fitScore`.
- Added all five stable dimensions and user-facing labels:
  - `skill` / `技能`
  - `responsibility` / `工作职责`
  - `project` / `项目经验`
  - `qualification` / `基本条件`
  - `preference` / `求职偏好`
- Breakdown dimensions report rounded `earned` and `available` points plus satisfied, unknown, and conflict counts.
- Reconciled rounded components deterministically so the two-decimal dimension earnings sum to the authoritative `fitScore`; present dimension availability also sums to the normalized total.
- Preserved `rankingScore` calculation and persistence compatibility, but removed it from `sortJobMatches`. Sorting is now `fitScore` descending, then `confidence` descending, then `canonicalUrl` ascending.
- Added behavior-focused coverage for every named boundary: unknown, satisfied, multiple requirements in one dimension, missing dimensions, no scorable requirements, dimension/fit total equality, stable two-decimal rounding, fit authority over ranking score, confidence tie-breaking, and URL tie-breaking.

## TDD RED

Exact command:

```powershell
rtk corepack pnpm --filter @resume/job-matching exec vitest run src/scoring-v1.test.ts
```

Result: exit code `1`; `1` test file failed; `11` tests failed and `4` passed.

Representative expected failures:

- Unknown-only score was `50`, expected `0`.
- One satisfied and one unknown requirement in the same dimension scored `75`, expected `50`.
- Mixed rounding case scored `65.1`, expected `30.21`.
- `scoreBreakdown` was `undefined`.
- Lower visible fit won when its persisted `rankingScore` was higher.
- Equal-fit results were ordered by `rankingScore` instead of confidence and URL.

Why RED was expected: the prior scorer awarded unknown outcomes `0.5` of their weight, did not populate `scoreBreakdown`, and sorted first by `rankingScore`. The failures therefore demonstrated the missing requested behavior rather than test setup or syntax errors. The inherited nationwide-location regression test passed during RED.

## GREEN and Verification

Focused GREEN command:

```powershell
rtk corepack pnpm --filter @resume/job-matching exec vitest run src/scoring-v1.test.ts
```

Result: exit code `0`; `1` test file passed; `15/15` tests passed.

Full package command:

```powershell
rtk corepack pnpm --filter @resume/job-matching test -- --run
```

Result: exit code `0`; `7/7` test files passed; `87/87` tests passed.

Typecheck command:

```powershell
rtk corepack pnpm --filter @resume/job-matching typecheck
```

Result: exit code `0`; `tsc --noEmit -p ../../tsconfig.json` completed without diagnostics.

Additional staged verification:

- `rtk git diff --cached --check` completed without errors.
- `rtk git show --name-only --format="" HEAD` confirmed the commit contains only `packages/job-matching/src/scoring-v1.ts` and `packages/job-matching/src/scoring-v1.test.ts`.

## Files Changed

Committed:

- `packages/job-matching/src/scoring-v1.ts`
- `packages/job-matching/src/scoring-v1.test.ts`

Report only, intentionally not included in the task commit:

- `.superpowers/sdd/task-2-report.md`

## Inherited Nationwide-Location Change

The two scoring files already contained user-owned, approved changes from the earlier Baidu filter work:

- `scoring-v1.ts` imports `isUnrestrictedLocationValue` and treats a nationwide location criterion as satisfied.
- `scoring-v1.test.ts` verifies that a nationwide location preference is unrestricted.

These prerequisite edits were preserved unchanged. Because they occupy the same two authorized files and safe partial staging would make the committed file state diverge from the approved working state, they are included in commit `9ae60e4e0925392c58375b37e4f0ef7413db4b8d`. The nationwide test passed in RED, focused GREEN, and the full package run.

## Self-Review

- Plan alignment: every boundary and exact sort precedence from the brief is covered.
- Authority: `fitScore` is assigned from `scoreBreakdown.total`, preventing independent backend totals from drifting.
- Compatibility: `rankingScore` remains produced; the optional Task 1 contract is now populated for new scores.
- Determinism: dimensions follow the fixed weight-map order, URL comparison remains locale-independent, and rounding correction is deterministic.
- Edge cases: unscorable-only postings return `0` with an empty breakdown; absent dimensions are excluded and present dimensions normalize to 100.
- Scope: no unrelated files were edited or committed by this task. Existing unrelated worktree changes remain untouched.
- Review tooling: no code-review subagent was available in this session, so the code-review checklist was performed directly against the requirements and exact diff.

## Concerns

No Task 2 code concerns found. The repository still has many unrelated pre-existing modified and untracked files; they were not staged or committed. The report itself remains outside the task commit as required by the instruction to commit only the two scoring files.
