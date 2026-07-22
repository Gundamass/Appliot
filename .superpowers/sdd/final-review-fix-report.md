# Foundation Final-Review Fix Report

Branch: `feature/resume-assistant-foundation`

Base commit: `726ecb3`

## 1. Runnable API package

Changed files:

- `apps/api/package.json`
- `apps/api/src/server.ts`
- `apps/api/src/server-launch.test.ts`
- `pnpm-lock.yaml`

RED:

- Command: `corepack pnpm --filter @resume/api exec vitest run src/server-launch.test.ts`
- Summary: the package did not emit a package-local executable entrypoint, so launching the intended artifact could not reach the explicit missing-adapter guard.
- Integration RED: `corepack pnpm --filter @resume/api test` later failed because esbuild followed `@napi-rs/canvas` into a native `.node` binary and emitted no artifact.

GREEN:

- Command: `corepack pnpm --filter @resume/api exec vitest run src/server-launch.test.ts`
- Summary: 1 test passed; esbuild emitted `dist/server.js`, Node resolved its runtime dependencies, and execution reached `Local PDF and fact extraction dependencies must be configured before starting the API` without `ERR_MODULE_NOT_FOUND`.

Concern:

- Production still intentionally requires concrete local PDF/fact extraction adapters before listening. No fake OCR or model provider was added.

## 2. Durable original PDF retention

Changed files:

- `apps/api/src/app.ts`
- `apps/api/src/db/migrate.ts`
- `apps/api/src/db/schema.ts`
- `apps/api/src/db/migrate.test.ts`
- `apps/api/src/profile/document-repository.ts`
- `apps/api/src/profile/document-repository.test.ts`
- `apps/api/src/profile/original-document-store.ts`
- `apps/api/src/profile/original-document-store.test.ts`
- `apps/api/src/profile/import-service.ts`
- `apps/api/src/profile/import-service.test.ts`
- `apps/api/src/profile/profile-routes.test.ts`
- `apps/api/src/server.ts`

RED:

- Commands: `corepack pnpm --filter @resume/api exec vitest run src/profile/original-document-store.test.ts src/profile/document-repository.test.ts src/profile/import-service.test.ts src/profile/profile-routes.test.ts`
- Summary: the application had no owned original-file store or retained/importing/completed metadata, and failed extraction left no durable exact-byte source for retry.
- Recovery RED: `corepack pnpm --filter @resume/api exec vitest run src/db/migrate.test.ts` failed with `{ import_status: 'importing' }` instead of `{ import_status: 'retained' }`, proving a process interruption could permanently block retries.

GREEN:

- Command: `corepack pnpm --filter @resume/api exec vitest run src/db/migrate.test.ts src/profile/document-repository.test.ts src/profile/import-service.test.ts src/profile/profile-routes.test.ts`
- Summary: 35 tests passed; exact bytes are hash-addressed and durably written before extraction, metadata remains retryable after failures, completed imports retain their source, and startup recovers interrupted claims.

Concern:

- Existing databases from before this fix receive compatible metadata columns, but originals that were never retained cannot be reconstructed; those legacy completed rows receive an empty `source_path`.

## 3. Web development proxy

Changed files:

- `apps/web/vite.config.ts`
- `apps/web/src/vite-proxy.test.ts`

RED:

- Command: `corepack pnpm --filter @resume/web exec vitest run src/vite-proxy.test.ts`
- Summary: expected `http://127.0.0.1:43120`, received the old `http://localhost:3000` target.

GREEN:

- Command: `corepack pnpm --filter @resume/web exec vitest run src/vite-proxy.test.ts`
- Summary: 1 test passed with the API's actual loopback host and port.

Concern: none.

## 4. Usable RAG API and Web loop

Changed files:

- `packages/contracts/src/rag.ts`
- `packages/contracts/src/index.ts`
- `apps/api/src/app.ts`
- `apps/api/src/rag/rag-routes.ts`
- `apps/api/src/rag/rag-routes.test.ts`
- `apps/web/src/api/client.ts`
- `apps/web/src/api/client.test.ts`
- `apps/web/src/main.tsx`
- `apps/web/src/profile/ProfilePage.tsx`
- `apps/web/src/rag/RagWorkspace.tsx`
- `apps/web/src/rag/RagWorkspace.test.tsx`
- `apps/web/src/styles.css`

RED:

- Commands: `corepack pnpm --filter @resume/api exec vitest run src/rag/rag-routes.test.ts` and `corepack pnpm --filter @resume/web exec vitest run src/api/client.test.ts src/rag/RagWorkspace.test.tsx`
- Summary: no HTTP contract/routes/client or reachable UI exposed planning, evidence, decision state, questions, and server-owned corrections.

GREEN:

- API command: `corepack pnpm --filter @resume/api exec vitest run src/rag/rag-routes.test.ts` (3 passed).
- Web command: `corepack pnpm --filter @resume/web exec vitest run src/api/client.test.ts src/rag/RagWorkspace.test.tsx` (9 passed).
- Summary: the API delegates planning/resolution/correction to `@resume/rag`; the Web field-evidence view displays strategy, evidence, confidence, status, questions, and explicit task/profile correction controls.

Concern:

- Retrieval is intentionally foundation-scale local keyword/exact retrieval; no embedding provider or browser automation was introduced.

## 5. End-to-end self-evaluation workflow

Changed files:

- `packages/contracts/src/reviews.ts`
- `packages/contracts/src/reviews.test.ts`
- `apps/api/src/app.ts`
- `apps/api/src/reviews/review-routes.ts`
- `apps/api/src/reviews/review-routes.test.ts`
- `apps/web/src/api/client.ts`
- `apps/web/src/api/client.test.ts`
- `apps/web/src/profile/ProfilePage.tsx`
- `apps/web/src/profile/ProfilePage.test.tsx`
- `apps/web/src/profile/SelfEvaluationWorkflow.test.tsx`
- `apps/web/src/reviews/SelfEvaluationReview.tsx`
- `apps/web/src/reviews/SelfEvaluationReview.test.tsx`
- `apps/web/src/reviews/SelfEvaluationPromotion.test.tsx`
- `apps/web/src/styles.css`

RED:

- Commands: `corepack pnpm --filter @resume/contracts exec vitest run src/reviews.test.ts`, `corepack pnpm --filter @resume/api exec vitest run src/reviews/review-routes.test.ts`, and `corepack pnpm --filter @resume/web exec vitest run src/profile/SelfEvaluationWorkflow.test.tsx src/reviews/SelfEvaluationPromotion.test.tsx`
- Summary: creation accepted a caller-generated draft and discarded job provenance; the route did not invoke a real provider; the Web had no creation form or explicit post-approval promotion action.

GREEN:

- Contracts: 1 focused test passed.
- API: 14 review-route tests passed.
- Web: the creation/promotion workflow tests passed, and the five focused review/RAG files passed 49 tests together.
- Summary: the server generates through `tailorSelfEvaluation`, persists the job description, returns `503` without a configured provider, and the Web requires separate create, approve/keep-original, and promote actions.

Concern:

- The production composition root still has no concrete model provider, so tailoring correctly reports temporary unavailability until one is configured.

## 6. Current-task answers in self-evaluation evidence

Changed files:

- `apps/api/src/profile/profile-repository.ts`
- `apps/api/src/profile/profile-repository.test.ts`
- `apps/api/src/reviews/review-routes.ts`
- `apps/api/src/reviews/review-routes.test.ts`

RED:

- Commands: `corepack pnpm --filter @resume/api exec vitest run src/profile/profile-repository.test.ts src/reviews/review-routes.test.ts`
- Summary: repository retrieval exposed only profile facts, so same-task answers could not support tailoring; the new adversarial test also required another task's answer to remain absent.

GREEN:

- Summary: the repository/review focused suites passed; `listForTask(taskId)` returns active profile facts plus only that task's answers, and provider-input assertions include the owning task value while excluding the other task value.

Concern: none.

## 7. Scope integrity at every boundary

Changed files:

- `packages/contracts/src/profile.ts`
- `packages/contracts/src/profile.test.ts`
- `apps/api/src/db/migrate.ts`
- `apps/api/src/db/schema.ts`
- `apps/api/src/profile/import-service.ts`
- `apps/api/src/profile/profile-repository.ts`
- `apps/api/src/profile/profile-repository.test.ts`
- `apps/api/src/profile/profile-routes.test.ts`

RED:

- Commands: `corepack pnpm --filter @resume/contracts exec vitest run src/profile.test.ts` and `corepack pnpm --filter @resume/api exec vitest run src/profile/profile-repository.test.ts src/profile/profile-routes.test.ts`
- Summary: `scope: 'profile'` with `taskId` passed shared validation and legacy SQLite checks enforced only the application-to-task direction; malformed extractor output also needed rejection before persistence.

GREEN:

- Contracts: 6 profile contract tests passed.
- API: repository and profile-route suites passed, including direct SQL inserts/updates, malformed extraction output, both scope/task mismatch directions, and cross-task isolation.

Concern:

- New tables use CHECK constraints; existing tables receive equivalent insert/update triggers because SQLite cannot add a table CHECK in place.

## 8. Duplicate detection before expensive extraction

Changed files:

- `apps/api/src/profile/document-repository.ts`
- `apps/api/src/profile/document-repository.test.ts`
- `apps/api/src/profile/import-service.ts`
- `apps/api/src/profile/import-service.test.ts`
- `apps/api/src/profile/profile-routes.test.ts`

RED:

- Commands: `corepack pnpm --filter @resume/api exec vitest run src/profile/import-service.test.ts src/profile/profile-routes.test.ts`
- Summary: duplicate detection happened during final document insertion, after PDF/OCR/model work; no retained failed-import state existed for a legal retry.

GREEN:

- Import-service command: 2 tests passed.
- Route suite: 31 tests passed, including atomic concurrent duplicate handling.
- Summary: SHA-256 is computed from the immutable upload snapshot, completed metadata short-circuits before extractors, and retained failures can reclaim and retry the same source.

Concern:

- Concurrent requests while one import is actively `importing` receive the same `409` response as a completed duplicate; a later request may retry after the active attempt fails.

## 9. Malformed PDF parser response mapping

Changed files:

- `packages/profile-domain/src/pdf/extract-pdf.ts`
- `packages/profile-domain/src/pdf/extract-pdf.test.ts`
- `apps/api/src/profile/import-service.ts`
- `apps/api/src/profile/profile-routes.test.ts`

RED:

- Commands: `corepack pnpm --filter @resume/profile-domain exec vitest run src/pdf/extract-pdf.test.ts` and `corepack pnpm --filter @resume/api exec vitest run src/profile/profile-routes.test.ts`
- Summary: a signed `%PDF-` payload rejected by PDF.js propagated as an unexpected error and the route returned `500`.

GREEN:

- Profile-domain: 7 PDF tests passed.
- API: 31 profile-route tests passed; the real parser rejection returns `400 Invalid PDF upload`, while configured unavailability remains `503` and unexpected failures remain `500`.

Concern: none.

## Package Integration Verification

- `corepack pnpm --filter @resume/api test`: 74 tests passed after adding interrupted-import recovery coverage.
- `corepack pnpm --filter @resume/web test`: 58 tests passed.
- `corepack pnpm --filter @resume/contracts test`: 9 tests passed.
- `corepack pnpm --filter @resume/profile-domain test`: 15 tests passed.
- `corepack pnpm --filter @resume/rag test`: 179 tests passed.
- `corepack pnpm typecheck`: passed.

## Final Verification

- `corepack pnpm test`: passed, 337 tests across 26 test files (API 74, Web 58, contracts 9, model provider 2, profile domain 15, RAG 179).
- `corepack pnpm typecheck`: passed.
- `corepack pnpm build`: passed; Vite emitted the Web production assets and esbuild emitted `apps/api/dist/server.js`.
- `git diff --check`: passed; Git emitted only the repository's existing LF-to-CRLF checkout warnings.

## Launch Follow-up After `c74cf14`

Independent direct execution found that the emitted API artifact still performed an undeclared runtime package lookup. The bundled profile-domain extractor called `createRequire(import.meta.url).resolve("pdfjs-dist/legacy/build/pdf.mjs")` to locate PDF.js `standard_fonts`, but `@resume/api` did not declare `pdfjs-dist`; the earlier launch test also rejected only `ERR_MODULE_NOT_FOUND`, not CommonJS `MODULE_NOT_FOUND` or `Cannot find module`.

Changed files:

- `apps/api/package.json`
- `apps/api/src/server-launch.test.ts`
- `pnpm-lock.yaml`
- `.superpowers/sdd/progress.md`
- `.superpowers/sdd/final-review-fix-report.md`

RED:

- Direct command from repository root: `node apps/api/dist/server.js`
- Direct command from `apps/api`: `node dist/server.js`
- Result for both: exit 1 before the intentional guard with `Error: Cannot find module 'pdfjs-dist/legacy/build/pdf.mjs'`, code `MODULE_NOT_FOUND`, originating from `apps/api/dist/server.js`.
- Focused command: `corepack pnpm --filter @resume/api exec vitest run src/server-launch.test.ts`
- Result: 1 failed. The strengthened test builds once, removes `NODE_PATH`, launches both literal direct-command paths, requires the intentional missing-adapter message, and rejects `MODULE_NOT_FOUND`, `ERR_MODULE_NOT_FOUND`, and `Cannot find module`.

GREEN:

- Minimal fix: add `pdfjs-dist@5.3.31` as an `@resume/api` runtime dependency and externalize `pdfjs-dist/*` from the API bundle. This keeps executable PDF.js code and its runtime-resolved `standard_fonts` resources in the same declared/deployable package.
- Install command: `corepack pnpm install` completed successfully and created `apps/api/node_modules/pdfjs-dist`.
- Focused command: `corepack pnpm --filter @resume/api exec vitest run src/server-launch.test.ts`
- Result: 1 test passed; both sanitized direct launches reached `Local PDF and fact extraction dependencies must be configured before starting the API` without a module-resolution failure.
- Direct command from repository root: `node apps/api/dist/server.js`
- Direct command from `apps/api`: `node dist/server.js`
- Result for both: intentional exit 1 at `createProductionDependencies` with the missing extraction-adapter message; no `MODULE_NOT_FOUND` or `Cannot find module` output.

Concern: none beyond the intentional absence of concrete production extraction adapters, which must continue to fail before listening.

### Follow-up Final Verification

- `corepack pnpm test`: passed, 337 tests across 26 test files; API 74, Web 58, contracts 9, model provider 2, profile domain 15, and RAG 179.
- `corepack pnpm typecheck`: passed.
- `corepack pnpm build`: passed; the API build externalized `pdfjs-dist/*` and emitted `apps/api/dist/server.js` (210.9 kB).
- From repository root, `node apps/api/dist/server.js`: intentional exit 1 with `Local PDF and fact extraction dependencies must be configured before starting the API`; no module-resolution failure.
- From `apps/api`, `node dist/server.js`: intentional exit 1 with the same missing-adapter guard; no module-resolution failure.
- `git diff --check`: passed; only the repository's LF-to-CRLF checkout warnings were emitted.
