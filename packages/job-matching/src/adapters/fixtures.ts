import type { JobExpectationSnapshot, JobPageSnapshot } from "@resume/contracts";

const capturedAt = "2026-08-16T00:00:00.000Z";

function snapshot(overrides: Partial<JobPageSnapshot>): JobPageSnapshot {
  return {
    id: "snapshot-1",
    ownerId: "jm-1",
    url: "https://app.mokahr.com/social-recruitment/example/1#/jobs",
    title: "示例招聘",
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

export const jobExpectationFixture: JobExpectationSnapshot = {
  revision: 3,
  confirmedAt: capturedAt,
  criteria: [
    { kind: "target_role", values: ["Java"], strength: "required" },
    { kind: "location", values: ["深圳"], strength: "preferred" },
    { kind: "employment_type", values: ["全职"], strength: "required" },
    { kind: "salary", values: ["25k-35k"], strength: "preferred" }
  ]
};

export const mokaListFixture = snapshot({
  visibleText: ["职位列表", "Java 技术负责人", "深圳", "本科及以上，5 年 Java 经验"],
  jobCards: [{
    sourceJobId: "moka-job-1",
    canonicalUrl: "https://app.mokahr.com/social-recruitment/example/1#/job/1001",
    title: "Java 技术负责人",
    organization: "示例科技",
    location: "深圳",
    summary: "本科及以上，5 年 Java 经验"
  }],
  pagination: { kind: "page", current: 1, hasNext: true, nextCursor: "page-2" }
});

export const mokaDetailFixture = snapshot({
  url: "https://app.mokahr.com/social-recruitment/example/1#/job/1001",
  title: "Java 技术负责人",
  entryHint: "job_detail",
  visibleText: ["Java 技术负责人", "示例科技", "工作地点：深圳", "职位要求", "本科及以上", "5 年以上 Java 开发经验"],
  jobCards: [mokaListFixture.jobCards[0]!]
});

export const mokaApplicationFixture = snapshot({
  url: "https://app.mokahr.com/social-recruitment/example/1#/job/1001/apply",
  entryHint: "application_form",
  visibleText: ["申请职位", "个人信息"]
});

export const campusMokaListFixture = snapshot({
  url: "https://app.mokahr.com/campus_apply/acme-campus/39595#/jobs",
  title: "Acme Campus 招聘",
  visibleText: ["职位列表", "Java 技术负责人", "深圳"],
  jobCards: [{
    sourceJobId: "java-lead",
    canonicalUrl: "https://app.mokahr.com/campus_apply/acme-campus/39595#/jobs/java-lead",
    title: "Java 技术负责人",
    organization: "示例科技",
    location: "深圳",
    summary: "本科及以上，5 年 Java 经验"
  }]
});

export const campusMokaDetailFixture = snapshot({
  url: "https://app.mokahr.com/campus_apply/another-tenant/72913#/jobs/backend-architect",
  title: "后端架构师",
  entryHint: "job_detail",
  visibleText: ["后端架构师", "示例科技", "工作地点：杭州", "本科及以上", "5 年 Java 经验"],
  jobCards: [{
    sourceJobId: "backend-architect",
    canonicalUrl: "https://app.mokahr.com/campus_apply/another-tenant/72913#/jobs/backend-architect",
    title: "后端架构师",
    organization: "示例科技",
    location: "杭州",
    summary: "负责平台架构"
  }]
});

export const campusMokaApplicationFixture = snapshot({
  url: "https://app.mokahr.com/campus_apply/another-tenant/72913#/jobs/backend-architect/apply",
  entryHint: "application_form",
  visibleText: ["申请职位", "个人信息"]
});

export const mokaLoginFixture = snapshot({
  entryHint: "login",
  visibleText: ["登录后继续"]
});

export const mokaChallengeFixture = snapshot({
  entryHint: "unknown",
  visibleText: ["安全验证"],
  challenge: { kind: "captcha", detectedAt: capturedAt, reasonCode: "captcha_visible" }
});

export const mokaContractDriftFixture = snapshot({
  visibleText: ["职位列表"],
  pagination: { kind: "page", current: 1, hasNext: true, nextCursor: "page-2" }
});

export const djiListFixture = snapshot({
  url: "https://we.dji.com/zh-CN/careers/positions",
  title: "DJI 招聘",
  visibleText: ["职位列表", "后端开发工程师", "深圳"],
  jobCards: [{
    sourceJobId: "dji-job-1",
    canonicalUrl: "https://we.dji.com/zh-CN/careers/position/1001",
    title: "后端开发工程师",
    organization: "DJI",
    location: "深圳",
    summary: "计算机相关专业，熟悉 Java"
  }]
});

export const djiDetailFixture = snapshot({
  url: "https://we.dji.com/zh-CN/careers/position/1001",
  title: "后端开发工程师",
  entryHint: "job_detail",
  visibleText: ["后端开发工程师", "DJI", "工作地点：深圳", "任职要求", "计算机相关专业", "熟悉 Java"],
  jobCards: [djiListFixture.jobCards[0]!]
});

export const djiApplicationFixture = snapshot({
  url: "https://we.dji.com/zh-CN/careers/position/1001/apply",
  entryHint: "application_form",
  visibleText: ["申请职位", "个人信息"]
});
