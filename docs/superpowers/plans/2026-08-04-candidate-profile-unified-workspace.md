# 候选人档案统一工作区实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将候选人档案改造成以长表单和全局简历解析为中心的资料工作区，并把字段映射与 PDF 证据查看集中到投递审核页面。

**Architecture:** 保留现有 `ProfilePage` 的上传、资料读取和异步竞态保护；新增最新简历摘要接口和两个纯展示组件，将全局信息栏与解析面板从页面逻辑中拆出。`CandidateProfileCenter` 改为集中管理草稿和统一保存，投递内容审核复用统一的证据抽屉能力，档案页移除字段级确认、过滤和证据入口。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、Fastify、Zod、SQLite、Lucide React。

## Global Constraints

- 可见界面文案全部使用中文。
- 用户点击保存档案后视为确认自己的长期资料，不再显示字段级“已确认”状态。
- 简历解析入口全局只保留一个，解析结果按语义写入对应栏目。
- 实习描述、项目描述和项目要点不由档案页自动生成或改写。
- 投递审核仍然独立于档案保存，自动化流程永远不能触发最终提交。
- 既有 `.superpowers/sdd/*` 修改不属于本计划，不得覆盖、回退或加入提交。

---

### Task 1: 增加最新简历摘要接口

**Files:**
- Modify: `packages/contracts/src/http.ts`
- Modify: `apps/api/src/profile/profile-routes.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/api/src/profile/profile-routes.test.ts`
- Test: `apps/web/src/api/client.test.ts`

**Interfaces:**
- Produces `ProfileDocumentSummarySchema`：`{ documentId, filename, importedAt, extractedFactCount }`。
- Produces `ProfileApi.getLatestDocument(): Promise<ProfileDocumentSummary | undefined>`。
- Adds `GET /api/profile/documents/latest`; no document returns `200 { document: null }` to avoid treating an empty profile as a server error.

- [ ] **Step 1: Write failing contract and route tests**

在 `profile-routes.test.ts` 增加：上传并完成导入后请求 `/api/profile/documents/latest`，断言文件名、导入时间、文档 ID 和提取资料数量；空数据库断言 `document: null`。在 `client.test.ts` 增加成功和空结果的 fetch mock。

- [ ] **Step 2: Run focused tests and verify failure**

Run: `corepack pnpm --filter @resume/api test -- profile-routes.test.ts` and `corepack pnpm --filter @resume/web test -- client.test.ts`

Expected: FAIL because the response schema, route and client method do not exist.

- [ ] **Step 3: Implement the schema, route and client method**

Use the existing `DocumentRepository.findLatestCompleted()` result. Count active profile facts whose evidence contains the latest document fingerprint; do not expose source paths or local filesystem details. Parse every response through Zod before returning it from the client.

- [ ] **Step 4: Run focused tests and verify pass**

Run the commands from Step 2.

Expected: PASS, including the no-document response.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/http.ts apps/api/src/profile/profile-routes.ts apps/api/src/profile/profile-routes.test.ts apps/web/src/api/client.ts apps/web/src/api/client.test.ts
git commit -m "feat: expose latest profile document summary"
```

### Task 2: 建立全局档案信息栏和简历解析面板

**Files:**
- Create: `apps/web/src/profile/ProfileSummaryBar.tsx`
- Create: `apps/web/src/profile/ProfileSummaryBar.test.tsx`
- Create: `apps/web/src/profile/ResumeParsePanel.tsx`
- Create: `apps/web/src/profile/ResumeParsePanel.test.tsx`
- Modify: `apps/web/src/profile/ProfilePage.tsx`

**Interfaces:**
- `ProfileSummaryBarProps`: `candidateName`, `targetRole`, `completeness`, `missingCount`, `latestDocument`, `saving`, `onSave`, `onOpenParser`, `onFillMissing`。
- `ResumeParsePanelProps`: `open`, `selectedFile`, `uploadState`, `uploadMessage`, `latestDocument`, `onSelectFile`, `onUpload`, `onRetry`, `onClose`。
- The components are presentational and do not call fetch directly.

- [ ] **Step 1: Write failing component tests**

Test `ProfileSummaryBar` renders candidate name, target role, percentage, missing count, save state and exactly one “简历解析” trigger; clicking “补全资料” calls the callback. Test `ResumeParsePanel` renders filename and latest parse metadata, exposes upload/retry actions for each upload state, and closes through `onClose`.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `corepack pnpm --filter @resume/web test -- ProfileSummaryBar.test.tsx ResumeParsePanel.test.tsx`

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement the two components**

Use the existing `button`, `icon-button`, `profile-*` styling conventions and Lucide icons. Do not render field status badges, evidence buttons or per-section parser actions. Keep the parse panel expandable and responsive; it must show upload failure, import-refreshing and refresh-error messages in Chinese.

- [ ] **Step 4: Integrate the components into `ProfilePage`**

Pass the existing upload state and callbacks into `ResumeParsePanel`; call `api.getLatestDocument()` alongside `listFacts()` and `getCompleteness()`. Place `ProfileSummaryBar` above the profile editor. Remove the old upload-only header from the profile view, but keep the existing request-generation and stale-response guards.

- [ ] **Step 5: Run focused tests and verify pass**

Run: `corepack pnpm --filter @resume/web test -- ProfileSummaryBar.test.tsx ResumeParsePanel.test.tsx ProfilePage.test.tsx`

Expected: PASS with the parser available once in the profile view.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/profile/ProfileSummaryBar.tsx apps/web/src/profile/ProfileSummaryBar.test.tsx apps/web/src/profile/ResumeParsePanel.tsx apps/web/src/profile/ResumeParsePanel.test.tsx apps/web/src/profile/ProfilePage.tsx
git commit -m "feat: add profile summary and global resume parser"
```

### Task 3: 将长表单改为统一草稿和保存模型

**Files:**
- Modify: `apps/web/src/profile/CandidateProfileCenter.tsx`
- Modify: `apps/web/src/profile/RepeatedEntryEditor.tsx`
- Modify: `apps/web/src/profile/CandidateProfileCenter.test.tsx`
- Modify: `apps/web/src/profile/RepeatedEntryEditor.test.tsx`

**Interfaces:**
- `CandidateProfileCenter` owns `draftValues: Record<string, string>`, `dirtyPaths: Set<string>`, `activeSection`, `saveError` and `saving`.
- `RepeatedEntryEditor` changes from per-entry `onSave` to controlled `entries` plus `onChange(values)` and `onAdd()`/`onRemove(index)` callbacks; the parent performs persistence.
- `ScalarField` becomes controlled: `value`, `onChange`, `missing`; remove its individual save icon.

- [ ] **Step 1: Add failing tests for the new save semantics**

Add tests that editing a scalar field shows “有未保存的更改”, does not call `api.upsert` immediately, and clicking “保存档案” persists the changed path. Add tests that switching sections preserves drafts, adding an education/project/award entry keeps it grouped, and project/work field labels remain “项目要点” and “职责和成果”. Add a test that no “已确认”“查看来源” text or field-level source button is rendered.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `corepack pnpm --filter @resume/web test -- CandidateProfileCenter.test.tsx RepeatedEntryEditor.test.tsx`

Expected: FAIL because the current controls save immediately and render section status/source semantics.

- [ ] **Step 3: Implement controlled draft state**

Initialize drafts from the newest active profile fact for each field. On input, update only local draft state. On save, compute changed paths and call `api.upsert` for those paths using `Promise.all`; preserve dirty values and show an error if any request fails. On success call `onFactsChanged`, reinitialize from the returned facts, and clear dirty state. Disable save while a save is in progress.

- [ ] **Step 4: Implement repeated-entry editing rules**

Keep education, work, projects, campus, awards, publications and certificates as separate indexed entries. Preserve the required project order `name -> startDate -> endDate -> description -> technologies -> highlights`; preserve work order `company -> position -> startDate -> endDate -> description/achievements`; keep awards fields `name -> date -> level -> description`. Add remove controls and ensure removing an unsaved entry only changes local state.

- [ ] **Step 5: Implement completeness presentation without confirmation state**

Use completeness only for percentage, missing count and section counts. Empty fields show a local required/missing hint when the registry marks them as required; completed sections use a numeric count or neutral label, never “已确认/待评估”. The left navigation click changes only the active section and does not submit data.

- [ ] **Step 6: Run focused tests and verify pass**

Run: `corepack pnpm --filter @resume/web test -- CandidateProfileCenter.test.tsx RepeatedEntryEditor.test.tsx ProfilePage.test.tsx`

Expected: PASS, including draft preservation and no per-field save/source controls.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/profile/CandidateProfileCenter.tsx apps/web/src/profile/RepeatedEntryEditor.tsx apps/web/src/profile/CandidateProfileCenter.test.tsx apps/web/src/profile/RepeatedEntryEditor.test.tsx
git commit -m "feat: save candidate profile through unified drafts"
```

### Task 4: 移除档案页字段审核并把证据放回投递审核

**Files:**
- Modify: `apps/web/src/profile/ProfilePage.tsx`
- Modify: `apps/web/src/profile/EvidenceDrawer.tsx`
- Create: `apps/web/src/applications/ApplicationEvidenceDrawer.tsx`
- Create: `apps/web/src/applications/ApplicationEvidenceDrawer.test.tsx`
- Modify: `apps/web/src/applications/ContentReviewPage.tsx`
- Modify: `apps/web/src/applications/EvidenceList.tsx`
- Modify: `apps/web/src/profile/ProfilePage.test.tsx`
- Modify: `apps/web/src/applications/ContentReviewPage.test.tsx`

**Interfaces:**
- Refactor `EvidenceDrawer` input from a full `ProfileFact` dependency to a small evidence model: `fieldLabel`, `value`, `evidence`, `returnFocusTo`, `onClose`.
- `ApplicationEvidenceDrawer` converts an `ApplicationContentReview` into that small evidence model and owns the review-specific title/value choice.
- `ContentReviewPage` owns the selected application field and opens the drawer from its evidence section; `ProfilePage` no longer imports or renders `EvidenceDrawer`.
- `EvidenceList` retains the compact evidence list and adds a “查看原文” action that opens the drawer rather than only a new PDF tab.

- [ ] **Step 1: Add failing tests for evidence ownership**

Update profile tests to assert the profile editor has no field status filters, “查看来源” action, or standalone evidence list. Add content-review tests that clicking a field evidence action opens a dialog showing the field label, value, PDF page and grounding highlight request, and closing it returns focus to the trigger.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `corepack pnpm --filter @resume/web test -- ProfilePage.test.tsx ContentReviewPage.test.tsx`

Expected: FAIL because profile currently owns the evidence drawer and application evidence only links to a PDF.

- [ ] **Step 3: Refactor the evidence drawer model**

Keep the existing PDF page image, exact/page-level grounding states, keyboard trap, Escape handling and focus restoration. Replace the direct `ProfileFact` dependency with the small evidence model, then implement `ApplicationEvidenceDrawer` with `value={review.draft}` and `evidence={review.evidence}` so application reviews do not create fake profile facts.

- [ ] **Step 4: Move the entry point into content review**

Render the drawer from `ContentReviewPage` with the current application field's proposed/original value and evidence. Keep user-confirmed evidence readable, but do not attempt PDF grounding for it. Keep final approval/rejection controls unchanged and preserve the rule that approval is not recruitment submission.

- [ ] **Step 5: Remove profile review-only UI**

Delete the profile status filter/count rendering, per-fact confirm/correct affordances and profile evidence trigger paths. Keep the existing upload race protection, self-evaluation review and RAG workspace behavior unless they are required by the new profile form contract. Remove now-unused imports, state and helper functions only after the tests identify them as unreachable.

- [ ] **Step 6: Run focused tests and verify pass**

Run: `corepack pnpm --filter @resume/web test -- ProfilePage.test.tsx ContentReviewPage.test.tsx ApplicationTaskPage.test.tsx`

Expected: PASS; evidence is available during投递审核 and absent from the档案编辑表单.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/profile/ProfilePage.tsx apps/web/src/profile/EvidenceDrawer.tsx apps/web/src/applications/ApplicationEvidenceDrawer.tsx apps/web/src/applications/ApplicationEvidenceDrawer.test.tsx apps/web/src/applications/ContentReviewPage.tsx apps/web/src/applications/EvidenceList.tsx apps/web/src/profile/ProfilePage.test.tsx apps/web/src/applications/ContentReviewPage.test.tsx
git commit -m "feat: move profile evidence review into application review"
```

### Task 5: 完成样式、工作区回归和真实页面验证

**Files:**
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/workspace/ProfileApplicationWorkspace.test.tsx`
- Modify: `apps/web/src/profile/ProfilePage.test.tsx`
- Modify: `apps/web/src/profile/CandidateProfileCenter.test.tsx`
- Modify: `apps/web/src/applications/ApplicationTaskPage.test.tsx`
- Create: `tests/browser/profile-workspace.spec.ts`

- [ ] **Step 1: Add failing responsive and workspace assertions**

Assert the workspace keeps only “候选人档案 / 新建投递 / 投递审核” at the shell level, the profile view has one global parser, the summary bar remains readable at 1280px and 390px, and navigating to “补全资料” selects the correct section. Assert an application review can inspect evidence without exposing a profile evidence tab.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `corepack pnpm --filter @resume/web test -- ProfileApplicationWorkspace.test.tsx ProfilePage.test.tsx CandidateProfileCenter.test.tsx ApplicationTaskPage.test.tsx`

Expected: FAIL until styles and updated navigation/test fixtures match the new structure.

- [ ] **Step 3: Update styles**

Modify the existing profile workspace styles in `apps/web/src/styles.css` to add the global information bar, parser panel, controlled form states, section navigation counts, repeated-entry actions and responsive stacking. Remove styles for obsolete profile fact status filters and field evidence actions. Keep cards shallow, avoid nested card surfaces, and keep all visible text Chinese.

- [ ] **Step 4: Run web verification**

Run: `corepack pnpm --filter @resume/web test && corepack pnpm --filter @resume/web typecheck && corepack pnpm --filter @resume/web build`

Expected: all web tests pass, TypeScript reports no errors, and Vite build succeeds.

- [ ] **Step 5: Run repository verification**

Run: `corepack pnpm test && corepack pnpm typecheck && corepack pnpm build`

Expected: all workspace package tests, repository typecheck and builds pass; unrelated `.superpowers/sdd/*` changes remain untouched.

- [ ] **Step 6: Run browser-level visual verification**

Run: `corepack pnpm test:e2e -- --grep "候选人档案|投递审核"`.

Verify manually in the running local app at `http://127.0.0.1:5173/`: open the global parser, upload/refresh a PDF fixture, edit a basic field, switch sections without losing the draft, save the archive, then open a投递审核 field and inspect its PDF evidence. Do not click any final recruitment submission control.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/styles.css apps/web/src/workspace/ProfileApplicationWorkspace.test.tsx apps/web/src/profile/ProfilePage.test.tsx apps/web/src/profile/CandidateProfileCenter.test.tsx apps/web/src/applications/ApplicationTaskPage.test.tsx tests/browser/profile-workspace.spec.ts
git commit -m "feat: polish unified candidate profile workspace"
```

## Final Review Checklist

- The global parser exists exactly once in the candidate profile view.
- The profile view has no field-level confirmation badges, status filters or source buttons.
- Save state is explicit and unsaved drafts are not lost on section changes.
- Education, work, project and award entries remain separately grouped and ordered.
- Project highlights and work responsibilities remain user-authored.
- Application review displays field mapping and PDF evidence, including page-level or exact grounding where available.
- Final recruitment submission remains unavailable to automation.
