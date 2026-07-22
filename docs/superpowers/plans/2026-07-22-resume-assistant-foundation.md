# Resume Assistant Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local application that imports a PDF resume, creates a source-backed editable profile, runs the plan/retrieve/verify/question/correct RAG loop, and requires review before using a job-tailored self-evaluation.

**Architecture:** A pnpm TypeScript monorepo contains a React web client, a Fastify local API, and focused domain packages. SQLite stores documents, evidence, profile facts, revisions, task-scoped answers, and embeddings; model access is hidden behind a provider interface so tests use deterministic fakes.

**Tech Stack:** Node.js 24.14.1, pnpm 10.13.1, TypeScript 5.8.3, React 19.1.0, Vite 6.3.5, Fastify 5.4.0, Zod 3.25.67, Drizzle ORM 0.44.2, better-sqlite3 11.10.0, Vitest 3.2.4, Testing Library 16.3.0, pdfjs-dist 5.3.31, tesseract.js 6.0.1

## Global Constraints

- Run entirely on the user's machine; bind the API to `127.0.0.1` only.
- PDF originals, structured facts, evidence, indexes, and task records remain local.
- An extracted fact is never eligible for automatic filling until the user confirms or corrects it.
- Every generated value carries evidence, confidence, scope, and decision status.
- Task-scoped answers override profile facts only inside that task and never become profile defaults without explicit user action.
- Self-evaluation changes require user review and do not replace the base self-evaluation by default.
- Do not implement browser control in this plan; Plan 2 owns that boundary.

---

## File Structure

```text
package.json                         Workspace scripts and pinned package manager
pnpm-workspace.yaml                  Workspace package discovery
tsconfig.base.json                   Shared strict TypeScript settings
tsconfig.json                        Whole-workspace typecheck project
vitest.workspace.ts                  Cross-package test discovery
apps/api/                            Local Fastify API and SQLite composition root
apps/web/                            React profile and review UI
packages/contracts/                  Zod schemas shared by API and UI
packages/profile-domain/             PDF ingestion, facts, evidence, and revisions
packages/rag/                        Retrieval planning, ranking, verification, questions
packages/model-provider/             Provider interface and deterministic test provider
tests/fixtures/                      Generated test-document helpers and static text fixtures
```

### Task 1: Bootstrap the workspace and shared contracts

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`
- Create: `vitest.workspace.ts`
- Create: `.gitignore`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/src/profile.ts`
- Create: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/profile.test.ts`

**Interfaces:**
- Consumes: Nothing; this is the root contract task.
- Produces: `ProfileFact`, `Evidence`, `FactStatus`, `FactScope`, `DecisionStatus`, and their Zod schemas.

- [ ] **Step 1: Enable the pinned package manager and write the failing contract test**

Run: `corepack prepare pnpm@10.13.1 --activate`
Expected: command exits 0; `pnpm --version` prints `10.13.1`.

Create the workspace files with these contents, then add the failing test:

```json filename=package.json
{
  "name": "resume-application-assistant",
  "private": true,
  "packageManager": "pnpm@10.13.1",
  "engines": { "node": ">=24.14.1" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "build": "pnpm -r build"
  },
  "devDependencies": {
    "@types/node": "24.0.0",
    "typescript": "5.8.3",
    "vitest": "3.2.4"
  }
}
```

```yaml filename=pnpm-workspace.yaml
packages:
  - apps/*
  - packages/*
```

```json filename=tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noEmit": true,
    "skipLibCheck": true
  }
}
```

```json filename=tsconfig.json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "allowImportingTsExtensions": true,
    "jsx": "react-jsx"
  },
  "include": ["apps/**/*.ts", "apps/**/*.tsx", "packages/**/*.ts", "packages/**/*.tsx", "tests/**/*.ts", "tests/**/*.tsx"]
}
```

```ts filename=vitest.workspace.ts
import { defineWorkspace } from "vitest/config";

export default defineWorkspace(["packages/*/vite.config.ts", "apps/*/vite.config.ts"]);
```

```text filename=.gitignore
node_modules/
dist/
.env*
data/
playwright-report/
test-results/
```

```json filename=packages/contracts/package.json
{
  "name": "@resume/contracts",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit -p ../../tsconfig.json" },
  "dependencies": { "zod": "3.25.67" }
}
```

```ts filename=packages/contracts/src/index.ts
export * from "./profile";
```

Test this behavior:

```ts
import { describe, expect, it } from "vitest";
import { ProfileFactSchema } from "./profile";

describe("ProfileFactSchema", () => {
  it("rejects an extracted fact without source evidence", () => {
    const result = ProfileFactSchema.safeParse({
      id: "fact-1",
      fieldPath: "basics.email",
      value: "me@example.com",
      status: "extracted",
      confidence: 0.9,
      scope: "profile",
      revision: 1
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the contract test and verify failure**

Run: `pnpm install && pnpm --filter @resume/contracts test`
Expected: FAIL because `./profile` does not exist.

- [ ] **Step 3: Implement the shared fact and evidence schemas**

```ts
import { z } from "zod";

export const FactStatusSchema = z.enum([
  "extracted",
  "user_confirmed",
  "user_corrected",
  "superseded"
]);
export const FactScopeSchema = z.enum(["profile", "application"]);
export const DecisionStatusSchema = z.enum([
  "verified_auto",
  "needs_review",
  "needs_question",
  "blocked"
]);
export const EvidenceSchema = z.object({
  documentId: z.string().min(1),
  page: z.number().int().positive(),
  text: z.string().min(1),
  extraction: z.enum(["pdf_text", "ocr", "user"])
});
export const ProfileFactSchema = z.object({
  id: z.string().min(1),
  fieldPath: z.string().min(1),
  value: z.unknown(),
  status: FactStatusSchema,
  confidence: z.number().min(0).max(1),
  scope: FactScopeSchema,
  taskId: z.string().min(1).optional(),
  evidence: z.array(EvidenceSchema).min(1),
  revision: z.number().int().positive()
}).superRefine((fact, context) => {
  if (fact.scope === "application" && !fact.taskId) {
    context.addIssue({ code: "custom", message: "application facts require taskId" });
  }
});

export type ProfileFact = z.infer<typeof ProfileFactSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type FactStatus = z.infer<typeof FactStatusSchema>;
export type FactScope = z.infer<typeof FactScopeSchema>;
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;
```

- [ ] **Step 4: Run workspace checks**

Run: `pnpm --filter @resume/contracts test && pnpm --filter @resume/contracts typecheck`
Expected: PASS with one test and no TypeScript errors.

- [ ] **Step 5: Commit the workspace contract**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json tsconfig.json vitest.workspace.ts .gitignore packages/contracts
git commit -m "chore: bootstrap resume assistant workspace"
```

### Task 2: Add SQLite persistence and fact revision rules

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/src/db/client.ts`
- Create: `apps/api/src/db/schema.ts`
- Create: `apps/api/src/db/migrate.ts`
- Create: `apps/api/src/profile/profile-repository.ts`
- Test: `apps/api/src/profile/profile-repository.test.ts`

**Interfaces:**
- Consumes: `ProfileFact` from `@resume/contracts`.
- Produces: `ProfileRepository.createExtracted`, `confirm`, `correct`, `listActive`, and `resolveForTask`.

- [ ] **Step 1: Write failing repository tests**

```ts
it("keeps revisions and resolves task answers before profile defaults", () => {
  const repository = createTestProfileRepository();
  repository.createExtracted(makeFact("杭州"));
  repository.confirm("fact-1");
  repository.correct("fact-1", "上海", userEvidence("上海"));
  repository.putTaskAnswer("task-1", "preferences.city", "深圳", userEvidence("深圳"));

  expect(repository.resolveForTask("task-1", "preferences.city")?.value).toBe("深圳");
  expect(repository.resolveForTask("task-2", "preferences.city")?.value).toBe("上海");
  expect(repository.history("fact-1")).toHaveLength(2);
});
```

- [ ] **Step 2: Run the repository test and verify failure**

Run: `pnpm --filter @resume/api test -- profile-repository.test.ts`
Expected: FAIL because the repository is not implemented.

- [ ] **Step 3: Implement schema, migration, and transactional repository**

Use tables `documents`, `document_chunks`, `profile_facts`, `fact_revisions`, `application_answers`, and `embeddings`. Enforce `task_id IS NOT NULL` for application scope and expose this exact resolver:

```ts
export interface ProfileRepository {
  createExtracted(fact: ProfileFact): ProfileFact;
  confirm(factId: string): ProfileFact;
  correct(factId: string, value: unknown, evidence: Evidence[]): ProfileFact;
  putTaskAnswer(taskId: string, fieldPath: string, value: unknown, evidence: Evidence[]): ProfileFact;
  resolveForTask(taskId: string, fieldPath: string): ProfileFact | undefined;
  listActive(): ProfileFact[];
  history(factId: string): ProfileFact[];
}
```

Implement `resolveForTask` as: current-task confirmed answer, active `user_corrected` profile fact, then active `user_confirmed` profile fact. Never return `extracted` or `superseded`.

- [ ] **Step 4: Verify migration and repository behavior**

Run: `pnpm --filter @resume/api test -- profile-repository.test.ts`
Expected: PASS, including revision and task-scope assertions.

- [ ] **Step 5: Commit persistence**

```bash
git add apps/api
git commit -m "feat: persist source-backed profile facts"
```

### Task 3: Extract PDF text with OCR fallback

**Files:**
- Create: `packages/profile-domain/package.json`
- Create: `packages/profile-domain/src/pdf/types.ts`
- Create: `packages/profile-domain/src/pdf/extract-pdf.ts`
- Create: `packages/profile-domain/src/pdf/ocr.ts`
- Create: `tests/fixtures/create-pdf.ts`
- Test: `packages/profile-domain/src/pdf/extract-pdf.test.ts`

**Interfaces:**
- Consumes: PDF bytes and an injected `OcrEngine`.
- Produces: `extractPdf(bytes, ocr): Promise<ExtractedDocument>` with page-level source type and text.

- [ ] **Step 1: Write failing text and OCR tests**

```ts
it("preserves page numbers and uses OCR only for empty pages", async () => {
  const pdf = await createPdf(["张三\nme@example.com", ""]);
  const ocr = { recognize: vi.fn().mockResolvedValue("扫描页项目经历") };
  const result = await extractPdf(pdf, ocr);

  expect(result.pages).toEqual([
    expect.objectContaining({ page: 1, source: "pdf_text", text: expect.stringContaining("张三") }),
    expect.objectContaining({ page: 2, source: "ocr", text: "扫描页项目经历" })
  ]);
  expect(ocr.recognize).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run PDF tests and verify failure**

Run: `pnpm --filter @resume/profile-domain test -- extract-pdf.test.ts`
Expected: FAIL because `extractPdf` is missing.

- [ ] **Step 3: Implement page extraction and injected OCR**

```ts
export interface ExtractedPage {
  page: number;
  text: string;
  source: "pdf_text" | "ocr";
}
export interface ExtractedDocument { fingerprint: string; pages: ExtractedPage[]; }
export interface OcrEngine { recognize(image: Uint8Array, language: "chi_sim+eng"): Promise<string>; }

export async function extractPdf(bytes: Uint8Array, ocr: OcrEngine): Promise<ExtractedDocument> {
  const document = await getDocument({ data: bytes }).promise;
  const pages: ExtractedPage[] = [];
  for (let index = 1; index <= document.numPages; index += 1) {
    const page = await document.getPage(index);
    const content = await page.getTextContent();
    const text = content.items.map(item => "str" in item ? item.str : "").join(" ").trim();
    if (text.length > 20) pages.push({ page: index, text, source: "pdf_text" });
    else pages.push({ page: index, text: await ocr.recognize(await renderPage(page), "chi_sim+eng"), source: "ocr" });
  }
  return { fingerprint: createHash("sha256").update(bytes).digest("hex"), pages };
}
```

- [ ] **Step 4: Verify extraction and duplicate fingerprints**

Run: `pnpm --filter @resume/profile-domain test -- extract-pdf.test.ts`
Expected: PASS for text pages, OCR fallback, page numbering, and deterministic fingerprint.

- [ ] **Step 5: Commit PDF ingestion**

```bash
git add packages/profile-domain tests/fixtures
git commit -m "feat: extract resume pdf with ocr fallback"
```

### Task 4: Extract facts through a validated model-provider boundary

**Files:**
- Create: `packages/model-provider/package.json`
- Create: `packages/model-provider/src/provider.ts`
- Create: `packages/model-provider/src/fake-provider.ts`
- Create: `packages/profile-domain/src/extraction/extraction-schema.ts`
- Create: `packages/profile-domain/src/extraction/extract-facts.ts`
- Test: `packages/profile-domain/src/extraction/extract-facts.test.ts`

**Interfaces:**
- Consumes: `ExtractedDocument` and `ModelProvider.generateStructured`.
- Produces: `extractFacts(document, provider): Promise<ProfileFact[]>`.

- [ ] **Step 1: Write failing evidence-validation tests**

```ts
it("rejects a model fact whose quoted evidence is absent from the page", async () => {
  const provider = new FakeModelProvider({
    facts: [{ fieldPath: "skills[0]", value: "Rust", page: 1, quote: "精通 Rust", confidence: 0.9 }]
  });
  await expect(extractFacts(documentWithPage("熟悉 TypeScript"), provider))
    .rejects.toThrow("evidence quote not found on page 1");
});
```

- [ ] **Step 2: Run extraction tests and verify failure**

Run: `pnpm --filter @resume/profile-domain test -- extract-facts.test.ts`
Expected: FAIL because the provider boundary and extractor do not exist.

- [ ] **Step 3: Implement structured extraction and source checks**

```ts
export interface ModelProvider {
  generateStructured<T>(input: { system: string; user: string; schema: z.ZodType<T> }): Promise<T>;
  embed(texts: string[]): Promise<number[][]>;
}

export async function extractFacts(document: ExtractedDocument, provider: ModelProvider): Promise<ProfileFact[]> {
  const output = await provider.generateStructured({ system: EXTRACTION_RULES, user: serializePages(document.pages), schema: ExtractionSchema });
  return output.facts.map(candidate => {
    const page = document.pages.find(item => item.page === candidate.page);
    if (!page?.text.includes(candidate.quote)) throw new Error(`evidence quote not found on page ${candidate.page}`);
    return ProfileFactSchema.parse({
      id: randomUUID(), fieldPath: candidate.fieldPath, value: candidate.value,
      status: "extracted", confidence: candidate.confidence, scope: "profile", revision: 1,
      evidence: [{ documentId: document.fingerprint, page: candidate.page, text: candidate.quote, extraction: page.source }]
    });
  });
}
```

- [ ] **Step 4: Verify valid extraction, malformed output, and unsupported claims**

Run: `pnpm --filter @resume/profile-domain test -- extract-facts.test.ts`
Expected: PASS with all provider output parsed by Zod and every quote checked against source text.

- [ ] **Step 5: Commit model boundary and extraction**

```bash
git add packages/model-provider packages/profile-domain
git commit -m "feat: extract evidence-backed resume facts"
```

### Task 5: Expose profile import, confirmation, and correction APIs

**Files:**
- Create: `apps/api/src/app.ts`
- Create: `apps/api/src/server.ts`
- Create: `apps/api/src/profile/profile-routes.ts`
- Create: `apps/api/src/profile/import-service.ts`
- Test: `apps/api/src/profile/profile-routes.test.ts`

**Interfaces:**
- Consumes: PDF extractor, fact extractor, and `ProfileRepository`.
- Produces: `POST /api/documents`, `GET /api/profile/facts`, `POST /api/profile/facts/:id/confirm`, and `POST /api/profile/facts/:id/correct`.

- [ ] **Step 1: Write failing API tests**

```ts
it("imports facts as extracted and requires explicit confirmation", async () => {
  const app = buildTestApp();
  const upload = await app.inject({ method: "POST", url: "/api/documents", payload: testMultipartPdf });
  expect(upload.statusCode).toBe(202);
  const facts = await app.inject({ method: "GET", url: "/api/profile/facts" });
  expect(facts.json()[0]).toMatchObject({ status: "extracted", evidence: [expect.any(Object)] });
});
```

- [ ] **Step 2: Run route tests and verify failure**

Run: `pnpm --filter @resume/api test -- profile-routes.test.ts`
Expected: FAIL with route not found.

- [ ] **Step 3: Implement loopback-only Fastify routes**

Build `createApp(dependencies)` without listening, validate every request and response with Zod, limit PDF size to 15 MiB, reject non-PDF content, and start production with:

```ts
const app = await createApp(createProductionDependencies());
await app.listen({ host: "127.0.0.1", port: 43120 });
```

- [ ] **Step 4: Verify import, duplicate file, confirmation, correction, and invalid payloads**

Run: `pnpm --filter @resume/api test -- profile-routes.test.ts`
Expected: PASS with `202` import, `409` duplicate fingerprint, `200` confirmation/correction, and `400` invalid input.

- [ ] **Step 5: Commit profile APIs**

```bash
git add apps/api
git commit -m "feat: add local profile management api"
```

### Task 6: Build the profile review web experience

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/profile/ProfilePage.tsx`
- Create: `apps/web/src/profile/FactEditor.tsx`
- Create: `apps/web/src/profile/EvidenceDrawer.tsx`
- Test: `apps/web/src/profile/ProfilePage.test.tsx`

**Interfaces:**
- Consumes: profile HTTP endpoints from Task 5.
- Produces: upload, grouped fact review, evidence inspection, confirmation, and correction UI.

- [ ] **Step 1: Write failing interaction tests**

```tsx
it("does not mark an extracted email ready until the user confirms it", async () => {
  render(<ProfilePage api={fakeProfileApi(extractedEmailFact)} />);
  expect(await screen.findByText("待确认")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "查看来源" }));
  expect(screen.getByText("resume.pdf · 第 1 页")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "确认" }));
  expect(await screen.findByText("已确认")).toBeVisible();
});
```

- [ ] **Step 2: Run UI test and verify failure**

Run: `pnpm --filter @resume/web test -- ProfilePage.test.tsx`
Expected: FAIL because `ProfilePage` is missing.

- [ ] **Step 3: Implement the profile page**

Use unframed sections for categories, a compact status filter, semantic form controls, an evidence drawer, and explicit confirm/correct commands. Do not hide statuses in chat text. Keep all API effects behind this interface:

```ts
export interface ProfileApi {
  upload(file: File): Promise<{ documentId: string }>;
  listFacts(): Promise<ProfileFact[]>;
  confirm(factId: string): Promise<ProfileFact>;
  correct(factId: string, value: unknown): Promise<ProfileFact>;
}
```

- [ ] **Step 4: Verify desktop and narrow layouts**

Run: `pnpm --filter @resume/web test && pnpm --filter @resume/web build`
Expected: PASS; the build completes and interaction tests cover upload, evidence, confirm, and correct.

- [ ] **Step 5: Commit the profile UI**

```bash
git add apps/web
git commit -m "feat: add source-backed profile review ui"
```

### Task 7: Implement retrieval planning, verification, questions, and corrections

**Files:**
- Create: `packages/rag/package.json`
- Create: `packages/rag/src/types.ts`
- Create: `packages/rag/src/planner.ts`
- Create: `packages/rag/src/retriever.ts`
- Create: `packages/rag/src/verifier.ts`
- Create: `packages/rag/src/questions.ts`
- Create: `packages/rag/src/corrections.ts`
- Test: `packages/rag/src/rag-loop.test.ts`

**Interfaces:**
- Consumes: `ProfileRepository`, `ModelProvider`, normalized field semantics, and optional job description.
- Produces: `resolveField(request): Promise<FieldDecision>` and `applyAnswer(answer): ProfileFact`.

- [ ] **Step 1: Write failing RAG-loop tests**

```ts
it("asks instead of inventing an unsupported certificate", async () => {
  const decision = await service.resolveField({
    taskId: "task-1", fieldId: "field-9", semantic: "certificates.pmp",
    label: "是否持有 PMP", type: "boolean"
  });
  expect(decision).toMatchObject({ status: "needs_question", value: undefined });
  expect(decision.question).toContain("PMP");
});

it("returns a confirmed exact field with evidence", async () => {
  const decision = await service.resolveField(confirmedEmailRequest);
  expect(decision).toMatchObject({ status: "verified_auto", value: "me@example.com" });
  expect(decision.evidence).toHaveLength(1);
});
```

- [ ] **Step 2: Run RAG tests and verify failure**

Run: `pnpm --filter @resume/rag test -- rag-loop.test.ts`
Expected: FAIL because `resolveField` is missing.

- [ ] **Step 3: Implement typed planning and layered retrieval**

```ts
export interface FieldRequest {
  taskId: string;
  fieldId: string;
  semantic: string;
  label: string;
  type: "text" | "textarea" | "select" | "boolean" | "date";
  options?: string[];
  jobDescription?: string;
}
export interface FieldDecision {
  fieldId: string;
  status: DecisionStatus;
  value?: unknown;
  evidence: Evidence[];
  confidence: number;
  question?: string;
  validators: string[];
}
```

Use exact repository lookup first, FTS second, and embedding rank only for long text. Verifiers must enforce evidence coverage, option membership, date consistency, and absence of unsupported generated claims.

- [ ] **Step 4: Verify all four decision statuses and correction scope**

Run: `pnpm --filter @resume/rag test -- rag-loop.test.ts`
Expected: PASS for `verified_auto`, `needs_review`, `needs_question`, `blocked`, task overrides, and explicit profile promotion.

- [ ] **Step 5: Commit the RAG loop**

```bash
git add packages/rag
git commit -m "feat: add verified retrieval and correction loop"
```

### Task 8: Add self-evaluation tailoring and review

**Files:**
- Create: `packages/rag/src/self-evaluation.ts`
- Create: `apps/api/src/reviews/review-routes.ts`
- Create: `apps/web/src/reviews/SelfEvaluationReview.tsx`
- Test: `packages/rag/src/self-evaluation.test.ts`
- Test: `apps/web/src/reviews/SelfEvaluationReview.test.tsx`

**Interfaces:**
- Consumes: base self-evaluation, job description, evidence-backed facts, and `ModelProvider`.
- Produces: `SelfEvaluationDraft` with original, draft, reasons, evidence, unsupported-claim findings, and review status.

- [ ] **Step 1: Write failing generation and review tests**

```ts
it("blocks a draft that introduces an unsupported skill", async () => {
  const result = await tailorSelfEvaluation(input, providerReturning("精通 Rust"));
  expect(result.status).toBe("blocked");
  expect(result.unsupportedClaims).toContain("Rust");
});
```

```tsx
it("does not adopt a draft until the user confirms it", async () => {
  render(<SelfEvaluationReview draft={reviewableDraft} onApprove={approve} />);
  expect(screen.getByText("原始自我评价")).toBeVisible();
  expect(screen.getByText("岗位微调稿")).toBeVisible();
  expect(approve).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "采用此版本" }));
  expect(approve).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run self-evaluation tests and verify failure**

Run: `pnpm --filter @resume/rag test -- self-evaluation.test.ts && pnpm --filter @resume/web test -- SelfEvaluationReview.test.tsx`
Expected: FAIL because generation and review components are missing.

- [ ] **Step 3: Implement evidence-constrained tailoring and task-only approval**

```ts
export interface SelfEvaluationDraft {
  taskId: string;
  original: string;
  draft: string;
  reasons: string[];
  evidence: Evidence[];
  unsupportedClaims: string[];
  status: "needs_review" | "approved" | "blocked";
}
```

Persist approval as an application-scoped answer. Add a separate `promote-to-profile` endpoint; never update the base text from the approve endpoint.

- [ ] **Step 4: Run foundation verification**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: all tests pass, all packages typecheck, and API/Web production builds complete.

- [ ] **Step 5: Commit the complete foundation**

```bash
git add packages/rag apps/api apps/web
git commit -m "feat: review job-tailored self evaluation"
```

## Plan 1 Completion Gate

- A PDF can be imported and deduplicated.
- Every extracted fact has page evidence and remains unapproved until user action.
- Corrections are versioned and task answers do not leak into other tasks.
- RAG decisions exercise plan, retrieval, verification, question, and correction paths.
- Self-evaluation tailoring is evidence constrained and cannot be used before approval.
- `pnpm test`, `pnpm typecheck`, and `pnpm build` all pass.
