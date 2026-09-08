# Conversation Session Persistence Design

## Problem

Conversation messages and context are persisted by the API, but the chat client creates a new conversation whenever `ChatHome` mounts. A page refresh or a return to the chat view therefore opens an empty conversation rather than the prior one.

## Decision

Use a conversation ID in the root route query string and persist the most recently resolved ID in browser local storage.

- The canonical URL is `/?conversation=<conversation-id>` and preserves the existing `view` query parameter when present.
- On chat startup, select the URL ID first. If it is absent, use the locally stored most-recent ID. If neither exists, create a new conversation.
- After loading or creating a conversation successfully, write its ID to local storage and canonicalize the URL with `replace` navigation.
- If a remembered conversation returns HTTP 404, remove the stale local ID and create a new conversation. Other API failures remain visible to the user and do not create an accidental replacement conversation.

## Boundaries

- No server schema, route, or conversation payload changes are required.
- Existing job matching, recommendation, and controlled application flows continue to use the loaded conversation context unchanged.
- This change does not add company recruitment status tracking or a conversation history UI.

## Testing

- A saved or URL-provided session loads with `get` and does not call `create`.
- A missing saved session falls back to one new session and records the new ID.
- A non-404 load error remains visible and does not create a new session.
- Existing chat, router, and workspace tests remain green.
