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
