# Explainable job recommendation Phase A regression

Date: 2026-09-06

## Scope

This regression closes Phase A for explainable job recommendations without changing production source. It verifies payload-based API persistence, legacy compatibility, conversation projection, the six-card browser experience, selection retention, and the absence of application creation or final-submission side effects.

## Coverage

- Repository persistence writes and reloads two results through SQLite: one current result with `scoreBreakdown` and one legacy result with the optional property absent. The reloaded objects retain their exact respective shapes.
- Conversation integration reads both shapes through `createJobMatchRepository`, passes them through the conversation-facing service and response schemas, and projects both recommendation cards.
- Browser regression supplies seven deliberately unsorted current results, including a 91% tie. The UI renders exactly six `article[aria-label^="岗位："]` cards in non-increasing visible percentage order.
- Expanding the first card shows `匹配优势`, `待确认条件`, `差距与风险`, and `匹配度如何得出`, plus the safe Chinese explanation `你的技能“TypeScript”符合岗位技能要求。`.
- The rendered page is checked before and after selection against every fixture result, posting, source-job, requirement, evidence, session, hash, canonical URL/path, and reason-code value, plus patterns for UUIDs, opaque IDs, URLs, API/job paths, hashes, profile paths, and local filesystem paths.
- Selecting the first non-conflict card sends exactly one `select_result` conversation action. The mock returns a valid `ConversationJobMatchActionResult` payload, the session refreshes to `selected`, and the selected-state copy becomes visible.

## Zero-side-effect mechanism

The visual browser flow remains deterministic: `mockInlineConversation` intercepts the conversation view, process event stream, job-match session, and job-match action endpoints. Its page-level request observer treats the selection POST as allowed and asserts that no application-task creation or final-submit request is emitted.

A separate acceptance case starts Synthetic ATS, a real `BrowserWorkerClient`, and a migrated in-memory SQLite database. One Fastify instance registers the production application routes and conversation job-match routes over shared real repositories, a real `ApplicationService`, `ConversationJobMatchService`, and `JobMatchService`. The job-match service retains production's `prepareApplicationTask -> applicationService.start` handoff, so an accidental selection-to-conversion regression can reach the instrumented application graph and fail the safety assertions. A separate application control goes through `POST /api/applications`, is opened and filled by the browser worker, reaches `review_locked`, exposes terminal-submit actions, and remains unsubmitted. A second synthetic-only control posts to `/submit` and proves the ATS counter increments to `1`.

The recommendation selection then goes through the real HTTP `POST /api/conversations/:conversationId/job-match-actions` route. After the `200` response and persisted `selected` state are established, the shared application-task repository remains empty and the selected posting's ATS task remains at `submissionCount === 0`. Production final-submit approvals are unchanged.

## Test-first evidence

The new API retention/integration assertions passed on their first focused run because Tasks 1–4 already implemented the optional payload behavior. No artificial RED was manufactured and no compatibility fix was needed.

The first browser run intentionally used the existing one-result fixture after only the assertions were added. It failed at the expected boundary:

- expected six job cards;
- received one job card;
- legacy redirect scenario still passed;
- overall result: 1 failed, 1 passed.

After extending the E2E fixture and adding the production-equivalent HTTP acceptance, the target spec passed 3/3.

The reviewer follow-up first added an HTTP-status expectation to the old direct service harness. The target failed 1/3 at that exact boundary because a direct `ConversationJobMatchService` result has no `statusCode`. Replacing the direct call with the real Fastify route and wiring the real application graph made the target pass 3/3. The first `createApp` attempt exposed a root Playwright source-resolution error for `@resume/profile-domain/src/pdf/extract-pdf.js`; the established browser-test pattern of registering both production route modules directly on one Fastify instance avoided that test-runner boundary without production changes. Root typecheck then found one test-only untyped Fastify response generic (`TS2347`); an explicit response cast fixed it, and typecheck passed on rerun.

## Verification

| Command | Result |
| --- | --- |
| `rtk corepack pnpm --filter @resume/api exec vitest run src/job-matching/job-match-repository.test.ts src/job-matching/job-match-service.test.ts src/conversations/conversation-job-match-service.test.ts src/conversations/conversation-job-match-routes.test.ts src/applications/routes.test.ts` | 5 files, 67 tests passed |
| `rtk corepack pnpm --filter @resume/contracts test -- --run` | 16 files, 108 tests passed |
| `rtk corepack pnpm --filter @resume/job-matching test -- --run` | 7 files, 87 tests passed |
| `rtk corepack pnpm --filter @resume/api test -- --run` | final isolated run: 113 files, 956 tests passed |
| `rtk corepack pnpm --filter @resume/web test -- --run` | 45 files, 261 tests passed |
| `rtk corepack pnpm test:e2e -- tests/browser/conversation-job-match-flow.spec.ts` | 3 tests passed |
| `rtk corepack pnpm typecheck` | exit 0 |
| `rtk corepack pnpm build` | exit 0; 11 of 12 workspace projects in scope |

The first full API run was executed concurrently with the other package gates and had one timing-sensitive failure in the unrelated scheduled-embedding concurrency test: 955 passed and 1 failed with `runtime_checkpoint_interrupt_unexpected`. That exact test then passed in isolation (1 passed, 47 skipped), and the complete API suite passed when rerun alone (956/956). No code was changed for that transient failure.

Existing warnings retained in successful runs:

- API malformed-PDF tests emit expected invalid-header/indexing warnings.
- API route failure-path tests log their intentional mocked `start failed` and `initial observation failed` errors.
- Playwright reports that `NO_COLOR` is ignored because `FORCE_COLOR` is set.
- Vite reports a 513.55 kB minified JavaScript chunk (149.22 kB gzip) exceeding its 500 kB warning threshold.

## Screenshot evidence

The deterministic target E2E writes and validates nonempty images at both existing screenshot paths:

- `playwright-artifacts/conversation-job-match-flow-desktop.png`
- `playwright-artifacts/conversation-job-match-flow-mobile.png`

These generated artifacts are verification evidence and are not part of the Task 5 commit.

## Preserved user-owned additions

The commit also preserves three approved additions that were already present before Task 5 work began:

- immutable expectation reuse/conflict tests in `job-match-repository.test.ts`;
- completed recommendation copy assertion in `conversation-job-match-service.test.ts`;
- conversation-list route setup in `conversation-job-match-flow.spec.ts`.

They are included in the scoped commit but are distinguished from the Task 5 changes above.
