# Production Composition and Remote Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compose DeepSeek, remote embeddings, and remote OCR into the production API; expose safe degraded health state; and deploy both Workers into the remote user's Conda space on physical GPU 5.

**Architecture:** The API builds all configured adapters from one validated `ApiConfig`, but starts even when a configured remote Worker is offline. A health registry probes only free local Worker endpoints and treats DeepSeek as configured until a real task uses it. Remote deployment uses two pinned Conda environments, hash-verified offline assets, loopback listeners, bearer tokens, user-level process supervision, and an SSH tunnel.

**Tech Stack:** Existing pnpm monorepo, Fastify, React, Zod, SQLite, Node 24; user-space Conda, Supervisor or user systemd, PowerShell/SSH/rsync, NVIDIA A6000 GPU 5

## Global Constraints

- Complete Plans 1, 2, and 3 before starting this plan.
- Do not add Docker, sudo, system CUDA installation, public model ports, or permissions changes.
- Do not inspect or print the user's real `.env.local`, API keys, bearer tokens, SSH private keys, or passwords.
- Bind local API to `127.0.0.1:43120`, embedding Worker to `127.0.0.1:18080`, and OCR Worker to `127.0.0.1:43121`.
- Core configuration/database failures stop startup; absent/offline adapters produce explicit degraded states.
- Startup health checks never call paid DeepSeek endpoints.
- A new RAG task requires Embedding `ready`; an OCR-dependent import requires OCR `ready`; a DeepSeek step requires `configured` or `ready` and stops immediately on call failure.
- Browser automation policy remains unchanged: no programmatic job submission under any condition.
- Preserve the existing untracked root `README.md`; deployment documentation goes under `docs/deployment/` unless the user explicitly asks to reconcile that file.

---

## File Structure

```text
apps/api/src/config.ts                              Complete adapter configuration
apps/api/src/production-dependencies.ts             Production object graph
apps/api/src/health/adapter-health.ts               Safe adapter state registry
apps/api/src/health/health-routes.ts                 Health HTTP endpoint
packages/contracts/src/health.ts                     Shared health response schema
apps/web/src/health/ServiceStatus.tsx                Compact degraded-state UI
apps/web/src/api/health-client.ts                    Typed health client
deploy/remote/                                       User-space install and supervision
scripts/open-model-tunnel.ps1                        Local SSH tunnel helper
docs/deployment/remote-gpu.md                        Operator runbook
tests/fixtures/resumes/                              OCR/embedding acceptance fixtures
```

### Task 1: Complete configuration groups and production dependency composition

**Files:**
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/config.test.ts`
- Create: `apps/api/src/production-dependencies.ts`
- Create: `apps/api/src/production-dependencies.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/rag/rag-routes.ts`
- Modify: `apps/api/src/rag/rag-routes.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/server.test.ts`

**Interfaces:**
- Consumes: `DeepSeekStructuredModelProvider`, `RemoteEmbeddingProvider`, `RemoteOcrEngine`, `createFactEmbeddingSearch`, and `createProductionExtraction` from Plans 1-3.
- Produces: `createProductionDependencies(config, adapters?) -> AppDependencies`.
- Produces: optional `embeddingSearch` and `structuredProvider` app dependencies without hiding adapter absence.

- [ ] **Step 1: Extend failing configuration tests for remote groups**

```ts
it("loads complete embedding and OCR groups", () => {
  const config = loadConfig({
    EMBEDDING_BASE_URL: "http://127.0.0.1:18080",
    EMBEDDING_API_TOKEN: "embedding-test-token",
    EMBEDDING_MODEL: "Qwen/Qwen3-Embedding-8B",
    EMBEDDING_MODEL_REVISION: QWEN_REVISION,
    EMBEDDING_DIMENSIONS: "4096",
    OCR_BASE_URL: "http://127.0.0.1:43121",
    OCR_API_TOKEN: "ocr-test-token",
    OCR_MODEL: "deepseek-ai/DeepSeek-OCR-2",
    OCR_MODEL_REVISION: OCR_REVISION,
    OCR_TIMEOUT_MS: "180000"
  });
  expect(config.embedding?.dimensions).toBe(4096);
  expect(config.ocr?.modelRevision).toBe(OCR_REVISION);
});
```

Add partial-group, invalid URL, non-loopback URL, invalid dimension/timeout, and secret-safe error cases. Embedding and OCR URLs must use `http:` with hostname `127.0.0.1` or `localhost`, no credentials, and the configured tunnel ports; reject public hosts rather than warning. Production defaults must match the design specification exactly.

- [ ] **Step 2: Write failing composition tests**

```ts
it("composes configured adapters without making startup model requests", () => {
  const fetch = vi.fn();
  const dependencies = createProductionDependencies(fullConfig, { fetch });

  expect(dependencies.extractPdf).toEqual(expect.any(Function));
  expect(dependencies.extractFacts).toEqual(expect.any(Function));
  expect(dependencies.selfEvaluationModelProvider).toBeDefined();
  expect(dependencies.embeddingSearch).toBeDefined();
  expect(fetch).not.toHaveBeenCalled();
  dependencies.close?.();
});

it("composes an unconfigured degraded app instead of throwing", () => {
  const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }));
  expect(dependencies.selfEvaluationModelProvider).toBeUndefined();
  expect(dependencies.embeddingSearch).toBeUndefined();
  dependencies.close?.();
});
```

- [ ] **Step 3: Run tests and verify failure**

Run: `corepack pnpm --filter @resume/api test -- config.test.ts production-dependencies.test.ts server.test.ts`

Expected: FAIL because complete composition and remote groups are missing.

- [ ] **Step 4: Implement the object graph and cleanup ownership**

```ts
export interface AppDependencies {
  database: SqliteDatabase;
  profileRepository: ProfileRepository;
  originalDocumentStore: OriginalDocumentStore;
  extractPdf(bytes: Uint8Array): Promise<ExtractedDocument>;
  extractFacts(document: ExtractedDocument): Promise<ProfileFact[]>;
  selfEvaluationModelProvider?: StructuredModelProvider;
  embeddingSearch?: EmbeddingSearchPort;
  adapterHealth: AdapterHealthRegistry;
  close?(): void | Promise<void>;
}
```

Create the SQLite database and migrate first. Construct configured clients without network requests. Build production extraction with optional OCR and structured providers. Build `FactEmbeddingSearch` only when embedding config is complete. Register RAG routes with both keyword search and optional embedding search. On any construction failure, close the owned database exactly once.

- [ ] **Step 5: Update server entrypoint to load config and remove the intentional guard**

```ts
if (entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  const config = loadConfig(process.env);
  await startServer(createProductionDependencies(config), config);
}
```

`startServer` uses validated host/port. A missing adapter does not throw. A malformed partial adapter, invalid database path, or failed migration throws before `listen`.

- [ ] **Step 6: Run API and repository tests, then commit**

Run: `corepack pnpm --filter @resume/api test && corepack pnpm typecheck`

Expected: PASS; composition tests prove zero startup DeepSeek/Worker inference calls.

```bash
git add apps/api/src
git commit -m "feat: compose production model adapters"
```

### Task 2: Expose safe adapter health and degraded UI state

**Files:**
- Create: `packages/contracts/src/health.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/health/adapter-health.ts`
- Create: `apps/api/src/health/adapter-health.test.ts`
- Create: `apps/api/src/health/health-routes.ts`
- Create: `apps/api/src/health/health-routes.test.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/web/src/api/health-client.ts`
- Create: `apps/web/src/health/ServiceStatus.tsx`
- Create: `apps/web/src/health/ServiceStatus.test.tsx`
- Modify: `apps/web/src/profile/ProfilePage.tsx`
- Modify: `apps/web/src/rag/RagWorkspace.tsx`

**Interfaces:**
- Produces: `GET /api/health/adapters` with non-secret adapter states.
- Produces: `AdapterState = unconfigured | configured | checking | ready | unavailable | invalid`.
- Produces: compact UI status that disables only workflows requiring an unavailable adapter.

- [ ] **Step 1: Define shared health schemas and failing route tests**

```ts
export const AdapterStatusSchema = z.object({
  id: z.enum(["deepseek", "embedding", "ocr"]),
  state: z.enum(["unconfigured", "configured", "checking", "ready", "unavailable", "invalid"]),
  model: z.string().optional(),
  modelRevision: z.string().optional(),
  code: z.enum(["not_configured", "not_checked", "offline", "not_ready", "contract_mismatch"]).optional()
}).strict();
```

```ts
it("returns safe degraded state without probing DeepSeek", async () => {
  const response = await app.inject({ method: "GET", url: "/api/health/adapters" });
  expect(response.json()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "deepseek", state: "configured" }),
    expect.objectContaining({ id: "embedding", state: "unavailable" })
  ]));
  expect(deepseekFetch).not.toHaveBeenCalled();
  expect(JSON.stringify(response.json())).not.toContain("test-token");
});
```

- [ ] **Step 2: Run API health tests and verify failure**

Run: `corepack pnpm --filter @resume/api test -- adapter-health.test.ts health-routes.test.ts`

Expected: FAIL because health contracts and registry are missing.

- [ ] **Step 3: Implement free Worker probes and state transitions**

Probe only `GET /readyz` for embedding and OCR with their bearer tokens. Validate model/revision from readiness responses. Use a short timeout, coalesce concurrent probes, and cache results for five seconds. Wrap the configured structured provider in `ObservedStructuredModelProvider`, which delegates `generateStructured`, marks DeepSeek `ready` after a successful real call, and marks it `unavailable` before rethrowing a failed real call. DeepSeek starts as `configured`; never probe it solely for health.

The public payload includes adapter ID, state, model, revision, and stable code only. It excludes URLs, exception messages, headers, GPU process details, and secrets.

- [ ] **Step 4: Write failing UI status tests**

```tsx
it("keeps native PDF import available while marking OCR offline", async () => {
  render(<ServiceStatus statuses={[
    { id: "deepseek", state: "configured", model: "deepseek-v4-flash" },
    { id: "embedding", state: "unavailable", code: "offline" },
    { id: "ocr", state: "unavailable", code: "offline" }
  ]} />);
  expect(screen.getByText("OCR 离线")).toBeVisible();
  expect(screen.queryByText(/token|127\.0\.0\.1/iu)).not.toBeInTheDocument();
});
```

- [ ] **Step 5: Implement compact operational status in existing work surfaces**

Render icon plus short state text, not explanatory feature copy or decorative cards. Profile import remains enabled, because native-text PDFs may succeed; display the OCR outage next to import status. Disable new semantic RAG resolution when embedding is not `ready`. Self-evaluation creation remains available for `configured` or `ready` DeepSeek and surfaces the existing `503` on actual failure.

- [ ] **Step 6: Run API/Web health tests and commit**

Run: `corepack pnpm --filter @resume/contracts test && corepack pnpm --filter @resume/api test -- adapter-health.test.ts health-routes.test.ts && corepack pnpm --filter @resume/web test -- ServiceStatus.test.tsx`

Expected: PASS with no secret-bearing payloads.

```bash
git add packages/contracts apps/api/src/health apps/api/src/app.ts apps/web/src/api apps/web/src/health apps/web/src/profile apps/web/src/rag
git commit -m "feat: expose degraded adapter health"
```

### Task 3: Make the built API launchable with `.env.local`

**Files:**
- Modify: `apps/api/src/server-launch.test.ts`
- Modify: `apps/api/package.json`
- Modify: `package.json`
- Create: `scripts/start-local.ps1`
- Create: `scripts/open-model-tunnel.ps1`

**Interfaces:**
- Produces: `pnpm start:api` and a local SSH tunnel helper.
- Guarantees: built API starts in degraded mode without adapters and fails before listen for malformed partial configuration.

- [ ] **Step 1: Replace the obsolete intentional-guard launch test**

Build the API, spawn it with a temporary database and free test port, poll `GET /api/health/adapters`, assert `200`, then terminate the child and verify clean exit. Add a second launch with a partial DeepSeek group and assert nonzero exit before the port opens.

```ts
const child = spawn(process.execPath, ["apps/api/dist/server.js"], {
  cwd: workspaceRoot,
  env: {
    ...minimalEnvironment,
    DATABASE_FILE: databaseFile,
    API_PORT: String(port)
  },
  stdio: "pipe"
});
await waitForHttp(`http://127.0.0.1:${port}/api/health/adapters`);
```

- [ ] **Step 2: Run the launch test and verify failure**

Run: `corepack pnpm --filter @resume/api test -- server-launch.test.ts`

Expected: FAIL while the artifact still reaches the old dependency guard.

- [ ] **Step 3: Implement stable start scripts without printing secrets**

Root script:

```json
{
  "start:api": "corepack pnpm --filter @resume/api start"
}
```

`scripts/start-local.ps1` checks Node version, database directory writability, and ports `43110`, `43120`, `18080`, and `43121`; it prints only variable names for missing optional adapters. `open-model-tunnel.ps1` accepts `-HostName`, `-User heqing`, and optional `-Port 22`, then executes:

```powershell
ssh -N -L 18080:127.0.0.1:18080 -L 43121:127.0.0.1:43121 "$User@$HostName" -p $Port
```

Do not accept passwords or private-key contents as script parameters.

- [ ] **Step 4: Verify launch, malformed config, and build**

Run: `corepack pnpm --filter @resume/api test -- server-launch.test.ts config.test.ts && corepack pnpm build`

Expected: PASS; degraded artifact stays running, malformed partial config exits, and no module-resolution error appears.

- [ ] **Step 5: Commit launch orchestration**

```bash
git add apps/api package.json scripts/start-local.ps1 scripts/open-model-tunnel.ps1
git commit -m "feat: launch configured local api"
```

### Task 4: Add hash-verified user-space remote deployment

**Files:**
- Create: `deploy/remote/env.example`
- Create: `deploy/remote/install.sh`
- Create: `deploy/remote/verify-assets.py`
- Create: `deploy/remote/bin/run-embedding.sh`
- Create: `deploy/remote/bin/run-ocr.sh`
- Create: `deploy/remote/bin/start-all.sh`
- Create: `deploy/remote/bin/stop-all.sh`
- Create: `deploy/remote/bin/status.sh`
- Create: `deploy/remote/supervisord.conf`
- Create: `deploy/remote/systemd/resume-embedding.service`
- Create: `deploy/remote/systemd/resume-ocr.service`
- Create: `deploy/remote/tests/deploy.bats`
- Create: `docs/deployment/remote-gpu.md`

**Interfaces:**
- Consumes: uploaded `wheelhouse/`, model snapshots, lock files, and manifests from Plans 2-3.
- Produces: idempotent user-space installation under `/home/heqing/resume-ai`.
- Produces: `start-all`, `stop-all`, `status`, and safe logs without root access.

- [ ] **Step 1: Write failing deployment-script tests**

Use Bats with a temporary fake home and stubbed `conda`, `systemctl`, `nvidia-smi`, and `supervisord`. Assert:

```bash
@test "installer refuses a model checksum mismatch before creating environments" {
  corrupt "$BUNDLE/models/Qwen3-Embedding-8B/config.json"
  run ./deploy/remote/install.sh --root "$TEST_ROOT" --bundle "$BUNDLE"
  [ "$status" -ne 0 ]
  [ ! -d "$TEST_ROOT/envs/embedding" ]
}

@test "run scripts pin physical GPU 5 and loopback listeners" {
  run grep -E 'CUDA_VISIBLE_DEVICES=5' deploy/remote/bin/run-embedding.sh
  [ "$status" -eq 0 ]
  run grep -E '127\.0\.0\.1' deploy/remote/bin/run-ocr.sh
  [ "$status" -eq 0 ]
}
```

- [ ] **Step 2: Run deployment tests and verify failure**

Run in WSL/Linux: `bats deploy/remote/tests/deploy.bats`

Expected: FAIL because deployment assets do not exist.

- [ ] **Step 3: Implement asset verification and idempotent Conda installation**

`verify-assets.py` reads each Worker/model manifest, rejects path traversal and duplicate paths, computes SHA-256, and verifies model IDs/revisions. Before changes, `install.sh` requires Ubuntu x86-64, a visible physical GPU 5, at least 100 GiB free under the target filesystem, writable user directories, and both pinned Conda Python versions. It then runs asset verification and creates:

```text
~/resume-ai/envs/embedding
~/resume-ai/envs/ocr
~/resume-ai/models/Qwen3-Embedding-8B
~/resume-ai/models/DeepSeek-OCR-2
~/resume-ai/services
~/resume-ai/cache
~/resume-ai/logs
~/resume-ai/run
~/resume-ai/tmp
```

Install each Worker from its Linux wheelhouse and hash-locked requirements with no network access. Do not modify base Conda, `/etc`, the NVIDIA driver, Docker, or system Python.

- [ ] **Step 4: Generate service tokens with user-only permissions**

Document and automate:

```bash
umask 077
python - <<'PY' > "$HOME/resume-ai/run/embedding.token"
import secrets
print(secrets.token_urlsafe(48))
PY
python - <<'PY' > "$HOME/resume-ai/run/ocr.token"
import secrets
print(secrets.token_urlsafe(48))
PY
chmod 600 "$HOME/resume-ai/run/"*.token
```

The scripts print token file paths, never token values. The operator manually places the same values in local `.env.local` without committing them.

- [ ] **Step 5: Implement process supervision with an explicit fallback**

`run-embedding.sh` and `run-ocr.sh` export GPU/offline variables, read their own token files, and `exec` the correct Conda Python module. If `systemctl --user` works and linger is enabled, install/start the two user units. Otherwise `start-all.sh` launches the checked-in Supervisor config from the embedding environment. Supervisor limits each stdout/stderr log to 20 MiB with five backups and does not include environment secrets in command lines.

If neither persistence mechanism is allowed, the runbook states that `start-all.sh` must be executed after login/reboot. Do not install cron entries or system services without explicit administrator approval.

- [ ] **Step 6: Add operator runbook and test all shell paths**

The runbook covers asset preparation under WSL/Linux, `rsync -avP`, checksum verification, installation, status, SSH tunneling, log inspection, stop/start, model revision upgrades, disk cleanup, and the no-sudo/no-Docker boundary.

Run: `bats deploy/remote/tests/deploy.bats && shellcheck deploy/remote/*.sh deploy/remote/bin/*.sh`

Expected: PASS.

- [ ] **Step 7: Commit deployment assets**

```bash
git add deploy/remote docs/deployment/remote-gpu.md
git commit -m "feat: deploy remote GPU workers without root"
```

### Task 5: Execute local release gates and remote GPU acceptance

**Files:**
- Create: `tests/fixtures/resumes/embedding-cases.json`
- Create: `tests/fixtures/resumes/ocr-anchors.json`
- Create: `scripts/verify-remote-workers.mjs`
- Modify only defects found by acceptance.

**Interfaces:**
- Consumes: complete local application, SSH tunnel, and both live Workers.
- Produces: repeatable acceptance evidence for model identity, GPU isolation, retrieval relevance, OCR anchors, degraded behavior, and submission safety.

- [ ] **Step 1: Add the remote verification script and fixtures**

`verify-remote-workers.mjs` reads service URLs/tokens from environment without printing them. It asserts:

```ts
assert.equal(embedding.model, "Qwen/Qwen3-Embedding-8B");
assert.equal(embedding.modelRevision, QWEN_REVISION);
assert.equal(embedding.dimensions, 4096);
assert.ok(embedding.data.every(({ embedding }) => unitNorm(embedding)));
assert.equal(ocr.model, "deepseek-ai/DeepSeek-OCR-2");
assert.equal(ocr.modelRevision, OCR_REVISION);
```

The embedding fixture includes Chinese queries with one relevant and two unrelated resume facts. The OCR fixture maps each sanitized Chinese, English, scanned, and double-column page to mandatory anchor strings.

- [ ] **Step 2: Run all local automated tests**

Run:

```text
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
conda run -p <embedding-test-env> python -m pytest services/embedding-worker/tests -q
conda run -p <ocr-test-env> python -m pytest services/ocr-worker/tests -q
bats deploy/remote/tests/deploy.bats
```

Expected: every command exits 0. No paid DeepSeek or live GPU call occurs in this step.

- [ ] **Step 3: Upload and install on the authorized server account**

Use public-key SSH and `rsync -avP` to upload the verified bundle to `heqing@server:~/resume-ai-bundle/`. Run `install.sh` as `heqing` with no sudo. Do not send passwords, private keys, DeepSeek keys, or service tokens through chat.

- [ ] **Step 4: Prove physical GPU isolation before and after startup**

On the host, capture:

```bash
nvidia-smi --query-gpu=index,uuid,memory.used --format=csv,noheader
~/resume-ai/bin/start-all.sh
nvidia-smi --query-gpu=index,uuid,memory.used --format=csv,noheader
```

Expected: new model memory appears only on physical GPU 5. GPUs `0-4,6,7` show no project-caused increase. Both `/readyz` endpoints return the pinned model/revision.

- [ ] **Step 5: Run live tunnel and model acceptance**

Open the SSH tunnel locally, then run:

```bash
node --env-file-if-exists=.env.local scripts/verify-remote-workers.mjs
```

Expected: 4096-dimensional finite unit vectors; relevant Chinese facts outrank unrelated facts; all OCR anchor fixtures pass; no raw resume text appears in server logs.

- [ ] **Step 6: Verify degraded transitions and full application safety**

Stop each Worker separately and confirm `/api/health/adapters` becomes `unavailable`, native-text PDF import remains possible when OCR is stopped, scanned import returns `503`, and a new semantic RAG task is blocked when embedding is stopped. Restore services and confirm recovery to `ready`.

Run the existing RAG, self-evaluation, review, and controlled-browser safety suites. Expected: self-evaluation still requires explicit review, and all terminal submission variants remain policy-denied.

- [ ] **Step 7: Commit acceptance fixtures and any verified fixes**

```bash
git add tests/fixtures/resumes scripts/verify-remote-workers.mjs
git commit -m "test: verify production model adapters"
```

## Plan 4 Completion Gate

- The built API starts from `.env.local` without paid startup calls.
- Missing/offline adapters are visible and block only dependent operations.
- Health payloads and UI contain no secrets, URLs, raw model errors, or resume content.
- Both Workers install and run as `heqing` without Docker or sudo.
- Host `nvidia-smi` proves project memory is isolated to physical GPU 5.
- Live embedding and OCR fixtures pass against the pinned revisions.
- RAG verification, self-evaluation review, and the hard no-submit policy remain intact.
