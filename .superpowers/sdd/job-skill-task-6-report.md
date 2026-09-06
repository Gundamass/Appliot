# Task 6 Report — Closed Declarative Application Skill Contracts

## Files changed

- `packages/contracts/src/application-skill.ts` — closed schemas and inferred types for field semantics, Skill content/version/binding/directives/execution/evaluation/evolution patches.
- `packages/contracts/src/application-skill.test.ts` — valid Baidu campus fixture plus acceptance, rejection, privacy, metadata, CSS, retry, and compatibility tests.
- `packages/contracts/src/index.ts` — exports the application Skill contracts.
- `.superpowers/sdd/job-skill-task-6-report.md` — this report.

## TDD evidence

Initial RED command:

`rtk corepack pnpm --filter @resume/contracts exec vitest run src/application-skill.test.ts`

Result: exit 1; one failed suite and zero collected tests because `./application-skill.js` did not exist.

During current-form semantic review, a second RED run produced 1 failed / 23 passed because the closed enum initially rejected `education[].hasLaboratory`; the production semantic derivation also established split-date component paths. The enum was extended only with those closed canonical variants.

## Verification

- Focused Skill test: 1 file passed, 24/24 tests passed.
- Required combined test: 2 files passed, 26/26 tests passed (`application-skill.test.ts` 24, `agent-runtime.test.ts` 2).
- Contracts typecheck: exit 0.
- Full contracts regression: 17 files passed, 132/132 tests passed.

## Caveats

- Field semantics are canonical templates such as `education[].major`; the future interpreter must materialize runtime indexes without accepting arbitrary paths.
- Semantic workflow graph validation (reachability, cycle analysis, parent capability comparison, origin matching) is intentionally deferred to Task 8.
- Evolution patches are deliberately narrower than general JSON Patch: they can only add/remove typed list entries or replace typed evolvable top-level content sections.
- Registry metadata, evaluator policy, allocation, approval, auditing controls, raw values, and submit authority are absent from evolvable content.
