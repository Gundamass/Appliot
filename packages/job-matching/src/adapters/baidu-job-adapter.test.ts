import { describe, expect, it } from "vitest";
import type { JobPageSnapshot } from "@resume/contracts";
import { baiduJobAdapter } from "./baidu-job-adapter.js";

const capturedAt = "2026-08-24T00:00:00.000Z";

function snapshot(overrides: Partial<JobPageSnapshot>): JobPageSnapshot {
  return {
    id: "baidu-snapshot-1",
    ownerId: "job-match-1",
    url: "https://talent.baidu.com/jobs/list?projectType=4&recruitType=GRADUATE",
    title: "百度校园招聘",
    capturedAt,
    entryHint: "job_list",
    visibleText: [],
    jobCards: [],
    filterState: [],
    pagination: { kind: "none", hasNext: false },
    boundaries: [],
    ...overrides
  };
}

const baiduListFixture = snapshot({
  visibleText: ["职位列表", "北京-经营分析(J100725)", "北京市"],
  jobCards: [{
    sourceJobId: "bcde01c3-883b-4d2f-a6a6-7abafb95b642",
    canonicalUrl: "https://talent.baidu.com/jobs/detail/GRADUATE/bcde01c3-883b-4d2f-a6a6-7abafb95b642?projectType=4&recruitType=GRADUATE",
    title: "北京-经营分析(J100725)",
    organization: "百度",
    location: "北京市",
    summary: "本科及以上学历，财务、统计、数学相关专业"
  }],
  filterState: [
    { key: "postType", values: ["综合"] },
    { key: "workPlace", values: ["北京市"] },
    { key: "projectType", values: ["校招"] }
  ],
  pagination: { kind: "page", current: 1, hasNext: true, nextCursor: "2" }
});

const baiduDetailFixture = snapshot({
  url: "https://talent.baidu.com/jobs/detail/GRADUATE/bcde01c3-883b-4d2f-a6a6-7abafb95b642?projectType=4&recruitType=GRADUATE",
  entryHint: "job_detail",
  visibleText: [
    "北京-经营分析(J100725)",
    "百度",
    "北京市",
    "项目类型：校招",
    "本科及以上学历，财务、统计、数学相关专业",
    "熟练运用各种分析工具，具有数据建模和分析经验"
  ],
  jobCards: [baiduListFixture.jobCards[0]!]
});

const baiduApplicationFixture = snapshot({
  url: "https://talent.baidu.com/jobs/detail/GRADUATE/bcde01c3-883b-4d2f-a6a6-7abafb95b642/apply?projectType=4&recruitType=GRADUATE",
  entryHint: "application_form",
  visibleText: ["申请职位"]
});

const nonCampusFixture = snapshot({
  url: "https://talent.baidu.com/jobs/list?projectType=1&recruitType=SOCIAL"
});

describe("baiduJobAdapter", () => {
  it("identifies only Baidu campus list, detail and application entries", () => {
    expect(baiduJobAdapter.identify(baiduListFixture)).toBe("job_list");
    expect(baiduJobAdapter.identify(baiduDetailFixture)).toBe("job_detail");
    expect(baiduJobAdapter.identify(baiduApplicationFixture)).toBe("application_form");
    expect(baiduJobAdapter.identify(nonCampusFixture)).toBe("unsupported");
    expect(baiduJobAdapter.identify({ ...baiduListFixture, url: "https://jobs.example.test/jobs" })).toBe("unsupported");
  });

  it("normalizes the generic Baidu entry to ordinary campus recruitment", () => {
    expect(baiduJobAdapter.normalizeEntryUrl?.(new URL("https://talent.baidu.com/"))?.href)
      .toBe("https://talent.baidu.com/jobs/list?projectType=1&recruitType=GRADUATE");
  });

  it("maps job expectations to current Baidu labels without treating employment type as a project", () => {
    const plan = baiduJobAdapter.mapFilters({
      revision: 39,
      confirmedAt: "2026-09-06T07:29:58.122Z",
      criteria: [
        { kind: "target_role", values: ["开发"], strength: "required" },
        { kind: "location", values: ["全国"], strength: "required" },
        { kind: "employment_type", values: ["全职"], strength: "required" }
      ]
    });

    expect(plan.mapped).toEqual([
      { criterionIndex: 0, key: "postType", values: ["技术"] },
      { criterionIndex: 1, key: "workPlace", values: ["全国"] }
    ]);
    expect(plan.localOnly).toEqual([
      { criterionIndex: 2, reasonCode: "unsupported_employment_type" }
    ]);
  });

  it.each([
    ["前端开发", "技术"],
    ["产品经理", "产品"],
    ["政企业务", "政企"],
    ["销售经理", "销售"],
    ["人力资源", "综合"]
  ])("maps the target role %s to Baidu category %s", (role, category) => {
    const plan = baiduJobAdapter.mapFilters({
      revision: 1,
      confirmedAt: capturedAt,
      criteria: [{ kind: "target_role", values: [role], strength: "required" }]
    });

    expect(plan.mapped).toEqual([
      { criterionIndex: 0, key: "postType", values: [category] }
    ]);
    expect(plan.localOnly).toEqual([]);
  });

  it("keeps an unrecognized Baidu target role local instead of selecting an unverifiable option", () => {
    const plan = baiduJobAdapter.mapFilters({
      revision: 1,
      confirmedAt: capturedAt,
      criteria: [{ kind: "target_role", values: ["量子生态顾问"], strength: "required" }]
    });

    expect(plan.mapped).toEqual([]);
    expect(plan.localOnly).toEqual([
      { criterionIndex: 0, reasonCode: "unsupported_target_role" }
    ]);
  });

  it("normalizes supported city aliases and keeps unknown Baidu locations local", () => {
    const supported = baiduJobAdapter.mapFilters({
      revision: 1,
      confirmedAt: capturedAt,
      criteria: [{ kind: "location", values: ["深圳"], strength: "required" }]
    });
    const unknown = baiduJobAdapter.mapFilters({
      revision: 1,
      confirmedAt: capturedAt,
      criteria: [{ kind: "location", values: ["武汉市"], strength: "required" }]
    });

    expect(supported.mapped).toEqual([
      { criterionIndex: 0, key: "workPlace", values: ["深圳市"] }
    ]);
    expect(unknown.mapped).toEqual([]);
    expect(unknown.localOnly).toEqual([
      { criterionIndex: 0, reasonCode: "unsupported_location" }
    ]);
  });

  it("maps Baidu campus filters and keeps unsupported criteria local", () => {
    const plan = baiduJobAdapter.mapFilters({
      revision: 1,
      confirmedAt: capturedAt,
      criteria: [
        { kind: "target_role", values: ["综合"], strength: "required" },
        { kind: "location", values: ["北京市"], strength: "preferred" },
        { kind: "employment_type", values: ["校招"], strength: "required" },
        { kind: "salary", values: ["25k-35k"], strength: "preferred" }
      ]
    });

    expect(plan).toMatchObject({ source: "baidu", adapterVersion: "baidu-job-v1" });
    expect(plan.mapped).toEqual([
      { criterionIndex: 0, key: "postType", values: ["综合"] },
      { criterionIndex: 1, key: "workPlace", values: ["北京市"] }
    ]);
    expect(plan.localOnly).toEqual([
      { criterionIndex: 2, reasonCode: "unsupported_employment_type" },
      { criterionIndex: 3, reasonCode: "unsupported_salary" }
    ]);
  });

  it("extracts Baidu list and detail postings with campus type and requirements", () => {
    const list = baiduJobAdapter.extractList(baiduListFixture);
    expect(list).toMatchObject({
      hasNext: true,
      nextCursor: "2",
      postings: [{
        source: "baidu",
        sourceJobId: "bcde01c3-883b-4d2f-a6a6-7abafb95b642",
        title: "北京-经营分析(J100725)",
        organization: "百度",
        location: "北京市",
        employmentType: "校招"
      }]
    });

    const detail = baiduJobAdapter.extractDetail(baiduDetailFixture);
    expect(detail).toMatchObject({
      source: "baidu",
      adapterVersion: "baidu-job-v1",
      employmentType: "校招",
      canonicalUrl: baiduDetailFixture.jobCards[0]!.canonicalUrl
    });
    expect(detail.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "education", required: true }),
      expect.objectContaining({ category: "major", required: true })
    ]));
  });

  it("rejects a Baidu snapshot whose list contract has drifted", () => {
    expect(() => baiduJobAdapter.extractList(snapshot({
      pagination: { kind: "page", current: 1, hasNext: true, nextCursor: "2" }
    }))).toThrow("job_adapter_contract_mismatch");
  });
});
