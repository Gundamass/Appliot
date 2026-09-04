# 岗位推荐百分比与前六结果 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将岗位推荐页面和对话推荐卡片改为显示匹配度百分比，并在后端和前端最多保留最符合的前六条。

**Architecture:** 复用现有 `fitScore`（0–100）作为百分比值，不改变评分算法。岗位匹配子图继续负责排序和推荐集合截断；API 展示层与 Web 卡片组件分别做一致的六条限制，内部完整结果继续保留给冲突校验和审计使用。

**Tech Stack:** TypeScript, React, Vitest, Zod, pnpm workspace.

## Global Constraints

- 百分比来源固定为现有 `fitScore`，显示为四舍五入后的 `匹配度 X%`。
- 页面不得显示“分”或“置信度”。内部字段名称和评分范围不改动。
- 推荐结果最多展示六条；排序继续使用现有 `rankingScore` 主排序和既有稳定排序规则。
- 不触发真实投递，不修改投递提交链路。
- 遵守测试先行：每个行为先增加失败测试，再写生产代码。

---

### Task 1: 后端推荐集合和 API 展示限制

**Files:**
- Modify: `packages/contracts/src/job-matching.ts`
- Test: `apps/api/src/agent/subgraphs/job-matching.test.ts`
- Modify: `apps/api/src/agent/subgraphs/job-matching.ts`
- Test: `apps/api/src/job-matching/job-match-service.test.ts`
- Modify: `apps/api/src/job-matching/job-match-service.ts`
- Test: `apps/api/src/conversations/conversation-tools.test.ts`
- Modify: `apps/api/src/conversations/conversation-tools.ts`

**Interfaces:**
- Consumes: existing `JobMatchResult.fitScore`, `rankingScore`, `JobMatchAggregate.results` and `rankResults` ordering.
- Produces: shared `JOB_RECOMMENDATION_LIMIT = 6`; `recommendedResultIds` and API-facing result cards never exceed six items.

- [ ] **Step 1: Write failing tests for the backend limit.**

  Add a subgraph case with eight non-conflicting postings and assert `jobMatching.recommendedResultIds` has six entries. Add a service presentation case with eight stored results and assert `service.get(sessionId).results` has six results in descending ranking order. Add a conversation-tool case asserting list/create recommendation cards are capped at six.

- [ ] **Step 2: Run the focused backend tests and verify they fail for the missing limit.**

  Run:

  ```bash
  rtk corepack pnpm --filter @resume/api exec vitest run src/agent/subgraphs/job-matching.test.ts src/job-matching/job-match-service.test.ts src/conversations/conversation-tools.test.ts
  ```

  Expected: the new assertions fail because the current code exposes all ranked results (and the conversation creation path currently slices at 18).

- [ ] **Step 3: Add the shared limit and apply it after existing ranking.**

  Export `JOB_RECOMMENDATION_LIMIT = 6` from `packages/contracts/src/job-matching.ts`. In the matching subgraph, apply `.slice(0, JOB_RECOMMENDATION_LIMIT)` only to ranked non-conflict recommendation IDs. In `present()` and the conversation tool result builders, sort with the existing ranking fields and slice to the same limit. Keep the repository’s full result set intact for stale detection and guarded selection.

- [ ] **Step 4: Run the focused backend tests and verify they pass.**

  Re-run the command from Step 2. Expected: all focused backend tests pass with zero failures.

- [ ] **Step 5: Run backend type checking.**

  ```bash
  rtk corepack pnpm --filter @resume/api typecheck
  ```

  Expected: exit code 0.

### Task 2: Web recommendation percentage and six-card fallback

**Files:**
- Test: `apps/web/src/conversation/ConversationJobCards.test.tsx`
- Modify: `apps/web/src/conversation/ConversationJobCards.tsx`
- Test: `apps/web/src/conversation/ConversationCards.test.tsx`
- Modify: `apps/web/src/conversation/ConversationCards.tsx`

**Interfaces:**
- Consumes: `JobMatchSession.results`, `JobMatchResult.fitScore`, and `JOB_RECOMMENDATION_LIMIT` from `@resume/contracts`.
- Produces: visible labels `匹配度 X%`; at most six rendered recommendation cards while retaining existing selection and conflict-confirmation actions.

- [ ] **Step 1: Write failing Web tests.**

  Extend the `ConversationJobCards` fixture with more than six results and assert exactly six job articles render, the first card contains `匹配度 91%`, and the card does not contain `分` or `置信度`. Add a `ConversationCards` recommendation-card test that asserts an internal `score: 83` renders as `匹配度 83%` and not as a score label.

- [ ] **Step 2: Run the focused Web tests and verify they fail for the current UI.**

  ```bash
  rtk corepack pnpm --filter @resume/web exec vitest run src/conversation/ConversationJobCards.test.tsx src/conversation/ConversationCards.test.tsx
  ```

  Expected: the current card shows `分` and `置信度`, and the six-result assertion fails when the fixture has more than six results.

- [ ] **Step 3: Implement the minimum UI changes.**

  Import `JOB_RECOMMENDATION_LIMIT`. In `ConversationJobCards`, preserve the current recommendation-first/conflict ordering and apply `.slice(0, JOB_RECOMMENDATION_LIMIT)` as a render fallback. Replace the score header with `匹配度 {Math.round(result.fitScore)}%` and remove the confidence element. In `RecommendationCard`, render `匹配度 {Math.round(card.score)}%`.

- [ ] **Step 4: Run the focused Web tests and verify they pass.**

  Re-run the command from Step 2. Expected: all focused Web tests pass with zero failures.

- [ ] **Step 5: Run Web type checking.**

  ```bash
  rtk corepack pnpm --filter @resume/web typecheck
  ```

  Expected: exit code 0.

### Task 3: Full regression and live UI verification

**Files:**
- Verify: `packages/contracts/src/job-matching.ts`
- Verify: `apps/api/src/agent/subgraphs/job-matching.ts`
- Verify: `apps/api/src/job-matching/job-match-service.ts`
- Verify: `apps/api/src/conversations/conversation-tools.ts`
- Verify: `apps/web/src/conversation/ConversationJobCards.tsx`
- Verify: `apps/web/src/conversation/ConversationCards.tsx`

**Interfaces:**
- Consumes: the completed backend and Web behavior from Tasks 1–2.
- Produces: evidence that the complete repository test suites, type checks, build, services, and browser flow remain healthy.

- [ ] **Step 1: Run package test suites.**

  ```bash
  rtk corepack pnpm --filter @resume/job-matching test
  rtk corepack pnpm --filter @resume/browser-worker test
  rtk corepack pnpm --filter @resume/api test
  rtk corepack pnpm --filter @resume/web test
  ```

  Expected: every test file passes and every test reports zero failures.

- [ ] **Step 2: Run all type checks and the API build.**

  ```bash
  rtk corepack pnpm --filter @resume/job-matching typecheck
  rtk corepack pnpm --filter @resume/browser-worker typecheck
  rtk corepack pnpm --filter @resume/api typecheck
  rtk corepack pnpm --filter @resume/web typecheck
  rtk corepack pnpm --filter @resume/api build
  rtk git diff --check
  ```

  Expected: every command exits with code 0 and `git diff --check` is empty.

- [ ] **Step 3: Restart services and verify health endpoints.**

  ```bash
  rtk powershell -NoProfile -Command '& .\\scripts\\service-control.ps1 restart'
  rtk powershell -NoProfile -Command 'Invoke-WebRequest -UseBasicParsing http://127.0.0.1:43120/api/health/adapters'
  rtk powershell -NoProfile -Command 'Invoke-WebRequest -UseBasicParsing http://localhost:5173/'
  ```

  Expected: API health and frontend return HTTP 200 and service status reports API/Worker/frontend ready.

- [ ] **Step 4: Run the browser flow without submitting an application.**

  Use a fresh conversation to confirm a recruitment entry, start job recommendation, confirm filters, and inspect the result panel. Verify the panel contains no score/confidence labels, contains at most six recommendation cards, and displays `匹配度 X%`. Do not click any `开始投递` button.
