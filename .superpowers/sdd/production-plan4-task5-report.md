# Plan 4 Task 5 Report

## Result

Implemented Task 5 Step 1 local acceptance artifacts:

- `scripts/verify-remote-workers.mjs` reads worker URLs and bearer tokens only
  from environment variables and does not print URLs, tokens, request bodies,
  response bodies, raw OCR text, or raw resume text.
- The verifier fail-closes before a request when required environment values or
  fixture structures are invalid. It requires both Workers to report `ready`,
  verifies pinned model IDs/revisions, checks 4096 finite unit embedding
  vectors, requires Chinese relevant-fact ranking, and requires every OCR
  anchor.
- `tests/fixtures/resumes/embedding-cases.json` contains two sanitized Chinese
  relevance cases, each with one relevant fact and two unrelated facts.
- `tests/fixtures/resumes/ocr-anchors.json` maps sanitized Chinese, English,
  scanned, and double-column PNG fixtures to mandatory anchor strings. All
  fixture content is synthetic; no real resume data is included.
- `scripts/verify-remote-workers.test.mjs` supplies focused local TDD coverage
  using in-memory Worker responses only. It makes no remote, paid, GPU, or
  upload call.

## TDD Evidence

1. RED: `node --test scripts/verify-remote-workers.test.mjs` initially failed
   with `ERR_MODULE_NOT_FOUND` for the missing verifier module.
2. GREEN: the verifier implementation made the three initial focused cases
   pass.
3. RED: a new readiness test failed because a health payload with
   `status: "starting"` was accepted.
4. GREEN: adding exact `status === "ready"` assertions made the final focused
   suite pass.

## Verification

| Command | Result |
| --- | --- |
| `node --test scripts/verify-remote-workers.test.mjs` | PASS: 5 tests, 0 failures. |
| `node --check scripts/verify-remote-workers.mjs` | PASS. |
| `git diff --check -- tests/fixtures/resumes scripts/verify-remote-workers.mjs scripts/verify-remote-workers.test.mjs` | PASS. |
| `node scripts/verify-remote-workers.mjs` | Expected fail-safe result: exited 1 with `Missing required environment variable: EMBEDDING_BASE_URL.` before any request. No credentials, tunnel, or remote Worker was used. |
| `corepack pnpm test` | PASS: all workspace test suites passed. |
| `corepack pnpm typecheck` | PASS. |
| `corepack pnpm build` | PASS. |
| `python -m unittest deploy.remote.tests.test_verify_assets deploy.remote.tests.test_deployment_lifecycle -v` | PASS: 78 tests, 7 expected Windows/Linux capability skips. |

## Unavailable Or Invalid Local Gates

| Required command | Status |
| --- | --- |
| `conda run -p <embedding-test-env> python -m pytest services/embedding-worker/tests -q` | BLOCKED: no embedding test Conda environment exists in this worktree. |
| `conda run -p <ocr-test-env> python -m pytest services/ocr-worker/tests -q` | BLOCKED: no OCR test Conda environment exists in this worktree. |
| `bats deploy/remote/tests/deploy.bats` | BLOCKED: `bats` is not installed. |
| System Python worker fallback: `python -m pytest services/embedding-worker/tests -q --tb=no` | Invalid environment, not a product failure: 12 failed, 13 errors, 17 passed. FastAPI/Starlette mismatch raises `TypeError: Router.__init__() got an unexpected keyword argument 'on_startup'` during app construction. |
| System Python worker fallback: `python -m pytest services/ocr-worker/tests -q --tb=no` | Invalid environment, not a product failure: 12 failed, 18 errors, 26 passed. The same FastAPI/Starlette mismatch occurs during app construction. |

## External Acceptance Blockers

1. No authorized SSH tunnel, remote URLs/tokens, or pinned Workers were supplied
   for live acceptance. The verifier has not contacted any live service.
2. Target-host GPU isolation, authenticated Worker readiness, live Chinese
   retrieval ranking, OCR anchor recognition, degraded-mode transitions, and
   server-log inspection require the authorized remote GPU environment.
3. The required dedicated worker Conda environments and Bats/Linux tooling are
   unavailable locally. Run the exact Task 5 commands in the prepared target
   environment before claiming remote acceptance.

No secrets, real resume content, model payloads, or remote results were
invented or uploaded.
