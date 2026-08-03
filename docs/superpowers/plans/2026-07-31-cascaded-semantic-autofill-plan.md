# Cascaded Semantic Autofill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先填写能够确定映射的空字段，再对剩余空字段执行受阈值和结构约束的语义映射，最终聚合风险项交给用户审核。

**Architecture:** 字段注册表提供标准路径、别名和兼容约束；应用服务通过 `deterministic` 与 `semantic` 两个解析阶段驱动现有 RAG，并在每个阶段后使用新页面快照重建待处理字段。语义检索只决定标准路径，档案值仍由现有 RAG 按路径验证；Browser Worker 继续负责受控执行和回读。

**Tech Stack:** TypeScript、Vitest、XState、SQLite、远程 Embedding Provider、React。

## Global Constraints

- 不自动执行任何提交、投递、确认申请或语义等价动作。
- 先写失败测试并确认按预期失败，再写最小实现。
- 已有官网值绝不覆盖；只有当前可见、可编辑且值为空的字段进入补全。
- 敏感承诺和低置信度映射不得自动填写。
- 不修改用户已有无关改动，不创建隔离工作树，不提交 Git。

---

### Task 1: 标准字段注册表与确定性映射

**Files:**
- Create: `packages/form-semantics/src/field-registry.ts`
- Create: `packages/form-semantics/src/field-registry.test.ts`
- Modify: `packages/form-semantics/src/index.ts`
- Modify: `apps/api/src/applications/entry-field-semantics.ts`
- Test: `apps/api/src/applications/entry-field-semantics.test.ts`

**Interfaces:**
- Produces: `FIELD_DEFINITIONS: readonly FieldDefinition[]`
- Produces: `resolveDeterministicSemantic(field: SemanticFieldInput): FieldSemanticMatch | undefined`
- Produces: `semanticContext?: string` on derived application fields by encoding a non-final entry context in the resolver input rather than persisting an unknown field path.

- [ ] **Step 1: Write failing registry tests**

Cover exact aliases such as `个人联系电话 -> basics.phone`, `学校名称 -> education[].institution`, `职位名称 -> work[].position`, and verify that ambiguous labels such as `培养方式` do not become `application.jobSpecific` in the deterministic pass.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm --filter @resume/form-semantics test -- field-registry.test.ts`

Expected: FAIL because the registry exports do not exist.

- [ ] **Step 3: Implement the registry and context materialization**

Use a data-only definition:

```ts
export interface FieldDefinition {
  semantic: string;
  label: string;
  aliases: readonly string[];
  types: readonly SemanticFieldType[];
  sections: readonly FieldSection[];
  risk: "normal" | "sensitive" | "commitment";
  description: string;
}
```

Normalize NFKC, whitespace and ASCII case. Exact alias mapping must also validate field type and materialize `[]` from an existing repeated-entry context; an unresolved repeated index stays unresolved.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm --filter @resume/form-semantics test -- field-registry.test.ts`

Expected: PASS.

### Task 2: 受约束的字段语义检索

**Files:**
- Create: `apps/api/src/applications/field-semantic-resolver.ts`
- Create: `apps/api/src/applications/field-semantic-resolver.test.ts`
- Modify: `apps/api/package.json`

**Interfaces:**
- Consumes: `FIELD_DEFINITIONS`, `EmbeddingProvider`
- Produces: `createFieldSemanticResolver(options): FieldSemanticResolver`
- Produces: `resolve(field, context, phase): Promise<FieldSemanticDecision>` where phase is `deterministic | semantic`

- [ ] **Step 1: Write failing semantic resolver tests**

Tests must prove: deterministic aliases avoid embedding calls; semantic mode returns Top-K candidates; automatic mapping requires minimum similarity, minimum Top-1/Top-2 margin, compatible type and section, and non-commitment risk; an unavailable embedding provider returns unresolved rather than throwing the application task into failure.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm --filter @resume/api test -- field-semantic-resolver.test.ts`

Expected: FAIL because the resolver does not exist.

- [ ] **Step 3: Implement lazy registry embeddings and guarded ranking**

Embed registry descriptions once per resolver instance, cache vectors in memory, calculate cosine similarity locally, and return:

```ts
type FieldSemanticDecision =
  | { status: "mapped"; semantic: string; source: "exact_alias" | "embedding"; confidence: number }
  | { status: "review"; candidates: FieldSemanticCandidate[]; reason: string }
  | { status: "unresolved"; reason: string };
```

Thresholds are constructor options with conservative defaults and tests; no model-reported confidence is accepted.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm --filter @resume/api test -- field-semantic-resolver.test.ts`

Expected: PASS.

### Task 3: 两阶段级联应用编排

**Files:**
- Modify: `apps/api/src/applications/application-service.ts`
- Modify: `apps/api/src/applications/application-machine.ts`
- Test: `apps/api/src/applications/application-machine.test.ts`

**Interfaces:**
- Modify: `resolveField(taskId, field, phase)` where phase is `deterministic | semantic`
- Extend internal `FieldResolution.status` with `deferred`

- [ ] **Step 1: Write failing orchestration tests**

Add independent tests proving:

```text
one unknown field does not block a verified field
deterministic fields are filled before semantic fallback is requested
semantic phase receives only fields still empty after the first pass
newly appeared fields enter the bounded next pass
questions are emitted only after safe verified fields are applied
existing values are never overwritten
terminal submit remains untouched
```

- [ ] **Step 2: Run the focused test file and verify RED**

Run: `pnpm --filter @resume/api test -- application-machine.test.ts`

Expected: FAIL on the new ordering assertions.

- [ ] **Step 3: Extract a bounded pass runner**

Implement a private pass helper that resolves currently empty fields, applies only verified non-review decisions, updates the current snapshot after every command, and returns deferred/questions/content-review/blocked decisions without pausing early. Run deterministic once, then semantic only when empty eligible fields remain; allow at most one additional dynamic semantic rescan.

- [ ] **Step 4: Permit filling to hand off to questions or content review**

Add `QUESTIONS_REQUIRED` and `CONTENT_REVIEW_REQUIRED` transitions from `filling`. Convert unresolved or blocked residual fields into grouped human handoff after safe fills instead of failing the whole task.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm --filter @resume/api test -- application-machine.test.ts`

Expected: PASS.

### Task 4: Production RAG composition

**Files:**
- Modify: `apps/api/src/production-dependencies.ts`
- Modify: `apps/api/src/production-dependencies.test.ts`
- Modify: `packages/rag/src/planner.ts`
- Test: `packages/rag/src/rag-loop.test.ts`

**Interfaces:**
- Consumes: `FieldSemanticResolver`, existing `RagService`
- Produces: phase-aware production `resolveField`

- [ ] **Step 1: Write failing production composition tests**

Prove that deterministic unknown fields return `deferred`; semantic matches pass their canonical path into `ragService.resolveField`; exact verified facts fill; missing facts become questions; sensitive and commitment mappings cannot become automatic decisions.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm --filter @resume/api test -- production-dependencies.test.ts`

Expected: FAIL on phase-aware resolution.

- [ ] **Step 3: Wire the resolver before value RAG**

Replace `semanticForField` fallback behavior with the field semantic resolver. Keep `semanticForField` only as a compatibility helper for confirmed task answers until all stored paths are migrated. Extend supported RAG roots for newly registered profile sections without making them auto-fill eligible when their risk is sensitive or unknown.

- [ ] **Step 4: Run API and RAG tests and verify GREEN**

Run: `pnpm --filter @resume/api test -- production-dependencies.test.ts`

Run: `pnpm --filter @resume/rag test -- rag-loop.test.ts safety-review.test.ts`

Expected: PASS.

### Task 5: 投递阶段与风险聚焦界面

**Files:**
- Modify: `packages/contracts/src/application.ts`
- Modify: `packages/contracts/src/application.test.ts`
- Modify: `apps/api/src/applications/application-progress.ts`
- Modify: `apps/web/src/applications/ApplicationTaskPage.tsx`
- Modify: `apps/web/src/applications/ApplicationTaskPage.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Add display phases: `deterministic_fill`, `semantic_fill`, `dynamic_validation`, `review_handoff`
- Preserve existing task state API compatibility

- [ ] **Step 1: Write failing contract and UI tests**

Verify concise stage labels, count summaries and a focused attention list for semantic-review, sensitive, converted and unresolved fields. Do not render a verbose event log by default.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm --filter @resume/web test -- ApplicationTaskPage.test.tsx`

Expected: FAIL because the new phases are absent.

- [ ] **Step 3: Implement the compact work-focused task UI**

Use a four-stage horizontal/stacking progress indicator, one current-action line and one attention list. Keep controls icon-led with Lucide, cards limited to true review items, responsive constraints for 320px and desktop widths, and no marketing hero or nested cards.

- [ ] **Step 4: Run UI tests and verify GREEN**

Run: `pnpm --filter @resume/web test -- ApplicationTaskPage.test.tsx`

Expected: PASS.

### Task 6: Synthetic ATS and regression verification

**Files:**
- Modify: `apps/synthetic-ats/`
- Modify: `tests/browser/mokahr-high-coverage.spec.ts`
- Create: `tests/browser/cascaded-semantic-autofill.spec.ts`

**Interfaces:**
- Consumes: completed cascade and UI contracts

- [ ] **Step 1: Add a failing mixed-confidence ATS scenario**

Include exact aliases, one semantic-only alias, one dynamic field, one website-specific question and a terminal submit button with a server-side submission counter.

- [ ] **Step 2: Run E2E and verify RED**

Run: `pnpm exec playwright test tests/browser/cascaded-semantic-autofill.spec.ts`

Expected: FAIL before synthetic fixture support is complete.

- [ ] **Step 3: Complete the fixture and assertions**

Assert deterministic values appear before semantic values, unknown questions do not block safe fields, dynamic fields are revisited, all applied values read back correctly, review handoff occurs, and submission count remains zero.

- [ ] **Step 4: Run full verification**

Run: `pnpm --filter @resume/form-semantics test`

Run: `pnpm --filter @resume/api test`

Run: `pnpm --filter @resume/web test`

Run: `pnpm typecheck`

Run: `pnpm --filter @resume/api build`

Run: `pnpm exec playwright test tests/browser/mokahr-high-coverage.spec.ts tests/browser/cascaded-semantic-autofill.spec.ts`

Run: `git diff --check`

Expected: all commands exit with code 0 and the submission counter remains zero.
