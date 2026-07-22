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
