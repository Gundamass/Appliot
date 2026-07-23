# Remote Qwen3 Embedding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve Qwen3-Embedding-8B from the authorized remote GPU, validate it through a TypeScript client, and maintain a revision-aware incremental fact index for RAG retrieval.

**Architecture:** A user-space FastAPI Worker loads one offline Qwen model on physical GPU 5 and exposes a bearer-protected embedding endpoint. The Node client owns query instruction formatting and strict response validation. SQLite stores versioned fact vectors behind an active-index record; changed facts are re-embedded incrementally, while a model/config change builds a new index completely before activation.

**Tech Stack:** Python 3.10, PyTorch 2.6 CUDA 11.8 wheel, Sentence Transformers 4.1, FastAPI, Uvicorn, Pydantic, pytest; Node.js 24, TypeScript, native fetch, Zod, better-sqlite3

## Global Constraints

- Complete Plan 1 before starting this plan.
- Pin model `Qwen/Qwen3-Embedding-8B` at revision `1d8ad4ca9b3dd8059ad90a75d4983776a23d44af`.
- Use FP16, 4096 output dimensions, L2 normalization, and physical GPU 5 only.
- Set `CUDA_VISIBLE_DEVICES=5`; `cuda:0` inside the process must map to host GPU 5.
- Add the fixed English instruction only to queries; document/fact text remains unprefixed.
- Reject count, dimension, finite-number, norm, model, or revision mismatches before persistence.
- Do not log input text, vectors, authorization headers, or service tokens.
- Keep the Worker bound to `127.0.0.1:18080`; no public listener is allowed.
- Unit tests inject a fake backend and do not load the 8B model or require a GPU.

---

## File Structure

```text
packages/model-provider/src/remote-embedding-provider.ts       TypeScript HTTP client
packages/model-provider/src/remote-embedding-provider.test.ts  Protocol and validation tests
services/embedding-worker/pyproject.toml                       Worker package metadata
services/embedding-worker/requirements.lock                    Pinned Linux runtime dependencies
services/embedding-worker/src/resume_embedding_worker/app.py   FastAPI boundary
services/embedding-worker/src/resume_embedding_worker/model.py Qwen singleton backend
services/embedding-worker/src/resume_embedding_worker/config.py Environment parser
services/embedding-worker/tests/                               CPU-only contract tests
apps/api/src/db/migrate.ts                                     Versioned embedding-index tables
apps/api/src/rag/embedding-index-repository.ts                 Atomic index persistence
apps/api/src/rag/fact-embedding-search.ts                      Incremental sync and cosine search
packages/rag/src/types.ts                                      Embedding search port
packages/rag/src/retriever.ts                                  Exact/keyword/embedding merge
```

### Task 1: Implement the strict remote Embedding client

**Files:**
- Create: `packages/model-provider/src/remote-embedding-provider.ts`
- Create: `packages/model-provider/src/remote-embedding-provider.test.ts`
- Modify: `packages/model-provider/src/index.ts`

**Interfaces:**
- Consumes: `EmbeddingProvider` from Plan 1.
- Produces: `RemoteEmbeddingProvider`, `RemoteEmbeddingConfig`, `EMBEDDING_QUERY_INSTRUCTION`, and `EMBEDDING_INSTRUCTION_VERSION`.
- Consumers: `FactEmbeddingSearch` in Task 5 and production composition in Plan 4.

- [ ] **Step 1: Write failing client contract tests**

```ts
it("keeps documents raw and prefixes only queries", async () => {
  const fetch = embeddingFetch([
    responseFor([[1, 0, 0, 0]], 4),
    responseFor([[0, 1, 0, 0]], 4)
  ]);
  const provider = new RemoteEmbeddingProvider(testConfig({ dimensions: 4 }), { fetch });

  await provider.embedDocuments(["React experience"]);
  await provider.embedQuery("frontend role");

  expect(requestInputs(fetch)).toEqual([
    ["React experience"],
    ["Instruct: Retrieve verified resume facts relevant to completing a job application field.\nQuery: frontend role"]
  ]);
});
```

Add table-driven tests for wrong model, wrong revision, count mismatch, wrong dimensions, `NaN` represented through an injected parsed response, non-unit norm, `401`, `500`, timeout, and an error response containing a fake token. The thrown message must not contain token or response body.

- [ ] **Step 2: Run the client test and verify failure**

Run: `corepack pnpm --filter @resume/model-provider test -- remote-embedding-provider.test.ts`

Expected: FAIL because `RemoteEmbeddingProvider` is missing.

- [ ] **Step 3: Implement request and response schemas**

Send:

```json
{
  "model": "Qwen/Qwen3-Embedding-8B",
  "input": ["text"]
}
```

Parse:

```ts
const EmbeddingResponseSchema = z.object({
  model: z.string(),
  modelRevision: z.string(),
  dimensions: z.number().int().positive(),
  data: z.array(z.object({
    index: z.number().int().nonnegative(),
    embedding: z.array(z.number())
  }).strict())
}).strict();
```

Sort data by `index`, require contiguous indexes, exact configured dimension, finite values, and `Math.abs(norm - 1) <= 1e-3`. Use `AbortController` and never include response text in public errors. Retry network failures, `429`, and `5xx` at most two times with capped backoff; never retry `401`, other `4xx`, or response-contract failures.

- [ ] **Step 4: Implement separate document and query methods**

```ts
export const EMBEDDING_QUERY_INSTRUCTION =
  "Retrieve verified resume facts relevant to completing a job application field.";
export const EMBEDDING_INSTRUCTION_VERSION = "resume-fact-query-v1";

async embedDocuments(texts: string[]): Promise<number[][]> {
  return this.embed(texts);
}

async embedQuery(text: string): Promise<number[]> {
  const [vector] = await this.embed([
    `Instruct: ${EMBEDDING_QUERY_INSTRUCTION}\nQuery: ${text}`
  ]);
  if (!vector) throw new RemoteEmbeddingError("response");
  return vector;
}
```

Reject empty batches, blank strings, more than 32 inputs, or individual strings over 30,000 characters before making a request.

- [ ] **Step 5: Run the client suite and commit**

Run: `corepack pnpm --filter @resume/model-provider test -- remote-embedding-provider.test.ts && corepack pnpm typecheck`

Expected: PASS.

```bash
git add packages/model-provider/src
git commit -m "feat: add remote embedding provider"
```

### Task 2: Build the GPU-independent Worker HTTP contract

**Files:**
- Create: `services/embedding-worker/pyproject.toml`
- Create: `services/embedding-worker/src/resume_embedding_worker/__init__.py`
- Create: `services/embedding-worker/src/resume_embedding_worker/app.py`
- Create: `services/embedding-worker/src/resume_embedding_worker/auth.py`
- Create: `services/embedding-worker/src/resume_embedding_worker/types.py`
- Create: `services/embedding-worker/tests/test_app.py`

**Interfaces:**
- Produces: `create_app(backend, settings) -> FastAPI`.
- Consumes: an injected `EmbeddingBackend` protocol with `model`, `revision`, `dimensions`, `ready`, and `embed(texts)`.
- Produces: `GET /healthz`, `GET /readyz`, and `POST /v1/embeddings` matching Task 1.

- [ ] **Step 1: Create the package metadata and failing API tests**

Use this dependency baseline in `pyproject.toml`; the generated lock in Task 3 freezes transitive versions and hashes:

```toml
[project]
name = "resume-embedding-worker"
version = "0.1.0"
requires-python = "==3.10.*"
dependencies = [
  "fastapi==0.115.12",
  "uvicorn[standard]==0.34.3",
  "pydantic==2.11.7",
  "numpy==2.2.6"
]

[project.optional-dependencies]
test = ["pytest==8.4.1", "httpx==0.28.1"]
```

```py
def test_embeddings_requires_auth_and_returns_indexed_vectors(client, token):
    denied = client.post("/v1/embeddings", json={"model": MODEL, "input": ["resume"]})
    accepted = client.post(
        "/v1/embeddings",
        headers={"Authorization": f"Bearer {token}"},
        json={"model": MODEL, "input": ["resume"]},
    )
    assert denied.status_code == 401
    assert accepted.json() == {
        "model": MODEL,
        "modelRevision": REVISION,
        "dimensions": 4,
        "data": [{"index": 0, "embedding": [1.0, 0.0, 0.0, 0.0]}],
    }
```

Also test liveness before model readiness, readiness failure, wrong model, blank input, batch size 33, oversized input, backend exception, and that captured logs omit input text and token.

- [ ] **Step 2: Run tests and verify failure**

Run from `services/embedding-worker`: `python -m pytest tests/test_app.py -q`

Expected: FAIL because the Worker package is absent.

- [ ] **Step 3: Implement strict request limits, auth, and app factory**

```py
class EmbeddingRequest(BaseModel):
    model: str
    input: list[str] = Field(min_length=1, max_length=32)

class EmbeddingBackend(Protocol):
    model: str
    revision: str
    dimensions: int
    @property
    def ready(self) -> bool: ...
    def embed(self, texts: list[str]) -> list[list[float]]: ...
```

Compare tokens with `hmac.compare_digest`. Leave `/healthz` unauthenticated but return only `{ "status": "alive" }`; require the bearer token for `/readyz` and `/v1/embeddings`. Validate `Content-Length` before body parsing and Pydantic limits afterward. Convert backend exceptions into a generic `503` with a request ID; log only request ID, count, elapsed milliseconds, and error class.

- [ ] **Step 4: Validate backend output again at the Worker boundary**

Before responding, require correct count, dimensions, finite values, and unit norms. A malformed backend response returns `503` and never sends partial vectors.

- [ ] **Step 5: Run Worker contract tests and commit**

Run: `python -m pytest services/embedding-worker/tests/test_app.py -q`

Expected: all tests PASS without importing torch or loading a model.

```bash
git add services/embedding-worker
git commit -m "feat: add embedding worker contract"
```

### Task 3: Add the offline Qwen backend and locked runtime

**Files:**
- Create: `services/embedding-worker/src/resume_embedding_worker/config.py`
- Create: `services/embedding-worker/src/resume_embedding_worker/model.py`
- Create: `services/embedding-worker/src/resume_embedding_worker/main.py`
- Create: `services/embedding-worker/tests/test_config.py`
- Create: `services/embedding-worker/tests/test_model.py`
- Create: `services/embedding-worker/requirements.lock`
- Create: `services/embedding-worker/model-manifest.json`

**Interfaces:**
- Consumes: local model directory and environment settings.
- Produces: `QwenEmbeddingBackend` and module entrypoint `python -m resume_embedding_worker.main`.

- [ ] **Step 1: Write failing offline configuration tests**

```py
def test_settings_require_gpu_five_and_pinned_revision(tmp_path):
    settings = load_settings({
        "CUDA_VISIBLE_DEVICES": "5",
        "EMBEDDING_MODEL_PATH": str(tmp_path),
        "EMBEDDING_MODEL": MODEL,
        "EMBEDDING_MODEL_REVISION": REVISION,
        "EMBEDDING_DIMENSIONS": "4096",
        "EMBEDDING_API_TOKEN_FILE": str(token_file(tmp_path)),
    })
    assert settings.cuda_visible_devices == "5"
    assert settings.host == "127.0.0.1"
    assert settings.port == 18080
```

Reject any GPU value other than `5`, missing/non-`0600` token files, non-loopback host, wrong dimension, absent model directory, or manifest revision mismatch.

- [ ] **Step 2: Run the configuration tests and verify failure**

Run: `python -m pytest services/embedding-worker/tests/test_config.py -q`

Expected: FAIL because settings and manifest validation are missing.

- [ ] **Step 3: Implement singleton model loading**

```py
self._model = SentenceTransformer(
    settings.model_path,
    device="cuda:0",
    model_kwargs={"torch_dtype": torch.float16, "attn_implementation": "sdpa"},
    tokenizer_kwargs={"padding_side": "left"},
    local_files_only=True,
)

vectors = self._model.encode(
    texts,
    batch_size=settings.batch_size,
    normalize_embeddings=True,
    convert_to_numpy=True,
    show_progress_bar=False,
)
```

Set `ready` only after a one-item warmup produces one finite 4096-dimensional unit vector. Never call Hugging Face over the network.

- [ ] **Step 4: Unit test loading through injected modules**

Patch `SentenceTransformer` and torch so the test verifies `device="cuda:0"`, FP16, SDPA, `local_files_only=True`, and normalization without requiring CUDA. Include failures for warmup dimension mismatch and non-finite output.

- [ ] **Step 5: Generate and verify a hash-locked Linux dependency set**

Use a Linux x86-64 environment to resolve the exact direct versions:

```text
torch==2.6.0+cu118
sentence-transformers==4.1.0
transformers==4.51.3
fastapi==0.115.12
uvicorn==0.34.3
pydantic==2.11.7
numpy==2.2.6
```

Generate `requirements.lock` with hashes using `uv pip compile --generate-hashes`. Install from the lock with `--no-deps --require-hashes` during offline deployment. `model-manifest.json` records model ID, revision, expected dimensions, and SHA-256 for every uploaded model file.

- [ ] **Step 6: Run all CPU-only Worker tests and commit**

Run: `python -m pytest services/embedding-worker/tests -q`

Expected: PASS without a real model.

```bash
git add services/embedding-worker
git commit -m "feat: load Qwen embedding model offline"
```

### Task 4: Add versioned embedding index persistence

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/db/migrate.ts`
- Modify: `apps/api/src/db/migrate.test.ts`
- Create: `apps/api/src/rag/embedding-index-repository.ts`
- Create: `apps/api/src/rag/embedding-index-repository.test.ts`

**Interfaces:**
- Produces: `EmbeddingIndexRepository` with `beginBuild`, `putVectors`, `activate`, `getActive`, `listVectors`, `replaceFactVector`, and `deleteStaleFacts`.
- Guarantees: a building index cannot be queried as active; activation and retirement occur in one SQLite transaction.

- [ ] **Step 1: Write failing migration and repository tests**

```ts
it("keeps the old index active until the replacement is complete", () => {
  const first = repository.beginBuild(config("index-v1"));
  repository.putVectors(first.id, [storedVector("fact-1", 1)]);
  repository.activate(first.id);

  const second = repository.beginBuild(config("index-v2"));
  expect(repository.getActive()?.id).toBe(first.id);
  repository.putVectors(second.id, [storedVector("fact-1", 1)]);
  repository.activate(second.id);

  expect(repository.getActive()?.id).toBe(second.id);
  expect(repository.getById(first.id)?.status).toBe("retired");
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `corepack pnpm --filter @resume/api test -- migrate.test.ts embedding-index-repository.test.ts`

Expected: FAIL because the version tables and repository do not exist.

- [ ] **Step 3: Add the schema and idempotent migration**

Create:

```sql
CREATE TABLE embedding_indexes (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  normalization TEXT NOT NULL CHECK (normalization = 'l2'),
  instruction_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building', 'active', 'retired')),
  created_at TEXT NOT NULL,
  activated_at TEXT
);

CREATE UNIQUE INDEX embedding_indexes_one_active
ON embedding_indexes(status) WHERE status = 'active';

CREATE TABLE fact_embeddings (
  index_id TEXT NOT NULL REFERENCES embedding_indexes(id),
  fact_id TEXT NOT NULL REFERENCES profile_facts(id),
  fact_revision INTEGER NOT NULL CHECK (fact_revision > 0),
  content_hash TEXT NOT NULL,
  vector_json TEXT NOT NULL CHECK (json_valid(vector_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (index_id, fact_id)
);
```

Leave the pre-existing `embeddings` table untouched for backward-compatible database migration; new production code uses `embedding_indexes` and `fact_embeddings`.

- [ ] **Step 4: Implement transactional activation and strict parsing**

Validate vectors before JSON serialization. `activate(id)` must verify the index is `building`, retire the previous active row, and activate the new row in one transaction. Repository reads parse all rows with Zod and reject malformed persisted vectors.

- [ ] **Step 5: Run repository tests and commit**

Run: `corepack pnpm --filter @resume/api test -- migrate.test.ts embedding-index-repository.test.ts`

Expected: PASS, including repeated migration and interrupted-build cases.

```bash
git add apps/api/src/db apps/api/src/rag/embedding-index-repository*
git commit -m "feat: persist versioned fact embeddings"
```

### Task 5: Build incremental fact synchronization and semantic search

**Files:**
- Create: `apps/api/src/rag/fact-embedding-search.ts`
- Create: `apps/api/src/rag/fact-embedding-search.test.ts`
- Modify: `packages/rag/src/types.ts`
- Modify: `packages/rag/src/retriever.ts`
- Modify: `packages/rag/src/rag-loop.test.ts`
- Modify: `packages/rag/src/safety-review.test.ts`
- Modify: `apps/api/src/rag/rag-routes.ts`
- Modify: `apps/api/src/rag/rag-routes.test.ts`

**Interfaces:**
- Produces in `@resume/rag`: `EmbeddingSearchPort.search(input) -> Promise<EmbeddingSearchResult[]>`.
- Produces in API: `createFactEmbeddingSearch(database, profileRepository, embeddingProvider, indexConfig)`.
- Guarantees: only `user_confirmed` and `user_corrected` facts enter the vector index; task scope is enforced after retrieval.

- [ ] **Step 1: Write failing incremental-index tests**

```ts
it("re-embeds only a corrected fact in the active index", async () => {
  const service = createSearchHarness([confirmedFact("a", 1), confirmedFact("b", 1)]);
  await service.search(searchInput("first"));
  expect(provider.embedDocuments).toHaveBeenCalledWith([textFor("a", 1), textFor("b", 1)]);

  repository.correct("b", "corrected", userEvidence("corrected"));
  provider.embedDocuments.mockClear();
  await service.search(searchInput("second"));

  expect(provider.embedDocuments).toHaveBeenCalledWith([textFor("b", 2)]);
});
```

Add cases for initial full build, failed replacement retaining the previous active index, superseded/deleted facts, extracted-only facts, task-answer isolation, model revision change, deterministic score ties, malformed persisted vectors, and provider failure returning an unavailable result rather than unverified facts.

- [ ] **Step 2: Run tests and verify failure**

Run: `corepack pnpm --filter @resume/api test -- fact-embedding-search.test.ts`

Expected: FAIL because synchronization and semantic search are missing.

- [ ] **Step 3: Implement canonical fact text and content hashes**

```ts
export function factEmbeddingText(fact: ProfileFact): string {
  const evidence = fact.evidence
    .map((item) => `[${item.extraction} page ${item.page}] ${item.text}`)
    .sort();
  return [
    `Field: ${fact.fieldPath}`,
    `Value: ${stableJson(fact.value)}`,
    "Evidence:",
    ...evidence
  ].join("\n");
}
```

Hash UTF-8 text with SHA-256. Select eligible facts deterministically by ID. For an active matching index, embed only rows whose revision or hash changed and remove rows no longer eligible.

- [ ] **Step 4: Implement safe full rebuild and cosine retrieval**

When active metadata does not match configured model/revision/dimensions/normalization/instruction version, create a building index, embed every eligible fact, persist all vectors, verify row count, then activate. On any error, leave the old index active and mark/delete the failed building row without exposing partial vectors.

For search, call `embedQuery(input.query)`, read vectors from the matching active index, compute finite cosine scores, enforce task visibility, sort by score then fact ID, and return at most `limit` results.

- [ ] **Step 5: Integrate the RAG retrieval port**

```ts
export interface EmbeddingSearchResult {
  fact: ProfileFact;
  score: number;
}

export interface EmbeddingSearchPort {
  search(input: {
    query: string;
    taskId: string;
    limit: number;
    jobDescription?: string;
  }): Promise<EmbeddingSearchResult[]>;
}
```

Extend `RetrievalSource` to `"exact" | "keyword" | "embedding"`. Keep exact lookup first. Merge keyword and embedding results by canonical fact ID, reject conflicting duplicates, retain lifecycle precedence, and preserve `needs_review` for non-exact candidates. If the plan includes `embedding`, no exact fact exists, and `embeddingSearch` is absent or fails, return an invalid retrieval result instead of silently accepting keyword-only candidates. Do not let similarity bypass `verifyField`.

- [ ] **Step 6: Run RAG, API, and index tests**

Run: `corepack pnpm --filter @resume/rag test && corepack pnpm --filter @resume/api test -- fact-embedding-search.test.ts rag-routes.test.ts`

Expected: PASS; correction tests show one document re-embedding and cross-task leakage remains blocked.

- [ ] **Step 7: Commit semantic index integration**

```bash
git add apps/api/src/rag packages/rag
git commit -m "feat: retrieve from incremental fact embeddings"
```

### Task 6: Verify Plan 2 without a production GPU

**Files:**
- Modify only when verification reveals a Plan 2 defect.

**Interfaces:**
- Produces: a GPU-independent tested service contract, a strict Node client, and a persistent index ready for Plan 4 composition.

- [ ] **Step 1: Run Python contract tests**

Run: `python -m pytest services/embedding-worker/tests -q`

Expected: all tests PASS with fake model modules.

- [ ] **Step 2: Run TypeScript package tests**

Run: `corepack pnpm --filter @resume/model-provider test && corepack pnpm --filter @resume/rag test && corepack pnpm --filter @resume/api test`

Expected: all tests PASS.

- [ ] **Step 3: Run repository gates**

Run: `corepack pnpm typecheck && corepack pnpm build`

Expected: both commands exit 0.

- [ ] **Step 4: Confirm no model payloads or tokens are logged**

Run: `rg -n "logger\..*(input|embedding|authorization|token)|console\..*(input|embedding|authorization|token)" services/embedding-worker packages/model-provider apps/api`

Expected: no production logging of protected values; deliberate negative tests may match only inside test files.

## Plan 2 Completion Gate

- Remote client prefixes only queries and validates every response invariant.
- Worker tests pass without a GPU and production backend is pinned for offline loading.
- New model/index metadata never becomes active before a complete build.
- Correcting one fact re-embeds only that fact in an otherwise matching active index.
- RAG still plans, retrieves, validates, asks, and applies corrections without trusting similarity as fact.
