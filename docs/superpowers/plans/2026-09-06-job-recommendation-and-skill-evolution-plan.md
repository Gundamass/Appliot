# Job Recommendation and Declarative Skill Evolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver explainable top-six job recommendations, then add a site-specific declarative application Skill runtime that can learn from audited executions, test candidate versions, and automatically select, promote, quarantine, or roll back the best verified Skill without weakening final-submit safety.

**Architecture:** Phase A extends the existing job-matching scorer and conversation cards with structured explanations and one authoritative `fitScore` ordering. Phases B–D add a separate `application-skills` bounded context: immutable Skill contracts and registry, a constrained interpreter wired into the existing Application Agent, append-only execution evidence, offline evolution and replay, then deterministic Champion–Challenger allocation with fixed evaluation and rollback policies. The Skill layer may parameterize pre-submit behavior, but the existing action policy, NodeRef/snapshot/epoch checks, readback, full-page audit, browser ownership lease, and final-review boundary remain authoritative.

**Tech Stack:** TypeScript, Zod, Fastify, LangGraph runtime, SQLite/better-sqlite3, Vitest, Playwright, React, existing `StructuredModelProvider`, TraceSink, LangSmith outbox, synthetic ATS.

**Design Sources:** `docs/superpowers/specs/2026-09-06-job-recommendation-card-explanation-design.md` is the merged product/architecture specification; `docs/superpowers/plans/2026-09-02-agent-runtime-supervisor-intent-plan.md` defines the existing runtime safety substrate that this work extends without bypassing.

## Global Constraints

- Job cards show at most six results ordered by displayed `fitScore` descending, then `confidence` descending, then `canonicalUrl` ascending.
- A satisfied requirement earns full normalized weight; `unknown` and `conflict` each earn zero.
- Dimension base weights are skill 35, responsibility 25, project 20, qualification 10, and preference 10; absent dimensions are removed from the denominator and active dimensions are renormalized to 100.
- Collapsed cards permanently show only title, percentage, `查看详情`, `选择此岗位`, and `岗位页面`; transient stale/selected/conflict/error messages remain allowed.
- Expanded details use natural Chinese and never expose requirement IDs, evidence IDs, reason codes, JSON paths, or `Profile fact ...` strings.
- Declarative Skills are site-specific and immutable; the initial sites are `moka`, `dji`, and `baidu`.
- Skill content cannot contain executable scripts, XPath, arbitrary navigation/network requests, profile values, approval tokens, terminal-submit capability, audit switches, or evaluation weights.
- Skill selection is scoped by site and page fingerprint; one task is pinned to one version until release.
- Evaluation uses the fixed lexicographic order: safety violations, incorrect writes/audit mismatches, field accuracy, required-field completion, user corrections, retries/recovery, duration.
- Candidate generation cannot modify its validator, evaluator, replay holdout, traffic policy, audit evidence, stable backups, or final-submit gate.
- A candidate never receives live traffic before Schema, semantic, safety, holdout replay, and synthetic ATS checks pass.
- Any safety violation, incorrect field write, or new full-page mismatch quarantines the Challenger and restores the prior Champion.
- Automatic Skill promotion never authorizes a real application submission; final submit remains a separate explicit user action.
- All new behavior uses TDD, boundary and retention sets, deterministic fixtures, explicit budgets, bounded retries, and append-only audit evidence.
- Local append-only execution facts are authoritative for replay and release decisions; LangSmith receives the same safe aggregate projection for cross-run analysis, and a LangSmith outage cannot block or change Champion execution.

## Phase Gates

| Phase | Independently testable outcome | Entry gate | Exit gate |
| --- | --- | --- | --- |
| A | Six concise, explainable recommendation cards | Existing job matching tests green | Contracts, scorer, API, Web and conversation E2E green |
| B | Manually seeded Champion Skill safely controls pre-submit planning | Phase A green | Skill contracts, registry, interpreter, runtime binding and safety E2E green |
| C | Candidate Skills are generated and evaluated offline only | Phase B green | Replay holdout reproduces Champion/candidate differences; no live allocation |
| D | Verified Challengers receive stable limited traffic and auto-promote/rollback | Phase C green | Statistical promotion, hard-failure rollback and full regression green |

## File Structure

### Existing files modified

- `packages/contracts/src/job-matching.ts` — optional persisted score breakdown compatible with old results.
- `packages/contracts/src/agent-graph.ts` — safe optional Skill trace dimensions.
- `packages/contracts/src/agent-runtime.ts` — pinned Skill binding in checkpoint-safe application state.
- `packages/contracts/src/index.ts` — exports new Skill contracts.
- `packages/job-matching/src/scoring-v1.ts` — authoritative fit scoring, breakdown, and ordering.
- `apps/api/src/agent/subgraphs/job-matching.ts` — user-facing evidence summaries and authoritative ordering.
- `apps/api/src/job-matching/job-match-repository.ts` — old/new result compatibility.
- `apps/web/src/conversation/ConversationJobCards.tsx` — concise card and human-readable inline details.
- `apps/api/src/db/migrate.ts` — Skill registry, evidence, replay, evaluation, evolution, and traffic tables.
- `apps/api/src/agent/application-tools.ts` — accepts validated Skill directives while preserving authorization.
- `apps/api/src/agent/subgraphs/application-execution.ts` — binds one Skill and records evaluated execution facts.
- `apps/api/src/agent/runtime/application-state-store.ts` — persists only safe Skill binding metadata.
- `apps/api/src/agent/trace-sink.ts` and `apps/api/src/agent/langsmith-outbox.ts` — append safe Skill dimensions.
- `apps/api/src/production-dependencies.ts` — wires registries, selector, interpreter, evaluator, and evolution services.
- `apps/synthetic-ats/src/server.ts` — deterministic page variants for Skill replay and live allocation tests.

### New focused files

- `packages/contracts/src/application-skill.ts` — all strict Skill, directive, execution, evaluation, patch, and state Schemas.
- `apps/api/src/job-matching/profile-fact-presentation.ts` — safe Chinese labels and evidence summaries.
- `apps/api/src/application-skills/skill-registry.ts` — immutable versions, bindings, status transitions, and rollback.
- `apps/api/src/application-skills/skill-validator.ts` — semantic and parent-capability validation.
- `apps/api/src/application-skills/skill-interpreter.ts` — page matching and finite directive compilation.
- `apps/api/src/application-skills/skill-selector.ts` — site/page selection and stable assignment.
- `apps/api/src/application-skills/skill-execution-recorder.ts` — append-only local evaluation facts.
- `apps/api/src/application-skills/replay-corpus.ts` — redacted training/holdout snapshots.
- `apps/api/src/application-skills/evaluation-engine.ts` — fixed lexicographic comparison.
- `apps/api/src/application-skills/evolution-collector.ts` — triggers, failure/success pairs, and monotonic chains.
- `apps/api/src/application-skills/evolution-agent.ts` — structured LLM patch generation.
- `apps/api/src/application-skills/evolution-coordinator.ts` — candidate creation and offline gates.
- `apps/api/src/application-skills/bootstrap.ts` — manually authored initial Champion Skills.
- `apps/api/src/application-skills/statistics.ts` — deterministic stratified bootstrap.
- `apps/api/src/application-skills/promotion-engine.ts` — Challenger lifecycle and automatic rollback.

---

## Phase A — Explainable Top-Six Job Recommendations

### Task 1: Add backward-compatible score-breakdown contracts

**Files:**
- Modify: `packages/contracts/src/job-matching.ts`
- Test: `packages/contracts/src/job-matching.test.ts`

**Interfaces:**
- Produces: `JobMatchScoreDimension`, `JobMatchScoreBreakdown`, and optional `JobMatchResult.scoreBreakdown`.
- Consumes: existing `JobMatchResultSchema`, requirement outcome enums, and `scoringVersion`.

- [ ] **Step 1: Write failing old/new compatibility tests**

Add fixtures proving the old result parses without a breakdown and a new result rejects totals that are negative or above 100:

```ts
it("parses legacy results and strict v2 score breakdowns", () => {
  expect(JobMatchResultSchema.parse(legacyResult).scoreBreakdown).toBeUndefined();
  const parsed = JobMatchResultSchema.parse({
    ...legacyResult,
    scoreBreakdown: {
      total: 70,
      dimensions: [{
        dimension: "skill",
        label: "技能",
        earned: 35,
        available: 50,
        satisfied: 2,
        unknown: 1,
        conflict: 0
      }]
    }
  });
  expect(parsed.scoreBreakdown?.dimensions[0]?.label).toBe("技能");
});
```

- [ ] **Step 2: Run the focused test and observe RED**

Run: `rtk corepack pnpm --filter @resume/contracts exec vitest run src/job-matching.test.ts`

Expected: FAIL because `scoreBreakdown` is stripped or its Schema is undefined.

- [ ] **Step 3: Add strict optional Schemas**

Implement and export:

```ts
export const JobMatchScoreDimensionSchema = z.object({
  dimension: z.enum(["skill", "responsibility", "project", "qualification", "preference"]),
  label: z.enum(["技能", "工作职责", "项目经验", "基本条件", "求职偏好"]),
  earned: z.number().min(0).max(100),
  available: z.number().positive().max(100),
  satisfied: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  conflict: z.number().int().nonnegative()
}).strict();

export const JobMatchScoreBreakdownSchema = z.object({
  total: z.number().min(0).max(100),
  dimensions: z.array(JobMatchScoreDimensionSchema).max(5)
}).strict();
```

Add `scoreBreakdown: JobMatchScoreBreakdownSchema.optional()` to `JobMatchResultSchema` so persisted v1 rows remain readable.

- [ ] **Step 4: Run package tests and typecheck**

Run:

```powershell
rtk corepack pnpm --filter @resume/contracts test -- --run
rtk corepack pnpm --filter @resume/contracts typecheck
```

Expected: all contract tests pass and typecheck exits 0.

- [ ] **Step 5: Commit**

```powershell
rtk git add packages/contracts/src/job-matching.ts packages/contracts/src/job-matching.test.ts
rtk git commit -m "feat: add job match score breakdown contract"
```

### Task 2: Make fit scoring conservative and authoritative

**Files:**
- Modify: `packages/job-matching/src/scoring-v1.ts`
- Modify: `packages/job-matching/src/scoring-v1.test.ts`

**Interfaces:**
- Produces: `scoreJobMatch(input)` with `unknown = 0`, populated `scoreBreakdown`, and `sortJobMatches()` ordered by visible fit.
- Consumes: Task 1 `JobMatchScoreBreakdown` contract.

- [ ] **Step 1: Write failing boundary and retention tests**

Add tests proving unknown earns zero, satisfied behavior is retained, multiple requirements split one dimension evenly, missing dimensions normalize to 100, no scorable requirements return 0%, dimension totals equal `fitScore`, two-decimal backend rounding is stable, and ties use confidence then URL:

```ts
expect(scoreJobMatch(inputWithUnknown).fitScore).toBe(0);
expect(scoreJobMatch(inputWithSatisfied).fitScore).toBe(100);
expect(scoreJobMatch(mixedInput).scoreBreakdown?.total).toBe(scoreJobMatch(mixedInput).fitScore);
expect(sortJobMatches([lowFitHighConfidence, highFitLowConfidence])[0]).toBe(highFitLowConfidence);
```

- [ ] **Step 2: Run the focused test and observe RED**

Run: `rtk corepack pnpm --filter @resume/job-matching exec vitest run src/scoring-v1.test.ts`

Expected: FAIL because unknown currently contributes `0.5` and sorting begins with `rankingScore`.

- [ ] **Step 3: Implement the minimal scoring change**

Change the requirement contribution and produce breakdowns from the same weight map:

```ts
const BASE_DIMENSION_WEIGHTS = {
  skill: 35,
  responsibility: 25,
  project: 20,
  qualification: 10,
  preference: 10
} as const;

fit += weight * (outcome === "satisfied" ? 1 : 0);

const scoreBreakdown = buildScoreBreakdown(
  input.posting.requirements,
  requirementWeights,
  outcomeByRequirement
);
```

Change `sortJobMatches` to:

```ts
return [...results].sort((left, right) =>
  right.fitScore - left.fitScore
  || right.confidence - left.confidence
  || compareText(left.canonicalUrl, right.canonicalUrl)
);
```

Keep `rankingScore` for persisted compatibility, but stop using it to decide the top six.

- [ ] **Step 4: Run scoring and full package tests**

Run:

```powershell
rtk corepack pnpm --filter @resume/job-matching exec vitest run src/scoring-v1.test.ts
rtk corepack pnpm --filter @resume/job-matching test -- --run
rtk corepack pnpm --filter @resume/job-matching typecheck
```

Expected: focused and full package tests pass; no snapshot depends on unknown receiving half credit.

- [ ] **Step 5: Commit**

```powershell
rtk git add packages/job-matching/src/scoring-v1.ts packages/job-matching/src/scoring-v1.test.ts
rtk git commit -m "feat: make job fit scoring conservative"
```

### Task 3: Produce human-readable evidence and authoritative API ordering

**Files:**
- Create: `apps/api/src/job-matching/profile-fact-presentation.ts`
- Create: `apps/api/src/job-matching/profile-fact-presentation.test.ts`
- Modify: `apps/api/src/agent/subgraphs/job-matching.ts`
- Modify: `apps/api/src/agent/subgraphs/job-matching.test.ts`

**Interfaces:**
- Produces: `presentProfileFact(fact): { label: string; value: string }` and `presentMatchEvidence(requirement, fact): string`.
- Consumes: confirmed/corrected `ProfileFact`, `JobRequirement`, and Task 2 `sortJobMatches`.

- [ ] **Step 1: Write failing presentation and ordering tests**

Cover known fields, unknown paths, bounded values, no raw paths, and six-result API ordering:

```ts
expect(presentMatchEvidence(requirement, fact("education[0].major", "软件工程")))
  .toBe("你的专业“软件工程”符合岗位专业要求");
expect(presentMatchEvidence(requirement, fact("private.path", "secret")))
  .not.toMatch(/private\.path|Profile fact/u);
expect(result.results.map((item) => item.fitScore)).toEqual([90, 80, 70, 60, 50, 40]);
```

- [ ] **Step 2: Run focused API tests and observe RED**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/job-matching/profile-fact-presentation.test.ts
rtk corepack pnpm --filter @resume/api exec vitest run src/agent/subgraphs/job-matching.test.ts
```

Expected: FAIL because the presenter is missing and current summaries contain `Profile fact <fieldPath>`.

- [ ] **Step 3: Implement bounded Chinese presentation**

Use an explicit root/leaf label table and never fall back to the raw path:

```ts
const LABELS: ReadonlyArray<[RegExp, string]> = [
  [/^education\[\d+\]\.degree$/u, "学历"],
  [/^education\[\d+\]\.major$/u, "专业"],
  [/^skills\[\d+\](?:\.name)?$/u, "技能"],
  [/^(?:work|internship)\[\d+\]\.description$/u, "工作经历"]
];

export function presentProfileFact(fact: ProfileFact) {
  return { label: LABELS.find(([pattern]) => pattern.test(fact.fieldPath))?.[1] ?? "已确认资料",
    value: boundedDisplayValue(fact.value, 120) };
}
```

Replace `scoringEvidence().summary` and use `sortJobMatches` before applying `JOB_RECOMMENDATION_LIMIT`.

- [ ] **Step 4: Run focused and API regression tests**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/job-matching/profile-fact-presentation.test.ts src/agent/subgraphs/job-matching.test.ts
rtk corepack pnpm --filter @resume/api test -- --run
rtk corepack pnpm --filter @resume/api typecheck
```

Expected: all tests pass and no user-visible evidence fixture contains an internal path.

- [ ] **Step 5: Commit**

```powershell
rtk git add apps/api/src/job-matching/profile-fact-presentation.ts apps/api/src/job-matching/profile-fact-presentation.test.ts apps/api/src/agent/subgraphs/job-matching.ts apps/api/src/agent/subgraphs/job-matching.test.ts
rtk git commit -m "feat: explain job matching evidence in Chinese"
```

### Task 4: Render concise cards and inline explanations

**Files:**
- Modify: `apps/web/src/conversation/ConversationJobCards.tsx`
- Modify: `apps/web/src/conversation/ConversationJobCards.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces: defensive `visibleJobResults(session)` and accessible inline `JobCardDetails`.
- Consumes: optional `JobMatchResult.scoreBreakdown`, posting requirements, outcomes, and existing selection actions.

- [ ] **Step 1: Write failing collapsed/expanded/legacy/top-six tests**

Assert collapsed cards exclude organization/location/source/statistics/evidence; expanded details contain the four Chinese headings; seven unsorted results render six in fit order; legacy results show the rematch explanation; stale selection stays blocked; conflict selection still requires confirmation; and `岗位页面` opens the canonical URL in a new tab:

```tsx
expect(screen.queryByText("百度招聘")).not.toBeInTheDocument();
expect(screen.queryByText("满足 2")).not.toBeInTheDocument();
await user.click(screen.getAllByRole("button", { name: "查看详情" })[0]!);
expect(screen.getByRole("heading", { name: "匹配优势" })).toBeVisible();
expect(screen.getByRole("heading", { name: "匹配度如何得出" })).toBeVisible();
expect(screen.queryByText(/Profile fact|education\[/u)).not.toBeInTheDocument();
```

- [ ] **Step 2: Run the focused Web test and observe RED**

Run: `rtk corepack pnpm --filter @resume/web exec vitest run src/conversation/ConversationJobCards.test.tsx`

Expected: FAIL because collapsed cards still expose metadata and raw summaries.

- [ ] **Step 3: Implement minimal presentation helpers**

Sort without mutating session data and render only six:

```ts
const visible = [...session.results]
  .filter((result) => postings.has(result.postingId))
  .sort((a, b) => b.fitScore - a.fitScore
    || b.confidence - a.confidence
    || a.canonicalUrl.localeCompare(b.canonicalUrl))
  .slice(0, JOB_RECOMMENDATION_LIMIT);
```

Render score dimensions as `技能 28/35` and group requirement text by `outcome`. If `scoreBreakdown` is absent, show `此结果使用旧版评分，重新匹配后可查看分项说明` instead of recomputing.

- [ ] **Step 4: Run Web tests and build**

Run:

```powershell
rtk corepack pnpm --filter @resume/web exec vitest run src/conversation/ConversationJobCards.test.tsx
rtk corepack pnpm --filter @resume/web test -- --run
rtk corepack pnpm --filter @resume/web build
```

Expected: all Web tests pass; build exits 0 with no new warning beyond the existing chunk-size warning.

- [ ] **Step 5: Commit**

```powershell
rtk git add apps/web/src/conversation/ConversationJobCards.tsx apps/web/src/conversation/ConversationJobCards.test.tsx apps/web/src/styles.css
rtk git commit -m "feat: simplify explainable job cards"
```

### Task 5: Close Phase A with API persistence and browser regression

**Files:**
- Modify: `apps/api/src/job-matching/job-match-repository.test.ts`
- Modify: `apps/api/src/conversations/conversation-job-match-service.test.ts`
- Modify: `tests/browser/conversation-job-match-flow.spec.ts`
- Create: `docs/testing/2026-09-06-explainable-job-recommendation-regression.md`

**Interfaces:**
- Verifies: new breakdown persistence, legacy result loading, six-card browser UX, selection retention, and zero submission side effects.

- [ ] **Step 1: Add failing integration and E2E assertions**

Persist one new and one legacy result, then assert the conversation response parses both. In Playwright, assert exactly six `article[aria-label^="岗位："]`, the first percentage is not lower than the sixth, details are readable, selection still works, and synthetic ATS `submissionCount` stays `0`.

- [ ] **Step 2: Run focused integration tests and observe RED**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/job-matching/job-match-repository.test.ts src/conversations/conversation-job-match-service.test.ts
rtk corepack pnpm test:e2e -- tests/browser/conversation-job-match-flow.spec.ts
```

Expected: at least the new explanation/card assertions fail before the Phase A implementation is complete.

- [ ] **Step 3: Apply only compatibility fixes exposed by integration**

Keep persistence payload-based; do not add redundant score columns. Parse with `JobMatchResultSchema`, preserve absent breakdowns, and update only fixtures or response mapping required by the new optional field.

- [ ] **Step 4: Run Phase A gate and write evidence**

Run:

```powershell
rtk corepack pnpm --filter @resume/contracts test -- --run
rtk corepack pnpm --filter @resume/job-matching test -- --run
rtk corepack pnpm --filter @resume/api test -- --run
rtk corepack pnpm --filter @resume/web test -- --run
rtk corepack pnpm test:e2e -- tests/browser/conversation-job-match-flow.spec.ts
rtk corepack pnpm build
```

Expected: every command exits 0. Record exact counts, commands, failures seen during RED, browser screenshots, and confirmation that no application was submitted.

- [ ] **Step 5: Commit**

```powershell
rtk git add apps/api/src/job-matching/job-match-repository.test.ts apps/api/src/conversations/conversation-job-match-service.test.ts tests/browser/conversation-job-match-flow.spec.ts docs/testing/2026-09-06-explainable-job-recommendation-regression.md
rtk git commit -m "test: verify explainable job recommendations"
```

---

## Phase B — Declarative Skill Runtime With Manual Seed Champions

### Task 6: Define the closed declarative Skill language

**Files:**
- Create: `packages/contracts/src/application-skill.ts`
- Create: `packages/contracts/src/application-skill.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Produces: `ApplicationSkillContentSchema`, `ApplicationSkillVersionSchema`, `SkillBindingSchema`, `SkillDirectiveSchema`, `SkillExecutionRecordSchema`, `SkillEvaluationSchema`, and `SkillEvolutionPatchSchema`.
- Consumes: existing browser `NodeRef`, application field semantics, runtime task IDs, and Zod helpers.
- Boundary: content permits only enumerated capabilities, label/role/placeholder/stable-attribute hints, a restricted CSS final fallback, finite boolean conditions, finite page variants, ordered field semantics, and bounded recovery actions. Registry-owned identity/domain/Schema-major/parent/hash/status, evaluator policy, traffic allocation, approval, and submit are outside evolvable Skill content.

- [ ] **Step 1: Write failing acceptance and rejection tests**

Cover a valid Baidu campus Skill and reject JavaScript, XPath, CSS combinators/pseudo-selectors/dynamic IDs, URLs outside the registry-owned domains, profile values, approval tokens, evaluator weights, audit switches, `submit`, metadata changes, and retry counts above three:

```ts
expect(ApplicationSkillContentSchema.parse(baiduCampusSkill).capabilities)
  .toEqual(["observe", "fill_empty_fields", "select_option", "upload_approved_file", "readback", "full_page_audit"]);
expect(() => ApplicationSkillContentSchema.parse({
  ...baiduCampusSkill,
  workflow: [{ action: "script", source: "document.querySelector('form')" }]
})).toThrow();
expect(() => ApplicationSkillContentSchema.parse({
  ...baiduCampusSkill,
  recovery: { maxRetries: 4, actions: ["reobserve"] }
})).toThrow();
```

- [ ] **Step 2: Run the focused contract test and observe RED**

Run: `rtk corepack pnpm --filter @resume/contracts exec vitest run src/application-skill.test.ts`

Expected: FAIL because the Skill Schemas and inferred types do not exist.

- [ ] **Step 3: Implement strict discriminated Schemas**

Use closed enums and `.strict()` objects. The public directive must stay finite:

```ts
export const SkillDirectiveSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resolve-field"), semantic: ApplicationFieldSemanticSchema,
    locatorKeys: z.array(z.string().min(1)).max(8) }).strict(),
  z.object({ kind: z.literal("verify-field"), semantic: ApplicationFieldSemanticSchema }).strict(),
  z.object({ kind: z.literal("recover"), action: z.enum(["reobserve", "scroll-into-view", "refresh-node-ref"]) }).strict()
]);
```

Store `skillId`, semantic version, parent version, content hash, site, page fingerprint rule, capabilities, variants, workflow, recovery, and creation provenance. Do not add an arbitrary expression or extension field.

- [ ] **Step 4: Run contract tests and typecheck**

Run:

```powershell
rtk corepack pnpm --filter @resume/contracts exec vitest run src/application-skill.test.ts src/agent-runtime.test.ts
rtk corepack pnpm --filter @resume/contracts typecheck
```

Expected: both commands exit 0; every forbidden fixture is rejected.

- [ ] **Step 5: Commit**

```powershell
rtk git add packages/contracts/src/application-skill.ts packages/contracts/src/application-skill.test.ts packages/contracts/src/index.ts
rtk git commit -m "feat: define declarative application skill contracts"
```

### Task 7: Add immutable Skill storage and atomic lifecycle transitions

**Files:**
- Modify: `apps/api/src/db/migrate.ts`
- Modify: `apps/api/src/db/migrate.test.ts`
- Create: `apps/api/src/application-skills/skill-registry.ts`
- Create: `apps/api/src/application-skills/skill-registry.test.ts`

**Interfaces:**
- Produces: `SkillRegistry.createVersion`, `getVersion`, `bindPage`, `setAllocation`, `compareAndSetStatus`, `restoreChampion`, and append-only record APIs.
- Consumes: `ApplicationSkillVersion`, SQLite transactions, canonical JSON hashing, site/page fingerprint keys.

- [ ] **Step 1: Write failing migration, immutability, and race tests**

Assert migration creates `skill_versions`, `skill_page_bindings`, `skill_traffic_allocations`, `skill_execution_records`, `skill_evaluations`, `skill_evolution_runs`, `skill_replay_samples`, and `skill_replay_run_samples`. Test duplicate content-hash deduplication, rejected update/delete paths, and one winner from two concurrent compare-and-set promotions:

```ts
expect(registry.createVersion(candidate)).toEqual({ created: true, version: "1.1.0" });
expect(registry.createVersion(candidate)).toEqual({ created: false, version: "1.1.0" });
expect([
  registry.compareAndSetStatus(key, "challenger", "champion", "1.1.0"),
  registry.compareAndSetStatus(key, "challenger", "champion", "1.1.0")
].filter(Boolean)).toHaveLength(1);
```

- [ ] **Step 2: Run focused API tests and observe RED**

Run: `rtk corepack pnpm --filter @resume/api exec vitest run src/db/migrate.test.ts src/application-skills/skill-registry.test.ts`

Expected: FAIL because tables and registry APIs are absent.

- [ ] **Step 3: Implement append-only tables and transactional registry**

Use composite uniqueness for `(skill_id, version)`, `(site, page_fingerprint_hash, status)` where status is active, and `content_hash`. Lifecycle transitions are `candidate -> replay_qualified -> challenger -> champion -> retired`, with `quarantined` reachable on hard failure; never mutate version content. `restoreChampion` must atomically set allocation to 100% for the prior stable version.

- [ ] **Step 4: Run migration and registry tests twice**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/db/migrate.test.ts src/application-skills/skill-registry.test.ts
rtk corepack pnpm --filter @resume/api exec vitest run src/db/migrate.test.ts src/application-skills/skill-registry.test.ts
```

Expected: both runs pass, proving migrations and bootstrap reads are idempotent.

- [ ] **Step 5: Commit**

```powershell
rtk git add apps/api/src/db/migrate.ts apps/api/src/db/migrate.test.ts apps/api/src/application-skills/skill-registry.ts apps/api/src/application-skills/skill-registry.test.ts
rtk git commit -m "feat: persist immutable application skills"
```

### Task 8: Validate semantics and seed initial site Champions

**Files:**
- Create: `apps/api/src/application-skills/skill-validator.ts`
- Create: `apps/api/src/application-skills/skill-validator.test.ts`
- Create: `apps/api/src/application-skills/bootstrap.ts`
- Create: `apps/api/src/application-skills/bootstrap.test.ts`

**Interfaces:**
- Produces: `validateSkillCandidate(candidate, parent)` and `bootstrapApplicationSkills(registry)`.
- Consumes: strict contract parsing, parent capabilities, workflow graph, registry content hashes.

- [ ] **Step 1: Write failing semantic and bootstrap tests**

Test unreachable variants, cycles without a decrementing retry budget, capability expansion from the parent, unreferenced locator keys, missing verification after fill, and origin mismatch. Seed exactly one Champion each for `moka`, `dji`, and `baidu`, then run bootstrap twice and retain three versions.

- [ ] **Step 2: Run focused tests and observe RED**

Run: `rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/skill-validator.test.ts src/application-skills/bootstrap.test.ts`

Expected: FAIL because semantic validation and seed Skills do not exist.

- [ ] **Step 3: Implement validator and hand-authored seed Skills**

Return stable reason codes such as `CAPABILITY_EXPANSION`, `UNBOUNDED_RECOVERY`, `UNREACHABLE_VARIANT`, `MISSING_READBACK`, and `ORIGIN_MISMATCH`. Initial Skills must describe current observed flows only; their last directive is verification, never submission.

```ts
export interface SkillValidationResult {
  valid: boolean;
  issues: Array<{ code: SkillValidationIssueCode; path: string }>;
}
```

- [ ] **Step 4: Run validator/bootstrap tests and contract regression**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/skill-validator.test.ts src/application-skills/bootstrap.test.ts
rtk corepack pnpm --filter @resume/contracts test -- --run
```

Expected: all tests pass; bootstrap remains idempotent and no Skill has a terminal-submit capability.

- [ ] **Step 5: Commit**

```powershell
rtk git add apps/api/src/application-skills/skill-validator.ts apps/api/src/application-skills/skill-validator.test.ts apps/api/src/application-skills/bootstrap.ts apps/api/src/application-skills/bootstrap.test.ts
rtk git commit -m "feat: validate and seed application skills"
```

### Task 9: Compile Skills into finite execution directives

**Files:**
- Create: `apps/api/src/application-skills/skill-interpreter.ts`
- Create: `apps/api/src/application-skills/skill-interpreter.test.ts`

**Interfaces:**
- Produces: `SkillInterpreter.matchPage(observation, skill)` and `compileDirectives(match, requestedFields)`.
- Consumes: normalized browser observation, validated Skill content, requested field semantics.
- Boundary: interpreter returns data only and has no BrowserController, network, database, or model dependency.

- [ ] **Step 1: Write failing page-match and directive tests**

Cover exact page match, ambiguous match, no match, ordered field semantics, locator de-duplication, finite `all`/`any`/`not` conditions, bounded recovery, restricted CSS fallback, and a malicious unvalidated object. Assert the interpreter never emits a directive outside `SkillDirectiveSchema`.

- [ ] **Step 2: Run the interpreter test and observe RED**

Run: `rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/skill-interpreter.test.ts`

Expected: FAIL because the interpreter is absent.

- [ ] **Step 3: Implement pure matching and compilation**

Match registered origin, route signature, form landmarks, and required semantic markers; return a single page variant only when its score clears the fixed threshold and lead margin:

```ts
export type PageMatch =
  | { kind: "matched"; pageVariantId: string; fingerprintHash: string }
  | { kind: "ambiguous"; candidateIds: string[] }
  | { kind: "unmatched"; reason: "origin" | "fingerprint" };
```

Ambiguous/unmatched results produce no write directives.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/skill-interpreter.test.ts
rtk corepack pnpm --filter @resume/api typecheck
```

Expected: tests and typecheck pass; mutation spies show zero browser/model calls.

- [ ] **Step 5: Commit**

```powershell
rtk git add apps/api/src/application-skills/skill-interpreter.ts apps/api/src/application-skills/skill-interpreter.test.ts
rtk git commit -m "feat: interpret declarative application skills"
```

### Task 10: Pin one Skill version to each application task

**Files:**
- Create: `apps/api/src/application-skills/skill-selector.ts`
- Create: `apps/api/src/application-skills/skill-selector.test.ts`
- Modify: `packages/contracts/src/agent-runtime.ts`
- Modify: `packages/contracts/src/agent-runtime.test.ts`
- Modify: `apps/api/src/agent/runtime/application-state-store.ts`
- Modify: `apps/api/src/agent/runtime/application-state-store.test.ts`
- Modify: `apps/api/src/applications/runtime-application-service.ts`
- Modify: `apps/api/src/applications/runtime-application-service.test.ts`
- Modify: `apps/api/src/agent/subgraphs/application-execution.ts`
- Modify: `apps/api/src/agent/subgraphs/application-execution.test.ts`
- Modify: `apps/api/src/agent/application-tools.ts`
- Modify: `apps/api/src/agent/application-tools.test.ts`

**Interfaces:**
- Produces: deterministic `SkillBinding { skillId, version, site, pageFingerprintHash, allocationId }` persisted in runtime state.
- Consumes: registry selection, interpreter directives, existing observe/normalize/plan/authorize/execute/readback/audit flow.

- [ ] **Step 1: Write failing compatibility and pinning tests**

Parse old `1.0.0` checkpoints, round-trip a `1.1.0` checkpoint with safe Skill metadata, and prove repeated/resumed calls keep the original version even after registry promotion. Assert unmatched pages enter observe-only handoff and invoke no write tool.

```ts
expect(await selector.selectForTask(input)).toEqual(firstBinding);
registry.promote(newVersion);
expect(await selector.selectForTask(input)).toEqual(firstBinding);
expect(browser.writeCalls).toHaveLength(0);
```

- [ ] **Step 2: Run focused runtime tests and observe RED**

Run:

```powershell
rtk corepack pnpm --filter @resume/contracts exec vitest run src/agent-runtime.test.ts
rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/skill-selector.test.ts src/agent/runtime/application-state-store.test.ts src/applications/runtime-application-service.test.ts src/agent/subgraphs/application-execution.test.ts src/agent/application-tools.test.ts
```

Expected: FAIL because runtime state has no Skill binding and execution ignores directives.

- [ ] **Step 3: Integrate binding without bypassing safety controls**

Make `RuntimeApplicationStateSchema` a discriminated union of legacy `1.0.0` and current `1.1.0`; upgrade in memory on load. Resolve a binding once after observation, persist only identifiers/hashes, compile directives, then feed locator ordering into existing plan construction. Keep action policy authorization, NodeRef/snapshot/epoch validation, double readback, full-page audit, ownership lease, navigation detection, and final-review lock unchanged.

- [ ] **Step 4: Run all application runtime tests**

Run:

```powershell
rtk corepack pnpm --filter @resume/contracts exec vitest run src/agent-runtime.test.ts
rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/skill-selector.test.ts src/agent/runtime/application-state-store.test.ts src/applications/runtime-application-service.test.ts src/agent/subgraphs/application-execution.test.ts src/agent/application-tools.test.ts
```

Expected: all pass; legacy checkpoints resume, bindings are stable, and no final-submit call is possible.

- [ ] **Step 5: Commit**

```powershell
rtk git add packages/contracts/src/agent-runtime.ts packages/contracts/src/agent-runtime.test.ts apps/api/src/application-skills/skill-selector.ts apps/api/src/application-skills/skill-selector.test.ts apps/api/src/agent/runtime/application-state-store.ts apps/api/src/agent/runtime/application-state-store.test.ts apps/api/src/applications/runtime-application-service.ts apps/api/src/applications/runtime-application-service.test.ts apps/api/src/agent/subgraphs/application-execution.ts apps/api/src/agent/subgraphs/application-execution.test.ts apps/api/src/agent/application-tools.ts apps/api/src/agent/application-tools.test.ts
rtk git commit -m "feat: bind application tasks to skill versions"
```

### Task 11: Record append-only Skill execution evidence

**Files:**
- Create: `apps/api/src/application-skills/skill-execution-recorder.ts`
- Create: `apps/api/src/application-skills/skill-execution-recorder.test.ts`
- Modify: `packages/contracts/src/agent-graph.ts`
- Modify: `packages/contracts/src/agent-graph.test.ts`
- Modify: `apps/api/src/agent/trace-sink.ts`
- Modify: `apps/api/src/agent/trace-sink.test.ts`
- Modify: `apps/api/src/agent/langsmith-outbox.ts`
- Modify: `apps/api/src/agent/langsmith-outbox.test.ts`
- Modify: `apps/api/src/agent/langsmith-exporter.test.ts`
- Modify: `apps/api/src/production-dependencies.ts`
- Modify: `apps/api/src/production-dependencies.test.ts`

**Interfaces:**
- Produces: one immutable execution record plus safe TraceSink/LangSmith dimensions per attempt.
- Consumes: pinned binding, field plans, readbacks, audit mismatches, retry counts, durations, terminal state.

- [ ] **Step 1: Write failing evidence and PII-retention tests**

Assert records include IDs, hashed page fingerprint, semantic field outcomes, first-error attribution, audit mismatch classes, retries, duration, and terminal result. Assert names, phones, emails, resume text, field values, selectors, raw DOM, screenshots, approval tokens, and URLs with query strings are absent from both local trace metadata and LangSmith outbox payloads. Simulate LangSmith delivery failure and prove the local record/outbox remain durable while Champion execution completes.

- [ ] **Step 2: Run focused trace tests and observe RED**

Run: `rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/skill-execution-recorder.test.ts src/agent/trace-sink.test.ts src/agent/langsmith-outbox.test.ts src/agent/langsmith-exporter.test.ts src/production-dependencies.test.ts`

Expected: FAIL because Skill execution dimensions are not recorded.

- [ ] **Step 3: Implement one-way redaction and append-only writes**

Expose only optional safe dimensions on graph events:

```ts
export interface SkillTraceDimensions {
  skillId: string;
  skillVersion: string;
  pageFingerprintHash: string;
  pageVariantId: string;
  allocation: "champion" | "challenger";
}
```

Record first failure at its originating stage and do not overwrite it during recovery. LangSmith receives outcome counters and opaque IDs; replayable observations remain in the local redacted corpus only.

- [ ] **Step 4: Run trace, dependency, and privacy regression tests**

Run:

```powershell
rtk corepack pnpm --filter @resume/contracts exec vitest run src/agent-graph.test.ts
rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/skill-execution-recorder.test.ts src/agent/trace-sink.test.ts src/agent/langsmith-outbox.test.ts src/agent/langsmith-exporter.test.ts src/production-dependencies.test.ts
```

Expected: all pass; forbidden-value fixture search returns no match in serialized telemetry.

- [ ] **Step 5: Commit**

```powershell
rtk git add packages/contracts/src/agent-graph.ts packages/contracts/src/agent-graph.test.ts apps/api/src/application-skills/skill-execution-recorder.ts apps/api/src/application-skills/skill-execution-recorder.test.ts apps/api/src/agent/trace-sink.ts apps/api/src/agent/trace-sink.test.ts apps/api/src/agent/langsmith-outbox.ts apps/api/src/agent/langsmith-outbox.test.ts apps/api/src/agent/langsmith-exporter.test.ts apps/api/src/production-dependencies.ts apps/api/src/production-dependencies.test.ts
rtk git commit -m "feat: audit application skill executions"
```

### Task 12: Close Phase B with site runtime safety E2E

**Files:**
- Modify: `apps/synthetic-ats/src/server.ts`
- Modify: `apps/synthetic-ats/src/server.test.ts`
- Create: `tests/browser/application-skill-runtime.spec.ts`
- Create: `docs/testing/2026-09-06-application-skill-runtime-regression.md`

**Interfaces:**
- Verifies: Moka, DJI, and Baidu page recognition; stable binding; correct pre-submit filling; unmatched fallback; reload recovery; audit evidence; final-submit lock.

- [ ] **Step 1: Add failing synthetic variants and browser scenarios**

Add deterministic pages for all three sites plus renamed-label, duplicate-label, delayed-render, stale-node, ambiguous-fingerprint, and unexpected-navigation cases. Each scenario asserts expected field values after readback and `submissionCount === 0`.

- [ ] **Step 2: Run focused synthetic and browser tests and observe RED**

Run:

```powershell
rtk corepack pnpm --filter @resume/synthetic-ats test -- --run
rtk corepack pnpm test:e2e -- tests/browser/application-skill-runtime.spec.ts
```

Expected: new variants or Skill assertions fail until Phase B integration is complete.

- [ ] **Step 3: Apply only integration fixes within Phase B boundaries**

Correct seed locator hints, fingerprint landmarks, fixture timing, or runtime wiring. Assert a Champion hard failure stops automatic filling and requests user takeover; never switch to an unverified candidate. Do not weaken matching thresholds, action authorization, readback, audit, or final-submit protection to make a fixture pass.

- [ ] **Step 4: Run the Phase B gate and capture evidence**

Run:

```powershell
rtk corepack pnpm --filter @resume/contracts test -- --run
rtk corepack pnpm --filter @resume/api test -- --run
rtk corepack pnpm --filter @resume/synthetic-ats test -- --run
rtk corepack pnpm test:e2e -- tests/browser/application-skill-runtime.spec.ts
rtk corepack pnpm build
```

Expected: every command exits 0. Record exact counts, binding IDs/versions, screenshots for matched and unmatched flows, audit record IDs, and zero submissions.

- [ ] **Step 5: Commit**

```powershell
rtk git add apps/synthetic-ats/src/server.ts apps/synthetic-ats/src/server.test.ts tests/browser/application-skill-runtime.spec.ts docs/testing/2026-09-06-application-skill-runtime-regression.md
rtk git commit -m "test: verify declarative skill runtime"
```

---

## Phase C — Offline Skill Evolution and Qualification

### Task 13: Build a redacted training/holdout replay corpus

**Files:**
- Create: `apps/api/src/application-skills/replay-corpus.ts`
- Create: `apps/api/src/application-skills/replay-corpus.test.ts`
- Modify: `apps/api/src/application-skills/skill-execution-recorder.ts`
- Modify: `apps/api/src/application-skills/skill-execution-recorder.test.ts`
- Modify: `apps/api/src/application-skills/skill-registry.ts`
- Modify: `apps/api/src/application-skills/skill-registry.test.ts`

**Interfaces:**
- Produces: `ReplayCorpus.append`, `snapshotForEvolution(cutoffAt)`, training-only access, and evaluator-only holdout access with a frozen temporal manifest.
- Consumes: normalized redacted page structure, expected field semantics, execution/audit outcomes, stable site/fingerprint hashes.
- Boundary: evolution prompt construction can read training samples but cannot request or enumerate holdout samples.

- [ ] **Step 1: Write failing redaction, partition, and retention tests**

Use fixtures containing a name, phone, email, address, resume text, hidden input, query token, and approval token. Assert the stored sample retains role/tag/type/label hash/option hashes/relative structure/outcome but no raw user value. Within each site/page-fingerprint stratum, assert an evolution snapshot freezes the older 80% as training and newest 20% as holdout at its cutoff; records after the cutoff are excluded; holdout IDs cannot be fetched through the training API.

- [ ] **Step 2: Run focused corpus tests and observe RED**

Run: `rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/replay-corpus.test.ts src/application-skills/skill-execution-recorder.test.ts src/application-skills/skill-registry.test.ts`

Expected: FAIL because replay samples and partition enforcement are absent.

- [ ] **Step 3: Implement deterministic redaction and split**

Sort each `(site, pageFingerprintHash, scenarioClass)` stratum by `capturedAt` then `sampleId`; freeze the oldest 80% as training and newest 20% as holdout in the immutable evolution-run manifest. Preserve a retention set sufficient to reproduce selection and verification:

```ts
export interface RedactedReplaySample {
  sampleId: string;
  capturedAt: string;
  partition: "training" | "holdout";
  site: string;
  pageFingerprintHash: string;
  controls: Array<{ role: string; type: string; labelHash: string; optionHashes: string[] }>;
  expectedSemantics: string[];
  observedOutcome: SkillEvaluationInput;
}
```

Use insert-only storage, reject a changed payload for an existing `sampleId`, and never repartition an existing run manifest when later samples arrive.

- [ ] **Step 4: Run corpus tests and a serialized PII scan**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/replay-corpus.test.ts src/application-skills/skill-execution-recorder.test.ts src/application-skills/skill-registry.test.ts
rtk corepack pnpm --filter @resume/api typecheck
```

Expected: all pass; boundary fixtures are removed while structural retention fixtures remain replayable.

- [ ] **Step 5: Commit**

```powershell
rtk git add apps/api/src/application-skills/replay-corpus.ts apps/api/src/application-skills/replay-corpus.test.ts apps/api/src/application-skills/skill-execution-recorder.ts apps/api/src/application-skills/skill-execution-recorder.test.ts apps/api/src/application-skills/skill-registry.ts apps/api/src/application-skills/skill-registry.test.ts
rtk git commit -m "feat: build redacted skill replay corpus"
```

### Task 14: Implement the fixed lexicographic evaluator

**Files:**
- Create: `apps/api/src/application-skills/evaluation-engine.ts`
- Create: `apps/api/src/application-skills/evaluation-engine.test.ts`

**Interfaces:**
- Produces: `evaluateExecution(input)`, `aggregateEvaluations(records)`, and `compareEvaluation(left, right)`.
- Consumes: readback/audit facts, required-field set, corrections, retry/recovery counters, duration.
- Boundary: weights and ordering are code-owned versioned constants and are absent from Skill content and model prompts.

- [ ] **Step 1: Write failing ordering and edge-case tests**

Prove one safety violation loses to any safe result; one incorrect write loses before accuracy; accuracy precedes completion; corrections precede retries; duration breaks only the final tie. Include empty-required-field, timeout, duplicate record, partial audit, and equal-vector cases.

```ts
expect(compareEvaluation(
  { safetyViolations: 1, incorrectWrites: 0, fieldAccuracy: 1, requiredCompletion: 1,
    userCorrections: 0, retries: 0, durationMs: 10 },
  { safetyViolations: 0, incorrectWrites: 1, fieldAccuracy: 0, requiredCompletion: 0,
    userCorrections: 9, retries: 9, durationMs: 99_000 }
)).toBe("right");
```

- [ ] **Step 2: Run evaluator tests and observe RED**

Run: `rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/evaluation-engine.test.ts`

Expected: FAIL because no evaluator exists.

- [ ] **Step 3: Implement a versioned comparison vector**

Export `SKILL_EVALUATOR_VERSION = "1.0.0"`. Minimize safety violations and incorrect writes, maximize field accuracy and required completion, then minimize user corrections, retries/recovery, and duration. Return `equal` when every component matches. Keep raw facts beside the derived vector for auditability.

- [ ] **Step 4: Run evaluator tests with randomized invariants**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/evaluation-engine.test.ts
rtk corepack pnpm --filter @resume/api typecheck
```

Expected: deterministic tests and seeded permutation/transitivity checks pass.

- [ ] **Step 5: Commit**

```powershell
rtk git add apps/api/src/application-skills/evaluation-engine.ts apps/api/src/application-skills/evaluation-engine.test.ts
rtk git commit -m "feat: evaluate skill executions lexicographically"
```

### Task 15: Detect actionable evolution opportunities

**Files:**
- Create: `apps/api/src/application-skills/evolution-collector.ts`
- Create: `apps/api/src/application-skills/evolution-collector.test.ts`

**Interfaces:**
- Produces: deduplicated `EvolutionOpportunity` records containing a monotonic execution chain and, when available, a fail-to-success pair.
- Consumes: append-only execution records/evaluations and their safe cross-run aggregate projection (also mirrored to LangSmith) for one site, fingerprint, and pinned Skill version.

- [ ] **Step 1: Write failing trigger and chain tests**

Cover three equivalent failures in the latest twenty eligible executions, page-fingerprint drift with no usable Champion, an improving Challenger with repeated recoveries, a fail followed by success after recovery, duplicate retries, unrelated sites, old Skill versions, and already-open evolution runs. Assert transient browser ownership loss does not trigger evolution.

- [ ] **Step 2: Run collector tests and observe RED**

Run: `rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/evolution-collector.test.ts`

Expected: FAIL because trigger classification and chain construction do not exist.

- [ ] **Step 3: Implement bounded grouping and first-error attribution**

Group by `(site, pageFingerprintHash, skillId, version, firstErrorClass)`. Trigger when the latest twenty contain at least three equivalent actionable failures, when a new fingerprint is confirmed by two observations and has no usable Champion, or when an improving Challenger repeats the same recovery at least three times. Build a chain only when each adjacent child is strictly better than its parent and retain the shortest fail-to-success path. Hash the opportunity payload to suppress duplicates and merge repeated labels, fingerprints, and recovery strategies by page/field/error theme.

- [ ] **Step 4: Run collector and evaluator tests**

Run: `rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/evolution-collector.test.ts src/application-skills/evaluation-engine.test.ts`

Expected: all pass; duplicate and non-actionable traces produce no opportunity.

- [ ] **Step 5: Commit**

```powershell
rtk git add apps/api/src/application-skills/evolution-collector.ts apps/api/src/application-skills/evolution-collector.test.ts
rtk git commit -m "feat: collect skill evolution opportunities"
```

### Task 16: Generate constrained Skill patches with the structured model

**Files:**
- Create: `apps/api/src/application-skills/evolution-agent.ts`
- Create: `apps/api/src/application-skills/evolution-agent.test.ts`
- Modify: `apps/api/src/production-dependencies.ts`
- Modify: `apps/api/src/production-dependencies.test.ts`

**Interfaces:**
- Produces: one `SkillEvolutionPatch` against an exact parent content hash, or a typed non-candidate outcome.
- Consumes: `StructuredModelProvider.generateStructured`, training examples, monotonic chains, validator issue vocabulary.
- Boundary: prompt contains no holdout examples, evaluator implementation/weights, traffic thresholds, real profile values, or submit authority.

- [ ] **Step 1: Write failing provider, prompt-boundary, and patch tests**

Assert the provider is called once with `SkillEvolutionPatchSchema`; malformed output, parent-hash mismatch, forbidden capability, unchanged content hash, timeout, and provider error yield no candidate. Inspect the request to ensure it contains only redacted training evidence and the allowed patch operations `add`, `replace`, and `remove` on Skill content paths.

- [ ] **Step 2: Run evolution-agent tests and observe RED**

Run: `rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/evolution-agent.test.ts src/production-dependencies.test.ts`

Expected: FAIL because the evolution agent is not wired.

- [ ] **Step 3: Implement one-shot structured generation and local revalidation**

Apply the patch to an in-memory parent copy, canonicalize it, reject a same hash, parse strict contracts, then call `validateSkillCandidate(candidate, parent)`. Return stable outcomes:

```ts
export type EvolutionAgentResult =
  | { kind: "candidate"; content: ApplicationSkillContent; contentHash: string }
  | { kind: "rejected"; reason: "provider" | "schema" | "parent" | "unchanged" | "validation" };
```

Never retry the model automatically within the same evolution run.

- [ ] **Step 4: Run focused tests and dependency construction test**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/evolution-agent.test.ts src/application-skills/skill-validator.test.ts src/production-dependencies.test.ts
rtk corepack pnpm --filter @resume/api typecheck
```

Expected: all pass; every invalid model response is closed safely without registry mutation.

- [ ] **Step 5: Commit**

```powershell
rtk git add apps/api/src/application-skills/evolution-agent.ts apps/api/src/application-skills/evolution-agent.test.ts apps/api/src/production-dependencies.ts apps/api/src/production-dependencies.test.ts
rtk git commit -m "feat: generate constrained skill candidates"
```

### Task 17: Qualify candidates through replay and synthetic ATS

**Files:**
- Create: `apps/api/src/application-skills/evolution-coordinator.ts`
- Create: `apps/api/src/application-skills/evolution-coordinator.test.ts`
- Modify: `apps/synthetic-ats/src/server.ts`
- Modify: `apps/synthetic-ats/src/server.test.ts`
- Create: `tests/browser/application-skill-offline-evolution.spec.ts`
- Create: `docs/testing/2026-09-06-application-skill-offline-evolution.md`

**Interfaces:**
- Produces: atomic `candidate -> replay_qualified` transition and an immutable gate report; never assigns live traffic.
- Consumes: candidate generator, validator, training/holdout replay, evaluator, synthetic ATS runner, registry.

- [ ] **Step 1: Write failing gate-order and leakage tests**

Assert exact gate order: Schema, semantics, safety simulation, hidden holdout replay, synthetic ATS. A candidate must be safe, have zero new incorrect writes/mismatches, and be lexicographically better on the targeted failure stratum while non-inferior globally. Failures stop later gates; model-facing spies never receive holdout samples. Passing qualification leaves traffic allocation unchanged.

- [ ] **Step 2: Run coordinator and offline E2E tests and observe RED**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/evolution-coordinator.test.ts
rtk corepack pnpm --filter @resume/synthetic-ats test -- --run
rtk corepack pnpm test:e2e -- tests/browser/application-skill-offline-evolution.spec.ts
```

Expected: FAIL because qualification orchestration and adversarial ATS variants are absent.

- [ ] **Step 3: Implement idempotent offline orchestration**

Acquire one evolution-run lease per opportunity hash, create at most one immutable candidate, evaluate the Champion and candidate against the same samples, and store every gate input hash, evaluator version, result, and rejection reason. Add synthetic variants for reordered controls, duplicate labels, delayed options, hidden honeypot, unexpected navigation, stale NodeRef, and post-fill mutation.

- [ ] **Step 4: Run the Phase C gate and record evidence**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/replay-corpus.test.ts src/application-skills/evaluation-engine.test.ts src/application-skills/evolution-collector.test.ts src/application-skills/evolution-agent.test.ts src/application-skills/evolution-coordinator.test.ts
rtk corepack pnpm --filter @resume/synthetic-ats test -- --run
rtk corepack pnpm test:e2e -- tests/browser/application-skill-offline-evolution.spec.ts
rtk corepack pnpm build
```

Expected: every command exits 0; the candidate is `replay_qualified`, allocation remains 100% Champion/0% candidate, holdout access is evaluator-only, and submission count is zero. Record exact report IDs and counts.

- [ ] **Step 5: Commit**

```powershell
rtk git add apps/api/src/application-skills/evolution-coordinator.ts apps/api/src/application-skills/evolution-coordinator.test.ts apps/synthetic-ats/src/server.ts apps/synthetic-ats/src/server.test.ts tests/browser/application-skill-offline-evolution.spec.ts docs/testing/2026-09-06-application-skill-offline-evolution.md
rtk git commit -m "feat: qualify skill candidates offline"
```

---

## Phase D — Champion–Challenger Allocation, Promotion, and Rollback

### Task 18: Add deterministic limited live allocation

**Files:**
- Modify: `apps/api/src/application-skills/skill-selector.ts`
- Modify: `apps/api/src/application-skills/skill-selector.test.ts`
- Modify: `apps/api/src/application-skills/skill-registry.ts`
- Modify: `apps/api/src/application-skills/skill-registry.test.ts`

**Interfaces:**
- Produces: a stable 90% Champion / 10% Challenger assignment for eligible new tasks and stores its allocation ID in `SkillBinding`.
- Consumes: one `replay_qualified` version, site/page binding, task ID, traffic salt, lifecycle status.

- [ ] **Step 1: Write failing distribution, eligibility, and stability tests**

Across 10,000 fixed task IDs, require Challenger allocation between 9% and 11%. Prove the same task always receives the same version across process restarts; resumed tasks keep persisted bindings; unmatched fingerprints, quarantined versions, and tasks created before activation receive no Challenger.

- [ ] **Step 2: Run selector/registry tests and observe RED**

Run: `rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/skill-selector.test.ts src/application-skills/skill-registry.test.ts`

Expected: FAIL because only a Champion can currently be selected.

- [ ] **Step 3: Implement hash-bucket allocation and activation transaction**

Compute `bucket = uint32(sha256(site + fingerprint + taskId + allocationSalt)) % 1000`; buckets `0..99` receive the Challenger. Activate an allocation only with a compare-and-set from `replay_qualified` to `challenger`, one stable Champion backup, and `challengerPermille = 100`. Do not switch an existing task after binding.

- [ ] **Step 4: Run deterministic and randomized selector tests**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/skill-selector.test.ts src/application-skills/skill-registry.test.ts
rtk corepack pnpm --filter @resume/api typecheck
```

Expected: all pass; test snapshots reproduce the same assignments on repeated runs.

- [ ] **Step 5: Commit**

```powershell
rtk git add apps/api/src/application-skills/skill-selector.ts apps/api/src/application-skills/skill-selector.test.ts apps/api/src/application-skills/skill-registry.ts apps/api/src/application-skills/skill-registry.test.ts
rtk git commit -m "feat: allocate limited challenger traffic"
```

### Task 19: Compute deterministic stratified confidence intervals

**Files:**
- Create: `apps/api/src/application-skills/statistics.ts`
- Create: `apps/api/src/application-skills/statistics.test.ts`

**Interfaces:**
- Produces: `stratifiedBootstrapComparison(input)` with sample counts, first differing evaluation dimension, observed delta, 95% confidence interval, and decision.
- Consumes: Champion/Challenger evaluations stratified by site, page fingerprint, scenario class, and required-field-count band.

- [ ] **Step 1: Write failing statistical fixtures**

Use fixed seeds for clear improvement, clear regression, equal outcomes, sparse strata, one oversized stratum, and reordered input. Assert fewer than ten eligible Challenger runs returns `insufficient`; 10–49 inconclusive runs return `continue`; 50 inconclusive runs return `stop-inconclusive`; confidence interval output is byte-for-byte stable.

- [ ] **Step 2: Run statistics tests and observe RED**

Run: `rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/statistics.test.ts`

Expected: FAIL because no comparison module exists.

- [ ] **Step 3: Implement seeded stratified bootstrap**

Sort records by execution ID, derive the PRNG seed from allocation ID plus evaluator version, resample within each stratum for 10,000 iterations, then combine using fixed observed stratum weights. Hard dimensions are not averaged: any Challenger safety violation, incorrect write, or new audit mismatch is a regression. For the first lower-priority dimension that differs, promotion requires the 95% interval to exclude zero in the better direction while every higher-priority dimension is non-inferior.

```ts
export type ChallengerDecision =
  | "insufficient"
  | "continue"
  | "promote"
  | "rollback"
  | "stop-inconclusive";
```

- [ ] **Step 4: Run statistics tests twice to verify determinism**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/statistics.test.ts
rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/statistics.test.ts
```

Expected: both runs pass with identical snapshots and decisions.

- [ ] **Step 5: Commit**

```powershell
rtk git add apps/api/src/application-skills/statistics.ts apps/api/src/application-skills/statistics.test.ts
rtk git commit -m "feat: compare skill versions statistically"
```

### Task 20: Promote, quarantine, and roll back atomically

**Files:**
- Create: `apps/api/src/application-skills/promotion-engine.ts`
- Create: `apps/api/src/application-skills/promotion-engine.test.ts`
- Modify: `apps/api/src/application-skills/skill-execution-recorder.ts`
- Modify: `apps/api/src/application-skills/skill-execution-recorder.test.ts`
- Modify: `apps/api/src/production-dependencies.ts`
- Modify: `apps/api/src/production-dependencies.test.ts`

**Interfaces:**
- Produces: `PromotionEngine.recordAndDecide(execution)` with idempotent `continue`, `promoted`, `rolled_back`, or `stopped_inconclusive` outcomes.
- Consumes: append-only evaluation record, allocation state, statistical comparison, stable Champion backup, registry compare-and-set transitions.

- [ ] **Step 1: Write failing lifecycle and race tests**

Cover immediate rollback on safety violation, incorrect write, or new full-page mismatch; promotion after at least ten eligible runs and positive 95% confidence; continued allocation while inconclusive below fifty; stopped allocation at fifty; duplicate record delivery; late record after rollback; and two workers racing to decide.

- [ ] **Step 2: Run promotion tests and observe RED**

Run: `rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/promotion-engine.test.ts src/application-skills/skill-execution-recorder.test.ts src/production-dependencies.test.ts`

Expected: FAIL because execution recording does not drive lifecycle decisions.

- [ ] **Step 3: Implement transactional decisions with stable backup**

On a hard failure, insert the evidence first, atomically mark Challenger `quarantined`, set Challenger traffic to zero, restore the prior Champion to 100%, and keep already-bound tasks on their version only until they stop before the next write; resumed quarantined tasks must enter safe handoff. On promotion, retire the old Champion only after the new version and 100% allocation commit together. At fifty inconclusive runs, mark the Challenger `retired` and restore the Champion without classifying it as unsafe.

- [ ] **Step 4: Run promotion, registry, and failure-injection tests**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/promotion-engine.test.ts src/application-skills/skill-execution-recorder.test.ts src/application-skills/skill-registry.test.ts src/production-dependencies.test.ts
rtk corepack pnpm --filter @resume/api typecheck
```

Expected: all pass; transaction rollback tests leave exactly one Champion and a complete evidence chain.

- [ ] **Step 5: Commit**

```powershell
rtk git add apps/api/src/application-skills/promotion-engine.ts apps/api/src/application-skills/promotion-engine.test.ts apps/api/src/application-skills/skill-execution-recorder.ts apps/api/src/application-skills/skill-execution-recorder.test.ts apps/api/src/production-dependencies.ts apps/api/src/production-dependencies.test.ts
rtk git commit -m "feat: automate skill promotion and rollback"
```

### Task 21: Verify the complete automatic evolution loop end to end

**Files:**
- Modify: `apps/synthetic-ats/src/server.ts`
- Modify: `apps/synthetic-ats/src/server.test.ts`
- Create: `tests/browser/application-skill-evolution.spec.ts`
- Create: `docs/testing/2026-09-06-application-skill-evolution-regression.md`

**Interfaces:**
- Verifies: audited failure collection → constrained patch → offline qualification → 10% stable allocation → promotion or hard-failure rollback, with final submission permanently blocked.

- [ ] **Step 1: Add failing promotion and rollback browser scenarios**

Scenario one introduces a Baidu label change that the seed Champion misses, supplies a later verified success, evolves a locator hint, qualifies it, runs deterministic cohorts, and promotes it. Scenario two injects a post-fill mutation into the Challenger cohort and asserts immediate quarantine. For both, assert existing tasks stay pinned, new tasks receive the expected version, evidence is append-only, and `submissionCount === 0`.

- [ ] **Step 2: Run the evolution E2E and observe RED**

Run: `rtk corepack pnpm test:e2e -- tests/browser/application-skill-evolution.spec.ts`

Expected: FAIL before all Phase D wiring is complete.

- [ ] **Step 3: Apply only wiring and deterministic-fixture fixes**

Connect execution completion to the collector/coordinator/promotion engine through production dependencies. Add test-only deterministic model responses and allocation task IDs through existing dependency injection; do not add production bypass flags or relax any validator, evaluator, traffic, audit, or submission gate.

- [ ] **Step 4: Run the Phase D gate and capture evidence**

Run:

```powershell
rtk corepack pnpm --filter @resume/api test -- --run
rtk corepack pnpm --filter @resume/synthetic-ats test -- --run
rtk corepack pnpm test:e2e -- tests/browser/application-skill-runtime.spec.ts tests/browser/application-skill-offline-evolution.spec.ts tests/browser/application-skill-evolution.spec.ts
rtk corepack pnpm build
```

Expected: every command exits 0. The report records seed, allocation IDs, sample counts, confidence intervals, lifecycle transitions, rollback latency in execution events, audit record IDs, screenshots, and zero submissions.

- [ ] **Step 5: Commit**

```powershell
rtk git add apps/synthetic-ats/src/server.ts apps/synthetic-ats/src/server.test.ts tests/browser/application-skill-evolution.spec.ts docs/testing/2026-09-06-application-skill-evolution-regression.md
rtk git commit -m "test: verify automatic skill evolution"
```

### Task 22: Run full regression, review safety boundaries, and close the plan

**Files:**
- Modify: `docs/testing/2026-09-06-explainable-job-recommendation-regression.md`
- Modify: `docs/testing/2026-09-06-application-skill-runtime-regression.md`
- Modify: `docs/testing/2026-09-06-application-skill-offline-evolution.md`
- Modify: `docs/testing/2026-09-06-application-skill-evolution-regression.md`
- Create: `docs/testing/2026-09-06-job-recommendation-and-skill-evolution-final-report.md`

**Interfaces:**
- Verifies: every approved requirement, backward compatibility, privacy boundary, deterministic selection/evaluation, no final-submit regression, and deployable rollback evidence.

- [ ] **Step 1: Run static hygiene and changed-file review**

Run:

```powershell
rtk git diff --check
rtk rg -n "Profile fact|education\[|approvalToken|rawDom|document\.querySelector|kind: [\"']submit" packages/contracts/src apps/api/src apps/web/src
rtk git diff --stat
```

Expected: `git diff --check` exits 0; each search hit is either an explicit rejection/privacy test or an existing audited boundary, documented in the final report.

- [ ] **Step 2: Run the complete automated test matrix**

Run:

```powershell
rtk corepack pnpm --filter @resume/contracts test -- --run
rtk corepack pnpm --filter @resume/job-matching test -- --run
rtk corepack pnpm --filter @resume/api test -- --run
rtk corepack pnpm --filter @resume/web test -- --run
rtk corepack pnpm --filter @resume/synthetic-ats test -- --run
rtk corepack pnpm test:e2e -- tests/browser/conversation-job-match-flow.spec.ts tests/browser/application-skill-runtime.spec.ts tests/browser/application-skill-offline-evolution.spec.ts tests/browser/application-skill-evolution.spec.ts
rtk corepack pnpm build
```

Expected: every command exits 0 with exact test counts captured; no application submission occurs.

- [ ] **Step 3: Perform adversarial manual browser checks**

Use the local app and synthetic ATS to inspect: top-six card order and inline Chinese explanations; Moka/DJI/Baidu matched flows; ambiguous and unmatched handoff; stale node/reload recovery; Challenger pinning; hard-failure rollback; and final-review confirmation. Capture screenshots and verify the ATS submission counter stays at zero after every case.

- [ ] **Step 4: Request code review and resolve findings with focused RED/GREEN tests**

Review specifically for capability expansion, holdout leakage, PII retention, mutable version data, non-atomic promotion, unstable allocation, evaluator configurability, bypassed readback/audit, and accidental terminal submission. For each accepted finding, add a focused failing test, implement the minimum correction, rerun that package and the affected browser scenario, and append the evidence to the final report.

- [ ] **Step 5: Commit final verification evidence**

```powershell
rtk git add docs/testing/2026-09-06-explainable-job-recommendation-regression.md docs/testing/2026-09-06-application-skill-runtime-regression.md docs/testing/2026-09-06-application-skill-offline-evolution.md docs/testing/2026-09-06-application-skill-evolution-regression.md docs/testing/2026-09-06-job-recommendation-and-skill-evolution-final-report.md
rtk git commit -m "docs: record recommendation and skill evolution verification"
```

## Final Acceptance Checklist

- [ ] Recommendation results are sorted once by displayed percentage, limited to six, and persisted without breaking legacy sessions.
- [ ] Collapsed cards expose only the approved five elements; expanded content is understandable Chinese and contains the score formula and per-dimension contribution.
- [ ] Every production Skill is immutable, site/page scoped, capability-bounded, parent-non-expanding, and unable to submit.
- [ ] One task remains pinned to one version; unmatched or quarantined Skills stop before writes and produce a user-visible safe handoff.
- [ ] Execution evidence is append-only, first-error attributed, useful for replay, and free of profile values, approval secrets, raw DOM, and query tokens.
- [ ] Training and holdout samples are deterministically separated; the model never sees holdout data or evaluator/release internals.
- [ ] Offline qualification precedes live traffic and compares Champion/candidate on identical deterministic inputs.
- [ ] Challenger allocation is stable at 10%; promotion needs at least ten eligible runs and a favorable 95% interval; fifty inconclusive runs stop the experiment.
- [ ] Any safety violation, incorrect write, or new audit mismatch immediately quarantines the Challenger and atomically restores the stable Champion.
- [ ] Existing action policy, browser ownership, NodeRef/snapshot/epoch checks, double readback, full-page audit, navigation detection, and final-submit confirmation remain green.
- [ ] Full package tests, production build, and all four browser scenarios pass with zero synthetic or real submissions.
