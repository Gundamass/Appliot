import { describe, expect, it } from "vitest";
import {
  ConflictJobSelectionInputSchema,
  ExtractedJobPageSchema,
  FilterPlanSchema,
  JobEntryKindSchema,
  JobExpectationSnapshotSchema,
  JobMatchMutationGuardSchema,
  JobMatchResultSchema,
  JobMatchSessionStateSchema,
  JobPageSnapshotSchema,
  JobPostingDraftSchema,
  JobPostingSchema,
  JobRequirementSchema,
  RequirementOutcomeSchema
} from "./job-matching.js";

const requirement = {
  id: "requirement-java",
  category: "skill",
  normalizedValue: "java",
  required: true,
  sourceEvidence: "熟悉 Java"
} as const;

const posting = {
  id: "posting-1",
  source: "moka",
  sourceJobId: "job-1001",
  canonicalUrl: "https://jobs.example.test/jobs/1001",
  title: "Java 开发工程师",
  organization: "示例科技",
  location: "深圳",
  employmentType: "全职",
  description: "负责服务端功能开发。",
  requirements: [requirement],
  adapterVersion: "moka-job-v1",
  contentHash: "sha256:posting-1",
  extractedAt: "2026-08-16T00:00:00.000Z"
} as const;

const postingDraft = {
  source: posting.source,
  sourceJobId: posting.sourceJobId,
  canonicalUrl: posting.canonicalUrl,
  title: posting.title,
  organization: posting.organization,
  location: posting.location,
  employmentType: posting.employmentType,
  description: posting.description,
  requirements: posting.requirements,
  adapterVersion: posting.adapterVersion
} as const;

const legacyResult = {
  id: "result-1",
  version: 1,
  sessionId: "session-1",
  postingId: posting.id,
  fitScore: 75,
  confidence: 65.5,
  rankingScore: 68.53,
  outcomes: [{ requirementId: requirement.id, outcome: "unknown", reasonCode: "profile_fact_missing" }],
  evidence: [],
  gaps: [{ requirementId: requirement.id, outcome: "unknown", summary: "档案中缺少已确认技能证据" }],
  scoringVersion: "job-match-v1",
  profileRevision: 7,
  expectationRevision: 3,
  postingContentHash: posting.contentHash,
  stale: false
} as const;

const jobSnapshot = {
  id: "job-snapshot-1",
  ownerId: "session-1",
  url: "https://jobs.example.test/jobs",
  title: "招聘职位",
  capturedAt: "2026-08-16T00:00:00.000Z",
  entryHint: "job_list",
  visibleText: ["招聘职位", "Java 开发工程师"],
  jobCards: [{
    sourceJobId: "job-1001",
    canonicalUrl: "https://jobs.example.test/jobs/1001",
    title: "Java 开发工程师",
    organization: "示例科技",
    location: "深圳",
    summary: "负责服务端功能开发。"
  }],
  filterState: [{ key: "location", values: ["深圳"] }],
  pagination: { kind: "page", current: 1, hasNext: true, nextCursor: "2" },
  boundaries: []
} as const;

describe("job matching contracts", () => {
  it("defines every approved session state and entry kind", () => {
    const states = [
      "created",
      "awaiting_filter_confirmation",
      "opening_job_page",
      "awaiting_login",
      "applying_filters",
      "extracting_jobs",
      "matching_jobs",
      "awaiting_job_selection",
      "selected",
      "converted_to_application",
      "awaiting_challenge",
      "paused",
      "failed",
      "cancelled",
      "expired"
    ];

    expect(states.map((state) => JobMatchSessionStateSchema.parse(state))).toEqual(states);
    expect(JobEntryKindSchema.parse("job_list")).toBe("job_list");
    expect(JobEntryKindSchema.parse("job_detail")).toBe("job_detail");
    expect(JobEntryKindSchema.parse("application_form")).toBe("application_form");
    expect(RequirementOutcomeSchema.parse("unknown")).toBe("unknown");
  });

  it("parses a confirmed expectation snapshot", () => {
    const snapshot = {
      revision: 3,
      criteria: [
        { kind: "target_role", values: ["Java 开发"], strength: "required" },
        { kind: "location", values: ["深圳", "上海"], strength: "preferred" }
      ],
      confirmedAt: "2026-08-16T00:00:00.000Z"
    } as const;

    expect(JobExpectationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("parses normalized postings, drafts, filter plans and extracted pages", () => {
    expect(JobRequirementSchema.parse(requirement)).toEqual(requirement);
    expect(JobPostingSchema.parse(posting)).toEqual(posting);
    expect(JobPostingDraftSchema.parse(postingDraft)).not.toHaveProperty("id");
    expect(FilterPlanSchema.parse({
      source: "moka",
      adapterVersion: "moka-job-v1",
      mapped: [{ criterionIndex: 1, key: "location", values: ["深圳"] }],
      localOnly: [{ criterionIndex: 0, reasonCode: "unsupported_filter" }]
    }).mapped).toHaveLength(1);
    expect(ExtractedJobPageSchema.parse({
      postings: [postingDraft],
      nextCursor: "2",
      hasNext: true
    }).hasNext).toBe(true);
  });

  it("accepts the registered Baidu campus source", () => {
    expect(JobPostingDraftSchema.parse({
      ...postingDraft,
      source: "baidu",
      adapterVersion: "baidu-job-v1"
    }).source).toBe("baidu");
  });

  it("accepts only finite, sanitized browser job snapshots", () => {
    expect(JobPageSnapshotSchema.parse(jobSnapshot)).toEqual(jobSnapshot);

    for (const sensitive of [
      { rawDom: "<html>" },
      { selector: "#job-list" },
      { browserProfile: "profile-dir" },
      { coordinates: { x: 10, y: 20 } }
    ]) {
      expect(JobPageSnapshotSchema.safeParse({ ...jobSnapshot, ...sensitive }).success).toBe(false);
    }
  });

  it("requires optimistic concurrency and non-empty idempotency keys", () => {
    expect(JobMatchMutationGuardSchema.parse({
      sessionVersion: 2,
      idempotencyKey: "confirm-filters-2"
    })).toEqual({ sessionVersion: 2, idempotencyKey: "confirm-filters-2" });
    expect(JobMatchMutationGuardSchema.safeParse({ sessionVersion: 2, idempotencyKey: "" }).success).toBe(false);
    expect(ConflictJobSelectionInputSchema.safeParse({
      sessionVersion: 2,
      idempotencyKey: "select-conflict-2",
      resultId: "result-1",
      resultVersion: 1,
      postingContentHash: "sha256:posting-1"
    }).success).toBe(false);
  });

  it("pins match results to deterministic versions and hashes", () => {
    expect(JobMatchResultSchema.parse(legacyResult)).toEqual(legacyResult);
    expect(JobMatchResultSchema.safeParse({ ...legacyResult, scoringVersion: "job-match-v2" }).success).toBe(false);
    expect(JobMatchResultSchema.safeParse({ ...legacyResult, fitScore: 100.01 }).success).toBe(false);
  });

  it("parses legacy results and strict v2 score breakdowns", () => {
    expect(JobMatchResultSchema.parse(legacyResult).scoreBreakdown).toBeUndefined();

    const scoreBreakdown = {
      total: 70,
      dimensions: [{
        dimension: "skill",
        label: "技能",
        earned: 35,
        available: 50,
        satisfied: 2,
        unknown: 1,
        conflict: 0
      }]
    } as const;
    const parsed = JobMatchResultSchema.parse({ ...legacyResult, scoreBreakdown });

    expect(parsed.scoreBreakdown?.dimensions[0]?.label).toBe("技能");
    expect(JobMatchResultSchema.safeParse({
      ...legacyResult,
      scoreBreakdown: { ...scoreBreakdown, total: -0.01 }
    }).success).toBe(false);
    expect(JobMatchResultSchema.safeParse({
      ...legacyResult,
      scoreBreakdown: { ...scoreBreakdown, total: 100.01 }
    }).success).toBe(false);
  });
});
