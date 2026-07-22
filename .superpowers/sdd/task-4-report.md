# Task 4 Report

## Implementation Summary
- Added the vendor-neutral `@resume/model-provider` contract and deterministic fake provider.
- Added Zod-validated candidate extraction that creates only source-backed `ProfileFact` values.
- Every candidate quote is checked against its exact referenced page before fact construction.

## RED
`corepack pnpm --filter @resume/profile-domain test -- extract-facts.test.ts`
Output: FAIL - `Cannot find package '@resume/model-provider'` from the new extraction test suite.

## GREEN
`corepack pnpm --filter @resume/profile-domain test -- extract-facts.test.ts`
Output: PASS - 2 files, 12 tests passed (five Task 4 tests plus existing PDF tests).

## Verification
`corepack pnpm test && corepack pnpm typecheck && corepack pnpm build`
Output: PASS - root suite: contracts 5, API 12, profile domain 12; root typecheck and recursive build exit 0.

## Files Changed
- `packages/model-provider/package.json`, `src/provider.ts`, `src/fake-provider.ts`, `src/index.ts`
- `packages/profile-domain/package.json`, `src/extraction/extraction-schema.ts`, `src/extraction/extract-facts.ts`, `src/extraction/extract-facts.test.ts`
- `pnpm-lock.yaml`

## Self-Review
- Re-parses provider output at the extraction boundary even if a provider violates its generic contract.
- Uses `ProfileFactSchema`; no `DecisionStatus` is placed on profile facts.
- Checks `git diff --check`; no whitespace errors.

## Concerns
- Existing PDF test logs `Warning: Indexing all PDF objects`; it does not fail tests and is unrelated to Task 4.

## Review Fixes
- FakeModelProvider now snapshots structured JSON-like data and embedding matrices with `structuredClone` at construction and returns fresh clones. This deliberately rejects values that are not structured-cloneable rather than claiming support for unserializable fixtures.
- `extractFacts` indexes document pages before provider invocation and rejects non-positive/non-integer or duplicate page identities instead of resolving them with `find`.
- Empty quotes are schema-rejected by `ExtractionSchema` (`z.string().min(1)`), with a regression test.

### RED
`corepack pnpm --filter @resume/model-provider test; corepack pnpm --filter @resume/profile-domain test -- extract-facts.test.ts`
Output: FAIL - fake response changed after caller mutation; fake embeddings changed after output mutation; duplicate and page `0` documents invoked the provider and failed later with a missing structured response.

### GREEN
`corepack pnpm --filter @resume/model-provider test; corepack pnpm --filter @resume/profile-domain test -- extract-facts.test.ts; corepack pnpm --filter @resume/model-provider typecheck; corepack pnpm --filter @resume/profile-domain typecheck`
Output: PASS - provider 2 tests; profile-domain 15 tests; both package typechecks exit 0.

### Semantic Support Disposition
The reviewer suggestion to prove `fieldPath` and `value` entailment from the quote is not implemented. Task 4 defines support as exact quote existence on the referenced page, while values may normalize dates, booleans, arrays, and canonical field paths; substring heuristics would reject valid facts without proving entailment. Task 6 requires user review of every extracted fact and Task 7 owns decision verification. The existing non-brittle safeguard remains schema validation plus exact page-quote validation; no new architecture was added.
