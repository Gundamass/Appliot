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

## Review Hardening Follow-up

Commit pending: `fix: harden remote worker acceptance`

### Fixed Review Findings

1. All verifier failures now use fixed `VERIFY_*` codes. `VerificationError`
   carries only its code, request/response validation never uses Node assertion
   formatting, and the CLI always prints the fixed line
   `Remote worker verification failed: VERIFY_FAILED`. It cannot print URLs,
   tokens, HTTP bodies, OCR text, fixture content, or untrusted response values.
2. Worker URLs are validated before any fixture read or fetch. The only accepted
   embedding base URLs are `http://127.0.0.1:18080` and that exact origin with a
   trailing slash; OCR is identical on port `43121`. Aliases, IPv6, HTTPS,
   non-loopback hosts, other ports, credentials, queries, fragments, and extra
   pathnames fail with a fixed configuration code.
3. Relevance now requires the relevant score to be strictly greater than each
   unrelated score independently. A tie fails with `VERIFY_EMBEDDING_RANKING`.
   The checked-in synthetic embedding fixtures put the relevant item last so
   their ordering cannot conceal a tie.
4. Focused acceptance tests use all four checked-in OCR images. They assert
   exactly four OCR requests, byte-match each payload to one source image, and
   verify every individual mandatory-anchor omission fails with the fixed
   `VERIFY_OCR_ANCHORS` code.

### Review TDD Evidence

1. RED: the new suite initially failed because the verifier did not export a
   CLI boundary suitable for safe-output testing.
2. GREEN: fixed-code failures and `runRemoteWorkerVerifier()` were added. Five
   adversarial regressions passed; fixture-order validation then remained red.
3. GREEN: moving each synthetic relevant fact after the two unrelated facts made
   the final focused suite pass.

### Fresh Follow-up Verification

| Command | Result |
| --- | --- |
| `node --test scripts/verify-remote-workers.test.mjs` | PASS: 6 tests, 0 failures. Covers secret-safe CLI output, invalid URLs with zero fetch calls, ranking ties, all four image payloads, and all anchor omissions. |
| `node --check scripts/verify-remote-workers.mjs` | PASS. |
| `node scripts/verify-remote-workers.mjs` | Expected fail-safe result: exit 1 and only `Remote worker verification failed: VERIFY_FAILED`; no request was configured or made. |
| `corepack pnpm test` | PASS: all workspace suites passed. |
| `corepack pnpm typecheck` | PASS. |
| `corepack pnpm build` | PASS. |

No live Worker, paid API, GPU, tunnel, upload, token, or `.env.local` was used.
