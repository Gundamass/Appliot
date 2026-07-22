# Task 8 Report: Evidence-Constrained Self-Evaluation Review

## Status

Implemented and verified.

## Design

- `packages/rag/src/self-evaluation.ts` sends the provider only the base self-evaluation, job description, and eligible facts. Eligible facts are `user_confirmed` or `user_corrected` profile facts and same-task application facts.
- Provider output is constrained by a strict Zod schema, reparsed at the tailoring boundary, and must declare claims with evidence fact IDs.
- The deterministic validator blocks claims/tokens not present in the original or declared eligible evidence. Unsupported skills, years, metrics, certifications, qualifications, and commitments therefore leave the draft `blocked`; valid drafts remain `needs_review` until explicit approval.
- SQLite table `self_evaluation_reviews` persists task review records. This is the API-owned persistence port selected because application approvals must survive process restarts and the existing application already owns SQLite migrations.
- `POST /api/reviews/self-evaluations/:taskId` stores a reviewable draft only after strict body, evidence, and deterministic claim validation. `POST .../approve` persists a server-evidenced application-scoped `selfEvaluation` answer through `putTaskAnswer`; it never calls `correct`.
- `POST .../promote` is separate, requires a previously approved task review and an explicit active profile fact whose path is `selfEvaluation`, then calls `correct`. Approved/promoted records cannot be overwritten or promoted twice.
- `SelfEvaluationReview` provides side-by-side desktop/stacked narrow review content, evidence labels for PDF/OCR/user sources, explicit adopt/edit-adopt/keep-original controls, disabled blocked adoption, non-optimistic busy/error handling, and focus return.

## Verification

- Focused RAG: 147 tests passed.
- Focused API: 50 tests passed.
- Focused web: 47 tests passed.
- `corepack pnpm test` passed.
- `corepack pnpm typecheck` passed.
- `corepack pnpm build` passed.
- `git diff --check` passed.

## Concerns

- Deterministic token coverage is intentionally conservative, not semantic entailment. A claim without clear lexical coverage is blocked for review rather than inferred as safe.
- The review component and parsed review client are implemented as the task-facing integration surface; no browser automation or submission flow was added.

## Review Fixes

### RED

- Added failing tests for server-owned profile base provenance, forged originals, missing eligible base facts, extracted/superseded/cross-task base exclusion, empty and duplicate claims, short technical tokens, numeric/currency and polarity changes, approval rollback/retry, promotion rollback/retry, base-revision conflict, concurrent transitions, and the production ProfilePage review consumer.
- The web RED run exposed the missing terminal result: returned approvals did not update `SelfEvaluationReview`, and focus could target a removed adopt button.

### GREEN

- Reviews now bind the active reviewed profile `selfEvaluation` fact ID, revision, original and evidence snapshot on the server; the client cannot provide a base identity or evidence.
- Tailoring reparses strict generated output, validates declared claim references against eligible server facts, and blocks uncovered technical tokens, numeric changes, and commitment-polarity changes.
- Approval and promotion use conditional state transitions inside the profile repository SQLite transaction. Failure injection confirms each operation rolls back and can be retried; concurrent calls yield one success and one conflict.
- Promotion resolves only the persisted base fact and revision; a changed or superseded base conflicts.
- ProfilePage now uses the parsed review API and has an explicit task load/refresh view. The review component owns the returned terminal result, removes actions after approval, renders whether the tailored draft or original was chosen, and focuses the stable status element.

### Final Verification

- Focused RAG: 154 tests passed.
- Focused API: 57 tests passed.
- Focused web: 49 tests passed.
- Package web typecheck passed.
- Root test, typecheck, build, and `git diff --check` are run in the final verification gate before commit.

## Second Security Hardening

### RED

- RAG regressions initially failed for English and Chinese negation reversals, Unicode-only invented terms, added negation, changed clauses without metadata, and conflicting duplicate evidence IDs.
- The ProfilePage ownership regressions initially allowed an edited task input to retarget an existing review and allowed a mismatched or stale load response to render.

### GREEN

- Tailoring now canonicalizes eligible facts before calling the provider; identical duplicate IDs deduplicate while conflicting full payloads block generation and cannot supply referenced evidence.
- The validator uses NFKC-normalized Unicode material units and conservative polarity fingerprints. It blocks unclaimed changed clauses, Unicode inventions, numeric changes, and added, removed, or reversed negation where preservation cannot be established.
- The create route continues to validate through the server-bound original and eligible fact snapshot via `buildSelfEvaluationDraft`; client data cannot establish base provenance or authorize a polarity bypass.
- ProfilePage keeps the editable task input distinct from the immutable loaded task, discards stale/out-of-order loads, validates returned task IDs, and serializes review actions against the loaded review only.

### Final Verification

- Focused RAG: 170 tests passed.
- Focused API: 58 tests passed.
- Focused web: 53 tests passed.
- Root test, typecheck, build, and `git diff --check` were run in the final completion gate before commit.

## Final Association Hardening

### RED

- Added relation-level regressions for swapped React/Java tenure in both directions, project percentages, currency responsibilities, and certification-to-skill associations. All passed incorrectly under the old unordered token coverage.
- Added a split-evidence regression: separate `5 years` and `React` facts incorrectly authorized `5 years React` when pooled.
- Added an approve-route regression showing an edited tenure swap needed to fail without changing the stored task answer or review status.

### GREEN

- The shared validator now derives compact, per-clause material relationship fingerprints: numeric/qualification anchors carry their nearby material subjects, and polarity stays bound to its local subject/action.
- Every changed generated clause requires exactly one clause-scoped claim and is authorized by one original clause or by one referenced fact value/evidence clause; evidence fragments are never unioned to manufacture a relationship.
- Edited approvals use the review's persisted authorized evidence snapshot with the same structural relation check, so current unrelated facts cannot broaden authorization.
- Safe sentence reordering remains accepted when each original relationship is intact.

### Final Verification

- Focused RAG: 179 tests passed.
- Focused API: 59 tests passed.
- Focused web: 53 tests passed.
- Root test, typecheck, build, and `git diff --check` were run in the final completion gate before commit.
