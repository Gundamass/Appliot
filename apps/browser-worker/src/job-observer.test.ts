import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobObserver } from "./job-observer.js";

const rawSnapshot = {
  entryHint: "job_list" as const,
  visibleText: ["岗位列表", "Java Tech Lead"],
  jobCards: [{
    sourceJobId: "job-1",
    canonicalUrl: "https://jobs.example.test/job/1",
    title: "Java Tech Lead",
    organization: "Example",
    location: "深圳",
    summary: "负责平台架构"
  }],
  filterState: [{ key: "location", values: ["深圳"] }],
  pagination: { kind: "page" as const, current: 1, hasNext: true, nextCursor: "page-2" }
};

function createPage() {
  return {
    url: vi.fn(() => "https://jobs.example.test/list"),
    title: vi.fn(async () => "岗位列表"),
    evaluate: vi.fn(async (_script: string) => rawSnapshot)
  };
}

describe("JobObserver", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recognizes the current DJI portal list despite hashed classes and embedded descriptions", async () => {
    const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    try {
      const page = await browser.newPage();
      await page.route("**/*", async (route) => route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><body>
          <main>
            <div class="container-a normal-b card-c">
              <a class="link-d" href="#/job/job-1">
                <span class="title-e">后端开发工程师（深圳）</span>
                <div class="info-f"><div class="sd-foundation-body-secondary-g"><span class="sd-Ellipsis-hiddenContent">广东·深圳市</span><span class="no-adaptive-tooltip">广东·深圳市</span></div></div>
                <div class="job-description-h">职位简介：负责平台架构与服务开发。</div>
              </a>
            </div>
            <div class="container-i normal-j card-k">
              <a class="link-l" href="#/job/job-2">
                <span class="title-m">算法工程师（上海）</span>
                <div class="info-n"><div class="sd-foundation-body-secondary-o"><span class="sd-Ellipsis-hiddenContent">上海市</span><span class="no-adaptive-tooltip">上海市</span></div></div>
                <div class="job-description-p">职位简介：负责算法研发。</div>
              </a>
            </div>
          </main>
        </body></html>`
      }));
      await page.goto("https://apply.careers.dji.com/campus-recruitment/dji/143359?locale=zh-CN#/", {
        waitUntil: "domcontentloaded"
      });

      const detector = { inspect: vi.fn(async () => ({ boundaries: [] })) };
      const snapshot = await new JobObserver(page, detector as never).observe("jm-dji");

      expect(snapshot).toMatchObject({
        ownerId: "jm-dji",
        entryHint: "job_list",
        jobCards: [
          {
            canonicalUrl: "https://apply.careers.dji.com/campus-recruitment/dji/143359?locale=zh-CN#/job/job-1",
            title: "后端开发工程师(深圳)",
            organization: "DJI",
            location: "广东·深圳市",
            summary: "职位简介:负责平台架构与服务开发。"
          },
          {
            canonicalUrl: "https://apply.careers.dji.com/campus-recruitment/dji/143359?locale=zh-CN#/job/job-2",
            title: "算法工程师(上海)",
            organization: "DJI",
            location: "上海市",
            summary: "职位简介:负责算法研发。"
          }
        ]
      });
    } finally {
      await browser.close();
    }
  });

  it("applies DJI keyword and location filters and returns their readback", async () => {
    const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    try {
      const page = await browser.newPage();
      await page.route("**/*", async (route) => route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><body>
          <main>
            <label><input type="text" placeholder="搜索职位关键词"></label>
            <section><h2>工作地点</h2>
              <label><input type="checkbox"><span class="sd-Ellipsis-hiddenContent">深圳市</span><span class="no-adaptive-tooltip">深圳市</span></label>
              <label><input type="checkbox"><span class="sd-Ellipsis-hiddenContent">上海市</span><span class="no-adaptive-tooltip">上海市</span></label>
            </section>
            <div id="results"></div>
            <script>
              document.querySelector('[placeholder="搜索职位关键词"]').addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                  event.currentTarget.dataset.entered = 'true';
                  setTimeout(() => {
                    document.querySelector('#results').innerHTML = '<div class="container-a card-b"><a href="#/job/job-1"><span class="title-c">后端开发工程师</span><div class="job-description-d">职位简介:负责平台开发。</div></a></div>';
                  }, 250);
                }
              });
            </script>
          </main>
        </body></html>`
      }));
      await page.goto("https://apply.careers.dji.com/campus-recruitment/dji/143359?locale=zh-CN#/", {
        waitUntil: "domcontentloaded"
      });

      const detector = { inspect: vi.fn(async () => ({ boundaries: [] })) };
      const observer = new JobObserver(page, detector as never);
      await expect(observer.applyFilters("jm-dji", {
        source: "dji",
        adapterVersion: "dji-job-v1",
        mapped: [
          { criterionIndex: 0, key: "keyword", values: ["后端"] },
          { criterionIndex: 1, key: "work_location", values: ["深圳市"] }
        ],
        localOnly: []
      })).resolves.toMatchObject({
        entryHint: "job_list",
        jobCards: [{ title: "后端开发工程师" }],
        filterState: [
          { key: "keyword", values: ["后端"] },
          { key: "work_location", values: ["深圳市"] }
        ]
      });
      expect(await page.locator('input[placeholder="搜索职位关键词"]').getAttribute("data-entered")).toBe("true");
    } finally {
      await browser.close();
    }
  });

  it("queries Baidu's official list API for semantic filters and paginates without navigating the page", async () => {
    const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    try {
      const page = await browser.newPage();
      await page.route("**/*", async (route) => route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><head><title>百度校园招聘</title></head><body>
          <main>
            <section class="param-item"><div class="param-title">职位类别</div>
              <label><input type="checkbox"><span>技术</span></label>
              <label><input type="checkbox"><span>产品</span></label>
            </section>
            <section class="param-item" id="locations"><div class="param-title">职位地点</div>
              <label><input type="checkbox"><span>北京市</span></label>
              <button type="button" id="more-locations">更多</button>
            </section>
            <script>
              window.__INITIAL_DATA__ = { listData: {
                pageNum: 1, pageSize: 10, total: 1, listDetailData: [],
                postList: [{ value: '1', label: '技术' }, { value: '2', label: '产品' }],
                workPlaceList: [{ value: '1100', label: '北京市' }, { value: '9000', label: '全国' }],
                graduateProjectList: [{ value: '1', label: '校招' }, { value: '4', label: '管培生项目' }]
              } };
              const select = (label, key, value) => label.addEventListener('click', () => {
                label.querySelector('input').checked = true;
                const url = new URL(location.href);
                url.searchParams.set(key, value);
                location.assign(url);
              });
              select(document.querySelector('.param-item label'), 'postType', '1');
              document.querySelector('#more-locations').addEventListener('click', () => {
                setTimeout(() => {
                  const label = document.createElement('label');
                  label.innerHTML = '<input type="checkbox"><span>全国</span>';
                  select(label, 'workPlace', '9000');
                  document.querySelector('#locations').append(label);
                }, 0);
              });
            </script>
          </main>
        </body></html>`
      }));
      await page.goto("https://talent.baidu.com/jobs/list?projectType=1&recruitType=GRADUATE", {
        waitUntil: "domcontentloaded"
      });
      const requestPostSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
        const requestedPage = Number(new URLSearchParams(String(options?.body)).get("curPage") ?? "1");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "ok",
            data: {
              total: "20",
              list: [{
                postId: `post-${requestedPage}`,
                jobId: `job-${requestedPage}`,
                name: `技术岗位 ${requestedPage}`,
                postType: "技术",
                workPlace: "北京市",
                projectType: "校招",
                projectTypeCode: "1"
              }],
              pageNum: requestedPage
            }
          })
        } as never;
      });
      const gotoSpy = vi.spyOn(page, "goto");

      const detector = { inspect: vi.fn(async () => ({ boundaries: [] })) };
      const observer = new JobObserver(page, detector as never);
      const result = await observer.applyFilters("jm-baidu", {
        source: "baidu",
        adapterVersion: "baidu-job-v1",
        mapped: [
          { criterionIndex: 0, key: "postType", values: ["技术"] },
          { criterionIndex: 1, key: "workPlace", values: ["全国"] }
        ],
        localOnly: [{ criterionIndex: 2, reasonCode: "unsupported_employment_type" }]
      });

      expect(result.filterState).toEqual([
        { key: "postType", values: ["技术"] },
        { key: "workPlace", values: ["全国"] }
      ]);
      expect(page.url()).toBe("https://talent.baidu.com/jobs/list?projectType=1&recruitType=GRADUATE");
      expect(gotoSpy).not.toHaveBeenCalled();
      expect(requestPostSpy).toHaveBeenCalledWith(
        "https://talent.baidu.com/httservice/getPostListNew",
        expect.objectContaining({
          headers: expect.objectContaining({ referer: "https://talent.baidu.com/jobs/list?projectType=1&recruitType=GRADUATE" })
        })
      );
      const firstRequest = new URLSearchParams(String(requestPostSpy.mock.calls[0]?.[1]?.body));
      expect(firstRequest.get("postType")).toBe("1");
      expect(firstRequest.get("workPlace")).toBeNull();
      expect(firstRequest.get("projectType")).toBeNull();
      expect(firstRequest.get("curPage")).toBe("1");
      await expect(observer.advance("jm-baidu", "2")).resolves.toMatchObject({
        url: "https://talent.baidu.com/jobs/list?projectType=1&recruitType=GRADUATE&postType=1&workPlace=9000&pageNum=2",
        pagination: { kind: "page", current: 2, hasNext: false }
      });
      const secondRequest = new URLSearchParams(String(requestPostSpy.mock.calls[1]?.[1]?.body));
      expect(secondRequest.get("curPage")).toBe("2");
      await expect(observer.advance("jm-baidu", "not-a-page")).rejects.toThrow("job_next_page_unavailable");
      await expect(observer.observe("jm-other")).rejects.toThrow("job_snapshot_owner_mismatch");
    } finally {
      await browser.close();
    }
  });

  it("fails closed when Baidu's official list response changes shape", async () => {
    const page = {
      url: vi.fn(() => "https://talent.baidu.com/jobs/list?projectType=1&recruitType=GRADUATE")
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        data: { total: "1", pageNum: 1, list: [{ postId: "post-without-title", postType: "技术" }] }
      })
    } as never);
    const observer = new JobObserver(page as never, { inspect: vi.fn() } as never);

    await expect(observer.applyFilters("jm-baidu", {
      source: "baidu",
      adapterVersion: "baidu-job-v1",
      mapped: [{ criterionIndex: 0, key: "postType", values: ["技术"] }],
      localOnly: []
    })).rejects.toThrow("job_filter_response_invalid");
  });

  it("fails closed when Baidu ignores filters or returns a different page", async () => {
    const page = {
      url: vi.fn(() => "https://talent.baidu.com/jobs/list?projectType=1&recruitType=GRADUATE")
    };
    const response = (postType: string, pageNum: number) => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        data: {
          total: "1",
          pageNum,
          list: [{
            postId: "post-1",
            name: "测试岗位",
            postType,
            workPlace: "北京市",
            projectType: "校招",
            projectTypeCode: "1"
          }]
        }
      })
    } as never);
    const plan = {
      source: "baidu" as const,
      adapterVersion: "baidu-job-v1",
      mapped: [{ criterionIndex: 0, key: "postType", values: ["技术"] }],
      localOnly: []
    };
    const ignoredFilterObserver = new JobObserver(page as never, { inspect: vi.fn() } as never);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response("产品", 1));
    await expect(ignoredFilterObserver.applyFilters("jm-filter", plan))
      .rejects.toThrow("job_filter_readback_mismatch:postType");

    const wrongPageObserver = new JobObserver(page as never, { inspect: vi.fn() } as never);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(response("技术", 2));
    await expect(wrongPageObserver.applyFilters("jm-page", plan))
      .rejects.toThrow("job_page_readback_mismatch");
  });

  it("returns only a bounded structured job snapshot", async () => {
    const page = createPage();
    const detector = { inspect: vi.fn(async () => ({ boundaries: [] })) };
    const snapshot = await new JobObserver(page as never, detector as never).observe("jm-1");

    expect(snapshot).toMatchObject({
      ownerId: "jm-1",
      entryHint: "job_list",
      jobCards: [{ title: "Java Tech Lead" }],
      pagination: { nextCursor: "page-2" }
    });
    expect(snapshot).not.toHaveProperty("rawDom");
    expect(snapshot).not.toHaveProperty("selectors");
  });

  it("returns challenge diagnostics instead of interpreting an unsupported boundary as no jobs", async () => {
    const page = createPage();
    const challenge = {
      kind: "unsupported_iframe" as const,
      detectedAt: "2026-08-16T00:00:00.000Z",
      reasonCode: "visible_iframe_boundary"
    };
    const detector = {
      inspect: vi.fn(async () => ({
        boundaries: [{ kind: "iframe", visible: true, interactive: true, reasonCode: "visible_interactive_iframe" }],
        challenge
      }))
    };
    const snapshot = await new JobObserver(page as never, detector as never).observe("jm-1");

    expect(snapshot.challenge).toEqual(challenge);
    expect(snapshot.boundaries).toHaveLength(1);
  });

  it("applies only mapped filters and returns the observed readback", async () => {
    const page = {
      ...createPage(),
      waitForTimeout: vi.fn(async () => undefined)
    };
    const detector = { inspect: vi.fn(async () => ({ boundaries: [] })) };
    const observer = new JobObserver(page as never, detector as never);
    const plan = {
      source: "moka" as const,
      adapterVersion: "moka-job-v1",
      mapped: [{ criterionIndex: 0, key: "location", values: ["深圳"] }],
      localOnly: [{ criterionIndex: 1, reasonCode: "unsupported_salary" }]
    };

    const snapshot = await observer.applyFilters("jm-1", plan);

    expect(page.evaluate.mock.calls[0]?.[0]).toEqual(expect.stringContaining(JSON.stringify(plan.mapped)));
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(snapshot.filterState).toEqual([{ key: "location", values: ["深圳"] }]);
  });

  it("advances with an opaque cursor and observes the resulting page", async () => {
    const page = {
      ...createPage(),
      waitForLoadState: vi.fn(async () => undefined),
      waitForTimeout: vi.fn(async () => undefined)
    };
    const detector = { inspect: vi.fn(async () => ({ boundaries: [] })) };

    await new JobObserver(page as never, detector as never).advance("jm-1", "page-2");

    expect(page.evaluate.mock.calls[0]?.[0]).toEqual(expect.stringContaining(JSON.stringify("page-2")));
    expect(page.waitForLoadState).toHaveBeenCalledWith("domcontentloaded");
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  });
});
