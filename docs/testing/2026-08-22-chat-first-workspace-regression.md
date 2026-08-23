# Chat-First Workspace Regression Report

Date: 2026-08-23
Branch: `codex/langgraph-agent-implementation`

## Scope

- Chat home recommendation cards resolve real job-match session and result IDs.
- Application task creation remains behind explicit confirmation and uses the existing selection/convert and controlled application service paths.
- Confirmation tokens are single-use.
- Missing context, stale results, browser worker failures, challenge pauses and policy locks return bounded Chinese recovery text.
- LangSmith projection keeps conversation content, prompts, form values, secrets, URLs and raw recommendation IDs out of exported events.
- Enterprise recruitment status tracking, account binding, polling, webhooks, notifications and automatic final submission remain out of scope.

## Verification

| Check | Result |
| --- | --- |
| API conversation focused tests | 23/23 passed across 4 files |
| Web conversation/workspace focused tests | 27/27 passed across 5 files |
| API workspace test suite | 669/669 passed across 69 files |
| Web workspace test suite | 215/215 passed across 35 files |
| Task 7 API integration tests | 5/5 passed |
| Task 7 Web integration tests | 2/2 passed |
| Task 8 observability/privacy tests | 3/3 passed |
| API typecheck | passed |
| Web typecheck | passed |
| Workspace typecheck | passed |
| Web build | passed |
| Workspace build | passed |
| Browser job-matching regression | 8/8 passed |

The requested Playwright grep for `conversation` found no matching browser test titles in this repository. The existing browser job-matching suite was run instead and passed 8/8; it covers job matching, login/challenge boundaries, stale rematching and no-submit safety.

The full workspace test command did not reach the API/Web packages because `apps/browser-worker` failed 5 of 117 tests: four cleanup hook timeouts in `control-adapters`, `dom-runtime`, `executor` and `node-registry`, plus one refused synthetic page connection in `executor`. These failures are outside the changed files and should be investigated separately before treating the whole repository test command as green.

The production build emitted the existing Vite warning that the main web chunk is above 500 kB; the build still exited successfully.

## Safety Notes

Trace and LangSmith assertions inspect only bounded metadata such as node/tool names, hashed run identities, counts, duration and normalized error codes. Tests do not expose or persist resume text, DOM, form values, secrets, raw URLs or model prompts.
