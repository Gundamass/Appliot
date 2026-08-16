# Mokahr Campus Apply 适配实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让浏览器观察器和岗位匹配链路识别任意租户的 Mokahr `campus_apply` 岗位列表、岗位详情和申请表单，并保持未知页面安全拒绝、零自动提交。

**Architecture:** 在现有 `JobObserver` 浏览器脚本中增加仅针对 Mokahr `campus_apply` 路径的模板分支，先使用专用卡片/详情抽取，再回退到现有通用选择器。快照协议、Moka Adapter、JobMatchService 和投递安全策略保持不变；仅补齐 Adapter 回归夹具和前端错误文案。

**Tech Stack:** TypeScript, Playwright, Vitest, `@resume/contracts`, `@resume/job-matching`, React/Vite。

## Global Constraints

- 适配所有合法 `mokahr.com` 域下的 `/campus_apply/<tenant>/<campaign>`，不得写入租户或公司名称特判。
- 不访问真实 ATS 页面；浏览器回归只使用本地 Playwright route fixture 或 Synthetic ATS。
- 不绕过登录、验证码、iframe、Shadow DOM 或风控；检测到挑战/边界时继续拒绝页面。
- 岗位卡片必须有同域、可导航的规范 URL；没有可靠链接的列表项不得伪造成岗位。
- 不自动选岗、创建未确认的投递任务或触发最终提交；所有 E2E 断言 `submissionCount === 0`。
- 严格执行 TDD：每个生产行为先写测试并观察预期失败，再写最小实现。
- 所有 Shell 命令以 `rtk` 开头；不读取或提交 `.env.local`、本地数据库、简历或浏览器配置。

---

### Task 1: Add a failing browser-observer regression for the campus_apply template

**Files:**
- Create: `tests/browser/mokahr-campus-apply.spec.ts`
- Modify: `apps/browser-worker/src/job-observer.test.ts` only to add a bounded contract assertion if the implementation changes filter/pagination readback.

**Interfaces:**
- Consumes: `JobObserver.observe`, `ChallengeDetector`, `@playwright/test` `Page`.
- Produces: a local, deterministic route fixture that exposes list, detail, application, login, and non-navigable-card states at Mokahr-shaped URLs.

- [ ] **Step 1: Add a local page route and failing assertions.**

Create a Playwright test that intercepts `https://app.mokahr.com/campus_apply/acme-campus/39595**` and fulfills HTML without contacting the network. The list fixture must use two visible cards with classes such as `position-item`, `data-job-id`, and anchors whose hrefs are `#/jobs/java-lead` and `#/jobs/backend-architect`; include title, company, location, and summary text. Add detail, application, login, and a card with only a click handler/no href variants. Assert the intended behavior:

```ts
test("observes Mokahr campus_apply lists without tenant-specific rules", async ({ page }) => {
  await installCampusApplyFixture(page);
  await page.goto("https://app.mokahr.com/campus_apply/acme-campus/39595#/jobs");
  const detector = new ChallengeDetector();
  detector.start(page);
  const snapshot = await new JobObserver(page as never, detector).observe("campus-list");

  expect(snapshot.entryHint).toBe("job_list");
  expect(snapshot.jobCards).toEqual([
    expect.objectContaining({
      sourceJobId: "java-lead",
      canonicalUrl: "https://app.mokahr.com/campus_apply/acme-campus/39595#/jobs/java-lead",
      title: "Java 技术负责人",
      organization: "示例科技",
      location: "深圳"
    }),
    expect.objectContaining({ sourceJobId: "backend-architect", title: "后端架构师" })
  ]);
  expect(snapshot.jobCards).toHaveLength(2);
  expect(snapshot.url).toContain("/campus_apply/acme-campus/39595");
  detector.dispose();
});

test("keeps campus_apply safety boundaries", async ({ page }) => {
  await installCampusApplyFixture(page);
  const detector = new ChallengeDetector();
  detector.start(page);
  const observer = new JobObserver(page as never, detector);

  await page.goto("https://app.mokahr.com/campus_apply/acme-campus/39595#/jobs/java-lead");
  expect((await observer.observe("campus-detail")).entryHint).toBe("job_detail");

  await page.goto("https://app.mokahr.com/campus_apply/acme-campus/39595#/jobs/java-lead/apply");
  const application = await observer.observe("campus-application");
  expect(application.entryHint).toBe("application_form");
  expect(application.jobCards).toHaveLength(0);

  await page.goto("https://app.mokahr.com/campus_apply/acme-campus/39595#/login");
  expect((await observer.observe("campus-login")).entryHint).toBe("login");

  await page.goto("https://app.mokahr.com/campus_apply/acme-campus/39595#/jobs/no-link");
  const noLink = await observer.observe("campus-no-link");
  expect(noLink.entryHint).toBe("unknown");
  expect(noLink.jobCards).toHaveLength(0);
  expect(noLink.challenge).toBeUndefined();
  detector.dispose();
});
```

The second test must contain concrete `page.goto` calls and assertions for all four states; do not use a single parameterized assertion that hides which page failed. The no-href card must remain `unknown` rather than being converted into a fake posting URL.

- [ ] **Step 2: Run the new test and verify the expected RED failure.**

Run: `rtk playwright test tests/browser/mokahr-campus-apply.spec.ts --grep "campus_apply"`

Expected: the list assertion fails because the current observer returns `unknown` and no `campus_apply` cards. If the test fails for fixture setup, URL routing, or a syntax error instead, correct the test until the failure is specifically the missing observer behavior.

- [ ] **Step 3: Commit only the failing regression fixture.**

Run:

```text
rtk git add tests/browser/mokahr-campus-apply.spec.ts
rtk git commit -m "test: reproduce Mokahr campus apply observation gap"
```

### Task 2: Implement the dedicated campus_apply observer branch

**Files:**
- Modify: `apps/browser-worker/src/job-observer.ts`
- Test: `tests/browser/mokahr-campus-apply.spec.ts`
- Test: `apps/browser-worker/src/job-observer.test.ts` for any changed filter/pagination readback contract.

**Interfaces:**
- Consumes: existing `JobPageSnapshotSchema`, `ChallengeDetector`, `FilterPlan` and `Page` interfaces.
- Produces: the same `JobPageSnapshot` shape with reliable `entryHint`, `jobCards`, filter state, and pagination for `campus_apply`.

- [ ] **Step 1: Add the smallest browser-script implementation.**

Inside `JOB_OBSERVATION_SCRIPT`, add an `isCampusApply` predicate requiring a Mokahr host and a pathname matching `/campus_apply/<tenant>/<campaign>`. Add local helpers for normalized text, visible elements, same-domain canonical URLs, and parent-card de-duplication. The card candidate selector must cover explicit attributes and stable semantic class fragments without selecting arbitrary text containers:

```js
const campusCardSelector = [
  "[data-job-id]", "[data-position-id]", "[data-recruitment-id]",
  "[data-job-card]", "[class*=job-item]", "[class*=position-item]",
  "[class*=recruit-item]", "[class*=post-item]"
].join(",");
```

For each candidate, require visibility, a title, and an anchor/data URL that resolves to the current Mokahr origin. Read the ID from `data-job-id`, `data-position-id` or `data-recruitment-id`; read title, organization, location, and summary from explicit data attributes first, then semantic class/heading descendants. Reject a card that has only an `onclick` or a bare ID with no URL. De-duplicate by canonical URL and cap at the existing 2,000-card boundary.

Use this entry precedence in the script: existing application-form signal, campus cards (`job_list`), campus detail signal with a single current-page card (`job_detail`), existing login signal, then existing generic list/detail detection, then `unknown`. For a detail page, accept the current canonical URL only when it is a same-domain campus URL with a job fragment/id and the visible page contains a title plus a description container. Do not let a campus list card override a challenge or interactive boundary; `ChallengeDetector` remains authoritative in `observe` and the Adapter.

Extend only the read-side selectors for campus pagination and filters. Accept accessible next-page controls (`a[rel=next]`, `button[data-next-page]`, or visible controls whose label/text is `下一页`/`Next`) and the existing `data-resume-filter-key`/`data-filter-key` attributes. Keep `APPLY_FILTERS_SCRIPT` and `ADVANCE_PAGE_SCRIPT` unchanged unless a failing campus fixture demonstrates a necessary selector addition; any addition must still throw `job_filter_control_missing` or `job_next_page_unavailable` when the control cannot be identified.

- [ ] **Step 2: Run the focused browser regression and make it GREEN.**

Run: `rtk playwright test tests/browser/mokahr-campus-apply.spec.ts --grep "campus_apply"`

Expected: all campus list/detail/application/login/no-href assertions pass, with no network request to a real Mokahr server. If a selector matches nested cards, fix parent-card de-duplication rather than weakening the assertions.

- [ ] **Step 3: Add observer contract coverage and verify existing behavior.**

Add a focused assertion to `apps/browser-worker/src/job-observer.test.ts` only for any changed filter/pagination readback behavior, then run:

```text
rtk pnpm --filter @resume/browser-worker test -- src/job-observer.test.ts
rtk playwright test tests/browser/job-matching.spec.ts --grep "structured observation|identifies job detail"
```

Expected: the existing Synthetic ATS list/detail/application/login/challenge tests remain green and the new campus script does not change non-campus pages.

- [ ] **Step 4: Commit the observer implementation and regression tests.**

Run:

```text
rtk git add apps/browser-worker/src/job-observer.ts apps/browser-worker/src/job-observer.test.ts tests/browser/mokahr-campus-apply.spec.ts
rtk git commit -m "fix: observe Mokahr campus apply job pages"
```

### Task 3: Add adapter and service coverage for arbitrary campus tenants

**Files:**
- Modify: `packages/job-matching/src/adapters/fixtures.ts`
- Modify: `packages/job-matching/src/adapters/moka-job-adapter.test.ts`
- Modify: `apps/api/src/job-matching/job-match-service.test.ts` to run a real `mokaJobAdapter` against a campus URL during session creation.
- Modify: `apps/web/src/job-matching/JobMatchStartPanel.tsx`
- Modify: `apps/web/src/job-matching/JobMatchStartPanel.test.tsx`

**Interfaces:**
- Consumes: existing `mokaJobAdapter`, `JobPageSnapshot`, `JobMatchApiError` and `JobMatchStartPanel` contracts.
- Produces: proof that the adapter accepts campus list/detail/application snapshots for multiple tenant names, rejects foreign URLs, and the UI no longer mislabels an observation failure as unsupported Moka/Mokahr.

- [ ] **Step 1: Add failing adapter fixtures/tests before production changes.**

Add `campusMokaListFixture`, `campusMokaDetailFixture`, and `campusMokaApplicationFixture` using at least two neutral tenant slugs (for example `acme-campus` and `another-tenant`) and URLs of the form `https://app.mokahr.com/campus_apply/<tenant>/39595#/jobs...`. Assert `mokaJobAdapter.identify` returns `job_list`, `job_detail`, and `application_form`, `extractList` preserves same-domain canonical URLs, and a `https://jobs.example.test/...` card still throws `job_adapter_contract_mismatch`. The tests must fail if the adapter accidentally restricts the implementation to one tenant.

Add a `JobMatchStartPanel` test that makes `jobMatchApi.create` reject with `new JobMatchApiError("unsupported", "unsupported_job_entry")`, then asserts the alert says the page structure was not recognized and does not say “当前仅支持 Moka/Mokahr”. This test should fail against the current copy.

- [ ] **Step 2: Run the focused tests and confirm RED.**

Run:

```text
rtk pnpm --filter @resume/job-matching test -- src/adapters/moka-job-adapter.test.ts
rtk pnpm --filter @resume/web test -- src/job-matching/JobMatchStartPanel.test.tsx
```

Expected: adapter campus fixture tests fail only where the new fixture/behavior is absent, and the UI test fails only on the old error text. Correct setup failures before implementation.

- [ ] **Step 3: Implement the minimal adapter/UI changes.**

Keep `mokaJobAdapter.supportsUrl` host-based (`mokahr.com` and its subdomains); do not add tenant strings or a separate adapter. If a campus fixture exposes a URL parsing edge case, normalize it in the shared `createSnapshotJobAdapter` URL check and preserve the foreign-origin rejection.

Change the `unsupported_job_entry` UI mapping to `当前招聘页面结构尚未识别，请确认链接打开的是岗位列表或岗位详情页。` while leaving the formal supported-source boundary in the surrounding help text. Do not change API error codes or direct-application redirect behavior. In the API test, extend the local `harness` with a `JobAdapter` parameter and a URL parameter, pass `mokaJobAdapter` plus `https://app.mokahr.com/campus_apply/acme-campus/39595#/jobs`, and assert `service.create` returns `source: "moka"` and `entryKind: "job_list"`; the browser mock must still report zero execution calls.

- [ ] **Step 4: Run adapter, service and UI tests and commit.**

Run:

```text
rtk pnpm --filter @resume/job-matching test -- src/adapters/moka-job-adapter.test.ts
rtk pnpm --filter @resume/api test -- src/job-matching/job-match-service.test.ts
rtk pnpm --filter @resume/web test -- src/job-matching/JobMatchStartPanel.test.tsx
```

Expected: all focused tests pass, including existing login/challenge/foreign-origin rejection and the UI redirect tests. Then commit:

```text
rtk git add packages/job-matching/src/adapters/fixtures.ts packages/job-matching/src/adapters/moka-job-adapter.test.ts apps/api/src/job-matching/job-match-service.test.ts apps/web/src/job-matching/JobMatchStartPanel.tsx apps/web/src/job-matching/JobMatchStartPanel.test.tsx
rtk git commit -m "test: cover Mokahr campus apply adapter tenants"
```

### Task 4: Full verification and handoff

**Files:**
- Modify: none unless verification exposes a regression; any follow-up fix must get a new focused RED test before production changes.
- Test: `tests/browser/mokahr-campus-apply.spec.ts`, existing Browser Worker, Adapter, API, and Web suites.

**Interfaces:**
- Consumes: all outputs from Tasks 1–3.
- Produces: fresh evidence for campus list/detail/application routing, no real-site access, no automatic submission, and clean type/build checks.

- [ ] **Step 1: Run all owning package tests.**

Run:

```text
rtk pnpm --filter @resume/browser-worker test
rtk pnpm --filter @resume/job-matching test
rtk pnpm --filter @resume/api test
rtk pnpm --filter @resume/web test
```

Expected: each command exits 0 with no failed tests.

- [ ] **Step 2: Run browser regressions and verify zero submission.**

Run:

```text
rtk playwright test tests/browser/mokahr-campus-apply.spec.ts tests/browser/job-matching.spec.ts
```

Expected: campus fixtures, existing Synthetic ATS matching, filter confirmation, pagination, redirects, conflict selection, and challenge boundaries pass; every relevant fixture state reports `submissionCount === 0`.

- [ ] **Step 3: Run typecheck and production build.**

Run:

```text
rtk pnpm typecheck
rtk pnpm build
```

Expected: TypeScript and all workspace builds exit 0. Do not claim completion if either command fails; record the exact failing package and continue with a focused RED/GREEN fix.

- [ ] **Step 4: Review the final diff and commit verification metadata only if needed.**

Run:

```text
rtk git diff --check
rtk git status --short --branch
rtk git log --oneline -5
```

Expected: no whitespace errors, only intentional Mokahr campus changes are present, and no sensitive files are staged. Report the test/build evidence and explicitly state that real Mokahr pages were not accessed and final submission remains blocked.
