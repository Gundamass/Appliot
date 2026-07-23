# DeepSeek Configuration and Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split structured generation from embeddings, load production configuration from `.env.local`, and provide a validated, retry-bounded DeepSeek structured-generation adapter.

**Architecture:** `@resume/model-provider` owns narrow provider contracts and the DeepSeek HTTP client. `apps/api/src/config.ts` converts an injected environment map into core and optional adapter groups; Node loads the root `.env.local` before the API entrypoint runs. Domain callers supply both a Zod schema and a concrete JSON example, while the provider owns JSON mode, timeout, retry, and one-time model escalation.

**Tech Stack:** Node.js 24.14.1+, TypeScript 5.8, pnpm 10.13.1, Vitest 3.2, Zod 3.25, native `fetch` and `AbortController`, DeepSeek OpenAI-compatible Chat Completions API

## Global Constraints

- Do not read, print, snapshot, or log the real root `.env.local` in tests.
- Keep `DEEPSEEK_API_KEY` and all future service tokens out of errors, health payloads, and request logs.
- Use `https://api.deepseek.com`, `deepseek-v4-flash`, and `deepseek-v4-pro` as defaults.
- Send `thinking: { type: "disabled" }`; do not persist or return `reasoning_content`.
- JSON mode prompts must contain the literal word `json` and a concrete output example.
- Empty content is retryable; valid JSON that fails the caller's Zod schema is not accepted.
- Escalate from flash to pro at most once and only after validation-class failures on flash.
- Automated tests use injected `fetch`, sleep, and environment values; they never make paid requests.

---

## File Structure

```text
packages/model-provider/src/provider.ts                 Narrow provider interfaces
packages/model-provider/src/fake-provider.ts            Separate structured and embedding fakes
packages/model-provider/src/deepseek-provider.ts        DeepSeek JSON-mode HTTP adapter
packages/model-provider/src/deepseek-provider.test.ts   Retry, validation, and redaction tests
apps/api/src/config.ts                                  Pure environment parser
apps/api/src/config.test.ts                             Complete/partial/invalid config tests
packages/profile-domain/src/extraction/extract-facts.ts Structured caller with JSON example
packages/rag/src/self-evaluation.ts                     Structured caller with JSON example
apps/api/package.json                                   `.env.local` production start command
```

### Task 1: Split provider contracts and migrate all callers

**Files:**
- Modify: `packages/model-provider/src/provider.ts`
- Modify: `packages/model-provider/src/fake-provider.ts`
- Modify: `packages/model-provider/src/fake-provider.test.ts`
- Modify: `packages/model-provider/src/index.ts`
- Modify: `packages/profile-domain/src/extraction/extract-facts.ts`
- Modify: `packages/profile-domain/src/extraction/extract-facts.test.ts`
- Modify: `packages/rag/src/types.ts`
- Modify: `packages/rag/src/retriever.ts`
- Modify: `packages/rag/src/rag-loop.test.ts`
- Modify: `packages/rag/src/safety-review.test.ts`
- Modify: `packages/rag/src/self-evaluation.ts`
- Modify: `packages/rag/src/self-evaluation.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/reviews/review-routes.ts`
- Modify: `apps/api/src/reviews/review-routes.test.ts`

**Interfaces:**
- Produces: `StructuredModelProvider`, `EmbeddingProvider`, `FakeStructuredModelProvider`, and `FakeEmbeddingProvider`.
- Produces: required `jsonExample` on every `StructuredGenerationInput<T>`.
- Consumers: Plans 2-4 use these names directly; do not retain a combined `ModelProvider` alias.

- [ ] **Step 1: Replace the fake-provider tests with failing split-interface tests**

```ts
const ResponseSchema = z.object({ facts: z.array(z.object({ value: z.array(z.string()) })) });

it("keeps structured and embedding fakes independent", async () => {
  const structured = new FakeStructuredModelProvider({ facts: [{ value: ["TypeScript"] }] });
  const embeddings = new FakeEmbeddingProvider([[0.1, 0.2]], [0.9, 0.1]);

  await expect(structured.generateStructured({
    system: "Return json.",
    user: "resume",
    schema: ResponseSchema,
    jsonExample: { facts: [{ value: ["example"] }] }
  })).resolves.toEqual({ facts: [{ value: ["TypeScript"] }] });
  await expect(embeddings.embedDocuments(["resume"])).resolves.toEqual([[0.1, 0.2]]);
  await expect(embeddings.embedQuery("query")).resolves.toEqual([0.9, 0.1]);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `corepack pnpm --filter @resume/model-provider test -- fake-provider.test.ts`

Expected: FAIL because the split interfaces and fake classes do not exist.

- [ ] **Step 3: Define the narrow contracts and fake implementations**

```ts
export interface StructuredGenerationInput<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  jsonExample: unknown;
}

export interface StructuredModelProvider {
  generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T>;
}

export interface EmbeddingProvider {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}
```

Implement `FakeStructuredModelProvider` by cloning and parsing its response. Implement `FakeEmbeddingProvider` with separate document vectors and query vector, returning fresh clones on every call.

- [ ] **Step 4: Migrate structured callers and test doubles**

Use `StructuredModelProvider` in fact extraction, self-evaluation, API app dependencies, and review routes. Add explicit examples:

```ts
const EXTRACTION_JSON_EXAMPLE = {
  facts: [{
    fieldPath: "basics.email",
    value: "candidate@example.com",
    page: 1,
    quote: "candidate@example.com",
    confidence: 0.99
  }]
};
```

```ts
const SELF_EVALUATION_JSON_EXAMPLE = {
  draft: "Original facts restated for the role.",
  reasons: ["Emphasized relevant verified experience."],
  claims: [{ text: "verified experience", kind: "evidence", evidenceFactIds: ["fact-id"] }]
};
```

Use `EmbeddingProvider` in RAG dependencies, replacing the current `modelProvider` property with `embeddingProvider`. In `retriever.ts`, call `embedQuery(query)` once and `embedDocuments(values)` once rather than embedding a mixed array.

- [ ] **Step 5: Prove the combined interface is gone and run affected suites**

Run: `rg -n "\bModelProvider\b|\.embed\(" apps packages -g '!**/node_modules/**' -g '!**/dist/**'`

Expected: no matches for the removed type or method.

Run: `corepack pnpm --filter @resume/model-provider test && corepack pnpm --filter @resume/profile-domain test && corepack pnpm --filter @resume/rag test && corepack pnpm --filter @resume/api test`

Expected: all four package suites PASS.

- [ ] **Step 6: Commit the interface split**

```bash
git add packages/model-provider packages/profile-domain packages/rag apps/api/src/app.ts apps/api/src/reviews
git commit -m "refactor: split model provider responsibilities"
```

### Task 2: Add pure configuration loading and `.env.local` startup

**Files:**
- Create: `apps/api/src/config.ts`
- Create: `apps/api/src/config.test.ts`
- Modify: `apps/api/package.json`
- Modify: `package.json`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): ApiConfig`.
- Produces: `DeepSeekAdapterConfig | undefined`; a wholly absent group is allowed, a partial group throws `ConfigurationError`.
- Consumers: Plans 2 and 3 extend `ApiConfig` with embedding and OCR groups without changing its partial-group rule.

- [ ] **Step 1: Write failing configuration tests**

```ts
it("loads core defaults and a complete DeepSeek group", () => {
  expect(loadConfig({ DEEPSEEK_API_KEY: "test-key" })).toMatchObject({
    databaseFile: "data/resume-assistant.sqlite",
    host: "127.0.0.1",
    port: 43120,
    deepseek: {
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com",
      defaultModel: "deepseek-v4-flash",
      escalationModel: "deepseek-v4-pro",
      thinking: "disabled",
      timeoutMs: 60_000,
      maxRetries: 2
    }
  });
});

it("allows an entirely absent adapter but rejects a partial adapter", () => {
  expect(loadConfig({}).deepseek).toBeUndefined();
  expect(() => loadConfig({ DEEPSEEK_BASE_URL: "https://api.deepseek.com" }))
    .toThrow("DEEPSEEK_API_KEY");
});

it("does not include secret values in validation errors", () => {
  const secret = "do-not-print-this";
  expect(captureError(() => loadConfig({ DEEPSEEK_API_KEY: secret, DEEPSEEK_TIMEOUT_MS: "NaN" })))
    .not.toContain(secret);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `corepack pnpm --filter @resume/api test -- config.test.ts`

Expected: FAIL because `loadConfig` does not exist.

- [ ] **Step 3: Implement grouped parsing with secret-safe errors**

```ts
export interface ApiConfig {
  databaseFile: string;
  host: "127.0.0.1";
  port: number;
  deepseek?: DeepSeekAdapterConfig;
}

export class ConfigurationError extends Error {
  constructor(readonly variables: string[]) {
    super(`Invalid configuration: ${variables.join(", ")}`);
  }
}
```

Parse positive integers with a Zod preprocess, accept only `http:` or `https:` URLs, require `DEEPSEEK_THINKING=disabled`, and construct errors from variable names rather than values. Treat `DEEPSEEK_API_KEY` as the group-presence sentinel: no DeepSeek variables means `undefined`; any DeepSeek variable means all required values must resolve through explicit input or defaults.

- [ ] **Step 4: Load `.env.local` only in process scripts**

Set the API package scripts to:

```json
{
  "start": "node --env-file-if-exists=../../.env.local dist/server.js",
  "dev": "node --env-file-if-exists=../../.env.local --import tsx src/server.ts"
}
```

Add `tsx@4.20.3` at the workspace root as the TypeScript development runner. Do not import `dotenv` and do not load files inside `loadConfig`.

- [ ] **Step 5: Run configuration and type checks**

Run: `corepack pnpm --filter @resume/api test -- config.test.ts && corepack pnpm typecheck`

Expected: PASS; the tests do not access the real `.env.local`.

- [ ] **Step 6: Commit configuration loading**

```bash
git add apps/api/src/config.ts apps/api/src/config.test.ts apps/api/package.json package.json pnpm-lock.yaml
git commit -m "feat: load api configuration safely"
```

### Task 3: Implement the DeepSeek structured provider

**Files:**
- Create: `packages/model-provider/src/deepseek-provider.ts`
- Create: `packages/model-provider/src/deepseek-provider.test.ts`
- Modify: `packages/model-provider/src/index.ts`

**Interfaces:**
- Consumes: `StructuredModelProvider` and `StructuredGenerationInput<T>` from Task 1.
- Produces: `DeepSeekStructuredModelProvider` and `DeepSeekProviderConfig`.
- Produces: sanitized `DeepSeekProviderError` with `kind` equal to `configuration`, `authentication`, `rate_limit`, `network`, `timeout`, `response`, or `validation`.

- [ ] **Step 1: Write failing request-shape and validation tests**

```ts
it("sends JSON mode with thinking disabled and validates locally", async () => {
  const fetch = fakeFetch(200, completion(JSON.stringify({ facts: [] })));
  const provider = new DeepSeekStructuredModelProvider(config, { fetch, sleep: async () => undefined });

  await expect(provider.generateStructured({
    system: "Extract supported facts.",
    user: "resume text",
    schema: z.object({ facts: z.array(z.unknown()) }),
    jsonExample: { facts: [] }
  })).resolves.toEqual({ facts: [] });

  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({
    model: "deepseek-v4-flash",
    response_format: { type: "json_object" },
    thinking: { type: "disabled" }
  });
  expect(JSON.stringify(fetch.mock.calls[0])).toContain("json");
  expect(JSON.stringify(fetch.mock.calls[0])).toContain('"facts":[]');
});
```

Add table-driven cases for empty content, malformed JSON, Schema failure, `429`, retryable `500`, non-retryable `400`, timeout, and a response containing `reasoning_content`. Assert no thrown error contains `config.apiKey`, response content, or reasoning content.

- [ ] **Step 2: Run the provider test and verify failure**

Run: `corepack pnpm --filter @resume/model-provider test -- deepseek-provider.test.ts`

Expected: FAIL because the provider is missing.

- [ ] **Step 3: Implement the HTTP boundary and response parser**

Use a strict response schema that extracts only `choices[0].message.content`:

```ts
const CompletionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullable() }).passthrough()
  })).min(1)
}).passthrough();
```

Build `POST ${baseUrl}/chat/completions` with `Authorization: Bearer ...`, `Content-Type: application/json`, `max_tokens: 8192`, JSON mode, and disabled thinking. Append this provider-owned instruction to the system message:

```text
Return only valid json. Follow this example json shape exactly:
{serialized jsonExample}
```

Parse `content` with `JSON.parse`, then return `input.schema.parse(parsed)`. Never include raw response bodies in errors.

- [ ] **Step 4: Implement bounded retries and one-time escalation**

Classify failures before retrying:

```ts
type FailureClass = "retryable_transport" | "retryable_validation" | "fatal";
```

For a model, permit `maxRetries + 1` attempts. Retry network errors, timeouts, `429`, `5xx`, empty content, malformed JSON, and Zod failures. Use capped exponential delay with injected sleep. If flash exhausts attempts due to validation-class failures, repeat once with the escalation model. Authentication and other non-`429` `4xx` failures stop immediately and never escalate.

- [ ] **Step 5: Verify escalation, redaction, and deterministic retry limits**

Run: `corepack pnpm --filter @resume/model-provider test -- deepseek-provider.test.ts`

Expected: PASS with exact fetch call counts for every retry case and no secret/raw-content leakage.

- [ ] **Step 6: Commit the DeepSeek provider**

```bash
git add packages/model-provider/src
git commit -m "feat: add DeepSeek structured provider"
```

### Task 4: Verify Plan 1 as an independently usable library slice

**Files:**
- Modify only if verification exposes a Plan 1 defect.

**Interfaces:**
- Produces: a tested DeepSeek provider and pure configuration loader for Plan 4 composition.

- [ ] **Step 1: Run focused package gates**

Run: `corepack pnpm --filter @resume/model-provider test && corepack pnpm --filter @resume/profile-domain test && corepack pnpm --filter @resume/rag test && corepack pnpm --filter @resume/api test`

Expected: all package tests PASS.

- [ ] **Step 2: Run repository type and build gates**

Run: `corepack pnpm typecheck && corepack pnpm build`

Expected: both commands exit 0.

- [ ] **Step 3: Inspect secrets and removed interfaces**

Run: `rg -n "\bModelProvider\b|reasoning_content|DEEPSEEK_API_KEY=.*[^.]" apps packages -g '!**/node_modules/**' -g '!**/dist/**'`

Expected: no combined `ModelProvider`; `reasoning_content` appears only in negative tests or explicit discard logic; no committed secret value.

- [ ] **Step 4: Record the plan completion commit if verification required fixes**

```bash
git add packages apps package.json pnpm-lock.yaml
git commit -m "fix: complete DeepSeek provider integration"
```

Skip this commit only when the working tree is already clean.

## Plan 1 Completion Gate

- Structured generation and embeddings have separate compile-time contracts.
- Every structured caller supplies a JSON example and retains local evidence validation.
- `.env.local` is process-loaded, while `loadConfig(env)` remains pure and testable.
- DeepSeek requests use current model names, JSON mode, and disabled thinking.
- Retry and escalation counts are bounded and verified.
- Tests never access real configuration or paid APIs.
