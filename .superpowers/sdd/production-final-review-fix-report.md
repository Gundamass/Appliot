# Production Final Review Fix Report

## Status

DONE

## Fixes

- Semantic RAG plans now return no candidates with the stable `embedding search unavailable` reason when the embedding provider is absent or reports `EmbeddingSearchUnavailableError`. Exact repository matches still win first, and keyword-only plans retain keyword retrieval.
- DeepSeek request timeouts now span response headers and JSON body parsing. Body-parse `AbortError` failures are retryable timeouts, malformed response JSON remains retryable response validation, and every attempt clears its timer.
- Remote deployment `start`, `stop`, and `status` now hold `InstallLock` across controller ownership validation, resolution, and lifecycle action. The existing heqing entry check remains before filesystem and lock access, and lock-agnostic helpers avoid nested acquisition during rollback.

## TDD Evidence

- RAG missing-provider and unavailable-provider tests failed by returning keyword candidates before the retriever change, then passed with empty candidates and the stable invalid reason. Added keyword-only preservation and API route-level blocked-state coverage.
- DeepSeek stalled-body test failed because the timer was cleared after headers and body parsing never reached the retry limit. It passed after extending the timer scope, with 2 attempts, 1 retry sleep, 2 aborted signals, and 2 cleared timers.
- Deployment tests failed because `_control` resolved and invoked the controller without entering `InstallLock`. They passed after locking the lifecycle boundary and prove no resolution or action occurs under contention.

## Verification

- `corepack pnpm --filter @resume/rag test` - PASS, 185 tests.
- `corepack pnpm --filter @resume/model-provider test` - PASS, 48 tests.
- `corepack pnpm --filter @resume/api exec vitest run src/rag/rag-routes.test.ts` - PASS, 8 tests.
- `python -m unittest discover -s deploy/remote/tests -p "test_*.py"` - PASS, 80 tests; 7 platform-specific tests skipped on Windows.
- `corepack pnpm test` - PASS across 6 workspace projects after updating the route integration expectations.
- `corepack pnpm typecheck` - PASS.
- `corepack pnpm build` - PASS, including the Vite web build and bundled API artifact.
- `git diff --check` - PASS.

## Concerns

- Seven deployment tests are skipped on Windows because they require Linux behavior such as real activation symlinks. The lock regressions themselves ran and passed on Windows.
- Pre-existing `.superpowers/sdd/progress.md` changes and cache directories were intentionally excluded from this work.
