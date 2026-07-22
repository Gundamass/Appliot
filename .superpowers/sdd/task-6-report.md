# Task 6 Report: Profile Review Web Experience

## Status

Complete. The local operational profile-review surface is implemented as the first web screen.

## Delivered

- Added the `@resume/web` React/Vite application with a compact full-width frame, local-only state, PDF upload controls, status filters, and unframed grouped fact sections.
- Added predictable `fieldPath` category derivation with stable Chinese ordering for basic information, education, work, projects, skills, certificates, links, self-evaluation, preferences, and other.
- Added explicit visible status treatment for extracted, confirmed, corrected, and superseded facts. Extracted facts always display `待确认` until the confirmation API succeeds.
- Added an accessible evidence side dialog with honest document identity, page, extraction method, exact quote, Escape/backdrop close, focus entry, focus trap, body scroll lock, and focus restoration.
- Added explicit confirmation and type-aware correction flows. Strings use text inputs or textareas, numbers use number inputs, booleans use checkboxes, and structured/null values use JSON textareas with local validation.
- Added non-optimistic mutation handling, disabled in-flight controls, row-level API errors, and active-fact reconciliation after successful mutations so Task 5 superseded alternatives disappear immediately.
- Added PDF selection validation, selected filename, indeterminate progress, loading/disabled/error/success states, and fact refresh after an accepted upload.
- Added loading, retryable error, empty, filtered-empty, overflow, reduced-motion, and narrow mobile states.
- Added a strict `ProfileApi` HTTP adapter. Upload, list, confirm, and correct responses are parsed through shared Zod contracts before use; confirmation sends no body and correction sends exactly `{ value }`.

## TDD Evidence

- Initial UI/client run failed because `ProfilePage` and `client` did not exist.
- Category-alias regression failed because underscore-normalized education/work/project/skill/link paths fell into `其他`, then passed after the mapper update.
- Active-fact reconciliation regression failed because a superseded alternative remained visible, then passed after successful mutations refreshed `listFacts()`.
- Deterministic fake API tests cover upload, initial loading/error/empty, pending extracted status, evidence dialog semantics, confirm success/failure, correction cancel/success/failure/type preservation, invalid JSON, filters, grouping, mutation reconciliation, disabled in-flight controls, and HTTP payload contracts.

## Verification

- Focused profile tests: 19 passed.
- Full web tests: 24 passed.
- Web typecheck: passed.
- Web production build: passed.
- Root workspace tests: 92 passed.
- Root typecheck: passed.
- Root workspace build: passed.
- `git diff --check`: passed.
- CSS constraint scan: no viewport-scaled font sizes, negative letter spacing, gradients, or fact-row radii above 8px.

## Self-Review

- Accessibility: semantic headings/sections/forms/buttons, labeled icon-only controls, `aria-pressed` filters, status/alert announcements, modal dialog semantics, keyboard close/focus trap/focus restoration, visible focus outlines, and reduced-motion handling.
- Responsive layout: fixed typography breakpoints, horizontally scrollable compact filters, mobile single-column fact rows, wrapping action controls, filename truncation, overflow-safe values/document IDs/quotes, and a full-width narrow drawer.
- Scope: no login, RAG, application task, submission, or browser automation UI was added.

## Concerns

None blocking. Automated interaction and static responsive checks are complete; the in-app browser connector was unavailable in this execution environment, so visual review was performed from the implemented responsive constraints rather than an interactive browser capture.

## Review Fixes

### RED

Shared HTTP response contracts were specified before their implementation:

```text
corepack pnpm --filter @resume/contracts exec vitest run src/http.test.ts --reporter=dot

Test Files  1 failed (1)
Tests       no tests
Error: Cannot find module './http.js'
```

Async ownership, mutation serialization, accepted-upload refresh, MIME validation, and dead-filter regressions failed against the reviewed implementation:

```text
corepack pnpm --filter @resume/web exec vitest run src/profile/ProfilePage.test.tsx --reporter=dot

Test Files  1 failed (1)
Tests       9 failed | 19 passed (28)
```

User-origin evidence, context-aware labels, and keyboard-focus ownership regressions then failed before their production changes:

```text
corepack pnpm --filter @resume/web exec vitest run src/profile/ProfilePage.test.tsx --reporter=dot

Test Files  1 failed (1)
Tests       8 failed | 26 passed (34)
```

Covering verification caught one test-fixture typing issue after runtime behavior was green:

```text
corepack pnpm --filter @resume/web typecheck

src/profile/ProfilePage.test.tsx(405,72): error TS2322: Type 'true | "ada@example.com" | readonly ["TypeScript"]' is not assignable to type 'JsonValue | undefined'.
Type 'readonly ["TypeScript"]' is not assignable to type 'JsonValue | undefined'.
```

### GREEN

Shared schema, client parsing, and API route coverage:

```text
corepack pnpm --filter @resume/contracts exec vitest run src/http.test.ts --reporter=dot
Test Files  1 passed (1)
Tests       2 passed (2)

corepack pnpm --filter @resume/web exec vitest run src/api/client.test.ts --reporter=dot
Test Files  1 passed (1)
Tests       5 passed (5)

corepack pnpm --filter @resume/api exec vitest run src/profile/profile-routes.test.ts --reporter=dot
Test Files  1 passed (1)
Tests       28 passed (28)
```

Async ownership and operational-flow slice:

```text
corepack pnpm --filter @resume/web exec vitest run src/profile/ProfilePage.test.tsx --reporter=dot
Test Files  1 passed (1)
Tests       28 passed (28)
```

Evidence, labels, and focus slice:

```text
corepack pnpm --filter @resume/web exec vitest run src/profile/ProfilePage.test.tsx --reporter=dot
Test Files  1 passed (1)
Tests       34 passed (34)
```

Focused covering tests after all fixes:

```text
corepack pnpm --filter @resume/contracts exec vitest run src/http.test.ts src/profile.test.ts --reporter=dot
Test Files  2 passed (2)
Tests       7 passed (7)

corepack pnpm --filter @resume/web exec vitest run src/api/client.test.ts --reporter=dot
Test Files  1 passed (1)
Tests       5 passed (5)

corepack pnpm --filter @resume/api exec vitest run src/profile/profile-routes.test.ts --reporter=dot
Test Files  1 passed (1)
Tests       28 passed (28)
```

Full web verification after widening the structured fixture to `JsonValue`:

```text
corepack pnpm --filter @resume/web test
Test Files  2 passed (2)
Tests       39 passed (39)

corepack pnpm --filter @resume/web typecheck
Exit code: 0

corepack pnpm --filter @resume/web build
1792 modules transformed
vite built in 227ms
Exit code: 0
```

Package and workspace coverage:

```text
corepack pnpm --filter @resume/contracts test
Test Files  2 passed (2)
Tests       7 passed (7)

corepack pnpm --filter @resume/api test
Test Files  3 passed (3)
Tests       46 passed (46)

corepack pnpm test
Workspace tests: 109 passed across contracts, model-provider, profile-domain, web, and API
Exit code: 0

corepack pnpm typecheck
Exit code: 0

corepack pnpm build
All 5 participating workspace projects built successfully
Exit code: 0

git diff --check
Exit code: 0
```

Schema ownership scan:

```text
rg -n "const DocumentResponseSchema|const ErrorResponseSchema|DecisionStatus" apps packages

packages/contracts/src/http.ts:3:export const DocumentResponseSchema = z.object({
packages/contracts/src/http.ts:8:export const ErrorResponseSchema = z.object({
packages/contracts/src/profile.ts:55:export const DecisionStatusSchema = z.enum([
packages/contracts/src/profile.ts:87:export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;
```

`DocumentResponseSchema` and `ErrorResponseSchema` now have one shared owner in `@resume/contracts`; `DecisionStatus` remains separate and is not part of `ProfileFact`.
