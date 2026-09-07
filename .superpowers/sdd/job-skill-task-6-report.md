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

## Reviewer fix cycle

The reviewer identified three contract-level bypasses. Tests were added before production changes.

Reviewer RED command:

`rtk corepack pnpm --filter @resume/contracts exec vitest run src/application-skill.test.ts`

Result: exit 1; 11 failed / 25 passed. The failures demonstrated that observe-only content, audit-removing replacement/removal patches, unsafe static UI text in all four text-bearing positions, and dynamic CSS attributes were accepted. A follow-up isolated UUID test produced 1 failed / 35 passed for a prefixed UUID with no long numeric run.

Fixes:

- `full_page_audit` is mandatory in both declared capabilities and workflow actions.
- Capability/workflow replacement patches preserve that boundary; context-free indexed removals from those sections are forbidden.
- Reusable `SafeStaticUiHintSchema` now protects label, role-name, placeholder, and required-text fields in both direct content and typed patch values.
- High-signal email, mainland phone, explicit name assignment, URL/scheme, filesystem/API path, XPath, JavaScript/code, UUID/hash/JWT/base64-like or long opaque token, approval/token/secret channels are rejected.
- Restricted CSS attribute values are parsed and checked by the same stable-attribute validator, including long numeric IDs and embedded UUIDs.

Reviewer GREEN verification:

- Focused Skill test: 1 file passed, 36/36 tests passed.
- Required combined test: 2 files passed, 38/38 tests passed.
- Full contracts regression: 17 files passed, 144/144 tests passed.
- Contracts typecheck: exit 0.
- Root typecheck: exit 0.

Static hint filtering intentionally does not claim perfect PII detection: a bare two-character human name cannot be distinguished reliably from a legitimate short ATS label. Task 8 must validate every hint against observed static page text and the registered site origin before a Skill can be activated.
