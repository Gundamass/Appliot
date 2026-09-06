# Explainable job recommendation Phase A regression

Date: 2026-09-06

## Scope

This regression closes Phase A for explainable job recommendations without changing production source. It verifies payload-based API persistence, legacy compatibility, conversation projection, the six-card browser experience, selection retention, and the absence of application creation or final-submission side effects.

## Coverage

- Repository persistence writes and reloads two results through SQLite: one current result with `scoreBreakdown` and one legacy result with the optional property absent. The reloaded objects retain their exact respective shapes.
- Conversation integration reads both shapes through `createJobMatchRepository`, passes them through the conversation-facing service and response schemas, and projects both recommendation cards.
- Browser regression supplies seven deliberately unsorted current results, including a 91% tie. The UI renders exactly six `article[aria-label^="岗位："]` cards in non-increasing visible percentage order.
- Expanding the first card shows `匹配优势`, `待确认条件`, `差距与风险`, and `匹配度如何得出`, plus the safe Chinese explanation `你的技能“TypeScript”符合岗位技能要求。`.
- The rendered page is checked for absence of fixture result/posting/requirement/session identifiers, hashes, and profile paths.
- Selecting the first non-conflict card sends exactly one `select_result` conversation action. The mock returns a valid `ConversationJobMatchActionResult` payload, the session refreshes to `selected`, and the selected-state copy becomes visible.

## Zero-side-effect mechanism

This E2E is a deterministic mocked conversation flow, not a Synthetic ATS run. `mockInlineConversation` intercepts the conversation view, process event stream, job-match session, and job-match action endpoints. A page-level request observer inspects every non-GET `/api/` request. The conversation job-match selection POST is explicitly allowed; application-task creation endpoints and final-submit endpoints/commands are classified as forbidden. The test asserts the forbidden request list remains exactly empty.

No application task was created and no final submission request was made.

## Test-first evidence

The new API retention/integration assertions passed on their first focused run because Tasks 1–4 already implemented the optional payload behavior. No artificial RED was manufactured and no compatibility fix was needed.

The first browser run intentionally used the existing one-result fixture after only the assertions were added. It failed at the expected boundary:

- expected six job cards;
- received one job card;
- legacy redirect scenario still passed;
- overall result: 1 failed, 1 passed.

After extending only the E2E mock and fixture, the target spec passed 2/2.

## Verification

| Command | Result |
| --- | --- |
| `rtk corepack pnpm --filter @resume/api exec vitest run src/job-matching/job-match-repository.test.ts src/conversations/conversation-job-match-service.test.ts` | 2 files, 19 tests passed |
| `rtk corepack pnpm --filter @resume/contracts test -- --run` | 16 files, 108 tests passed |
| `rtk corepack pnpm --filter @resume/job-matching test -- --run` | 7 files, 87 tests passed |
| `rtk corepack pnpm --filter @resume/api test -- --run` | final isolated run: 113 files, 956 tests passed |
| `rtk corepack pnpm --filter @resume/web test -- --run` | 45 files, 261 tests passed |
| `rtk corepack pnpm test:e2e -- tests/browser/conversation-job-match-flow.spec.ts` | 2 tests passed |
| `rtk corepack pnpm build` | exit 0; 11 of 12 workspace projects in scope |

The first full API run was executed concurrently with the other package gates and had one timing-sensitive failure in the unrelated scheduled-embedding concurrency test: 955 passed and 1 failed with `runtime_checkpoint_interrupt_unexpected`. That exact test then passed in isolation (1 passed, 47 skipped), and the complete API suite passed when rerun alone (956/956). No code was changed for that transient failure.

Existing warnings retained in successful runs:

- API malformed-PDF tests emit expected invalid-header/indexing warnings.
- API route failure-path tests log their intentional mocked `start failed` and `initial observation failed` errors.
- Playwright reports that `NO_COLOR` is ignored because `FORCE_COLOR` is set.
- Vite reports a 503.64 kB minified JavaScript chunk (146.46 kB gzip) exceeding its 500 kB warning threshold.

## Screenshot evidence

The deterministic target E2E writes and validates both existing screenshot paths:

- `playwright-artifacts/conversation-job-match-flow-desktop.png` — 149,181 bytes
- `playwright-artifacts/conversation-job-match-flow-mobile.png` — 144,693 bytes

These generated artifacts are verification evidence and are not part of the Task 5 commit.

## Preserved user-owned additions

The commit also preserves three approved additions that were already present before Task 5 work began:

- immutable expectation reuse/conflict tests in `job-match-repository.test.ts`;
- completed recommendation copy assertion in `conversation-job-match-service.test.ts`;
- conversation-list route setup in `conversation-job-match-flow.spec.ts`.

They are included in the scoped commit but are distinguished from the Task 5 changes above.
