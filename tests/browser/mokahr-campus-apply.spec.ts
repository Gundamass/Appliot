import { expect, test, type Page } from "@playwright/test";
import { ChallengeDetector } from "../../apps/browser-worker/src/challenge-detector.js";
import { JobObserver } from "../../apps/browser-worker/src/job-observer.js";

const CAMPUS_URL = "https://app.mokahr.com/campus_apply/acme-campus/39595";

test("observes Mokahr campus_apply lists without tenant-specific rules", async ({ page }) => {
  await installCampusApplyFixture(page);
  await page.goto(`${CAMPUS_URL}#/jobs`);
  const detector = new ChallengeDetector();
  detector.start(page);
  const snapshot = await new JobObserver(page as never, detector).observe("campus-list");

  expect(snapshot.entryHint).toBe("job_list");
  expect(snapshot.jobCards).toEqual([
    expect.objectContaining({
      sourceJobId: "java-lead",
      canonicalUrl: `${CAMPUS_URL}#/jobs/java-lead`,
      title: "Java 技术负责人",
      organization: "示例科技",
      location: "深圳"
    }),
    expect.objectContaining({
      sourceJobId: "backend-architect",
      canonicalUrl: `${CAMPUS_URL}#/jobs/backend-architect`,
      title: "后端架构师"
    })
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

  await page.goto(`${CAMPUS_URL}#/jobs/java-lead`);
  expect((await observer.observe("campus-detail")).entryHint).toBe("job_detail");

  await page.goto(`${CAMPUS_URL}#/jobs/java-lead/apply`);
  const application = await observer.observe("campus-application");
  expect(application.entryHint).toBe("application_form");
  expect(application.jobCards).toHaveLength(0);

  await page.goto(`${CAMPUS_URL}#/login`);
  expect((await observer.observe("campus-login")).entryHint).toBe("login");

  await page.goto(`${CAMPUS_URL}#/jobs/no-link`);
  const noLink = await observer.observe("campus-no-link");
  expect(noLink.entryHint).toBe("unknown");
  expect(noLink.jobCards).toHaveLength(0);
  expect(noLink.challenge).toBeUndefined();
  detector.dispose();
});

async function installCampusApplyFixture(page: Page): Promise<void> {
  await page.route(`${CAMPUS_URL}**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: campusApplyShell()
    });
  });
}

function campusApplyShell(): string {
  return `<!doctype html>
    <html lang="zh-CN">
      <head><meta charset="utf-8"><title>Mokahr 校园招聘</title></head>
      <body><main id="app"></main>
        <script>
          const app = document.querySelector("#app");
          const render = () => {
            const path = location.hash;
            if (path === "#/jobs") {
              app.innerHTML = '<h1>职位列表</h1>' +
              '<div class="position-item" data-position-id="java-lead">' +
                '<a class="position-link" href="#/jobs/java-lead">' +
                  '<span class="position-title">Java 技术负责人</span>' +
                  '<span class="company-name">示例科技</span>' +
                  '<span class="job-location">深圳</span>' +
                  '<span class="job-summary">本科及以上，5 年 Java 经验</span>' +
                '</a>' +
              '</div>' +
              '<div class="position-item" data-position-id="backend-architect">' +
                '<a class="position-link" href="#/jobs/backend-architect">' +
                  '<span class="position-title">后端架构师</span>' +
                  '<span class="company-name">示例科技</span>' +
                  '<span class="job-location">杭州</span>' +
                  '<span class="job-summary">负责平台架构</span>' +
                '</a>' +
              '</div>';
            } else if (path === "#/jobs/no-link") {
              app.innerHTML = '<h1>职位列表</h1><div class="position-item" data-position-id="hidden-job" onclick="return false">' +
              '<span class="position-title">不可导航岗位</span></div>';
            } else if (path.endsWith("/apply")) {
              app.innerHTML = '<h1>申请职位</h1><form><label>简历<input type="file" name="resume"></label><input name="candidateName"></form>';
            } else if (path === "#/login") {
              app.innerHTML = '<h1>登录招聘系统</h1><form><label>密码<input type="password" name="password"></label></form>';
            } else if (path.startsWith("#/jobs/")) {
              app.innerHTML = '<article class="position-detail"><h1>Java 技术负责人</h1>' +
              '<p>示例科技 · 深圳</p><section class="job-description"><h2>岗位职责</h2>' +
              '<p>负责平台服务设计、交付与技术治理。</p><h2>岗位要求</h2>' +
              '<ul><li>本科及以上学历</li><li>五年以上 Java 开发经验</li></ul></section></article>';
            } else {
              app.innerHTML = '<h1>未知页面</h1>';
            }
          };
          render();
          window.addEventListener("hashchange", render);
        </script>
      </body>
    </html>`;
}
