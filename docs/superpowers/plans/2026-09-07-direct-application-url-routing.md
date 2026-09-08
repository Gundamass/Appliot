# Direct Application URL Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route explicit form-filling URLs into a confirmation-gated controlled application task instead of job recommendation.

**Architecture:** Extend the bounded conversation contract with an `application_url` target, give explicit filling language precedence over stale recruitment context, and reuse the existing `start_application` confirmation boundary. Extend the allowlisted conversation application tool to create a Runtime-owned task directly from a validated HTTPS URL.

**Tech Stack:** TypeScript, Zod, LangGraph, React, Vitest, Testing Library, pnpm

## Global Constraints

- Explicit `填写/填表/申请表 + HTTPS URL` routes to controlled filling.
- Explicit recruitment/recommendation wording keeps the recruitment-site flow.
- A bare URL asks for purpose and performs no side effect.
- Historical recruitment context cannot override explicit filling language.
- Task creation is confirmation-gated and never submits an application automatically.
- Preserve unrelated changes in the dirty worktree.

---

### Task 1: Bound direct application URL contracts

**Files:**
- Modify: `packages/contracts/src/conversation.ts`
- Test: `packages/contracts/src/conversation.test.ts`

**Interfaces:**
- Produces: `ConversationTarget` and `ConversationConfirmation` variants with `{ kind: "application_url"; url: string }`.
- Consumes: the existing `start_application` intent and confirmation action.

- [x] **Step 1: Write failing contract tests**

Add assertions equivalent to:

```ts
expect(ConversationIntentSchema.parse({
  kind: "start_application",
  target: { kind: "application_url", url: "https://jobs.example.com/apply/123" },
  requiresConfirmation: true
})).toMatchObject({ target: { kind: "application_url" } });

expect(ConversationConfirmationSchema.parse({
  confirmationId: "confirmation-application-url",
  action: "start_application",
  target: { kind: "application_url", url: "https://jobs.example.com/apply/123" }
})).toMatchObject({ target: { kind: "application_url" } });

expect(() => ConversationIntentSchema.parse({
  kind: "start_application",
  target: { kind: "application_url", url: "http://jobs.example.com/apply/123" },
  requiresConfirmation: true
})).toThrow();
```

- [x] **Step 2: Verify RED**

Run: `corepack pnpm --filter @resume/contracts test -- conversation.test.ts`

Expected: FAIL because `application_url` is not an allowed target.

- [x] **Step 3: Implement the bounded schema**

Add an HTTPS-only `ApplicationUrlTargetSchema`, include `application_url` in `ConversationTargetKindSchema`, allow only `url` on that target, and include it in the `start_application` confirmation target union and card refinement.

- [x] **Step 4: Verify GREEN**

Run: `corepack pnpm --filter @resume/contracts test -- conversation.test.ts`

Expected: PASS.

### Task 2: Create controlled application tasks from direct URLs

**Files:**
- Modify: `apps/api/src/conversations/conversation-tools.ts`
- Test: `apps/api/src/conversations/conversation-tools.test.ts`

**Interfaces:**
- Consumes: `{ applicationUrl: string }` as an alternative input to `create_application_task`.
- Produces: the existing `ConversationToolResult` with `task` and an `application_task` card.

- [x] **Step 1: Write failing tool tests**

Invoke `create_application_task` with `{ applicationUrl: "https://jobs.example.com/apply/123" }` and assert:

```ts
expect(create).toHaveBeenCalledWith(expect.objectContaining({
  applicationUrl: "https://jobs.example.com/apply/123"
}));
expect(startApplication).toHaveBeenCalledWith(expect.objectContaining({
  applicationUrl: "https://jobs.example.com/apply/123"
}));
expect(result.cards[0]).toMatchObject({
  type: "application_task",
  applicationUrl: "https://jobs.example.com/apply/123"
});
```

Repeat the invocation and assert the repository receives the same deterministic task ID.

- [x] **Step 2: Verify RED**

Run: `corepack pnpm --filter @resume/api test -- conversation-tools.test.ts`

Expected: FAIL because the tool accepts recommendation identifiers only.

- [x] **Step 3: Implement the direct URL branch**

Change the tool input to a strict union of the current recommendation payload and `{ applicationUrl: HttpsUrlSchema }`. For a direct URL, derive the task ID from the conversation ID and normalized URL, call the existing idempotent `applicationTasks.createFromJob`, start `applicationService`, and return the existing task card.

- [x] **Step 4: Verify GREEN**

Run: `corepack pnpm --filter @resume/api test -- conversation-tools.test.ts`

Expected: PASS.

### Task 3: Route explicit filling language ahead of recruitment context

**Files:**
- Modify: `apps/api/src/conversations/conversation-graph.ts`
- Modify: `apps/api/src/agent/intent/intent-understanding.ts`
- Test: `apps/api/src/conversations/conversation-graph.test.ts`
- Test: `apps/api/src/agent/intent/intent-understanding.test.ts`

**Interfaces:**
- Consumes: `start_application` with target `{ kind: "application_url"; url }`.
- Produces: a validated direct-URL confirmation and, after approval, an application task card and `activeApplicationTaskId` context patch.

- [x] **Step 1: Write failing routing tests**

Create a context containing `lastRecruitmentRequest`, send `填写 https://jobs.example.com/apply/123`, and assert:

```ts
expect(response.message.intent).toMatchObject({
  kind: "start_application",
  target: { kind: "application_url", url: "https://jobs.example.com/apply/123" }
});
expect(response.pendingConfirmation?.target).toMatchObject({ kind: "application_url" });
expect(searchRecruitmentSites).not.toHaveBeenCalled();
expect(createJobMatchSession).not.toHaveBeenCalled();
```

Send a bare URL and assert the response asks `你想填写这个申请页面，还是用它进行岗位推荐？`, has no pending confirmation, and invokes no side-effect dependency. Add intent-understanding coverage proving `填写` sets the application goal and extracts the URL.

- [x] **Step 2: Verify RED**

Run: `corepack pnpm --filter @resume/api test -- conversation-graph.test.ts intent-understanding.test.ts`

Expected: FAIL with the current `discover_recruitment_site` routing.

- [x] **Step 3: Implement deterministic precedence and confirmation execution**

Add focused predicates for filling and recruitment wording. Before the historical manual recruitment URL branch, emit `start_application` with an `application_url` target for explicit filling. For a bare URL, persist the purpose clarification without side effects. Validate direct URLs with `validatePublicHttpsUrl`, create a `start_application` confirmation, resolve that target on approval, and invoke `create_application_task` with `{ applicationUrl }`. Extend application intent extraction with `填写|填表|申请表|填写申请`.

- [x] **Step 4: Verify GREEN**

Run: `corepack pnpm --filter @resume/api test -- conversation-graph.test.ts intent-understanding.test.ts`

Expected: PASS.

### Task 4: Render direct filling confirmation and run regression checks

**Files:**
- Modify: `apps/web/src/conversation/ConversationCards.tsx`
- Test: `apps/web/src/conversation/ConversationCards.test.tsx`

**Interfaces:**
- Consumes: a `start_application` confirmation card with an `application_url` target.
- Produces: filling-specific copy while preserving recommendation confirmation copy.

- [x] **Step 1: Write the failing component test**

Render a direct URL confirmation and assert:

```ts
expect(screen.getByText("准备开始识别并填写")).toBeInTheDocument();
expect(screen.getByText("https://jobs.example.com/apply/123")).toBeInTheDocument();
await user.click(screen.getByRole("button", { name: /确认开始填写/ }));
expect(onConfirm).toHaveBeenCalledWith("confirmation-1", true, undefined);
```

- [x] **Step 2: Verify RED**

Run: `corepack pnpm --filter @resume/web test -- ConversationCards.test.tsx`

Expected: FAIL with recommendation-oriented copy.

- [x] **Step 3: Implement direct filling copy**

Branch `confirmationCopy` on `card.target.kind === "application_url"` and return the approved title, URL target, and filling-specific button labels.

- [x] **Step 4: Run focused and workspace verification**

Run:

```text
corepack pnpm --filter @resume/contracts test -- conversation.test.ts
corepack pnpm --filter @resume/api test -- conversation-tools.test.ts conversation-graph.test.ts intent-understanding.test.ts
corepack pnpm --filter @resume/web test -- ConversationCards.test.tsx
corepack pnpm typecheck
```

Expected: all tests and typecheck PASS.

- [x] **Step 5: Perform browser regression**

Start the API and web app using the repository's normal development commands. In one conversation, first trigger a company recommendation request, then send `填写 https://example.com/apply/123`. Verify the UI asks `确认开始填写`, approval opens/creates the application task, and no job recommendation session appears. In a second turn send only `https://example.com/apply/456` and verify the purpose clarification appears without browser automation.
