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
