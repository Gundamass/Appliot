# Lightweight Semantic Application Routing Design

## Problem

Direct application messages currently fail in three connected ways:

- a pasted URL can absorb immediately following prose because URL extraction reads until whitespace;
- the deterministic router recognizes only a small set of filling phrases, while the DeepSeek classifier is instructed not to return URLs even though an `application_url` target requires one;
- conversation-created application tasks use a `conversation-application-*` identifier, while application HTTP routes and response contracts require UUIDs. The task row is created and rendered in chat, but `/api/applications` and `/api/applications/:id` fail when they parse it.

The product should understand varied natural-language requests without adding a new keyword rule for every wording, while keeping the set of executable modules fixed and auditable.

## Goals

- Keep the interaction lightweight: no mention system, URL chips, or message protocol expansion.
- Make pasted URLs and following prose unambiguous in the common input path.
- Let DeepSeek classify varied wording into the existing fixed intent set.
- Keep URL and task identifier authority in deterministic backend code.
- Ensure a task reported as created can be listed, loaded by ID, and opened in the filling workspace.
- Preserve the existing confirmation gate before controlled filling begins.

## Non-goals

- DeepSeek does not choose tools, execute routes, generate URLs, or create database identifiers.
- This change does not add a free-running intent Agent or a ReAct loop. Intent classification remains one bounded structured-generation call.
- This change does not introduce `@` references or structured message attachments.
- This change does not automatically submit an application.

## Design

### 1. Paste-time URL separation

`ConversationComposer` handles paste events. When the clipboard's trimmed plain text is exactly one valid HTTP or HTTPS URL, the composer inserts that original clipboard text followed by one ASCII space at the current selection. It preserves text before and after the selection and restores the caret after the inserted space.

Ordinary text, mixed clipboard content, and non-web protocols keep native paste behavior. The 500-character message limit is still enforced. This is a convenience and accuracy improvement, not a backend correctness boundary.

### 2. Deterministic extraction, semantic classification, deterministic binding

The conversation graph extracts at most one HTTPS URL before model classification. It then replaces the exact extracted occurrence in the model-visible user message with the literal placeholder `[URL]`.

DeepSeek receives a compact classifier prompt that:

- enumerates the existing `ConversationIntentKindSchema` routes and their meanings;
- asks only for a route, target kind/reference metadata that does not contain a URL, and whether confirmation is required;
- distinguishes application filling from recruitment-site discovery and job recommendation;
- treats questions and indirect wording according to their semantic goal rather than a phrase allowlist.

After structured output validation, deterministic backend code binds the previously extracted URL when the model selected `start_application`. The model cannot copy, normalize, edit, or invent a URL. Existing public-HTTPS validation and confirmation creation remain authoritative.

The deterministic fast paths remain for confirmation messages, explicit indexed recommendation actions, help, and other high-confidence commands. The small filling-phrase predicate no longer acts as the extensibility mechanism for arbitrary URL-bearing prose.

### 3. Missing and ambiguous URLs

- If the classifier selects application filling and one URL was extracted, bind it and request confirmation.
- If application filling is selected without a URL, resolve an existing selected recommendation/application context when available; otherwise ask the user to provide a page or select a job.
- A bare URL with no semantic purpose continues to ask whether it is for filling or job recommendation.
- Multiple URLs remain ambiguous and cause clarification rather than silent selection.
- If DeepSeek is unavailable or returns invalid output, existing deterministic behavior remains the fallback and performs no new side effect.

### 4. Application task identity

New conversation-created tasks use a deterministic RFC 4122 UUID derived from the existing idempotency material (`conversationId` plus result ID or normalized application URL). Version and variant bits are set explicitly, so retries return the same UUID and satisfy application API contracts.

For previously created `conversation-application-<32 hex>` rows, application request and response schemas accept only that exact legacy shape in addition to UUIDs. This narrow compatibility path makes existing rows listable and loadable without rewriting foreign references or deleting user data. No other arbitrary identifier form is accepted. New writes never emit the legacy form.

### 5. Fixed module boundary

The model-selected intent is mapped through the existing deterministic conversation graph routes. Schema validation, target resolution, confirmation state, URL policy, application task creation, browser ownership, and execution remain outside the model. Trace events record whether classification used a deterministic fast path, structured DeepSeek output, clarification, or fallback.

## Failure handling

- Paste enhancement failure falls back to normal input behavior; it cannot trigger an action.
- Invalid or unsupported URLs produce clarification or validation errors before task creation.
- Invalid model output is recorded and falls back to the non-side-effecting deterministic result.
- Task creation is not considered successful until the created identifier can be projected through `ApplicationTaskSchema` and read through the application service.

## Testing

### Boundary set

- Paste a URL, then type Chinese immediately: the submitted message contains a separating space.
- Send `投递<URL>这个页面可以投递吗` and equivalent varied wording: DeepSeek chooses application filling and backend binds the extracted URL without model-generated URL data.
- Send recommendation wording with a URL: it stays on the recruitment/job-matching path.
- Send a bare URL, no URL, two URLs, malformed URL, or an unsupported protocol: no unintended filling task is created.
- Force DeepSeek timeout and invalid structured output: deterministic fallback remains safe.
- Create a direct-URL task: its ID is a UUID, repeated creation is idempotent, list returns 200, detail returns 200, and the returned ID is unchanged end to end.
- Seed an exact legacy `conversation-application-<32 hex>` task: list and detail remain readable; unrelated non-UUID IDs are rejected.

### Retention set

- Existing indexed recommendation selection and confirmation still create UUID tasks.
- Existing recruitment-site discovery and job recommendation flows remain unchanged.
- Existing filling phrases, confirmation copy, cancellation behavior, and browser safety gates continue to pass.
- The conversation composer still submits ordinary text, preserves selection replacement, respects max length, and does not alter mixed clipboard content.

### End-to-end acceptance

Run API and web integration tests, then use the real local frontend and API to:

1. paste a real application URL and add prose;
2. verify the response asks for filling confirmation rather than listing recommendations;
3. approve the confirmation;
4. verify `/api/applications` and `/api/applications/:id` both return 200;
5. open the task card and verify the filling workspace loads the same task.

