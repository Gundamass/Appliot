# Embedding Scheduling and Index Singleflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce remote embedding batches of at most 32 with global provider concurrency 1, singleflight both ontology and Fact indexes, and prevent embedding infrastructure failures from falling through to DeepSeek.

**Architecture:** `ScheduledEmbeddingProvider` is the only production wrapper around `RemoteEmbeddingProvider`; one FIFO queue serializes document batches and queries. A keyed ontology index owns immutable definition vectors, while Fact search keys concurrent builds by profile/config content. Field resolution classifies healthy retrieval separately from provider failures and gives DeepSeek only a healthy ambiguous Top-3 candidate set.

**Tech Stack:** TypeScript 5.8, Node crypto, Zod, Vitest, better-sqlite3 11.10, pnpm 10.

## Global Constraints

- This plan is independent of the Runtime/Challenge implementation and may be reviewed as a separate change, but production verification must include the final combined typecheck/test matrix.
- Work in the current repository and preserve all pre-existing changes; stage only files listed by the current task.
- Write each failing test first and verify the expected failure before production edits.
- Every shell command starts with `rtk`; every manual edit uses `apply_patch`.
- `ScheduledEmbeddingProvider` uses `maxBatchSize: 32` and `maxConcurrency: 1`; 83 ontology definitions produce exactly `[32, 32, 19]` in order.
- `embedDocuments()` and `embedQuery()` share one FIFO queue for a production provider instance.
- The scheduler adds no retries; `RemoteEmbeddingProvider` remains the sole owner of its existing maximum two retries after the first attempt.
- Any failed batch fails the whole index operation and never publishes partial vectors.
- Ontology and Fact index concurrent first builds are singleflight; failed entries are removed so a later explicit call may retry.
- Embedding configuration/network/timeout/rate-limit/response/count/dimension failures never invoke DeepSeek.
- DeepSeek is called only for a healthy ambiguous retrieval and receives at most the compatible Top-3 candidates with scores.
- A DeepSeek semantic outside that Top-3 remains unresolved.
- Do not add BM25, BGE-Reranker, Langfuse, Browser-Use or LangGraph; do not log field/resume source text.

## File Structure

- `packages/model-provider/src/scheduled-embedding-provider.ts`: shared FIFO batching/concurrency wrapper.
- `packages/model-provider/src/index.ts`: exports the scheduler.
- `apps/api/src/applications/field-ontology-index.ts`: content-addressed immutable ontology vectors and singleflight.
- `apps/api/src/applications/field-semantic-resolver.ts`: healthy/failure classification and constrained Top-3 arbitration.
- `apps/api/src/rag/fact-embedding-search.ts`: keyed build singleflight and old-active preservation.
- `apps/api/src/observability/embedding-trace.ts`: bounded, text-free batch/index/arbitration diagnostics.
- `apps/api/src/production-dependencies.ts`: constructs one scheduled provider and shares it across both consumers.
- `apps/api/src/production-dependencies.test.ts`: verifies production wiring uses one queue.
- `docs/testing/embedding-p0-regression.md`: sanitized batch/concurrency/failure evidence.

---

### Task 1: Add one FIFO scheduler for document batches and queries

**Files:**
- Create: `packages/model-provider/src/scheduled-embedding-provider.ts`
- Create: `packages/model-provider/src/scheduled-embedding-provider.test.ts`
- Modify: `packages/model-provider/src/index.ts`
- Modify: `packages/model-provider/src/fake-provider.ts`
- Modify: `packages/model-provider/src/fake-provider.test.ts`

**Interfaces:**
- Produces: `EmbeddingSchedule = { maxBatchSize: number; maxConcurrency: 1 }`.
- Produces: `ScheduledEmbeddingProvider implements EmbeddingProvider`.
- Constructor: `new ScheduledEmbeddingProvider(delegate, { maxBatchSize: 32, maxConcurrency: 1 })`.
- Produces: optional `onEvent({ kind, batchSize, queueWaitMs, result, errorKind? })` callback with no input text.

- [ ] **Step 1: Write failing strict-batching/order tests**

Build 83 labelled strings and a delegate that returns the label index as its vector. Assert:

```ts
expect(delegate.embedDocuments.mock.calls.map(([batch]) => batch.length))
  .toEqual([32, 32, 19]);
expect(vectors.map(([index]) => index)).toEqual(Array.from({ length: 83 }, (_, index) => index));
```

Also assert empty input rejects locally without calling the delegate.

- [ ] **Step 2: Write failing shared-FIFO/concurrency tests**

Use deferred promises for two document calls and two queries. Start all operations concurrently; assert `maxActive === 1` and start order equals invocation order. Reject the second document batch and assert the third batch never starts and no partial output resolves.

Collect scheduler events and assert they contain batch size, queue wait and sanitized error kind but not document/query text, provider token or raw error message.

- [ ] **Step 3: Run model-provider tests and confirm RED**

```text
rtk pnpm --filter @resume/model-provider test -- scheduled-embedding-provider.test.ts fake-provider.test.ts
```

Expected: FAIL because the scheduled provider does not exist.

- [ ] **Step 4: Implement the FIFO promise tail**

Use one private tail for both methods:

```ts
private tail: Promise<void> = Promise.resolve();

private enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = this.tail.then(operation, operation);
  this.tail = result.then(() => undefined, () => undefined);
  return result;
}
```

`embedDocuments()` splits synchronously, then awaits one queued delegate call per batch and concatenates only after validating every batch count. `embedQuery()` queues one delegate query. Capture enqueue/start timestamps to emit nonnegative `queueWaitMs`. Map known `RemoteEmbeddingError.kind` values to `errorKind` without serializing the error. Validate `maxBatchSize` as a positive integer and `maxConcurrency` as literal 1; the implementation must not add sleeps or retries.

- [ ] **Step 5: Export and keep fakes deterministic**

Export the provider from `index.ts`. Extend `FakeEmbeddingProvider` only as needed to return per-call vector sequences for scheduler tests; preserve cloning so callers cannot mutate fixtures.

- [ ] **Step 6: Run tests, typecheck and commit**

```text
rtk pnpm --filter @resume/model-provider test
rtk pnpm typecheck
rtk git add packages/model-provider/src/scheduled-embedding-provider.ts packages/model-provider/src/scheduled-embedding-provider.test.ts packages/model-provider/src/index.ts packages/model-provider/src/fake-provider.ts packages/model-provider/src/fake-provider.test.ts
rtk git commit -m "feat: serialize remote embedding workloads"
```

Expected: PASS, batch sizes are exactly `[32, 32, 19]`, and measured max concurrency is 1.

---

### Task 2: Build a content-addressed ontology index with singleflight

**Files:**
- Create: `apps/api/src/applications/field-ontology-index.ts`
- Create: `apps/api/src/applications/field-ontology-index.test.ts`
- Modify: `apps/api/src/applications/field-semantic-resolver.ts`
- Modify: `apps/api/src/applications/field-semantic-resolver.test.ts`

**Interfaces:**
- Produces: `EmbeddingIdentity = { model, modelRevision, instructionVersion }`.
- Produces: `FieldOntologyIndex.load(definitions, identity): Promise<readonly number[][]>`.
- Produces: `fieldOntologyKey(definitions, identity): string`.
- Consumes: a scheduled `EmbeddingProvider`.

- [ ] **Step 1: Write deterministic key coverage tests**

Create one base definition and vary each required property independently. Assert key changes for `semantic`, `label`, `aliases`, `types`, `sections`, `risk`, `description`, `model`, `modelRevision` and `instructionVersion`. Assert reordered object properties do not change the key, while reordered definition array entries do change it.

- [ ] **Step 2: Write failing concurrent build/retry tests**

Start 20 `load()` calls for the same key and assert only one provider `embedDocuments()` call. Reject that promise and assert all callers reject, then call once more and assert a second provider call succeeds. Mutate the returned vectors and assert a later load returns an unchanged read-only clone/frozen structure.

- [ ] **Step 3: Run API tests and confirm RED**

```text
rtk pnpm --filter @resume/api test -- field-ontology-index.test.ts field-semantic-resolver.test.ts
```

Expected: FAIL because no keyed ontology index exists and resolver owns only one unkeyed promise.

- [ ] **Step 4: Implement canonical content hashing**

Canonicalize each definition explicitly, not with an unchecked object spread:

```ts
const canonical = definitions.map(({ semantic, label, aliases, types, sections, risk, description }) => ({
  semantic, label, aliases: [...aliases], types: [...types], sections: [...sections], risk, description
}));
return createHash("sha256").update(JSON.stringify({ identity, definitions: canonical }), "utf8").digest("hex");
```

- [ ] **Step 5: Implement successful cache plus in-flight map**

Maintain separate `cache` and `inFlight` maps. Validate vector count, non-empty finite dimensions and consistent dimensionality before freezing/cloning. On rejection, delete only the matching in-flight promise. Never store partial results.

- [ ] **Step 6: Inject the ontology index into the resolver**

Replace `documentVectors` with options:

```ts
ontologyIndex?: FieldOntologyIndex;
embeddingIdentity?: EmbeddingIdentity;
```

When embeddings are configured, require both values and call `ontologyIndex.load(definitions, identity)`. Tests with custom providers create an index explicitly; deterministic-only tests need neither.

- [ ] **Step 7: Run focused tests and commit**

```text
rtk pnpm --filter @resume/api test -- field-ontology-index.test.ts field-semantic-resolver.test.ts
rtk git add apps/api/src/applications/field-ontology-index.ts apps/api/src/applications/field-ontology-index.test.ts apps/api/src/applications/field-semantic-resolver.ts apps/api/src/applications/field-semantic-resolver.test.ts
rtk git commit -m "feat: singleflight field ontology embeddings"
```

Expected: PASS; concurrent same-key loads call the provider once and failure is retryable later.

---

### Task 3: Separate infrastructure failure from healthy ambiguity

**Files:**
- Modify: `apps/api/src/applications/field-semantic-resolver.ts`
- Modify: `apps/api/src/applications/field-semantic-resolver.test.ts`
- Modify: `apps/api/src/applications/production-field-resolver.ts`
- Create: `apps/api/src/applications/production-field-resolver.test.ts`

**Interfaces:**
- Produces internal retrieval states: `infrastructure_failure`, `healthy_no_candidate`, `healthy_ambiguous`, `healthy_resolved`.
- Changes: `deepSeekResolve(field, context, candidates, provider)` accepts only `FieldSemanticCandidate[]` with maximum length 3.
- Preserves public failure: `{ status: "unresolved", reason: "embedding_unavailable" }` for infrastructure failures.

- [ ] **Step 1: Write infrastructure no-fallback tests**

Parameterize document/query rejection, count mismatch, dimension mismatch, NaN and zero-length vectors. For every case assert:

```ts
expect(decision).toEqual({ status: "unresolved", reason: "embedding_unavailable" });
expect(structured.generateStructured).not.toHaveBeenCalled();
```

Also configure a structured provider without any embedding provider/index and assert the same `embedding_unavailable` result with zero DeepSeek calls; missing embedding configuration is infrastructure unavailability, not healthy ambiguity.

- [ ] **Step 2: Write healthy Top-3 arbitration tests**

Create four compatible candidates with valid vectors and an ambiguous top margin. Capture the structured-provider input and assert it contains exactly the sorted first three `{ semantic, label, similarity, risk }` records, and no aliases/descriptions/full ontology. Return candidate four from DeepSeek and assert the public decision remains unresolved/review rather than mapped.

- [ ] **Step 3: Write healthy-no-candidate tests**

Use valid embeddings but no definition compatible with section/control type. Assert `incompatible_field` and no DeepSeek call. Keep risk-requires-review behavior local and do not send commitment/sensitive decisions to DeepSeek solely because of risk.

- [ ] **Step 4: Run resolver tests and confirm RED**

```text
rtk pnpm --filter @resume/api test -- field-semantic-resolver.test.ts production-field-resolver.test.ts
```

Expected: FAIL because all embedding exceptions currently call DeepSeek and it currently receives up to 200 full definitions.

- [ ] **Step 5: Refactor retrieval into an explicit classifier**

Await ontology vectors first, then enqueue the query on the same scheduler; do not use `Promise.all`. Catch only around provider/index validation and return `infrastructure_failure`. After healthy vectors exist, filter compatible candidates and classify threshold/margin deterministically.

Use this branch table:

```ts
switch (retrieval.status) {
  case "infrastructure_failure": return { status: "unresolved", reason: "embedding_unavailable" };
  case "healthy_no_candidate": return { status: "unresolved", reason: "incompatible_field" };
  case "healthy_ambiguous": return arbitrateTopThree(retrieval.candidates.slice(0, 3));
  case "healthy_resolved": return mapOrReviewForRisk(retrieval.candidate);
}
```

- [ ] **Step 6: Constrain and validate DeepSeek output**

The prompt includes only field label/type, finite context and Top-3 candidates with scores. Accept the response only when the materialized semantic equals one of the supplied candidates and confidence is at least 0.9. Provider errors return the precomputed review result, not `embedding_unavailable`, because retrieval itself was healthy.

- [ ] **Step 7: Run tests and commit**

```text
rtk pnpm --filter @resume/api test -- field-semantic-resolver.test.ts production-field-resolver.test.ts
rtk git add apps/api/src/applications/field-semantic-resolver.ts apps/api/src/applications/field-semantic-resolver.test.ts apps/api/src/applications/production-field-resolver.ts apps/api/src/applications/production-field-resolver.test.ts
rtk git commit -m "fix: constrain semantic fallback to healthy candidates"
```

Expected: PASS and every infrastructure case records zero structured-provider calls.

---

### Task 4: Singleflight Fact index synchronization

**Files:**
- Modify: `apps/api/src/rag/fact-embedding-search.ts`
- Modify: `apps/api/src/rag/fact-embedding-search.test.ts`
- Modify: `apps/api/src/rag/embedding-index-repository.ts`
- Modify: `apps/api/src/rag/embedding-index-repository.test.ts`

**Interfaces:**
- Produces: deterministic build key covering active fact revisions/content and all index configuration.
- Produces: one in-flight build Promise per key.
- Preserves: old active index until a complete new index is activated.

- [ ] **Step 1: Write concurrent synchronize tests**

Create one service, hold the first document embedding promise, then call `search()` 20 times. Assert exactly one building index row and one `embedDocuments()` call before release. After release, assert all searches use the same activated index.

- [ ] **Step 2: Write failure/old-active/retry tests**

Build revision 1 successfully. Change a fact, reject revision 2's second batch, and assert the building row is removed while the revision-1 active row/vectors remain. Concurrent callers all reject with `EmbeddingSearchUnavailableError`. A later search starts one fresh build and activates it.

- [ ] **Step 3: Run RAG tests and confirm RED**

```text
rtk pnpm --filter @resume/api test -- fact-embedding-search.test.ts embedding-index-repository.test.ts
```

Expected: FAIL because concurrent `synchronize()` calls start independent builds.

- [ ] **Step 4: Implement the exact build key**

Build after sorting eligible facts by ID:

```ts
const key = createHash("sha256").update(JSON.stringify({
  config: {
    model: indexConfig.model,
    modelRevision: indexConfig.modelRevision,
    dimensions: indexConfig.dimensions,
    normalization: indexConfig.normalization,
    instructionVersion: indexConfig.instructionVersion
  },
  facts: facts.map((fact) => ({ id: fact.id, revision: fact.revision, contentHash: contentHash(fact) }))
}), "utf8").digest("hex");
```

- [ ] **Step 5: Add the in-flight gate around rebuild only**

Fast paths that match an already active index remain synchronous. When a rebuild is required, return the existing promise for the key or install one. Delete it in `finally` only when it is still the same promise. Keep existing `discardBuildingIndex()` in the build catch path and activate only after row count and all vectors validate.

- [ ] **Step 6: Run tests and commit**

```text
rtk pnpm --filter @resume/api test -- fact-embedding-search.test.ts embedding-index-repository.test.ts
rtk git add apps/api/src/rag/fact-embedding-search.ts apps/api/src/rag/fact-embedding-search.test.ts apps/api/src/rag/embedding-index-repository.ts apps/api/src/rag/embedding-index-repository.test.ts
rtk git commit -m "feat: singleflight fact embedding indexes"
```

Expected: PASS; one key has at most one building row and one provider workload.

---

### Task 5: Share one scheduled provider in production

**Files:**
- Modify: `apps/api/src/production-dependencies.ts`
- Modify: `apps/api/src/production-dependencies.test.ts`
- Create: `apps/api/src/observability/embedding-trace.ts`
- Create: `apps/api/src/observability/embedding-trace.test.ts`
- Modify: `packages/model-provider/src/remote-embedding-provider.test.ts`
- Modify: `apps/api/src/applications/field-semantic-resolver.test.ts`
- Modify: `apps/api/src/rag/fact-embedding-search.test.ts`

**Interfaces:**
- Constructs one `RemoteEmbeddingProvider`, wraps it once, and passes that same `ScheduledEmbeddingProvider` to ontology resolution and Fact search.
- Constructs one `FieldOntologyIndex` with the scheduled provider.
- Uses configured model/modelRevision plus `EMBEDDING_INSTRUCTION_VERSION` as identity.
- Emits only cache-key hashes, batch sizes, queue waits, provider error classes and a DeepSeek-used boolean.

- [ ] **Step 1: Write production-wiring concurrency test**

Inject a fake remote adapter, trigger ontology build, two semantic queries and Fact synchronization concurrently, and assert maximum active `/v1/embeddings` requests is 1. Assert the ontology request batch lengths are `[32, 32, 19]` before its queued query and Fact calls.

Use a collecting trace sink and assert ontology/Fact events include hashed cache keys and semantic-resolution events set `deepSeekUsed` correctly. Serialize all events and assert they do not contain field labels, definition text, fact text, query text, API tokens or raw provider messages.

- [ ] **Step 2: Assert retry ownership**

Make one scheduled delegate batch return 429 three times. Assert exactly three remote fetch attempts (initial plus the provider's two retries), not multiplied by the scheduler or index layers.

- [ ] **Step 3: Run production tests and confirm RED**

```text
rtk pnpm --filter @resume/api test -- production-dependencies.test.ts field-semantic-resolver.test.ts fact-embedding-search.test.ts
rtk pnpm --filter @resume/model-provider test -- remote-embedding-provider.test.ts scheduled-embedding-provider.test.ts
```

Expected: FAIL because production passes the raw provider to both consumers and ontology submits 83 items at once.

- [ ] **Step 4: Wire the single shared scheduler**

Use one instance:

```ts
const remoteEmbeddingProvider = config.embedding === undefined
  ? undefined
  : new RemoteEmbeddingProvider(config.embedding, adapters);
const embeddingProvider = remoteEmbeddingProvider === undefined
  ? undefined
  : new ScheduledEmbeddingProvider(remoteEmbeddingProvider, {
      maxBatchSize: 32,
      maxConcurrency: 1
    });
```

Create `FieldOntologyIndex` once and pass it plus identity to `createFieldSemanticResolver`; pass the same `embeddingProvider` to `createFactEmbeddingSearch`.

Implement `EmbeddingTraceSink` with this bounded event shape and inject it into the scheduler, ontology index, Fact search and resolver:

```ts
export interface EmbeddingTraceEvent {
  operation: "documents" | "query" | "ontology_build" | "fact_build" | "semantic_resolution";
  cacheKeyHash?: string;
  batchSize?: number;
  queueWaitMs?: number;
  providerErrorKind?: string;
  deepSeekUsed: boolean;
  result: "succeeded" | "failed" | "unresolved";
}
export interface EmbeddingTraceSink { record(event: EmbeddingTraceEvent): void; }
```

Only already hashed keys may enter `cacheKeyHash`. Add `BoundedEmbeddingTraceBuffer` with a fixed 1,000-event FIFO cap and instantiate it in production dependencies; tests verify eviction and the absence of sensitive text.

- [ ] **Step 5: Run focused tests, typecheck and commit**

```text
rtk pnpm --filter @resume/api test -- production-dependencies.test.ts field-semantic-resolver.test.ts fact-embedding-search.test.ts embedding-trace.test.ts
rtk pnpm --filter @resume/model-provider test
rtk pnpm typecheck
rtk git add apps/api/src/production-dependencies.ts apps/api/src/production-dependencies.test.ts apps/api/src/observability/embedding-trace.ts apps/api/src/observability/embedding-trace.test.ts packages/model-provider/src/remote-embedding-provider.test.ts apps/api/src/applications/field-semantic-resolver.test.ts apps/api/src/rag/fact-embedding-search.test.ts
rtk git commit -m "feat: share one embedding schedule in production"
```

Expected: PASS with `[32, 32, 19]` and max active request count 1.

---

### Task 6: Run the full Embedding P0 regression and record evidence

**Files:**
- Create: `docs/testing/embedding-p0-regression.md`

**Interfaces:**
- Documents only sanitized counts, failure classes and test commands.

- [ ] **Step 1: Run the complete local matrix**

```text
rtk pnpm --filter @resume/model-provider test
rtk pnpm --filter @resume/api test
rtk pnpm --filter @resume/rag test
rtk pnpm typecheck
rtk pnpm build
```

Expected: all commands PASS.

- [ ] **Step 2: Run the combined ATS safety regressions**

After the Runtime and Challenge plans are complete:

```text
rtk pnpm test:e2e -- ats-runtime-p0.spec.ts ats-challenge-p0.spec.ts ats-autofill-stability.spec.ts dji-coverage.spec.ts mokahr-high-coverage.spec.ts submit-safety.spec.ts
```

Expected: all specs PASS and all synthetic/real-safe harness checks report `submissionCount === 0`. Real Moka/DJI execution must stop at final review.

- [ ] **Step 3: Write sanitized regression evidence**

Record:

```text
Ontology batch sizes: 32, 32, 19
Maximum active embedding requests: 1
Ontology same-key concurrent builds: 1
Fact same-key concurrent builds: 1
DeepSeek calls after infrastructure failure: 0
Submission count: 0
```

Do not include embedding input text, resume facts, field labels, provider tokens, `.env.local` values or raw logs.

- [ ] **Step 4: Verify the report and commit**

```text
rtk rg -n "TBD|TODO|FIXME|apiToken|Authorization|Bearer" docs/testing/embedding-p0-regression.md
rtk git diff --check -- docs/testing/embedding-p0-regression.md
rtk git add docs/testing/embedding-p0-regression.md
rtk git commit -m "docs: record embedding P0 regression"
```

Expected: `rg` has no matches, diff check passes, and the commit contains only the report.
