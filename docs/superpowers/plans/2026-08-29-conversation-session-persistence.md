# Conversation Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the most recent chat conversation across refreshes without changing backend conversation, job matching, or controlled application behavior.

**Architecture:** `ProfileApplicationWorkspace` selects a candidate conversation ID from the URL query string or local storage and keeps successful IDs in both places. `ChatHome` loads that ID first, creates a session only when no ID exists or the supplied session returns HTTP 404, and reports its resolved ID back to the workspace.

**Tech Stack:** React 19, React Router 7, TypeScript, Vitest, Testing Library.

## Global Constraints

- Keep the existing API contract and SQLite persistence unchanged.
- Preserve `view` query parameters while adding `conversation`.
- Treat only HTTP 404 as a stale conversation; surface all other load failures without creating a replacement.
- Do not add recruitment status tracking or change job matching and controlled application flows.

---

### Task 1: Restore Or Create a Conversation in ChatHome

**Files:**
- Modify: `apps/web/src/conversation/ChatHome.tsx`
- Test: `apps/web/src/conversation/ChatHome.test.tsx`

**Interfaces:**
- Consumes: `ConversationApi.get(id)`, `ConversationApi.create()`, and `ConversationApiError.status`.
- Produces: optional `initialSessionId?: string` and `onSessionResolved?(id: string): void` properties on `ChatHomeProps`.

- [x] **Step 1: Write the failing tests**

```tsx
it("restores an existing requested conversation without creating a replacement", async () => {
  const api = fakeConversationApi(viewFor("conversation-restored"));
  render(<ChatHome api={api} initialSessionId="conversation-restored" onOpenJobMatch={vi.fn()} onOpenApplication={vi.fn()} />);
  await screen.findByText("restored history");
  expect(api.get).toHaveBeenCalledWith("conversation-restored");
  expect(api.create).not.toHaveBeenCalled();
});

it("creates one replacement only when the requested conversation is missing", async () => {
  const api = fakeConversationApi(view());
  vi.mocked(api.get).mockRejectedValueOnce(new ConversationApiError("missing", "conversation_not_found", 404));
  render(<ChatHome api={api} initialSessionId="stale-id" onOpenJobMatch={vi.fn()} onOpenApplication={vi.fn()} />);
  await screen.findByText("new history");
  expect(api.create).toHaveBeenCalledOnce();
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `rtk corepack pnpm --filter @resume/web test -- src/conversation/ChatHome.test.tsx`

Expected: the restored-case assertion fails because the current component always calls `api.create()`.

- [x] **Step 3: Implement the smallest load-state change**

```tsx
interface ChatHomeProps {
  initialSessionId?: string;
  onSessionResolved?(id: string): void;
}

async function loadView(api: ConversationApi, initialSessionId?: string) {
  if (initialSessionId !== undefined) {
    try { return await api.get(initialSessionId); }
    catch (error) {
      if (!(error instanceof ConversationApiError && error.status === 404)) throw error;
    }
  }
  const created = await api.create();
  return api.get(created.id);
}
```

Keep a cancellation guard in the effect so a stale response cannot replace a newly requested conversation. Call `onSessionResolved` only after a successful view load.

- [x] **Step 4: Run the tests to verify they pass**

Run: `rtk corepack pnpm --filter @resume/web test -- src/conversation/ChatHome.test.tsx`

Expected: the added restore, stale-ID fallback, and existing chat tests pass.

### Task 2: Persist and Canonicalize the Conversation Identifier in the Workspace

**Files:**
- Modify: `apps/web/src/workspace/ProfileApplicationWorkspace.tsx`
- Test: `apps/web/src/workspace/ProfileApplicationWorkspace.test.tsx`

**Interfaces:**
- Consumes: `ChatHome.initialSessionId` and `ChatHome.onSessionResolved` from Task 1.
- Produces: `conversation` URL search parameter and local-storage key `resume-application-assistant.recent-conversation-id`.

- [x] **Step 1: Write the failing tests**

```tsx
it("restores the locally remembered conversation and canonicalizes its URL", async () => {
  window.localStorage.setItem("resume-application-assistant.recent-conversation-id", "conversation-1");
  const api = conversationApi();
  render(<BrowserRouter><ProfileApplicationWorkspace {...props} conversationApi={api} /></BrowserRouter>);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith("conversation-1"));
  expect(api.create).not.toHaveBeenCalled();
  expect(new URLSearchParams(window.location.search).get("conversation")).toBe("conversation-1");
});
```

Add a second test that starts at `/?conversation=conversation-from-url` while local storage contains a different ID and asserts that the URL ID wins.

- [x] **Step 2: Run the tests to verify they fail**

Run: `rtk corepack pnpm --filter @resume/web test -- src/workspace/ProfileApplicationWorkspace.test.tsx`

Expected: the current workspace ignores local storage and still calls `api.create()`.

- [x] **Step 3: Implement workspace persistence**

```tsx
const conversationId = searchParams.get("conversation") ?? readRecentConversationId();
const rememberConversation = useCallback((id: string) => {
  writeRecentConversationId(id);
  setSearchParams((current) => {
    const next = new URLSearchParams(current);
    next.set("conversation", id);
    return next;
  }, { replace: true });
}, [setSearchParams]);
```

Use `try/catch` around local-storage access so browser privacy settings do not break chat startup. Pass `conversationId` and `rememberConversation` to `ChatHome`.

- [x] **Step 4: Run the tests to verify they pass**

Run: `rtk corepack pnpm --filter @resume/web test -- src/workspace/ProfileApplicationWorkspace.test.tsx`

Expected: the persisted-ID and URL-priority tests pass with the existing workspace tests.

### Task 3: Verify the Combined Regression Surface

**Files:**
- Verify only: `apps/web/src/conversation/ChatHome.test.tsx`
- Verify only: `apps/web/src/workspace/ProfileApplicationWorkspace.test.tsx`
- Verify only: `apps/web/src/router.test.tsx`

**Interfaces:**
- Consumes: completed Tasks 1 and 2.
- Produces: evidence that restored conversation history, context, routing, and existing chat flows remain compatible.

- [x] **Step 1: Run the focused web suite**

Run: `rtk corepack pnpm --filter @resume/web test`

Expected: all web test files pass with zero failures.

- [x] **Step 2: Run static verification**

Run: `rtk corepack pnpm --filter @resume/web typecheck`

Expected: TypeScript exits with code 0.

- [x] **Step 3: Inspect the final diff**

Run: `rtk git diff --check`

Expected: no whitespace errors and no unrelated files changed by this task.
