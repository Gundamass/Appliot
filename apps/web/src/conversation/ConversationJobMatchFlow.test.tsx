import type {
  ConversationProcessEvent,
  JobExpectationSnapshot
} from "@resume/contracts";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { JobMatchSession } from "../job-matching/api.js";
import { ConversationJobMatchFlow } from "./ConversationJobMatchFlow.js";
import type { ConversationProcessGroup } from "./conversation-process-model.js";

const expectation: JobExpectationSnapshot = {
  revision: 3,
  confirmedAt: "2026-09-02T00:00:00.000Z",
  criteria: [
    { kind: "target_role", values: ["Frontend Engineer"], strength: "required" },
    { kind: "location", values: ["深圳"], strength: "preferred" }
  ]
};

function makeJobMatchComponentFixtures(): {
  awaitingFilters: JobMatchSession;
  resultsSession: JobMatchSession;
  staleSession: JobMatchSession;
  failedProcess: ConversationProcessGroup;
} {
  const posting = {
    id: "posting-1",
    source: "baidu" as const,
    sourceJobId: "baidu-frontend-1",
    canonicalUrl: "https://talent.baidu.com/jobs/detail/frontend-1",
    title: "Frontend Engineer",
    organization: "百度",
    location: "深圳",
    employmentType: "校招",
    description: "负责招聘平台前端体验。",
    requirements: [{
      id: "requirement-react",
      category: "skill" as const,
      normalizedValue: "React",
      required: true,
      sourceEvidence: "熟悉 React"
    }],
    adapterVersion: "baidu-campus-v1",
    contentHash: "sha256:posting-1",
    extractedAt: "2026-09-02T00:00:00.000Z"
  };
  const conflictPosting = {
    ...posting,
    id: "posting-2",
    sourceJobId: "baidu-backend-2",
    canonicalUrl: "https://talent.baidu.com/jobs/detail/backend-2",
    title: "Backend Engineer",
    contentHash: "sha256:posting-2"
  };
  const results = [
    {
      id: "result-1",
      version: 4,
      sessionId: "session-results",
      postingId: posting.id,
      fitScore: 91,
      confidence: 86,
      rankingScore: 89,
      outcomes: [{ requirementId: "requirement-react", outcome: "satisfied" as const, reasonCode: "profile_evidence" }],
      evidence: [{ requirementId: "requirement-react", evidenceId: "evidence-1", source: "confirmed_fact" as const, quality: 0.96, summary: "简历中有 React 项目经验" }],
      gaps: [],
      scoringVersion: "job-match-v1" as const,
      profileRevision: 2,
      expectationRevision: expectation.revision,
      postingContentHash: posting.contentHash,
      stale: false
    },
    {
      id: "result-2",
      version: 2,
      sessionId: "session-results",
      postingId: conflictPosting.id,
      fitScore: 62,
      confidence: 68,
      rankingScore: 59,
      outcomes: [{ requirementId: "requirement-react", outcome: "conflict" as const, reasonCode: "experience_conflict" }],
      evidence: [],
      gaps: [{ requirementId: "requirement-react", outcome: "conflict" as const, summary: "岗位要求与当前资料存在冲突" }],
      scoringVersion: "job-match-v1" as const,
      profileRevision: 2,
      expectationRevision: expectation.revision,
      postingContentHash: conflictPosting.contentHash,
      stale: false
    }
  ];
  const base = {
    version: 7,
    initialUrl: "https://talent.baidu.com/campus",
    scoringVersion: "job-match-v1" as const,
    profileRevision: 2,
    expectationRevision: expectation.revision,
    executionEpoch: 4,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:05:00.000Z",
    entryKind: "job_list" as const,
    source: "baidu" as const,
    adapterVersion: "baidu-campus-v1",
    expectation,
    filterPlan: {
      source: "baidu" as const,
      adapterVersion: "baidu-campus-v1",
      mapped: [{ criterionIndex: 0, key: "keyword", values: ["Frontend Engineer"] }],
      localOnly: [{ criterionIndex: 1, reasonCode: "unsupported_filter" }]
    },
    postings: [posting, conflictPosting],
    results,
    cursor: {
      value: "page-2",
      pagesRead: 2,
      elapsedMs: 1800,
      newJobs: 2,
      consecutiveNoNewPages: 0,
      updatedAt: "2026-09-02T00:05:00.000Z"
    }
  } satisfies Omit<JobMatchSession, "id" | "state">;
  const resultsSession: JobMatchSession = { ...base, id: "session-results", state: "awaiting_job_selection" };
  return {
    awaitingFilters: {
      ...base,
      id: "session-awaiting-filters",
      state: "awaiting_filter_confirmation",
      postings: [],
      results: []
    },
    resultsSession,
    staleSession: {
      ...resultsSession,
      id: "session-stale",
      results: results.map((result) => ({ ...result, sessionId: "session-stale", stale: true }))
    },
    failedProcess: {
      turnSequence: 6,
      steps: [{
        id: "18",
        conversationId: "conversation-1",
        turnSequence: 6,
        stepId: "match-jobs",
        type: "process_changed",
        stage: "matching_jobs",
        status: "failed",
        summary: "岗位匹配暂时失败",
        failure: { code: "JOB_MATCH_UNAVAILABLE", summary: "岗位匹配暂时失败", retryable: true },
        createdAt: "2026-09-02T00:06:00.000Z"
      } satisfies ConversationProcessEvent],
      active: false,
      failed: true,
      totalDurationMs: 2400
    }
  };
}

describe("ConversationJobMatchFlow", () => {
  it("shows filter confirmation and emits a guarded action", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const { awaitingFilters } = makeJobMatchComponentFixtures();

    render(
      <ConversationJobMatchFlow
        conversationId="conversation-1"
        session={awaitingFilters}
        onAction={onAction}
      />
    );

    expect(screen.getByText("目标岗位")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "确认筛选并读取岗位" }));

    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conversation-1",
      action: "confirm_filters",
      sessionId: awaitingFilters.id,
      sessionVersion: awaitingFilters.version,
      expectation: awaitingFilters.expectation
    }));
  });

  it("keeps the trace outside job cards and exposes failed and stale recovery", () => {
    const onAction = vi.fn();
    const { staleSession, failedProcess } = makeJobMatchComponentFixtures();

    render(
      <ConversationJobMatchFlow
        conversationId="conversation-1"
        session={staleSession}
        process={failedProcess}
        onAction={onAction}
      />
    );

    expect(screen.getByRole("list", { name: "执行过程" })).toBeInTheDocument();
    expect(screen.getByText("岗位匹配暂时失败")).toBeVisible();
    expect(screen.getByText("结果已变化")).toBeVisible();
    expect(screen.getByRole("button", { name: "重新匹配" })).toBeEnabled();
  });
});
