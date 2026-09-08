# Resume File Update and Application URL Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 允许用户只替换后续投递使用的 PDF 而不解析或改写档案，并保证所有新投递任务在创建、计算确定性 UUID 和浏览器导航前使用同一个安全、干净的 URL。

**Architecture:** 把“当前投递文件”从“最近成功解析文档”中分离：SQLite 保存唯一 `is_current` 标记，文档服务分别负责留存/切换与解析，表单文件解析器只读取当前文件。投递侧新增唯一的应用目标准备模块，集中完成旧污染 URL 恢复、公共 HTTPS 校验和 UUIDv5 生成，API、会话和岗位推荐转换都从该边界创建任务；旧任务只读兼容，不迁移、不覆盖。

**Tech Stack:** TypeScript 5.8、Node.js 24、Fastify 5、SQLite/better-sqlite3、Drizzle schema、Zod 3、React 19、Vitest 3、Playwright 1.53、Vite 8。

## Global Constraints

- “仅更新简历”不得调用 PDF/OCR、DeepSeek 或事实仓储，且不得改变档案事实或完整度。
- 新 PDF 留存并切换成功后立即成为投递文件，即使状态是 `retained` 或 `failed`。
- 解析写入页面、事实和 `completed` 状态必须原子提交；失败不得产生部分事实。
- 当前文件在解析期间被切换时，旧解析结果不得提交，旧文档恢复为 `retained`。
- 同一 PDF 重复上传幂等复用文档；兼容接口除重复内容改为成功外保持既有响应和错误语义。
- 所有新投递任务只接受公共 HTTPS URL；归一化后的同一值用于 UUID、数据库和浏览器导航。
- 旧任务 ID 和记录不迁移、不覆盖；兼容 UUID、`conversation-application-<32hex>` 和 `job-application-<32hex>`。
- 真实浏览器回归只使用合成 PDF、合成 ATS 或受控网络替身，不点击招聘网站最终提交按钮。
- TraceSink/LangSmith 继续记录实际 Agent 执行；URL 归一化和当前文件选择属于确定性执行器约束，不交给 LLM 判断。

---

## Phase 1: Current resume persistence and parsing boundary

### Task 1: Add current-document contracts and migrate existing databases

**Files:**
- Modify: `packages/contracts/src/http.ts:1-27`
- Test: `packages/contracts/src/http.test.ts`
- Modify: `apps/api/src/db/schema.ts:7-16`
- Modify: `apps/api/src/db/migrate.ts:9-22, 649-657`
- Test: `apps/api/src/db/migrate.test.ts`

**Interfaces:**
- Produces: `DocumentImportStatusSchema`, `CurrentProfileDocumentSummarySchema`, `CurrentProfileDocumentResponseSchema`.
- Produces: `documents.is_current INTEGER NOT NULL DEFAULT 0`, status set `retained | importing | completed | failed`, and unique partial index `documents_one_current_idx`.

- [ ] **Step 1: Write failing contract tests**

Add `packages/contracts/src/http.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CurrentProfileDocumentResponseSchema,
  CurrentProfileDocumentSummarySchema
} from "./http.js";

describe("current profile document contracts", () => {
  const document = {
    documentId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    filename: "resume.pdf",
    importedAt: "2026-09-08T00:00:00.000Z",
    extractedFactCount: 0,
    importStatus: "retained" as const
  };

  it("accepts all four parsing states and nullable reads", () => {
    for (const importStatus of ["retained", "importing", "completed", "failed"] as const) {
      expect(CurrentProfileDocumentSummarySchema.parse({ ...document, importStatus }).importStatus)
        .toBe(importStatus);
    }
    expect(CurrentProfileDocumentResponseSchema.parse({ document: null })).toEqual({ document: null });
  });
});
```

- [ ] **Step 2: Write failing migration tests**

In `apps/api/src/db/migrate.test.ts`, create a legacy `documents` table with the old three-state constraint, insert two completed rows and one importing row, run `migrateDatabase`, then assert:

```ts
const rows = database.prepare(`
  SELECT id, import_status, is_current FROM documents ORDER BY created_at, id
`).all() as Array<{ id: string; import_status: string; is_current: number }>;

expect(rows).toEqual([
  { id: "old", import_status: "completed", is_current: 0 },
  { id: "new", import_status: "completed", is_current: 1 },
  { id: "interrupted", import_status: "retained", is_current: 0 }
]);
expect(() => database.prepare("UPDATE documents SET import_status = 'failed' WHERE id = 'new'").run())
  .not.toThrow();
expect(() => database.prepare("UPDATE documents SET is_current = 1 WHERE id = 'old'").run())
  .toThrow();
migrateDatabase(database);
expect(database.pragma("quick_check", { simple: true })).toBe("ok");
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```powershell
rtk corepack pnpm --filter @resume/contracts exec vitest run src/http.test.ts
rtk corepack pnpm --filter @resume/api exec vitest run src/db/migrate.test.ts
```

Expected: contracts fail because the schemas are absent; migration fails because `is_current` and `failed` are unsupported.

- [ ] **Step 4: Implement contracts and schema**

Add to `packages/contracts/src/http.ts`:

```ts
export const DocumentImportStatusSchema = z.enum(["retained", "importing", "completed", "failed"]);

export const CurrentProfileDocumentSummarySchema = ProfileDocumentSummarySchema.extend({
  importStatus: DocumentImportStatusSchema
}).strict();

export const CurrentProfileDocumentResponseSchema = z.object({
  document: CurrentProfileDocumentSummarySchema.nullable()
}).strict();

export type DocumentImportStatus = z.infer<typeof DocumentImportStatusSchema>;
export type CurrentProfileDocumentSummary = z.infer<typeof CurrentProfileDocumentSummarySchema>;
export type CurrentProfileDocumentResponse = z.infer<typeof CurrentProfileDocumentResponseSchema>;
```

Update `apps/api/src/db/schema.ts` so `documents` includes:

```ts
importStatus: text("import_status", {
  enum: ["retained", "importing", "completed", "failed"]
}).notNull(),
isCurrent: integer("is_current", { mode: "boolean" }).notNull().default(false),
```

and its table callback contains the four-state check plus:

```ts
uniqueIndex("documents_one_current_idx").on(table.isCurrent).where(sql`${table.isCurrent} = 1`)
```

- [ ] **Step 5: Implement the idempotent SQLite upgrade**

In the new-table SQL in `apps/api/src/db/migrate.ts`, include `failed`, `is_current`, and the partial index. Add `upgradeDocumentLifecycle(database)` immediately after the base schema block and before the interrupted-import reset:

```ts
function upgradeDocumentLifecycle(database: SqliteDatabase): void {
  const sql = tableSql(database, "documents");
  const columns = database.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>;
  const needsRebuild = !sql.includes("'failed'") || !columns.some(({ name }) => name === "is_current");

  if (needsRebuild) {
    const foreignKeysWereEnabled = database.pragma("foreign_keys", { simple: true }) === 1;
    if (foreignKeysWereEnabled) database.pragma("foreign_keys = OFF");
    try {
      database.transaction(() => {
        database.exec(`
          CREATE TABLE documents_lifecycle_new (
            id TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL UNIQUE,
            filename TEXT NOT NULL,
            source_path TEXT NOT NULL,
            import_status TEXT NOT NULL CHECK (import_status IN ('retained', 'importing', 'completed', 'failed')),
            is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
            created_at TEXT NOT NULL
          );
          INSERT INTO documents_lifecycle_new (id, fingerprint, filename, source_path, import_status, is_current, created_at)
          SELECT id, fingerprint, filename, source_path,
                 CASE WHEN import_status = 'importing' THEN 'retained' ELSE import_status END,
                 0, created_at
          FROM documents;
          DROP TABLE documents;
          ALTER TABLE documents_lifecycle_new RENAME TO documents;
        `);
      })();
    } finally {
      if (foreignKeysWereEnabled) database.pragma("foreign_keys = ON");
    }
  }

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS documents_one_current_idx
      ON documents(is_current) WHERE is_current = 1;
  `);
  database.prepare(`
    UPDATE documents SET is_current = 1
    WHERE id = (
      SELECT id FROM documents WHERE import_status = 'completed'
      ORDER BY created_at DESC, id DESC LIMIT 1
    ) AND NOT EXISTS (SELECT 1 FROM documents WHERE is_current = 1)
  `).run();
}
```

- [ ] **Step 6: Run contracts and migration tests, then commit**

Run the two commands from Step 3. Expected: PASS, including a second migration and `quick_check = ok`.

```powershell
rtk git add packages/contracts/src/http.ts packages/contracts/src/http.test.ts apps/api/src/db/schema.ts apps/api/src/db/migrate.ts apps/api/src/db/migrate.test.ts
rtk git commit -m "feat: add current resume lifecycle schema"
```

### Task 2: Make current-file switching and parse claims transactional

**Files:**
- Modify: `apps/api/src/profile/document-repository.ts:1-95`
- Test: `apps/api/src/profile/document-repository.test.ts`

**Interfaces:**
- Consumes: four-state `documents` table and `is_current` from Task 1.
- Produces: `findById`, `findCurrent`, `setCurrent`, `claimImport`, `markFailed`, `releaseImport`, and `completeCurrentImport`.
- Produces: `RetainedDocument.isCurrent: boolean`.

- [ ] **Step 1: Extend repository tests with current switching, failure retry, and compare-and-swap**

Add tests that create documents `document-1` and `document-2` and assert:

```ts
repository.setCurrent("document-1");
expect(repository.findCurrent()?.id).toBe("document-1");
repository.setCurrent("document-2");
expect(repository.findById("document-1")?.isCurrent).toBe(false);
expect(repository.findCurrent()?.id).toBe("document-2");

expect(repository.claimImport("document-2")).toBe(true);
repository.markFailed("document-2");
expect(repository.findCurrent()?.importStatus).toBe("failed");
expect(repository.claimImport("document-2")).toBe(true);
repository.setCurrent("document-1");
expect(repository.completeCurrentImport("document-2")).toBe(false);
repository.releaseImport("document-2");
expect(repository.findById("document-2")?.importStatus).toBe("retained");
```

Also assert calling `setCurrent` twice is idempotent and exactly one row has `is_current = 1`.

- [ ] **Step 2: Run the repository test and verify RED**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/profile/document-repository.test.ts
```

Expected: FAIL because current-file methods and `failed` transitions do not exist.

- [ ] **Step 3: Implement the repository contract**

Use document IDs at service boundaries and keep fingerprint lookup for evidence routes:

```ts
export interface DocumentRepository {
  createRetained(document: NewRetainedDocument): RetainedDocument;
  findById(documentId: string): RetainedDocument | undefined;
  findByFingerprint(fingerprint: string): RetainedDocument | undefined;
  findCurrent(): RetainedDocument | undefined;
  findLatestCompleted(): RetainedDocument | undefined;
  findPageContent(fingerprint: string, page: number): string | undefined;
  setCurrent(documentId: string): RetainedDocument;
  claimImport(documentId: string): boolean;
  markFailed(documentId: string): void;
  releaseImport(documentId: string): void;
  completeCurrentImport(documentId: string): boolean;
}
```

Implement `setCurrent` as one better-sqlite3 transaction:

```ts
const switchCurrent = database.transaction((documentId: string) => {
  if (findById(documentId) === undefined) throw new Error("document_not_found");
  database.prepare("UPDATE documents SET is_current = 0 WHERE is_current = 1 AND id <> ?").run(documentId);
  database.prepare("UPDATE documents SET is_current = 1 WHERE id = ?").run(documentId);
  return findById(documentId)!;
});
```

Use guarded updates:

```sql
UPDATE documents SET import_status = 'importing'
WHERE id = ? AND is_current = 1 AND import_status IN ('retained', 'failed');

UPDATE documents SET import_status = 'completed'
WHERE id = ? AND is_current = 1 AND import_status = 'importing';
```

Map `is_current` to a boolean in `parseDocument`.

- [ ] **Step 4: Run repository and migration tests, then commit**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/profile/document-repository.test.ts src/db/migrate.test.ts
```

Expected: PASS.

```powershell
rtk git add apps/api/src/profile/document-repository.ts apps/api/src/profile/document-repository.test.ts
rtk git commit -m "feat: coordinate current resume state"
```

### Task 3: Split file retention from profile parsing and expose API endpoints

**Files:**
- Create: `apps/api/src/profile/current-document-service.ts`
- Create: `apps/api/src/profile/current-document-service.test.ts`
- Modify: `apps/api/src/profile/import-service.ts:1-137`
- Modify: `apps/api/src/profile/import-service.test.ts`
- Modify: `apps/api/src/profile/profile-routes.ts:1-162`
- Modify: `apps/api/src/profile/profile-routes.test.ts`

**Interfaces:**
- Produces: `retainCurrentProfileDocument(dependencies, filename, bytes): Promise<RetainedDocument>`.
- Produces: `parseCurrentProfileDocument(dependencies, documentId): Promise<ImportedDocument>`.
- Keeps: `importProfileDocument(dependencies, filename, bytes)` as the compatibility composition.
- Produces API: `POST /api/profile/documents/current`, `POST /api/profile/documents/:documentId/parse`, `GET /api/profile/documents/current`.

- [ ] **Step 1: Write failing retention tests**

In `current-document-service.test.ts`, use an in-memory database, a temporary original store, and spies that throw if extraction is touched:

```ts
const beforeFacts = profileRepository.listActive();
const retained = await retainCurrentProfileDocument(dependencies, "new.pdf", bytes);

expect(retained).toMatchObject({ filename: "new.pdf", importStatus: "retained", isCurrent: true });
expect(extractPdf).not.toHaveBeenCalled();
expect(extractFacts).not.toHaveBeenCalled();
expect(profileRepository.listActive()).toEqual(beforeFacts);

const repeated = await retainCurrentProfileDocument(dependencies, "renamed.pdf", Uint8Array.from(bytes));
expect(repeated.id).toBe(retained.id);
expect(database.prepare("SELECT COUNT(*) AS count FROM documents").get()).toEqual({ count: 1 });
```

Add a retention failure test where `originalDocumentStore.retain` rejects and assert no database row/current marker is created.

- [ ] **Step 2: Write failing parser tests**

Refactor existing `import-service.test.ts` expectations and add:

```ts
const retained = await retainCurrentProfileDocument(dependencies, "resume.pdf", bytes);
await expect(parseCurrentProfileDocument(dependencies, retained.id)).resolves.toMatchObject({
  documentId: retained.id
});
await expect(parseCurrentProfileDocument(dependencies, retained.id)).resolves.toMatchObject({
  documentId: retained.id
});
expect(extractPdf).toHaveBeenCalledTimes(1);

const parsing = parseCurrentProfileDocument(dependencies, retained.id);
await extractionStarted;
repository.setCurrent(other.id);
releaseExtraction();
await expect(parsing).rejects.toThrow("current_document_changed");
expect(repository.findById(retained.id)?.importStatus).toBe("retained");
expect(profileRepository.listActive()).toEqual(beforeFacts);
```

For extractor/model failure, assert status `failed`, current document unchanged, and old facts unchanged.

- [ ] **Step 3: Run service tests and verify RED**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/profile/current-document-service.test.ts src/profile/import-service.test.ts
```

Expected: FAIL because retention and parsing are still coupled.

- [ ] **Step 4: Implement independent retention**

In `current-document-service.ts`, snapshot bytes, hash once, retain the original before DB mutation, create/recover the document row, then set it current:

```ts
export async function retainCurrentProfileDocument(
  dependencies: Pick<ProfileImportDependencies, "database" | "originalDocumentStore">,
  filename: string,
  bytes: Uint8Array
): Promise<RetainedDocument> {
  const snapshot = Uint8Array.from(bytes);
  const fingerprint = createHash("sha256").update(snapshot).digest("hex");
  const documents = createDocumentRepository(dependencies.database);
  const existing = documents.findByFingerprint(fingerprint);
  if (existing !== undefined) return documents.setCurrent(existing.id);

  const original = await dependencies.originalDocumentStore.retain(fingerprint, snapshot);
  try {
    const document = documents.createRetained({
      id: randomUUID(), fingerprint, filename, sourcePath: original.path,
      createdAt: new Date().toISOString(), isCurrent: false
    });
    return documents.setCurrent(document.id);
  } catch (error) {
    const raced = documents.findByFingerprint(fingerprint);
    if (raced !== undefined) return documents.setCurrent(raced.id);
    await dependencies.originalDocumentStore.discardCreated(original);
    throw new ImportPersistenceError();
  }
}
```

- [ ] **Step 5: Implement idempotent current-document parsing**

Change `import-service.ts` so `parseCurrentProfileDocument`:

1. loads the document by ID and rejects non-current documents with `current_document_changed`;
2. returns immediately for `completed`;
3. claims only `retained`/`failed`;
4. reads `document.sourcePath`, extracts outside the DB transaction, and validates evidence;
5. opens one transaction, checks `completeCurrentImport(documentId)` before writing chunks/facts, and rolls the transaction back on a false result;
6. marks extraction/model errors `failed`, but on `current_document_changed` calls `releaseImport`.

The compatibility function becomes:

```ts
export async function importProfileDocument(
  dependencies: ProfileImportDependencies,
  filename: string,
  bytes: Uint8Array
): Promise<ImportedDocument> {
  const retained = await retainCurrentProfileDocument(dependencies, filename, bytes);
  return parseCurrentProfileDocument(dependencies, retained.id, Uint8Array.from(bytes));
}
```

Passing bytes from the compatibility path avoids a second disk read; the parse endpoint omits that argument and reads the retained source.

- [ ] **Step 6: Write failing route tests**

In `profile-routes.test.ts`, add API assertions:

```ts
const beforeFacts = await app.inject({ method: "GET", url: "/api/profile/facts" });
const upload = await app.inject({
  method: "POST", url: "/api/profile/documents/current", ...multipartPdf(bytes)
});
expect(upload.statusCode).toBe(201);
expect(upload.json()).toMatchObject({ importStatus: "retained", filename: "resume.pdf" });
expect(extractPdf).not.toHaveBeenCalled();
expect((await app.inject({ method: "GET", url: "/api/profile/facts" })).body).toBe(beforeFacts.body);

const current = await app.inject({ method: "GET", url: "/api/profile/documents/current" });
expect(current.json().document.documentId).toBe(upload.json().documentId);

const parsed = await app.inject({
  method: "POST", url: `/api/profile/documents/${upload.json().documentId}/parse`
});
expect(parsed.statusCode).toBe(200);
expect(parsed.json().importStatus).toBe("completed");
```

Also cover no current document, invalid UUID, non-current parse (`409 current_document_changed`), concurrent parse (`409 document_import_in_progress`), invalid PDF, parse failure (`503 profile_import_unavailable` with current status `failed`), and duplicate compatibility upload returning `202` instead of the old `409`.

- [ ] **Step 7: Implement the three routes with one summary helper**

Add `DocumentIdParamsSchema = z.object({ documentId: z.string().uuid() }).strict()` and a helper:

```ts
const currentSummary = (document: RetainedDocument): CurrentProfileDocumentSummary => ({
  documentId: document.id,
  filename: document.filename,
  importedAt: document.createdAt,
  importStatus: document.importStatus,
  extractedFactCount: dependencies.profileRepository.listActive().filter((fact) =>
    fact.scope === "profile" && fact.evidence.some((item) => item.documentId === document.fingerprint)
  ).length
});
```

Return `201` for current-file upload, `200` for parse and current read, `409` for stable lifecycle conflicts, `400` for invalid upload/input, and `503` for unavailable extraction. Call `notifyProfileUpdated()` only after successful parsing, never after upload-only.

- [ ] **Step 8: Run profile tests and commit**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/profile/current-document-service.test.ts src/profile/import-service.test.ts src/profile/profile-routes.test.ts src/profile/document-repository.test.ts
```

Expected: PASS.

```powershell
rtk git add apps/api/src/profile/current-document-service.ts apps/api/src/profile/current-document-service.test.ts apps/api/src/profile/import-service.ts apps/api/src/profile/import-service.test.ts apps/api/src/profile/profile-routes.ts apps/api/src/profile/profile-routes.test.ts
rtk git commit -m "feat: separate resume update from parsing"
```

### Task 4: Resolve application upload fields from the current resume

**Files:**
- Modify: `apps/api/src/production-dependencies.ts:536-551, 577-591`
- Test: `apps/api/src/production-dependencies.test.ts`

**Interfaces:**
- Consumes: `DocumentRepository.findCurrent()` from Task 2.
- Produces: resume form fields use `${current.fingerprint}.pdf` regardless of parse status.
- Keeps: Resume Agent evidence ingestion on `findLatestCompleted()`.

- [ ] **Step 1: Write a failing production-composition test**

Create one older `completed` document and one newer current `retained` document. Resolve a `file` field labelled `简历附件` and assert:

```ts
await expect(resolveField(taskId, applicationField("简历附件", { type: "file" }), "deterministic"))
  .resolves.toMatchObject({ status: "verified", value: `${currentFingerprint}.pdf` });
expect(currentFingerprint).not.toBe(completedFingerprint);
```

Keep/add a Resume Agent ingestion assertion that its loaded bytes still come from the completed document.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/production-dependencies.test.ts -t "current resume"
```

Expected: FAIL because `resolveFileId` selects `findLatestCompleted()`.

- [ ] **Step 3: Change only the form file resolver**

Replace the resume branch with:

```ts
const currentDocument = documentRepository.findCurrent();
return /resume|cv|简历/iu.test(`${field.semanticHint ?? ""} ${field.label}`)
  && currentDocument !== undefined
  ? `${currentDocument.fingerprint}.pdf`
  : undefined;
```

Do not alter the earlier Resume Agent `loadDocument()` call to `findLatestCompleted()`.

- [ ] **Step 4: Run focused and retention tests, then commit**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/production-dependencies.test.ts -t "current resume|resume document"
rtk corepack pnpm --filter @resume/api exec vitest run src/profile/current-document-service.test.ts
```

Expected: PASS.

```powershell
rtk git add apps/api/src/production-dependencies.ts apps/api/src/production-dependencies.test.ts
rtk git commit -m "fix: use current resume for application uploads"
```

## Phase 2: Web client and profile interaction

### Task 5: Add typed web-client methods for current-file lifecycle

**Files:**
- Modify: `apps/web/src/api/client.ts:1-75`
- Test: `apps/web/src/api/client.test.ts`
- Modify test fakes in: `apps/web/src/health/ServiceStatus.test.tsx`, `apps/web/src/profile/*.test.tsx`, `apps/web/src/workspace/ProfileApplicationWorkspace.test.tsx`

**Interfaces:**
- Produces: `updateCurrentDocument(file)`, `parseCurrentDocument(documentId)`, `getCurrentDocument()`.
- Keeps: `upload(file)` for the compatibility endpoint.

- [ ] **Step 1: Write failing HTTP contract tests**

Add tests that mock `fetch` and assert exact requests and parsed results:

```ts
await api.updateCurrentDocument(file);
expect(fetch).toHaveBeenCalledWith("/api/profile/documents/current", {
  method: "POST", body: expect.any(FormData)
});

await api.parseCurrentDocument(documentId);
expect(fetch).toHaveBeenCalledWith(
  `/api/profile/documents/${documentId}/parse`, { method: "POST" }
);

await expect(api.getCurrentDocument()).resolves.toMatchObject({
  documentId, importStatus: "retained"
});
```

Add invalid-response tests proving strict Zod parsing rejects an unknown status and malformed UUID.

- [ ] **Step 2: Run the client tests and verify RED**

Run:

```powershell
rtk corepack pnpm --filter @resume/web exec vitest run src/api/client.test.ts
```

Expected: FAIL because the three methods are absent.

- [ ] **Step 3: Implement the client methods**

Extend `ProfileApi`:

```ts
updateCurrentDocument(file: File): Promise<CurrentProfileDocumentSummary>;
parseCurrentDocument(documentId: string): Promise<CurrentProfileDocumentSummary>;
getCurrentDocument(): Promise<CurrentProfileDocumentSummary | undefined>;
```

Use the new contract schemas and `encodeURIComponent(documentId)` for the parse path. Update all structural test doubles with `vi.fn()` implementations returning `undefined` or the requested summary.

- [ ] **Step 4: Run all web unit tests and commit**

Run:

```powershell
rtk corepack pnpm --filter @resume/web test
```

Expected: PASS.

```powershell
rtk git add apps/web/src/api/client.ts apps/web/src/api/client.test.ts apps/web/src/health apps/web/src/profile apps/web/src/workspace
rtk git commit -m "feat: expose current resume web API"
```

### Task 6: Implement upload-only, update-and-parse, failure, and retry UI states

**Files:**
- Modify: `apps/web/src/profile/ResumeParsePanel.tsx:1-92`
- Modify: `apps/web/src/profile/ResumeParsePanel.test.tsx`
- Modify: `apps/web/src/profile/ProfilePage.tsx:180-460, 493-510`
- Modify: `apps/web/src/profile/ProfilePage.test.tsx`
- Modify: `apps/web/src/styles.css` (resume parse control/status selectors)

**Interfaces:**
- Consumes: Task 5 client methods and `CurrentProfileDocumentSummary`.
- Produces UI actions: `onUpdateOnly`, `onUpdateAndParse`, `onRetryParse`.
- Produces visible states: `未解析`, `解析中`, `已解析`, `解析失败，可重试`.

- [ ] **Step 1: Write failing panel interaction tests**

Replace the one-button assumptions with:

```ts
expect(screen.getByRole("button", { name: "仅更新简历" })).toBeEnabled();
expect(screen.getByRole("button", { name: "更新并解析" })).toBeEnabled();
await user.click(screen.getByRole("button", { name: "仅更新简历" }));
expect(onUpdateOnly).toHaveBeenCalledOnce();
await user.click(screen.getByRole("button", { name: "更新并解析" }));
expect(onUpdateAndParse).toHaveBeenCalledOnce();
```

Cover all four current document statuses, both buttons locked during upload/parse, and `重新解析` visible only for current `failed`/`retained` documents without a newly selected file.

- [ ] **Step 2: Write failing page orchestration tests**

Add these scenarios to `ProfilePage.test.tsx`:

1. upload-only calls `updateCurrentDocument`, clears the picker, shows “当前简历已更新，已有档案资料未改变”, and does not call `listFacts`/`getCompleteness` again;
2. update-and-parse calls upload then parse with the returned ID, and only after parse success reloads facts, completeness, and current document;
3. parse failure keeps the new document visible as current and exposes retry;
4. retry calls only `parseCurrentDocument(current.documentId)`, not upload;
5. a late response from a prior API/generation cannot replace current UI state.

- [ ] **Step 3: Run focused UI tests and verify RED**

Run:

```powershell
rtk corepack pnpm --filter @resume/web exec vitest run src/profile/ResumeParsePanel.test.tsx src/profile/ProfilePage.test.tsx
```

Expected: FAIL because the panel exposes only `开始解析` and the page has one combined flow.

- [ ] **Step 4: Implement explicit UI state and actions**

Use a discriminated state instead of combining upload and fact refresh:

```ts
type ResumeOperationState =
  | { kind: "idle" }
  | { kind: "uploading"; mode: "update_only" | "update_and_parse" }
  | { kind: "parsing"; documentId: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string; retry: "upload" | "parse" };
```

After upload success, immediately set `currentDocument` from the response and clear the native input. For upload-only, stop there. For update-and-parse/retry, set `parsing`, call `parseCurrentDocument`, then refresh facts/completeness/current summary only after parsing succeeds. Reuse `contextGeneration`, operation owner refs, and stale-response checks already present in `ProfilePage`.

- [ ] **Step 5: Update panel copy, accessibility, and layout**

Render:

```tsx
<button type="button" className="button secondary" disabled={!selectedFile || busy} onClick={onUpdateOnly}>
  仅更新简历
</button>
<button type="button" className="button primary" disabled={!selectedFile || busy} onClick={onUpdateAndParse}>
  更新并解析
</button>
```

Show the current filename independently from extracted fact count, add `role="status"` for non-error transitions and `role="alert"` for failures, and keep both buttons keyboard reachable. Add wrapping CSS so the two actions and picker do not overflow at 390px.

- [ ] **Step 6: Run web tests, typecheck, and commit**

Run:

```powershell
rtk corepack pnpm --filter @resume/web test
rtk corepack pnpm --filter @resume/web typecheck
```

Expected: PASS.

```powershell
rtk git add apps/web/src/profile/ResumeParsePanel.tsx apps/web/src/profile/ResumeParsePanel.test.tsx apps/web/src/profile/ProfilePage.tsx apps/web/src/profile/ProfilePage.test.tsx apps/web/src/styles.css
rtk git commit -m "feat: add independent resume update controls"
```

## Phase 3: Canonical application target creation

### Task 7: Create a deterministic, public-HTTPS application target module

**Files:**
- Create: `apps/api/src/applications/application-target.ts`
- Create: `apps/api/src/applications/application-target.test.ts`
- Modify: `apps/api/src/conversations/conversation-url-input.ts:1-86`
- Modify: `apps/api/src/conversations/conversation-url-input.test.ts`
- Modify: `packages/contracts/src/application.ts:197-207`
- Modify: `packages/contracts/src/application.test.ts:17-26`

**Interfaces:**
- Produces: `prepareApplicationTarget(rawUrl, identity, resolveHostname?): Promise<{ id: string; applicationUrl: string; boundary: "explicit" | "recovered_encoded_suffix" }>`.
- Produces: `deterministicApplicationTaskId(identity, applicationUrl): string` returning UUIDv5 format.
- Consumes: `validatePublicHttpsUrl` and the existing encoded-natural-language recovery rule.

- [ ] **Step 1: Write boundary-set and retention-set tests**

Create a table in `application-target.test.ts` with the exact production failure:

```ts
const polluted = "https://wondersharecampus.zhiye.com/form?fromPage=job&jobAdId=1e15df19-c887-41f5-b632-3845af9b5131&shareId=16002765-e0e5-4238-a46a-4f8b717777fc&userId=125079440%E8%BF%99%E4%B8%AA%E9%A1%B5%E9%9D%A2%E5%8F%AF%E4%BB%A5%E6%8A%95%E9%80%92%E5%90%97";
const clean = "https://wondersharecampus.zhiye.com/form?fromPage=job&jobAdId=1e15df19-c887-41f5-b632-3845af9b5131&shareId=16002765-e0e5-4238-a46a-4f8b717777fc&userId=125079440";

await expect(prepareApplicationTarget(polluted, "conversation:c1", publicDns)).resolves.toMatchObject({
  applicationUrl: clean,
  id: expect.stringMatching(/^[0-9a-f-]{36}$/u)
});
```

Assert the same clean input and identity produce the same UUID, while another identity produces a different UUID. Retention cases must remain byte-for-byte after safety normalization where applicable:

- encoded Chinese path `/岗位/%E5%89%8D%E7%AB%AF`;
- Chinese query value `keyword=%E5%89%8D%E7%AB%AF`;
- short identifier value ending in encoded Chinese that does not meet the natural-language rule;
- ordinary ASCII query and mixed-case percent bytes.

Reject HTTP, credentials, IP/localhost/private DNS, malformed percent encoding, and strings containing two URLs；片段沿用公共 HTTPS 校验器的既有行为，确定性移除后再计算 UUID。

- [ ] **Step 2: Run the target tests and verify RED**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/applications/application-target.test.ts src/conversations/conversation-url-input.test.ts
```

Expected: FAIL because the shared target module does not exist.

- [ ] **Step 3: Extract suffix recovery and implement target preparation**

Export a pure `recoverApplicationUrlSuffix(candidate)` from `conversation-url-input.ts` and keep `extractConversationUrlInput` behavior unchanged. Implement:

```ts
export interface PreparedApplicationTarget {
  id: string;
  applicationUrl: string;
  boundary: "explicit" | "recovered_encoded_suffix";
}

export class ApplicationTargetError extends Error {
  constructor(readonly code: "invalid_application_url" | "unsafe_application_url") {
    super(code);
    this.name = "ApplicationTargetError";
  }
}

export async function prepareApplicationTarget(
  rawUrl: string,
  identity: string,
  resolveHostname?: HostnameResolver
): Promise<PreparedApplicationTarget> {
  if (countConversationWebUrls(rawUrl) !== 1) {
    throw new ApplicationTargetError("invalid_application_url");
  }
  const extracted = extractConversationUrlInput(rawUrl);
  if (extracted === undefined) throw new ApplicationTargetError("invalid_application_url");
  let validated: Awaited<ReturnType<typeof validatePublicHttpsUrl>>;
  try {
    validated = await validatePublicHttpsUrl(extracted.url, resolveHostname);
  } catch {
    throw new ApplicationTargetError("unsafe_application_url");
  }
  return {
    id: deterministicApplicationTaskId(identity, validated.url),
    applicationUrl: validated.url,
    boundary: extracted.boundary
  };
}
```

`ApplicationTargetError` exposes only `invalid_application_url | unsafe_application_url` as `code`; it must not include the raw URL in its message.

Move the existing UUIDv5 byte construction from `conversation-tools.ts` into `deterministicApplicationTaskId`, hashing `identity + "\0" + applicationUrl` under one fixed namespace. Keep the version/variant bits and standard 36-character UUID formatting.

- [ ] **Step 4: Extend legacy task ID acceptance without weakening it**

In `packages/contracts/src/application.ts`, add:

```ts
const LegacyJobApplicationTaskIdSchema = z.string().regex(/^job-application-[a-f0-9]{32}$/u);

export const ApplicationTaskIdSchema = z.union([
  z.string().uuid(),
  LegacyConversationApplicationTaskIdSchema,
  LegacyJobApplicationTaskIdSchema
]);
```

Tests must accept the exact two legacy shapes and reject arbitrary prefixes/non-hex values.

- [ ] **Step 5: Run target, conversation URL, and contract tests, then commit**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/applications/application-target.test.ts src/conversations/conversation-url-input.test.ts
rtk corepack pnpm --filter @resume/contracts exec vitest run src/application.test.ts
```

Expected: PASS.

```powershell
rtk git add apps/api/src/applications/application-target.ts apps/api/src/applications/application-target.test.ts apps/api/src/conversations/conversation-url-input.ts apps/api/src/conversations/conversation-url-input.test.ts packages/contracts/src/application.ts packages/contracts/src/application.test.ts
rtk git commit -m "feat: prepare canonical application targets"
```

### Task 8: Route API, conversation, and job conversion through the canonical target

**Files:**
- Modify: `apps/api/src/applications/routes.ts:20-127`
- Modify: `apps/api/src/applications/routes.test.ts`
- Modify: `apps/api/src/conversations/conversation-tools.ts:67-93, 134-192, 245-317, 485-500`
- Modify: `apps/api/src/conversations/conversation-tools.test.ts`
- Modify: `apps/api/src/job-matching/job-match-service.ts:41-65, 255-300`
- Modify: `apps/api/src/job-matching/job-match-service.test.ts`
- Modify: `apps/api/src/production-dependencies.ts` (composition wiring)
- Modify: `apps/api/src/production-dependencies.test.ts`

**Interfaces:**
- Consumes: `prepareApplicationTarget` from Task 7.
- Produces: every new task persists and opens the prepared URL, with `{ task, created }` idempotency semantics.
- Keeps: repository reads of old task IDs and existing failed task rows unchanged.

- [ ] **Step 1: Write failing direct API regression tests**

Inject `resolveHostname: async () => ["220.181.7.203"]` into route dependencies. POST the exact polluted Wondershare URL and assert:

```ts
expect(response.statusCode).toBe(201);
expect(response.json()).toMatchObject({ applicationUrl: clean });
expect(tasks.get(response.json().id)?.applicationUrl).toBe(clean);
expect(applicationService.start).toHaveBeenCalledWith({
  taskId: response.json().id,
  applicationUrl: clean
});
expect(applicationService.openBrowser).toHaveBeenCalledWith(response.json().id);
```

Post the clean URL again and assert the same UUID and one DB row. Add rejection tests for unsafe DNS/HTTP before repository creation or browser opening.

- [ ] **Step 2: Write failing conversation and job conversion tests**

For `create_application_task`, seed the previously persisted dirty URL as tool input and assert the task ID, DB URL, card URL, and `start` URL all use the clean value. For job conversion, assert the new ID is a UUID and replaying the same conversion returns the existing task without a second `prepareApplicationTask` call.

- [ ] **Step 3: Run creation-path tests and verify RED**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/applications/routes.test.ts src/conversations/conversation-tools.test.ts src/job-matching/job-match-service.test.ts
```

Expected: FAIL because direct routes use `randomUUID`, conversation creation trusts the tool URL, and job conversion emits `job-application-*`.

- [ ] **Step 4: Add one injected target-preparation port**

Use this dependency shape in all three creation paths:

```ts
type PrepareApplicationTarget = (
  rawUrl: string,
  identity: string
) => Promise<{
  id: string;
  applicationUrl: string;
  boundary: "explicit" | "recovered_encoded_suffix";
}>;
```

Production wiring supplies:

```ts
const prepareTarget: PrepareApplicationTarget = (rawUrl, identity) =>
  prepareApplicationTarget(rawUrl, identity);
```

Test wiring supplies a public DNS resolver through `prepareApplicationTarget`. Do not copy URL-recovery regexes into routes or services.

- [ ] **Step 5: Replace each creation identity and preserve idempotency**

Use these exact identities（`prepareApplicationTarget` 会再把归一化 URL 纳入 UUID 名称，因此调用方不重复拼接 URL）：

```ts
`direct`
`conversation:${context.conversationId}`
`job-match:${sessionId}:${base.idempotencyKey}`
```

For direct/API and conversation paths, call `createFromJob` so an existing deterministic task is returned rather than violating the primary key. Start/open only when the task did not exist before creation. In the job conversion path, prepare the selected posting URL before `createFromJob`; persist its task ID in the session and pass `application.applicationUrl` unchanged to `prepareApplicationTask`.

- [ ] **Step 6: Normalize error mapping and audit evidence**

Map target errors to `400 invalid_application_url` for syntax/multiple URL and `400 unsafe_application_url` for non-public destinations. Keep `browser_task_in_use` as `409`. Add one structured TraceSink event at the task-creation boundary containing task ID, normalized host, and boundary kind, but never the full query string or recovered natural-language suffix.

- [ ] **Step 7: Run creation and production-composition tests, then commit**

Run:

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/applications/routes.test.ts src/conversations/conversation-tools.test.ts src/job-matching/job-match-service.test.ts src/production-dependencies.test.ts
```

Expected: PASS, including the exact polluted URL regression and clean idempotent replay.

```powershell
rtk git add apps/api/src/applications/routes.ts apps/api/src/applications/routes.test.ts apps/api/src/conversations/conversation-tools.ts apps/api/src/conversations/conversation-tools.test.ts apps/api/src/job-matching/job-match-service.ts apps/api/src/job-matching/job-match-service.test.ts apps/api/src/production-dependencies.ts apps/api/src/production-dependencies.test.ts
rtk git commit -m "fix: canonicalize every application task target"
```

## Phase 4: Full-stack and real-browser regression

### Task 9: Prove API, web, browser, persistence, and no-submit behavior end to end

**Files:**
- Create: `tests/browser/resume-file-update.spec.ts`
- Create: `tests/browser/application-url-hardening.spec.ts`
- Modify: `tests/browser/profile-workspace.spec.ts`
- Modify: `tests/browser/test-harness.ts` only if shared startup/cleanup removes duplication

**Interfaces:**
- Consumes: all previous tasks.
- Produces: browser evidence for upload-only, update-and-parse failure/retry, clean URL propagation, and zero final submissions.

- [ ] **Step 1: Add a full-stack test fixture with isolated state**

For each test, create a temporary directory and SQLite file, start `createApp` with deterministic extraction fakes, listen on `127.0.0.1:0`, then start Vite with `/api` proxying to that Fastify origin. Generate two distinct PDFs with `tests/fixtures/create-pdf.ts`. Cleanup must close Vite, Fastify, database/browser fakes, and remove only the test temporary directory in `finally`.

- [ ] **Step 2: Write the upload-only browser test and verify RED**

Drive the real React page:

```ts
await page.goto(`${webBaseUrl}/?view=profile`);
await page.getByRole("button", { name: "简历解析" }).click();
await page.getByLabel("选择 PDF 简历").setInputFiles(newPdfPath);
await page.getByRole("button", { name: "仅更新简历" }).click();
await expect(page.getByRole("status")).toContainText("已有档案资料未改变");
await expect(page.getByText("new-resume.pdf")).toBeVisible();
```

Query the API/DB afterward and assert the original fact JSON and profile revision are byte-for-byte unchanged, the new fingerprint is uniquely current, and its status is `retained`.

- [ ] **Step 3: Write parse failure/retry browser coverage**

Configure the first extraction call to reject with `ProfileImportUnavailableError` and the second to succeed. Click `更新并解析`, assert the new file remains current with `解析失败，可重试`, click `重新解析`, then assert `已解析`, refreshed facts, and updated completeness. Assert the parser is called exactly twice and the file retention operation once.

- [ ] **Step 4: Write canonical URL propagation browser/API coverage**

Submit the exact polluted Wondershare input through the application start UI while the API uses a fake application service that records start/open calls. Assert the visible task link, API response, database row, and recorded browser target are all the clean URL and share one deterministic UUID. Re-submit clean input and assert no duplicate row/start. Also assert the historical failed row `a0b682fc-7d1d-5b39-b090-1efa4d8bca42` is not modified when included in the fixture DB.

- [ ] **Step 5: Run the new browser tests and fix only integration defects**

Run:

```powershell
rtk corepack pnpm test:e2e -- tests/browser/resume-file-update.spec.ts tests/browser/application-url-hardening.spec.ts tests/browser/profile-workspace.spec.ts
```

Expected: PASS with Playwright traces/screenshots retained only on failure. Confirm the synthetic ATS/application service reports `submissionCount: 0`.

- [ ] **Step 6: Run the complete verification matrix**

Run:

```powershell
rtk corepack pnpm --filter @resume/contracts test
rtk corepack pnpm --filter @resume/api test
rtk corepack pnpm --filter @resume/web test
rtk corepack pnpm typecheck
rtk corepack pnpm build
rtk corepack pnpm test:e2e -- tests/browser/resume-file-update.spec.ts tests/browser/application-url-hardening.spec.ts tests/browser/application-flow.spec.ts tests/browser/submit-safety.spec.ts
```

Expected: every command exits `0`; no browser test performs final submission.

- [ ] **Step 7: Verify a migrated copy of the real database**

Copy `apps/api/data/resume-assistant.sqlite` into a newly created temporary directory, run the migration against the copy, and assert:

```sql
PRAGMA quick_check;
SELECT COUNT(*) FROM documents WHERE is_current = 1;
SELECT COUNT(*) FROM profile_facts WHERE status <> 'superseded';
SELECT id, application_url FROM application_tasks
WHERE id = 'a0b682fc-7d1d-5b39-b090-1efa4d8bca42';
```

Expected: `quick_check` is `ok`; current-document count is `0` or `1`; active fact count matches the pre-migration copy; the historical failed task ID and URL are unchanged. Never run migration experiments on the only real database file.

- [ ] **Step 8: Commit browser regression evidence**

```powershell
rtk git add tests/browser/resume-file-update.spec.ts tests/browser/application-url-hardening.spec.ts tests/browser/profile-workspace.spec.ts tests/browser/test-harness.ts
rtk git commit -m "test: cover resume update and canonical task flow"
```

## Final acceptance checklist

- [ ] Upload-only changes the current PDF and nothing in the profile fact set or revision.
- [ ] A retained/failed current PDF is selected for application upload fields.
- [ ] Parsing is idempotent, retryable, atomic, and protected against current-file switches.
- [ ] Existing completed-document evidence remains readable and Resume Agent ingestion remains completed-only.
- [ ] The exact Wondershare polluted URL creates/opens one task using the clean URL and deterministic UUID.
- [ ] Legal encoded Chinese URLs remain unchanged; unsafe/multiple URLs fail before any side effect.
- [ ] Historical tasks and IDs remain readable and unmodified.
- [ ] Unit, API, typecheck, build, selected full-stack Playwright, and migrated-copy checks all have recorded passing output.
- [ ] Trace/audit records can locate the first failing stage without exposing full query strings.
- [ ] No real or synthetic run clicks a final-submit action.
