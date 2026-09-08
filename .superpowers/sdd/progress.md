# Subagent-Driven Development Progress

---

Program: application stability and observability
Plan: docs/superpowers/plans/2026-07-28-application-stability-observability-plan.md

Task 1: complete (direct-workspace, no commit by user request; contract tests 22/22 and typecheck passed; review accepted)
Task 2: complete (direct-workspace, no commit by user request; focused Worker tests 15/15, Worker suite 20/20, typecheck and diff check passed; review accepted)
Task 3: complete (direct-workspace, no commit by user request; API Worker Client 6/6, Browser Worker IPC 1/1, contracts 14/14, Worker suite 21/21 and typechecks passed; review fixes accepted)
Task 4: complete (direct-workspace, no commit by user request; Task 4 focused tests 65/65, API typecheck and diff check passed; review fixes accepted)
Task 5: complete (direct-workspace, no commit by user request; Web focused tests 23/23, Web full tests 103/103, API full tests 219/219 and typechecks passed; review fixes accepted)
Task 6: complete (direct-workspace, no commit by user request; stability E2E 3/3, full browser suite 8/8, root tests, typecheck, build and diff check passed)
Task 4: complete (direct-workspace, no commit by user request; Task 4 focused tests 65/65, full API suite, typecheck and diff check passed)

Plan: docs/superpowers/plans/2026-07-22-resume-assistant-foundation.md
Branch start: aaa7e96

Task 1: complete (commits aaa7e96..8496ae2, review clean)
Task 2: complete (commits 8496ae2..51996fa, review approved)
Task 2 minor: containment check rejects in-root first components beginning with `..`; actual pnpm paths unaffected.
Task 2 minor: POSIX paths covered by focused injected tests, while clean-install evidence was Windows-only.
Task 3: complete (commits 51996fa..5885a2e, review approved)
Task 3 minor: encrypted/password-protected PDF propagation has no deterministic fixture coverage; no production defect observed.
Task 4: complete (commits 5885a2e..f297924, review approved)
Task 5: complete (commits f297924..b77c5c5, review approved)
Task 5 deferred: page-count, decompressed-text, canvas-pixel, OCR/model time budgets remain defense-in-depth beyond the exact 15 MiB upload limit.
Task 6: complete (commits b77c5c5..b78c8b3, review approved)
Task 6 note: interactive browser screenshot QA was unavailable; responsive/accessibility behavior is covered by focused tests and independent review.
Task 7: complete (commits b78c8b3..f48e57d, review approved)
Task 8: complete (commits f48e57d..726ecb3, review approved)
Final review fix: committed as `c74cf14`; runnable API artifact, durable original retention/retry, loopback proxy, exposed RAG workflow, server-owned self-evaluation tailoring/promotion, task-local evidence, bidirectional scope integrity, pre-extraction duplicate checks, and malformed-PDF mapping are recorded with focused RED/GREEN evidence in `final-review-fix-report.md`.
Final review launch follow-up: direct Node execution exposed an undeclared runtime `pdfjs-dist` resource resolution after `c74cf14`; the focused sanitized dual-working-directory launch regression, package/build correction, and final verification are recorded in `final-review-fix-report.md`, and the follow-up commit accompanies this entry.

---

Program: production model adapters
Branch: feature/production-adapters
Branch start: 7ecea00

Plan 1: docs/superpowers/plans/2026-07-23-deepseek-config-provider.md
Plan 2: docs/superpowers/plans/2026-07-23-remote-embedding.md
Plan 3: docs/superpowers/plans/2026-07-23-deepseek-ocr-worker.md
Plan 4: docs/superpowers/plans/2026-07-23-production-composition-deployment.md

Baseline: 337 tests passed; typecheck passed; build passed.
Task 1: complete (commits 7ecea00..6187e21, review clean)
Task 2: complete (commits 6187e21..2f1fd84, review clean)
Task 3: complete (commits 2f1fd84..65cda15, review clean)
Task 4: complete (independent verification: 297 focused tests, typecheck, build, and interface/secret scans passed)
Plan 2 Task 1: complete (commits 65cda15..fca04f3, review clean)
Plan 2 Task 2: complete (commits fca04f3..e476009, review clean)
Plan 2 Task 3: local code complete (commits e476009..55980d6; external model manifest and actual Linux lock verification pending)
Plan 2 Task 4: complete (commits 55980d6..71fe74d, review clean)
Plan 2 Task 5: complete (commits 71fe74d..ca12607, review approved)
Plan 2 Task 5 minor: legacy fact_embeddings migration cascade branch lacks a direct delete regression; implementation correct by inspection.
Plan 2 Task 6: CPU-only verification complete (12 checks passed, 0 failed; real model manifest and Linux lock verification pending)
Plan 3 Task 1: complete (commits ca12607..3d84807, review approved)
Plan 3 Task 1 minor: malformed OCR Worker JSON is handled but lacks a direct client regression test.
Plan 3 Task 2: complete (commits 3d84807..193b309, review approved)
Plan 3 Task 3: complete (commits 193b309..c22c0c7, review approved)
Plan 3 Task 4: local code complete (commits c22c0c7..9f0de4a, review approved; real model manifest, Linux hash lock, and native Linux symlink acceptance pending)
Plan 3 Task 5: complete (commits 9f0de4a..1c263ff, review approved)
Plan 3 completion gate: local code complete (OCR client, native-text fallback, Worker contract, offline backend, and degraded import verified; remote artifact/GPU acceptance pending)
Plan 4 Task 1: complete (commits 1c263ff..4a88981, review approved)
Plan 4 Task 1 minor: built artifact launch test currently proves bundling only; Task 3 must execute the entrypoint and verify degraded startup plus pre-listen malformed-config failure.
Plan 4 Task 2: complete (commits 4a88981..8592820, review approved)
Plan 4 Task 2 external QA: in-app browser unavailable; desktop/mobile screenshot overlap and wrapping inspection remains pending.
Plan 4 Task 3: complete (commits 8592820..f8519e3, review approved; built artifact launch minor resolved)
Plan 4 Task 4: local deployment code complete (commits f8519e3..4730d71, independent review approved; Bats/ShellCheck, native Linux ownership/socket/symlink behavior, verified manifests/locks/wheelhouses, and real Ubuntu/Conda/GPU 5/systemd/Supervisor acceptance remain external)
Plan 4 Task 5: local acceptance artifacts complete (commits 4730d71..0ce41ea, independent review approved; dedicated Worker Conda tests, Bats/ShellCheck, authorized SSH tunnel, live pinned models, GPU 5 isolation, degraded transitions, and real remote acceptance remain external)
Whole-branch review: clean after commit 0a8ad50; no Critical, Important, or Minor findings. Fresh local gates passed: pnpm test, typecheck, build, and 80 deployment tests with 7 Windows platform skips.

---

Program: resume assistant integration
Plan: docs/superpowers/plans/2026-07-22-resume-assistant-integration.md

Task 1: local code complete, not committed by user request. Typed application APIs, replayable SSE with history-gap reset, scoped questions/reviews, production EventBus composition, recovery checkpoints, and bundled browser worker are implemented. Fresh gates: full test, typecheck, build, git diff check, and 2 browser safety E2E tests passed.
Task 2: local code complete, not committed by user request; independent review clean. Added profile-to-application navigation, typed Web application client, create-task route, live task workspace, native SSE recovery state, state timeline, server-authoritative controls, generation/version/event isolation, and responsive layouts. TDD covered create, URL validation, manual login, event progression, stale-command removal, disconnect state, API parsing, SSE history reset, old GET/command/event races, task switching, cancel, and routing. Desktop/mobile Playwright screenshots passed horizontal-overflow and visual inspection. Fresh full test (Web 87), typecheck, build, 2 browser safety E2E tests, and git diff check passed.
Task 3: local code complete, not committed by user request; independent re-review clean. Added page-level aggregated questions, application-scoped answers with explicit profile promotion, side-by-side content review, evidence inspection, unsupported-claim blocking, exact answer-set validation, fail-closed final edited-text fact validation, and stable unsent inputs across equivalent server projections with reset on semantic changes. Question projections now expose page text, system interpretation, missing information, and application scope; old checkpoints receive safe defaults. Fresh full test (API 199, Web 97), typecheck, build, 4 headed browser tests, desktop/mobile screenshot inspection, and git diff check passed.
Task 3 deferred coordinator dependencies: automatic job-description acquisition and job-tailored draft generation; complete audit history for application-answer revisions and corrections.

---

Program: application stability observability
Plan: docs/superpowers/plans/2026-07-28-application-stability-observability-plan.md

Task 1: complete (direct-workspace, no commit by user request; focused contract tests 22/22 and typecheck passed; task review accepted)
Task 5: complete (direct-workspace, no commit by user request; focused Web tests 23/23, API projection 1/1, Web/API/contracts typechecks and diff check passed; final elapsed-baseline review accepted)
Task 6 final safety follow-up: complete (direct-workspace, no commit by user request). Added execution epochs with immediate IPC invalidation on cancel/user activity, pre-mutation freshness checks, privacy-safe ordinary action click monitoring, visible PAGE_ERROR pauses, and native form-submit/network guards. Fresh verification: root pnpm test, root typecheck, root build, git diff --check, and browser E2E 9/9 passed.

Program: independent project context documentation
Plan: E:\projects\docs\superpowers\plans\2026-08-17-independent-project-context-docs.md
Task 2: complete (external docs under E:\projects\docs\简历投递助手; review approved; source repository unchanged)
Task 1: complete (external index and documentation rules under E:\projects\docs; review approved)
Task 3: complete (external docs under E:\projects\docs\full-redbook-backend; review fix accepted; nested source root and no Git metadata documented)
Task 4: complete (external docs under E:\projects\docs\bigdata-backend-sx; multiple citation corrections re-reviewed and approved; source repository unchanged)
Task 5: complete (external docs under E:\projects\docs\hm-dianping; flash-sale initialization/durable-handoff and citation corrections re-reviewed and approved; source repository unchanged)
Task 6: complete (four external context packages globally verified and re-reviewed; 20 context documents, 27 local links, 472 source paths; no context-package prohibited/credential values)

---

Program: integrated profile workspace
Plan: docs/superpowers/plans/2026-08-03-integrated-profile-workspace.md

Tasks 1-7: complete (direct workspace, no commit by user request). The root route now combines candidate profile review, the full long-form profile center, application creation, and the human-review inbox. Education, work, projects, awards, publications, certificates, and campus entries remain independently editable; awards include name, date, level, and description. `resume_with_profile` performs a fresh browser observation before incrementally rematching only empty fields, preserves existing page values, and never exposes or triggers terminal submission.
Final regression follow-up: complete. Added a real browser profile-completion retry flow with a prefilled name, empty city select, profile HTTP upsert, fresh rematch, readback verification, and zero submissions. Fixed a browser-blank regression by exposing the field registry as a browser-safe package subpath while preserving the browser Worker's SHA-256 opaque IDs and checkpoint compatibility.
Fresh verification: `pnpm typecheck` passed; `pnpm test` passed across all workspaces (including API 278/278, Web 129/129, Browser Worker 56/56); `pnpm test:e2e` passed 15/15. Desktop profile/apply/reviews and 390px mobile apply views were inspected in the in-app browser; the mobile document width matched the viewport and navigation remained intentionally horizontally scrollable. Node 24.14.0 still emits the repository's existing `>=24.14.1` engine warning.

---

Program: profile revision synchronization and post-review stabilization
Plan: docs/superpowers/plans/2026-08-13-post-review-stabilization-plan.md
Report: .superpowers/sdd/post-review-stabilization-report.md

Tasks 1-6: local code complete. Candidate profile changes now advance a durable revision and mark eligible unfinished application tasks for rematching. Automatic refresh is restricted to tasks waiting for profile answers plus active in-memory observing tasks; terminal failures are never revived implicitly and require the explicit `sync_profile` command. Synchronization state, applied revision, and stable failure reason are persisted and exposed through the API. The task page displays concise Chinese synchronization status and still exposes no submit command.

Safety boundaries: existing page values and user edits remain authoritative; review-locked, cancelled, login-waiting, and failed tasks are excluded from automatic refresh; explicit failed-task recovery re-observes the live page and stops at `review_locked`. Local-at-rest encryption and sensitive-data routing to DeepSeek/vector services remain intentionally deferred by user decision.

Fresh verification: `pnpm test` passed across all workspaces (API 374, Web 164, Browser Worker 67, plus package suites); `pnpm typecheck`, `pnpm build`, `pnpm audit --prod --audit-level high`, and `git diff --check` passed. `pnpm test:e2e` passed 18/18, including DJI-style coverage, Mokahr repeated sections/PDF upload, profile-completion retry, browser stability, and terminal-submit refusal. Real local task UI inspection at 1280x800 and 390x844 found no horizontal overflow, out-of-bounds elements, or submit controls.

---

Program: LangGraph agent architecture upgrade
Plan: docs/superpowers/plans/2026-08-21-langgraph-agent-architecture-upgrade.md
Branch start: f715ecb

Task 1: complete (commit 3c9d9b8; contracts tests 76/76 and contracts typecheck passed)
Task 2: complete (commit 57bec39; TraceSink/tool registry focused tests 6/6, migration tests 11/11, API typecheck passed)
Task 2A: complete (commit 6ddbadc; LangSmith/config/outbox focused tests 36/36, API typecheck passed)
Task 3: complete (commit 9938f37; SQLite LangGraph Checkpointer, migration compatibility, and restart persistence; focused tests 20/20, API typecheck, and diff check passed)

---

Program: Agent Runtime, Supervisor and Intent Understanding
Plan: docs/superpowers/plans/2026-09-02-agent-runtime-supervisor-intent-plan.md

Tasks 1-8: local code complete, not committed by user request. Added the
CanonicalIntent/Plan/Capability/Runtime contracts, structured intent
resolution and clarification, LangGraph-backed Runtime with budgets and
cancel/recovery, Supervisor/Planner/Policy boundaries, specialist agents,
SQLite event/evidence/request-context persistence, lifecycle routes, replay
datasets, and browser safety regressions.
Task 9: production composition root now uses AgentRuntime and the Runtime
application service exclusively; the old graph service is not a production
task entry point. Legacy graph/subgraph modules remain as bounded compatibility
adapters for unmigrated tests and domain facades, so literal deletion of those
files is still a follow-up migration rather than being claimed complete.

Latest local verification: API 112 files / 930 tests passed; root workspace
tests 112 files / 931 tests passed; typecheck passed; `pnpm eval:agent` passed
with no failures and mis-submission count 0; Playwright 47/47 passed; and
`git diff --check` passed. The evaluation report records recall@3 1.0 and
OCR character accuracy 0.9667 on the current small synthetic corpus.

---

Program: explainable job recommendation and declarative Skill evolution
Plan: docs/superpowers/plans/2026-09-06-job-recommendation-and-skill-evolution-plan.md
Branch: fix/mokahr-campus-apply
Branch start: 1ec0ca9
Execution mode: direct workspace retained because the approved runtime and recommendation prerequisites are uncommitted on this branch; implementation subagents use isolated workspaces.
Baseline: root workspace tests passed (contracts 107, job matching 78, API 944, Web 259, Browser Worker 134, plus remaining package suites); existing PDF/font and intentional route-error test output noted.
Task 1: complete (commits 1ec0ca9..4f2b2e2, review clean; contracts 108/108 and typecheck passed with recorded RED/GREEN evidence)
Task 2: complete (commits 4f2b2e2..9ae60e4, review clean; focused scoring 15/15, job-matching package 87/87, and typecheck passed)
Task 3: complete (commits 9ae60e4..68cbe06, review clean; focused API 22/22, full API 954/954, and typecheck passed)
Task 4: complete (commits 68cbe06..5a4077d, review clean after evidence allowlist fix; focused Web 6/6, full Web 260/260, build and typecheck passed)
Task 5: complete (commits 5a4077d..ad5a696, final review approved; browser acceptance 3/3 and focused API 67/67 passed; the real HTTP selection route shares production-equivalent JobMatchService -> ApplicationService handoff wiring, leaves the application repository empty, and leaves Synthetic ATS submission count at zero with a separate positive counter control)
Task 6: complete (commits a884c8b..e4edbca, final review approved; focused Skill suite 73/73, contracts 181/181, contracts/root typecheck passed; mandatory audit, closed patch surface, credential/encoded-literal rejection, descriptive compatibility and 256-sample Base64URL corpus verified)
Task 7: complete (commits 71fb2b0..5818bf9, final review approved; migration/registry regression 35/35 and API typecheck passed; immutable content, atomic lifecycle/CAS, scoped allocations, quarantine withdrawal and append-only records verified)
Task 8: complete (commits 943caa8..01577b9, final review approved; Task 8 focused 14/14, cumulative API Skill/migration 49/49, contracts 181/181 and API typecheck passed; semantic graph/origin/readback validation and three idempotent safe Champions verified)
Task 9: complete (commits 0516a9e..81349bb, final review approved; interpreter 13/13, cumulative Skill API suite 62/62 and API typecheck passed; strict signatures, bounded glob/conditions/recovery, stable fingerprints, request ordering and forged-match rejection verified)
Task 10: complete (commits c2eb578..2a7b721 plus reviewed direct-workspace Runtime integration in pre-existing untracked/dirty Agent Runtime files; final review approved; contracts 76/76, focused API 133/133, production composition 49/49 and dual typecheck passed; Champion-only atomic pre-write pinning, 1.0->1.1 compatibility, stable structural fingerprints, supported-site unmatched/cross-origin zero-write stops, and unchanged authorization/readback/audit/final-review controls verified)
Task 11: complete (commits 0473365, d7d04a1, fdc621e plus reviewed direct-workspace integration in pre-existing untracked/dirty Runtime files; final review approved; contracts focused 86/86, API focused 131/131, full API 1044/1044, dual typecheck, build and diff check passed; one append-only first-write-wins record per bound attempt, persisted Champion/Challenger dimensions, pre-selector terminal-page coverage, credential/PII rejection, and durable LangSmith failure isolation verified)
Task 12: complete (commit 419007d plus reviewed direct-workspace audit classification in the pre-existing untracked ApplicationAgent file; site runtime safety E2E and TDD integration fixes; interpreter/tooling focused 39/39, contracts 193/193, API 1049/1049, synthetic ATS 7/7, browser-worker 134/134, new Playwright 11/11, three package typechecks and root build passed; Moka/DJI/Baidu binding and reload recovery, repeated-field templates, renamed/delayed pages, duplicate semantics, stale nodes, ambiguous fingerprints, unmatched routes, unexpected navigation evidence, final-submit lock and zero submissions verified)
Task 13: complete (commit 60a1ac0; redacted replay corpus with conservative capture quarantine, deterministic per-site/fingerprint/scenario temporal 80/20 manifests, separately wired training and evaluator capabilities, immutable restart-stable manifests, insert-only conflict detection, and replay-safe execution projections with transient NodeRefs removed; focused 39/39, full API 1055/1055, API typecheck and diff check passed; two independent review jobs were attempted but the review channel remained running without returning findings and was shut down, so final boundary review was completed locally)
Task 14: complete (commit 38cbe05; fixed evaluator version 1.0.0 with code-owned lexicographic safety/incorrect-write/accuracy/completion/correction/retry-recovery/duration ordering, replay-safe raw facts, fail-closed partial-audit and timeout decisions, deterministic duplicate-aware aggregation, and seeded antisymmetry/transitivity invariants; focused evaluator 7/7, adjacent Skill regression 46/46, API typecheck and diff check passed)
Task 15: complete (commit 9920990; bounded evolution-opportunity collector with exact site/fingerprint/Skill/version scope, latest-20 evaluated window, stable page/field/error themes and opportunity IDs, actionable-failure and fingerprint-drift triggers, improving Challenger recovery chains, shortest same-page/same-field fail-to-success pairs, open-run suppression, duplicate conflict rejection, and browser-ownership exclusion; collector 8/8 plus evaluator 7/7, API typecheck and diff check passed)
Task 16: complete (commit f674f00 plus direct-workspace production composition wiring/test retained in the pre-existing dirty production-dependencies files; one-shot structured Skill patch generation against an exact active parent hash, strict higher version, prompt evidence allowlisting, training-only partition enforcement, fixed validator vocabulary, local patch application/hash/schema/semantic validation, stable provider/schema/parent/unchanged/validation rejections, bounded timeout and zero registry mutation; evolution agent 11/11, validator 11/11, production composition 51/51, API typecheck and diff check passed)
Task 17: complete (commit 90e610e; idempotent opportunity lease, exact schema/semantics/safety/hidden-holdout/Synthetic ATS gate order, same-site same-sample Champion/candidate replay, fixed evaluator 1.0.0 lexicographic qualification, immutable hashed gate report, atomic candidate-to-replay-qualified CAS, and unchanged 100/0 traffic allocation; added reordered controls, delayed options, hidden honeypot and post-fill mutation alongside duplicate labels, unexpected navigation and stale NodeRef; focused Skill evolution 39/39, Synthetic ATS 7/7, offline Playwright 1/1, API typecheck, root build and diff check passed; E2E report ID evolution-report-evolution-opportunity-offline-e2e and all seven submission counts were zero; external review agent remained running without findings and was shut down, while local boundary review fixed target-stratum selection, cross-site holdout mixing, and runner-exception audit closure)
Task 18: complete (commit c6453b7; deterministic SHA-256 uint32 bucket using the stable allocation ID as allocation salt; exact 0..99/1000 Challenger assignment; persisted task bindings remain pinned; pre-activation task timestamps remain Champion; unsafe or missing Challengers fall back to the valid Champion; fresh Runtime selections compile the actually selected version; replay-qualified activation is available only through one SQLite transaction that CASes lifecycle and writes 90/10 allocation, while the generic status path cannot bypass it; focused selector/registry 31/31, API typecheck and diff check passed; review agent remained running without findings and was shut down, local review closed the direct-transition bypass)
Task 19: complete (commit e3a25bd; execution-ID normalized evaluation inputs stratified by site/fingerprint/scenario/required-field-count band; allocation/evaluator-derived xorshift seed; 10,000 within-stratum bootstrap iterations with fixed observed weights; hard Challenger safety, incorrect-write and new-audit-mismatch rollback; lexicographic first-difference confidence interval with higher-priority non-inferiority; exact insufficient/continue/stop-inconclusive thresholds; statistics 8/8 passed twice with byte-stable reordered input, API typecheck and diff check passed; review agent remained running without findings and was shut down)
Task 20: complete (commit a71d609 plus direct-workspace production composition wiring/test retained in the pre-existing dirty production-dependencies files; durable first-write execution evidence drives deterministic online evaluation and idempotent lifecycle decisions; safety violation, incorrect write, or new audit mismatch immediately quarantines the Challenger and atomically restores 100% Champion traffic; positive statistical evidence promotes atomically, while fifty inconclusive eligible runs retire without unsafe classification; experiment statistics are isolated by activation time and evaluator version; duplicate and late delivery plus two-worker races are idempotent; focused promotion/recorder/registry/production regression 98/98, API typecheck and scoped diff check passed; the persistent lifecycle trigger was migrated to allow transactional Challenger retirement; review agent remained running without findings through two bounded waits and was shut down, while local review added experiment-window isolation and verified quarantined pinned tasks enter observe-only safe handoff before another compiled write)
Task 21: complete (commit 88cdd0d plus direct-workspace automatic-evolution production composition wiring/test retained in the pre-existing dirty production-dependencies files; audited Champion failure clusters now enter constrained qualification automatically only when no Challenger is active, qualified next-patch candidates receive deterministic 10% traffic, positive evidence promotes, and a post-fill mutation produces an audit mismatch that hard-rolls back to the prior Champion; existing tasks remain pinned, quarantined bindings fail closed to observe-only handoff, execution evidence is append-only, and both Synthetic ATS submission counters remain zero; API 127 files/1115 tests, Synthetic ATS 7/7, Playwright runtime/offline/automatic evolution 13/13, root typecheck and production build passed with only the existing Web chunk-size warning; the independent review agent remained running without findings through two bounded waits and was shut down, and local review bound the evolved locator hint directly to the activated candidate)
Task 22: complete (commit ed4fa8d; final verification report reconciles recommendation, Runtime, offline qualification and automatic evolution evidence; contracts 17 files/193 tests, job-matching 7/87, API 127/1115, Web 45/261, Synthetic ATS 1/7 and four-spec Playwright 16/16 passed; root typecheck and production build passed with only the existing 518.41 kB Web chunk warning; full diff hygiene passed and the explicit PII/approval/raw-DOM/querySelector/submit-command scan returned no matches; real 5173 inspection identified an old in-memory browser bundle rather than current rendering, then a refreshed build handled a live Tavily 10-second outage by stopping with a retryable error and without creating a match or application task; deterministic browser fixtures remain the authoritative Baidu/Moka/DJI acceptance evidence with zero submissions; final review agent remained running without findings through two bounded waits and was shut down, while local safety review closed every checklist item)
