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
- High-signal email, mainland phone, URL/scheme, filesystem/API path, executable XPath/JavaScript syntax, UUID/hash/JWT/base64-like or long opaque token, approval/token/secret channels are rejected.
- Restricted CSS attribute values are parsed and checked by the same stable-attribute validator, including long numeric IDs and embedded UUIDs.

Reviewer GREEN verification:

- Focused Skill test: 1 file passed, 36/36 tests passed.
- Required combined test: 2 files passed, 38/38 tests passed.
- Full contracts regression: 17 files passed, 144/144 tests passed.
- Contracts typecheck: exit 0.
- Root typecheck: exit 0.

Static hint filtering intentionally does not claim perfect PII detection: a bare two-character human name cannot be distinguished reliably from a legitimate short ATS label. Task 8 must validate every hint against observed static page text and the registered site origin before a Skill can be activated.

## Second reviewer fix cycle

The second review found that evolvable identifiers, stable attributes, and relative route patterns could still retain risky literals, while the static UI filter rejected harmless literal labels too broadly.

Second-review RED command:

`rtk corepack pnpm --filter @resume/contracts exec vitest run src/application-skill.test.ts`

Result: exit 1; 19 failed / 36 passed. Failures covered six persisted evolvable identifier positions in direct content and typed patches, stable attributes, profile-value/API/local/credential-bearing route patterns, and the legitimate-label retention set.

Fixes:

- A shared persisted-literal risk refinement now rejects credential markers, mainland phone numbers, email addresses, URL schemes, UUIDs, hashes, JWTs, base64-like values, and long opaque values wherever the channel grammar permits.
- Every evolvable identifier/key, page-variant/workflow reference, stable attribute, relative route pattern, and static UI hint uses the appropriate shared refinement.
- Relative route patterns and static hints additionally reject local filesystem and API paths where those grammars permit them.
- Static hints reject only executable-shaped code/XPath literals such as `javascript:alert(...)`, `document.querySelector(...)`, `eval(...)`, and `//input[@...]`; literal labels `JavaScript experience`, `XPath proficiency`, `Name: Required`, and `姓名：必填` remain valid.
- Runtime-generated task, record, attempt, allocation, and evolution-run IDs retain a separate grammar-only opaque identifier Schema so legitimate UUID identities are not mistaken for evolvable content.

Second-review GREEN verification:

- Focused Skill test: 1 file passed, 55/55 tests passed.
- Required combined test: 2 files passed, 57/57 tests passed.
- Full contracts regression: 17 files passed, 163/163 tests passed.
- Contracts typecheck: exit 0.
- Root typecheck: exit 0.

Natural-language profile overlap cannot be decided safely from syntax alone. Task 8 remains responsible for proving that accepted static hints originate from the observed page at the registered origin before activation.

## Third reviewer fix cycle

The third review identified credential markers hidden behind underscore separators, segmented opaque payloads, and additional executable network/XPath literal shapes.

Third-review RED command:

`rtk corepack pnpm --filter @resume/contracts exec vitest run src/application-skill.test.ts`

Result: exit 1; 23 failed / 33 passed. Failures reproduced underscore-separated credentials across direct and typed-patch carriers, segmented high-entropy values, and `fetch`, XHR, axios, XPath-axis, and XPath-predicate literals in all static text positions. The descriptive identifier/route and legitimate static-label retention sets remained green during RED.

Fixes:

- Credential detection normalizes underscore, slash, hyphen, and whitespace separators before matching non-alphanumeric term boundaries, closing `approval_token_secret` and `bearer_token` bypasses.
- A conservative segmented-opaque check requires at least three substantial chunks, at least 24 alphanumeric characters, and mixed case or repeated letter/digit interleaving; ordinary lowercase descriptive IDs and routes remain valid.
- Static executable-shape detection now covers `fetch(...)`, `XMLHttpRequest(...)`, axios method calls, XPath axes using `::`, and XPath predicates containing attribute references.
- Shared refinements continue to protect evolvable identifiers, locator keys, stable attributes, relative routes, static hints, and the same values nested in typed patches.
- Mandatory full-page audit, context-free patch removal restrictions, CSS dynamic-value checks, runtime opaque-ID compatibility, and legitimate literal labels remain unchanged.

Third-review GREEN verification:

- Focused Skill test: 1 file passed, 56/56 tests passed.
- Required combined test: 2 files passed, 58/58 tests passed.
- Full contracts regression: 17 files passed, 164/164 tests passed.
- Contracts typecheck: exit 0.
- Root typecheck: exit 0.

## Fourth reviewer fix cycle

The fourth review found that the segmented-opaque detector discarded four-character chunks and treated mixed case alone as suspicious. That allowed `akj3-m9qx-7vpt-2n4c-z8r5-w1ys` while rejecting readable camelCase application terminology.

Fourth-review RED command:

`rtk corepack pnpm --filter @resume/contracts exec vitest run src/application-skill.test.ts`

Result: exit 1; 25 failed / 36 passed. Direct content and typed-patch failures reproduced the short segmented payload in all four static-text positions, six evolvable identifier positions, stable attributes, and relative routes. Compatibility failures reproduced rejection of `candidateName-workflowStep-educationEntry`; the exact `JavaScript`, `TypeScript`, and `NodeJS` labels remained valid.

Fixes:

- Segmented candidates now require a contiguous run of at least three alphanumeric chunks of at least four characters, with a combined length of at least 24 characters.
- Every eligible contiguous window is evaluated, so a readable route prefix cannot dilute a later opaque payload.
- A window is rejected only when all conservative random-payload signals agree: normalized Shannon entropy at least 4 bits/character, at least four digits, digit density at least 0.15, vowel ratio at most 0.20, and at least four adjacent letter/digit transitions.
- Mixed case is no longer a rejection signal. Exact static labels `JavaScript`, `TypeScript`, and `NodeJS`, descriptive camelCase static/attribute/route values, and a vowel-rich segmented boundary fixture with digits remain valid in direct content and typed patches.
- Restricted-CSS attribute carriers exercise the same opaque-value rejection and camelCase compatibility while retaining the mandatory final-fallback ordering.
- All earlier audit-boundary, credential-separator, executable-shape, CSS dynamic-value, schema-closure, and runtime opaque-ID protections remain in place.

Test-fixture correction: after adding explicit restricted-CSS compatibility coverage, one focused run reported 2 failed / 59 passed because the new fixture supplied CSS as the only locator. The fixture was corrected to use a stable label first and CSS last; no production relaxation was made.

Fourth-review GREEN verification:

- Focused Skill test: 1 file passed, 61/61 tests passed.
- Required combined test: 2 files passed, 63/63 tests passed.
- Full contracts regression: 17 files passed, 169/169 tests passed.
- Contracts typecheck: exit 0.
- Root typecheck: exit 0.

Caveat: entropy screening is intentionally conservative and syntactic; it is not proof that a retained literal came from the target ATS page. Task 8 must still validate static-text origin, profile overlap, and registered-domain context before activating evolved Skill content.
