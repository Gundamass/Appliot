# Task 3 Report: PDF Text Extraction with OCR Fallback

## Status

Implemented Task 3 in `E:\projects\简历投递助手\.worktrees\resume-assistant-foundation` with test-first development.

Implementation commit: `b45375e` (`feat: extract resume pdf with ocr fallback`).

The new `@resume/profile-domain` package accepts PDF bytes and an injected `OcrEngine`, returns page-level extraction provenance, computes a stable SHA-256 fingerprint from the original bytes, and renders actual PNG page images only when PDF text extraction is empty.

## RED

Command:

```powershell
corepack pnpm --filter @resume/profile-domain test -- extract-pdf.test.ts
```

Output:

```text
Test Files  1 failed (1)
Tests       no tests
Error: Cannot find module './extract-pdf.js' imported from
'.../packages/profile-domain/src/pdf/extract-pdf.test.ts'
```

Exit code: `1`.

This was the expected missing-implementation failure. The test had already specified all required behavior:

- pages retain their one-based PDF page numbers and input order;
- non-empty PDF text is preserved as `pdf_text`, including a deliberately short text page;
- only the empty page invokes injected OCR;
- OCR receives a PNG with the standard eight-byte PNG signature, proving real page rendering rather than a placeholder;
- duplicate byte sequences produce the same 64-character lowercase SHA-256 fingerprint.

## GREEN

Focused test command:

```powershell
corepack pnpm --filter @resume/profile-domain test -- extract-pdf.test.ts
```

Final output:

```text
Test Files  1 passed (1)
Tests       2 passed (2)
Exit code: 0
```

Package verification:

```powershell
corepack pnpm --filter @resume/profile-domain typecheck
corepack pnpm --filter @resume/profile-domain build
```

Final output: both commands exited `0`.

Root verification:

```powershell
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
git diff --check
```

Final output:

```text
corepack pnpm test: 3 workspace test files passed, 19 tests passed total
  @resume/contracts: 5 passed
  @resume/profile-domain: 2 passed
  @resume/api: 12 passed
corepack pnpm typecheck: exit 0
corepack pnpm build: exit 0
git diff --check: exit 0
```

## Implementation

- `packages/profile-domain/src/pdf/types.ts` defines `ExtractedPage`, `ExtractedDocument`, and the injected `OcrEngine` contract.
- `extractPdf` loads PDFs through Node-targeted `pdfjs-dist/legacy`, reads page text in ascending page order, and routes only empty text pages to OCR.
- `ocr.ts` uses `@napi-rs/canvas` at 2x scale to render those fallback pages to PNG before calling OCR. The rendering dependency is isolated in the profile-domain package; no browser-facing package imports Node PDF worker or canvas behavior.
- PDF.js receives the native resolved `standard_fonts` path so the Unicode Windows worktree can render without font warnings. The path is normalized to PDF.js's required trailing forward slash.
- The test fixture helper uses pinned `pdf-lib@1.17.1` to generate deterministic multi-page PDFs without checked-in binary fixtures.
- Pinned runtime dependencies are `pdfjs-dist@5.3.31` and `@napi-rs/canvas@0.1.70`; the lockfile was regenerated with Corepack pnpm 10.13.1.

## Files

- `package.json`
- `pnpm-lock.yaml`
- `packages/profile-domain/package.json`
- `packages/profile-domain/src/pdf/types.ts`
- `packages/profile-domain/src/pdf/extract-pdf.ts`
- `packages/profile-domain/src/pdf/ocr.ts`
- `packages/profile-domain/src/pdf/extract-pdf.test.ts`
- `tests/fixtures/create-pdf.ts`

## Self-Review

Reviewed `b45375e` against the task brief and final diff.

- No unnecessary OCR: fallback condition is `text.length === 0`; short but valid PDF text never invokes OCR.
- Determinism: page loading/rendering and result assembly are sequential from page 1 through `numPages`; fingerprint hashes the untouched original bytes.
- Rendering: the OCR test verifies a real PNG byte signature generated from the empty PDF page.
- Boundaries: model extraction, HTTP APIs, RAG, browser automation, and a concrete Tesseract worker implementation remain out of scope.
- Scope: only the requested domain, test fixture, root test-only dependency, and lockfile changed.

## Concerns

- OCR language-model execution is intentionally not implemented here; callers supply an `OcrEngine` in a later composition layer.
- `@napi-rs/canvas` is a native optional-platform dependency used only by the Node profile-domain renderer. It installed and rendered successfully on the current Windows environment.
- `pnpm install` emitted the pre-existing non-fatal `prebuild-install@7.1.3` deprecation warning. It did not affect test, typecheck, or build results.

## Review Fixes

### Findings Verified

All four Important findings were reproduced against commit `b45375e` before changing production code:

- The parser received a defensive copy, but the fingerprint was calculated from caller-owned bytes after OCR awaited. Mutating those bytes in `recognize` produced a fingerprint different from the parsed document snapshot.
- Any non-empty string was treated as usable PDF text; there was no visible-evidence predicate for controls, format characters, or separator-only text.
- `PDFPageProxy.cleanup()` was never called when OCR rejected; an observed real proxy-prototype spy reported zero cleanup calls.
- The original fallback fixture was a blank vector PDF page and asserted only the PNG signature.

The stated Minor `hasEOL` finding was technically valid and fixed. `TextItem.hasEOL` boundaries are preserved as `\n`, with a regression test for two lines. The other Minor disposition is that no separately actionable second Minor finding was included in the review material supplied for this fix; no unrelated architecture or scope change was made.

### RED

Command:

```powershell
corepack pnpm --filter @resume/profile-domain test -- extract-pdf.test.ts
```

Output summary:

```text
Test Files  1 failed (1)
Tests       4 failed | 3 passed (7)
Exit code: 1
```

Expected failures were:

- snapshot race: SHA-256 of caller bytes mutated during OCR differed from the original snapshot hash;
- `hasUsablePdfText` was missing for invisible-only text;
- line breaks were collapsed to spaces;
- observed `PDFPageProxy.cleanup` calls were `0` after an OCR error.

An earlier fixture-mechanics RED run additionally confirmed these same production failures after correcting the assembled page order and obtaining a real PDF.js page prototype for cleanup observation.

### GREEN

Focused commands:

```powershell
corepack pnpm --filter @resume/profile-domain test -- extract-pdf.test.ts
corepack pnpm --filter @resume/profile-domain typecheck
corepack pnpm --filter @resume/profile-domain build
```

Output:

```text
extract-pdf.test.ts: 1 test file passed, 7 tests passed, exit 0
profile-domain typecheck: exit 0
profile-domain build: exit 0
```

Covering verification commands:

```powershell
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
git diff --check
```

Output:

```text
root test: 3 test files passed, 24 tests passed total
  @resume/contracts: 5 passed
  @resume/profile-domain: 7 passed
  @resume/api: 12 passed
root typecheck: exit 0
root build: exit 0
git diff --check: exit 0
```

### Test Files

- `packages/profile-domain/src/pdf/extract-pdf.test.ts`
- `tests/fixtures/create-pdf.ts`

### Changes

- `extractPdf` now takes one `Uint8Array` snapshot and hashes it before asynchronous parsing or OCR; PDF.js receives that same snapshot.
- `hasUsablePdfText` removes whitespace, Unicode controls, format characters, and separators before deciding whether OCR is required. It has no arbitrary minimum character count.
- Every acquired PDF page is released with `page.cleanup()` in a per-page `finally`; `loadingTask.destroy()` remains the top-level cleanup.
- The generated OCR fixture embeds a deterministic scanned-style raster page with visible dark and red marks. The test decodes the OCR PNG, asserts its rendered 612x792 dimensions, and asserts non-white content pixels.
- `textFromPage` preserves PDF.js `hasEOL` line boundaries while retaining deterministic item order.
- OCR error and malformed-PDF propagation are covered. The malformed-PDF case causes PDF.js's expected `Warning: Indexing all PDF objects` recovery diagnostic but rejects as asserted.

## Re-Review Fixes

### RED

Command:

```powershell
corepack pnpm --filter @resume/profile-domain test -- extract-pdf.test.ts
```

Output:

```text
Test Files  1 failed (1)
Tests       1 failed | 6 passed (7)
Exit code: 1
```

The failure was expected: `hasUsablePdfText("\\u0000\\u200B\\u200C\\u200D\\u2060\\uFE0F\\uFEFF")` returned `true` because standalone variation selector U+FE0F is Unicode category `Mn` and was not removed. The same test specified that `A\\u0301` must remain usable, proving no arbitrary text-length threshold.

The OCR rendering test was also upgraded before the RED run. It decodes the OCR PNG and requires more than 1,000 fully opaque dark pixels plus more than 100 fully opaque red-mark pixels. Those assertions passed with the existing deterministic scanned fixture and reject transparent/blank output that the earlier alpha-blind RGB check could accept.

### GREEN

Commands:

```powershell
corepack pnpm --filter @resume/profile-domain test -- extract-pdf.test.ts
corepack pnpm --filter @resume/profile-domain typecheck
corepack pnpm --filter @resume/profile-domain build
git diff --check
```

Output:

```text
extract-pdf.test.ts: 1 test file passed, 7 tests passed, exit 0
profile-domain typecheck: exit 0
profile-domain build: exit 0
git diff --check: exit 0
```

### Changes and Minor Disposition

- `hasUsablePdfText` now also removes Unicode marks (`\p{M}`) for visibility evaluation, so mark-only strings fall back to OCR while base characters with combining marks remain usable.
- The deterministic scanned-fixture assertion is alpha-aware and tied to its actual dark/resume-line and red/footer mark colors.
- Encrypted/password-PDF propagation remains deferred Minor: existing `pdf-lib@1.17.1` can detect/read encrypted input but does not create a password-encrypted PDF, and adding encryption tooling or a binary fixture would expand scope/dependencies. The extractor already propagates PDF.js loading errors; a deterministic encrypted fixture belongs in a later dedicated ingestion-fixture task.
