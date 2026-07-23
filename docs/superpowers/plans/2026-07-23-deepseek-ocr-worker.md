# DeepSeek-OCR 2 Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the planned PaddleOCR adapter with a bearer-protected DeepSeek-OCR 2 Worker and use it only for PDF pages whose native text layer is unusable.

**Architecture:** The profile domain retains page rendering and native-text-first selection. A strict TypeScript `RemoteOcrEngine` sends one PNG page at a time over the SSH tunnel. A separate Python 3.12 Worker loads the pinned offline DeepSeek-OCR 2 custom code on physical GPU 5, serializes inference through a semaphore, converts the page to Markdown, and deletes all temporary files on success or failure.

**Tech Stack:** Node.js 24, TypeScript, native fetch, Zod, pdfjs-dist, `@napi-rs/canvas`; Python 3.12.9, PyTorch 2.6 CUDA 11.8, Transformers 4.46.3, Flash Attention 2.7.3, FastAPI, Pillow, pytest

## Global Constraints

- Complete Plan 1 before starting this plan; Plan 2 may run in parallel only in a separate worktree.
- Pin `deepseek-ai/DeepSeek-OCR-2` at revision `aaa02f3811945a91062062994c5c4a3f4c0af2b0`.
- Use BF16 and physical GPU 5 only through `CUDA_VISIBLE_DEVICES=5`.
- Prefer native PDF text. Call OCR only for empty, control-heavy, replacement-character-heavy, or otherwise unusable pages.
- Use the exact prompt `<image>\n<|grounding|>Convert the document to markdown.` with deterministic generation.
- Accept only PNG/JPEG bytes; reject URLs and caller-provided server paths.
- Process one page per request and one inference at a time.
- Never log OCR image bytes, Markdown output, authorization headers, or tokens.
- Every OCR-derived page remains `source="ocr"`; downstream fact extraction must preserve that evidence source.
- Worker unit tests inject a fake backend and never load the real model or GPU.

---

## File Structure

```text
packages/profile-domain/src/pdf/remote-ocr-engine.ts       TypeScript HTTP adapter
packages/profile-domain/src/pdf/remote-ocr-engine.test.ts  Protocol and redaction tests
packages/profile-domain/src/pdf/extract-pdf.ts             Native-text usability classifier
packages/profile-domain/src/pdf/extract-pdf.test.ts        Per-page fallback tests
services/ocr-worker/pyproject.toml                         Worker metadata
services/ocr-worker/requirements.lock                      Locked Linux runtime
services/ocr-worker/src/resume_ocr_worker/app.py           FastAPI boundary
services/ocr-worker/src/resume_ocr_worker/model.py         Pinned DeepSeek model backend
services/ocr-worker/src/resume_ocr_worker/config.py        GPU/offline settings
services/ocr-worker/tests/                                 CPU-only contract tests
```

### Task 1: Implement the TypeScript remote OCR adapter

**Files:**
- Create: `packages/profile-domain/src/pdf/remote-ocr-engine.ts`
- Create: `packages/profile-domain/src/pdf/remote-ocr-engine.test.ts`
- Modify: `packages/profile-domain/src/pdf/types.ts`
- Modify: `packages/profile-domain/package.json`

**Interfaces:**
- Consumes: `OcrEngine` from the profile domain.
- Produces: `RemoteOcrEngine`, `RemoteOcrConfig`, and sanitized `RemoteOcrError`.
- Consumers: PDF extraction in Task 2 and production composition in Plan 4.

- [ ] **Step 1: Simplify the OCR domain contract and write failing client tests**

Change the domain interface to remove a Tesseract-specific language string:

```ts
export interface OcrEngine {
  recognize(image: Uint8Array): Promise<string>;
}
```

```ts
it("sends one PNG page and returns pinned Markdown output", async () => {
  const fetch = fakeFetch(200, {
    text: "# Resume\nAda Lovelace",
    model: "deepseek-ai/DeepSeek-OCR-2",
    modelRevision: OCR_REVISION,
    mode: "document_to_markdown",
    elapsedMs: 1200
  });
  const engine = new RemoteOcrEngine(config, { fetch });

  await expect(engine.recognize(PNG_BYTES)).resolves.toBe("# Resume\nAda Lovelace");
  expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:43121/v1/ocr", expect.objectContaining({
    method: "POST",
    headers: expect.objectContaining({
      Authorization: "Bearer test-token",
      "Content-Type": "image/png"
    }),
    body: expect.any(Uint8Array)
  }));
});
```

Add tests for empty output, wrong model, wrong revision, wrong mode, `401`, `413`, `500`, timeout, one retry on network/`5xx`, and no retry on contract/auth failures. Assert errors omit token and response body.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `corepack pnpm --filter @resume/profile-domain test -- remote-ocr-engine.test.ts`

Expected: FAIL because `RemoteOcrEngine` is missing and the old interface still requires a language.

- [ ] **Step 3: Implement raw-image HTTP transport and strict response parsing**

```ts
const OcrResponseSchema = z.object({
  text: z.string().min(1),
  model: z.string(),
  modelRevision: z.string(),
  mode: z.literal("document_to_markdown"),
  elapsedMs: z.number().nonnegative()
}).strict();
```

Validate the PNG signature before sending. Use `AbortController`, a maximum of one retry for transport/`5xx`, and exact configured model/revision checks. Return a trimmed but otherwise unchanged Markdown string.

- [ ] **Step 4: Run client tests and typecheck**

Run: `corepack pnpm --filter @resume/profile-domain test -- remote-ocr-engine.test.ts && corepack pnpm typecheck`

Expected: PASS after updating all old `recognize(image, language)` test doubles.

- [ ] **Step 5: Commit the remote OCR client**

```bash
git add packages/profile-domain
git commit -m "feat: add remote OCR engine"
```

### Task 2: Harden native-PDF-text selection and OCR fallback

**Files:**
- Modify: `packages/profile-domain/src/pdf/extract-pdf.ts`
- Modify: `packages/profile-domain/src/pdf/extract-pdf.test.ts`
- Modify: `packages/profile-domain/src/pdf/ocr.ts`

**Interfaces:**
- Produces: `classifyPdfText(text): "usable" | "empty" | "corrupt" | "suspiciously_short"`.
- Consumes: `OcrEngine.recognize(image)` from Task 1.
- Guarantees: only fallback pages are rendered; page number and source remain stable.

- [ ] **Step 1: Add failing page-classification tests**

```ts
it.each([
  ["Ada Lovelace\nada@example.com", "usable"],
  ["\u0000\u200B\u200C\u200D\u2060\uFEFF", "empty"],
  ["�������", "corrupt"],
  ["A", "suspiciously_short"]
])("classifies PDF text %j as %s", (text, expected) => {
  expect(classifyPdfText(text)).toBe(expected);
});
```

Add a mixed three-page PDF test proving only the corrupt and image-only pages call OCR. Preserve the existing immutable-byte fingerprint and page-cleanup-on-error tests.

- [ ] **Step 2: Run tests and verify failure**

Run: `corepack pnpm --filter @resume/profile-domain test -- extract-pdf.test.ts`

Expected: FAIL because the classifier does not exist and short/corrupt text currently passes.

- [ ] **Step 3: Implement deterministic text quality checks**

Normalize with NFKC for measurement only; return the original extracted text when usable. Count visible letters/numbers, Unicode replacement characters, controls, and non-whitespace code points. Use named constants and these rules:

```ts
if (visibleCount === 0) return "empty";
if (replacementCount / nonWhitespaceCount >= 0.1) return "corrupt";
if (controlCount / nonWhitespaceCount >= 0.1) return "corrupt";
if (visibleCount < 8) return "suspiciously_short";
return "usable";
```

The threshold is intentionally page-level: a one-character PDF page is sent to OCR rather than trusted as complete resume evidence.

- [ ] **Step 4: Preserve cleanup and empty-OCR failure behavior**

After rendering, call `ocr.recognize(image)`. Reject a blank result with `OcrOutputError`; do not append a successful empty page. Keep page cleanup in `finally`, even when remote OCR fails.

- [ ] **Step 5: Run the complete profile-domain suite and commit**

Run: `corepack pnpm --filter @resume/profile-domain test`

Expected: PASS with OCR called only on classified fallback pages.

```bash
git add packages/profile-domain/src/pdf
git commit -m "feat: detect PDF pages that require OCR"
```

### Task 3: Build the GPU-independent OCR Worker contract

**Files:**
- Create: `services/ocr-worker/pyproject.toml`
- Create: `services/ocr-worker/src/resume_ocr_worker/__init__.py`
- Create: `services/ocr-worker/src/resume_ocr_worker/app.py`
- Create: `services/ocr-worker/src/resume_ocr_worker/auth.py`
- Create: `services/ocr-worker/src/resume_ocr_worker/types.py`
- Create: `services/ocr-worker/tests/test_app.py`

**Interfaces:**
- Produces: `create_app(backend, settings) -> FastAPI`.
- Consumes: `OcrBackend` with model metadata, readiness, and `recognize(image_bytes)`.
- Produces: `GET /healthz`, `GET /readyz`, and `POST /v1/ocr` matching Task 1.

- [ ] **Step 1: Create package metadata and failing API tests**

```toml
[project]
name = "resume-ocr-worker"
version = "0.1.0"
requires-python = "==3.12.*"
dependencies = [
  "fastapi==0.115.12",
  "uvicorn[standard]==0.34.3",
  "pydantic==2.11.7",
  "Pillow==11.2.1"
]

[project.optional-dependencies]
test = ["pytest==8.4.1", "httpx==0.28.1"]
```

```py
def test_ocr_accepts_png_bytes_and_returns_markdown(client, token):
    response = client.post(
        "/v1/ocr",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "image/png"},
        content=PNG_BYTES,
    )
    assert response.status_code == 200
    assert response.json()["text"] == "# Resume\nAda Lovelace"
    assert response.json()["mode"] == "document_to_markdown"
```

Add tests for no auth, wrong media type, caller URL JSON, invalid image bytes, decompression-bomb dimensions, body over 20 MiB, backend not ready, backend exception, concurrent requests being serialized, and logs excluding bytes/output/token.

- [ ] **Step 2: Run tests and verify failure**

Run: `python -m pytest services/ocr-worker/tests/test_app.py -q`

Expected: FAIL because the Worker package is missing.

- [ ] **Step 3: Implement raw-body validation and serialized inference**

```py
class OcrBackend(Protocol):
    model: str
    revision: str
    @property
    def ready(self) -> bool: ...
    def recognize(self, image_bytes: bytes) -> str: ...
```

Leave `/healthz` unauthenticated but return only `{ "status": "alive" }`; require the bearer token for `/readyz` and `/v1/ocr`. Validate `Content-Length`, read at most 20 MiB, require `image/png` or `image/jpeg`, and use Pillow `verify()`. Reject width or height above 10,000 pixels and total image area above 40,000,000 pixels. Run inference as:

```py
async with app.state.inference_lock:
    text = await asyncio.to_thread(backend.recognize, image_bytes)
```

Reject blank output. Return only model metadata, mode, text, and elapsed milliseconds. Log request metadata but no document content.

- [ ] **Step 4: Run CPU-only contract tests and commit**

Run: `python -m pytest services/ocr-worker/tests/test_app.py -q`

Expected: PASS without torch, transformers, or a GPU.

```bash
git add services/ocr-worker
git commit -m "feat: add OCR worker contract"
```

### Task 4: Implement pinned offline DeepSeek-OCR 2 inference

**Files:**
- Create: `services/ocr-worker/src/resume_ocr_worker/config.py`
- Create: `services/ocr-worker/src/resume_ocr_worker/model.py`
- Create: `services/ocr-worker/src/resume_ocr_worker/main.py`
- Create: `services/ocr-worker/tests/test_config.py`
- Create: `services/ocr-worker/tests/test_model.py`
- Create: `services/ocr-worker/requirements.lock`
- Create: `services/ocr-worker/model-manifest.json`

**Interfaces:**
- Produces: `DeepSeekOcrBackend` and `python -m resume_ocr_worker.main`.
- Guarantees: custom code and model files come only from the pinned local snapshot.

- [ ] **Step 1: Write failing offline and GPU-isolation tests**

```py
def test_settings_pin_gpu_model_and_loopback(tmp_path):
    settings = load_settings({
        "CUDA_VISIBLE_DEVICES": "5",
        "OCR_MODEL_PATH": str(tmp_path),
        "OCR_MODEL": MODEL,
        "OCR_MODEL_REVISION": REVISION,
        "OCR_API_TOKEN_FILE": str(token_file(tmp_path)),
    })
    assert settings.device == "cuda:0"
    assert settings.host == "127.0.0.1"
    assert settings.port == 43121
```

Reject wrong GPU, revision, manifest hash, token mode, model directory, or host. Test environment validation before importing the model's custom code.

- [ ] **Step 2: Run tests and verify failure**

Run: `python -m pytest services/ocr-worker/tests/test_config.py services/ocr-worker/tests/test_model.py -q`

Expected: FAIL because settings and backend are missing.

- [ ] **Step 3: Load the pinned model offline**

```py
self._tokenizer = AutoTokenizer.from_pretrained(
    settings.model_path,
    trust_remote_code=True,
    local_files_only=True,
)
self._model = AutoModel.from_pretrained(
    settings.model_path,
    trust_remote_code=True,
    local_files_only=True,
    use_safetensors=True,
    _attn_implementation="flash_attention_2",
).eval().cuda().to(torch.bfloat16)
```

Set `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1` before imports. Confirm the local manifest revision equals the configured revision. Do not pass a remote model ID to `from_pretrained`.

- [ ] **Step 4: Implement temporary-file inference with unconditional cleanup**

The official custom method requires paths. Create a private `TemporaryDirectory` under configured `~/resume-ai/tmp`, write one generated input filename, and call:

```py
result = self._model.infer(
    self._tokenizer,
    prompt="<image>\n<|grounding|>Convert the document to markdown.",
    image_file=str(image_path),
    output_path=str(output_dir),
    base_size=1024,
    image_size=768,
    crop_mode=True,
    save_results=True,
)
```

Normalize the returned string or the single generated result file into Markdown. If neither contains nonblank text, raise `OcrInferenceError`. The temporary directory context must remove input and output files for success, model exception, timeout cancellation, and parsing failure.

- [ ] **Step 5: Unit test model calls and cleanup with injected modules**

Mock `AutoTokenizer`, `AutoModel`, torch, and the custom `infer` method. Assert BF16, Flash Attention, offline local path, exact prompt, dimensions, one generated file, and zero leftover temporary files after both success and exception.

- [ ] **Step 6: Lock the official-compatible Linux runtime**

Resolve and hash this direct baseline in Linux x86-64:

```text
torch==2.6.0+cu118
torchvision==0.21.0+cu118
torchaudio==2.6.0+cu118
transformers==4.46.3
tokenizers==0.20.3
flash-attn==2.7.3
PyMuPDF
img2pdf
einops
easydict
addict
Pillow==11.2.1
numpy
fastapi==0.115.12
uvicorn==0.34.3
```

Generate `requirements.lock` with hashes. Store the reviewed custom Python files and all model file SHA-256 values in `model-manifest.json`.

- [ ] **Step 7: Run Worker unit tests and commit**

Run: `python -m pytest services/ocr-worker/tests -q`

Expected: PASS without loading the real model.

```bash
git add services/ocr-worker
git commit -m "feat: load DeepSeek OCR model offline"
```

### Task 5: Map remote OCR failures into profile-import behavior

**Files:**
- Modify: `apps/api/src/profile/import-service.ts`
- Modify: `apps/api/src/profile/import-service.test.ts`
- Modify: `apps/api/src/profile/profile-routes.test.ts`
- Create: `apps/api/src/profile/production-extraction.ts`
- Create: `apps/api/src/profile/production-extraction.test.ts`

**Interfaces:**
- Produces: `createProductionExtraction({ structuredProvider?, ocrEngine? })`.
- Guarantees: native-text PDFs can import without OCR; scanned pages return the existing public `503` when OCR is unavailable.

- [ ] **Step 1: Write failing degraded-import tests**

```ts
it("imports a native-text PDF while OCR is unavailable", async () => {
  const extraction = createProductionExtraction({ structuredProvider, ocrEngine: undefined });
  await expect(extraction.extractPdf(nativeTextPdf)).resolves.toMatchObject({
    pages: [expect.objectContaining({ source: "pdf_text" })]
  });
});

it("maps a scanned-page OCR outage to ProfileImportUnavailableError", async () => {
  const extraction = createProductionExtraction({ structuredProvider, ocrEngine: undefined });
  await expect(extraction.extractPdf(scannedPdf)).rejects.toBeInstanceOf(ProfileImportUnavailableError);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `corepack pnpm --filter @resume/api test -- production-extraction.test.ts profile-routes.test.ts`

Expected: FAIL because the production extraction wrapper does not exist.

- [ ] **Step 3: Implement unavailable adapters at the composition boundary**

Supply an `UnavailableOcrEngine` whose `recognize` throws a private typed error. `createProductionExtraction.extractPdf` catches only remote/unavailable OCR errors and rethrows `ProfileImportUnavailableError`; malformed PDF errors and programming defects retain their existing mappings. `extractFacts` similarly throws `ProfileImportUnavailableError` when no structured provider is configured.

- [ ] **Step 4: Run import and route suites**

Run: `corepack pnpm --filter @resume/profile-domain test && corepack pnpm --filter @resume/api test -- import-service.test.ts profile-routes.test.ts production-extraction.test.ts`

Expected: PASS; native-text import does not call OCR and scanned outage returns `503 Profile import is temporarily unavailable`.

- [ ] **Step 5: Commit degraded extraction behavior**

```bash
git add apps/api/src/profile
git commit -m "feat: degrade profile import around OCR outages"
```

## Plan 3 Completion Gate

- The Node OCR client validates model identity and never leaks response content or tokens.
- Native PDF text is preferred and suspicious pages alone are rendered for OCR.
- Worker HTTP tests pass without a GPU and serialize inference.
- DeepSeek-OCR 2 loads only from the pinned, hash-checked local snapshot.
- Temporary image/output files are deleted on every path.
- OCR evidence remains page-bound and marked `source=ocr` for downstream review.
