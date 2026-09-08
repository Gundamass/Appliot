import type { JobExpectationSnapshot, JobMatchResult, JobPosting } from "@resume/contracts";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { JobMatchSession } from "../job-matching/api.js";
import { ConversationJobCards } from "./ConversationJobCards.js";

const expectation: JobExpectationSnapshot = {
  revision: 3,
  confirmedAt: "2026-09-02T00:00:00.000Z",
  criteria: [{ kind: "target_role", values: ["Frontend Engineer"], strength: "required" }]
};

function makeJobMatchComponentFixtures(): { resultsSession: JobMatchSession; staleSession: JobMatchSession } {
  const posting: JobPosting = {
    id: "posting-1",
    source: "baidu" as const,
    canonicalUrl: "https://talent.baidu.com/jobs/frontend-1",
    title: "Frontend Engineer",
    organization: "百度",
    location: "深圳",
    employmentType: "校招",
    description: "负责前端开发。",
    requirements: [
      { id: "requirement-1", category: "skill", normalizedValue: "React", required: true, sourceEvidence: "熟悉 React" },
      { id: "requirement-2", category: "work_mode", normalizedValue: "混合办公", required: false, sourceEvidence: "接受混合办公" }
    ],
    adapterVersion: "baidu-campus-v1",
    contentHash: "sha256:posting-1",
    extractedAt: "2026-09-02T00:00:00.000Z"
  };
  const conflictPosting = {
    ...posting,
    id: "posting-2",
    canonicalUrl: "https://talent.baidu.com/jobs/backend-2",
    title: "Backend Engineer",
    contentHash: "sha256:posting-2"
  };
  const results: JobMatchResult[] = [
    {
      id: "result-1",
      version: 4,
      sessionId: "session-cards",
      postingId: posting.id,
      fitScore: 91,
      confidence: 86,
      rankingScore: 89,
      outcomes: [
        { requirementId: "requirement-1", outcome: "satisfied", reasonCode: "profile_evidence" },
        { requirementId: "requirement-2", outcome: "unknown", reasonCode: "insufficient_confirmed_evidence" }
      ],
      evidence: [{ requirementId: "requirement-1", evidenceId: "evidence-1", source: "confirmed_fact", quality: 0.96, summary: "你的技能“React”符合岗位技能要求。" }],
      gaps: [{ requirementId: "requirement-2", outcome: "unknown", summary: "接受混合办公" }],
      scoringVersion: "job-match-v1",
      scoreBreakdown: {
        total: 91,
        dimensions: [
          { dimension: "skill", label: "技能", earned: 70, available: 70, satisfied: 1, unknown: 0, conflict: 0 },
          { dimension: "preference", label: "求职偏好", earned: 21, available: 30, satisfied: 0, unknown: 1, conflict: 0 }
        ]
      },
      profileRevision: 2,
      expectationRevision: expectation.revision,
      postingContentHash: posting.contentHash,
      stale: false
    },
    {
      id: "result-2",
      version: 2,
      sessionId: "session-cards",
      postingId: conflictPosting.id,
      fitScore: 94,
      confidence: 68,
      rankingScore: 59,
      outcomes: [{ requirementId: "requirement-1", outcome: "conflict", reasonCode: "experience_conflict" }],
      evidence: [],
      gaps: [{ requirementId: "requirement-1", outcome: "conflict" as const, summary: "岗位要求与当前资料存在冲突" }],
      scoringVersion: "job-match-v1",
      scoreBreakdown: {
        total: 94,
        dimensions: [{ dimension: "skill", label: "技能", earned: 94, available: 100, satisfied: 0, unknown: 0, conflict: 1 }]
      },
      profileRevision: 2,
      expectationRevision: expectation.revision,
      postingContentHash: conflictPosting.contentHash,
      stale: false
    }
  ];
  const extraPostings: JobPosting[] = Array.from({ length: 5 }, (_value, index) => ({
    ...posting,
    id: `posting-${index + 3}`,
    canonicalUrl: `https://talent.baidu.com/jobs/frontend-${index + 3}`,
    title: `Frontend Engineer ${index + 3}`,
    contentHash: `sha256:posting-${index + 3}`
  }));
  const extraResults: JobMatchResult[] = extraPostings.map((extraPosting, index) => ({
    ...results[0]!,
    id: `result-${index + 3}`,
    postingId: extraPosting.id,
    fitScore: [91, 91, 87, 86, 10][index]!,
    confidence: [90, 86, 80, 80, 99][index]!,
    rankingScore: 80 - index,
    postingContentHash: extraPosting.contentHash
  }));
  const session: JobMatchSession = {
    id: "session-cards",
    version: 7,
    state: "awaiting_job_selection",
    initialUrl: "https://talent.baidu.com/campus",
    scoringVersion: "job-match-v1",
    profileRevision: 2,
    expectationRevision: expectation.revision,
    executionEpoch: 1,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:05:00.000Z",
    source: "baidu",
    adapterVersion: "baidu-campus-v1",
    expectation,
    postings: [posting, conflictPosting, ...extraPostings],
    results: [extraResults[4]!, extraResults[1]!, results[0]!, extraResults[3]!, results[1]!, extraResults[2]!, extraResults[0]!]
  };
  return {
    resultsSession: session,
    staleSession: { ...session, id: "session-stale", results: results.map((result) => ({ ...result, sessionId: "session-stale", stale: true })) }
  };
}

describe("ConversationJobMatchCards", () => {
  it("renders the sorted top six as concise cards and expands the four explanations", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const { resultsSession } = makeJobMatchComponentFixtures();
    const originalOrder = resultsSession.results.map((result) => result.id);

    render(<ConversationJobCards conversationId="conversation-1" session={resultsSession} onAction={onAction} />);

    const normalCard = screen.getByRole("article", { name: "岗位：Frontend Engineer" });
    expect(screen.getAllByRole("article").map((card) => card.getAttribute("aria-label"))).toEqual([
      "岗位：Backend Engineer",
      "岗位：Frontend Engineer 3",
      "岗位：Frontend Engineer",
      "岗位：Frontend Engineer 4",
      "岗位：Frontend Engineer 5",
      "岗位：Frontend Engineer 6"
    ]);
    expect(resultsSession.results.map((result) => result.id)).toEqual(originalOrder);
    expect(screen.queryByRole("article", { name: "岗位：Frontend Engineer 7" })).not.toBeInTheDocument();
    expect(within(normalCard).getByText("匹配度 91%")).toBeVisible();
    expect(within(normalCard).queryByText("91 分")).toBeNull();
    expect(within(normalCard).queryByText("置信度 86")).toBeNull();
    expect(within(normalCard).queryByText("百度")).not.toBeInTheDocument();
    expect(within(normalCard).queryByText("深圳")).not.toBeInTheDocument();
    expect(within(normalCard).queryByText("校招")).not.toBeInTheDocument();
    expect(within(normalCard).queryByText("百度招聘")).not.toBeInTheDocument();
    expect(within(normalCard).queryByText("满足 1")).not.toBeInTheDocument();
    expect(within(normalCard).queryByText("你的技能“React”符合岗位技能要求。")).not.toBeInTheDocument();

    const postingLink = within(normalCard).getByRole("link", { name: "岗位页面" });
    expect(postingLink).toHaveAttribute("href", "https://talent.baidu.com/jobs/frontend-1");
    expect(postingLink).toHaveAttribute("target", "_blank");
    expect(postingLink).toHaveAttribute("rel", "noreferrer");

    await user.click(within(normalCard).getByRole("button", { name: "查看详情" }));
    expect(within(normalCard).getByRole("heading", { name: "匹配优势" })).toBeVisible();
    expect(within(normalCard).getByRole("heading", { name: "待确认条件" })).toBeVisible();
    expect(within(normalCard).getByRole("heading", { name: "差距与风险" })).toBeVisible();
    expect(within(normalCard).getByRole("heading", { name: "匹配度如何得出" })).toBeVisible();
    expect(within(normalCard).getByText("熟悉 React")).toBeVisible();
    expect(within(normalCard).getByText("你的技能“React”符合岗位技能要求。")).toBeVisible();
    expect(within(normalCard).getByText("接受混合办公")).toBeVisible();
    expect(within(normalCard).getByText("技能 70/70")).toBeVisible();
    expect(within(normalCard).getByText("求职偏好 21/30")).toBeVisible();
    expect(within(normalCard).getByText("总分 91/100")).toBeVisible();

    await user.click(within(normalCard).getByRole("button", { name: "选择此岗位" }));

    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conversation-1",
      sessionId: resultsSession.id,
      action: "select_result",
      sessionVersion: resultsSession.version,
      idempotencyKey: `inline-job-match:${resultsSession.id}:select_result:${resultsSession.version}:result-1`,
      resultId: "result-1",
      resultVersion: 4,
      postingContentHash: "sha256:posting-1"
    }));
  });

  it("rejects evidence summaries outside the server natural-language grammar", async () => {
    const user = userEvent.setup();
    const { resultsSession } = makeJobMatchComponentFixtures();
    const result: JobMatchResult = { ...resultsSession.results.find((item) => item.id === "result-1")! };
    const unsafeSummaries = [
      "$.education.major",
      "/education/0/major",
      "550e8400-e29b-41d4-a716-446655440000",
      "evd-01J8Z8V4R4T4BX9E8D6M2N7Q5K"
    ];
    result.evidence = unsafeSummaries.map((summary, index) => ({
      ...result.evidence[0]!,
      evidenceId: `unsafe-evidence-${index}`,
      summary
    }));
    const adversarialSession: JobMatchSession = {
      ...resultsSession,
      postings: resultsSession.postings.filter((posting) => posting.id === result.postingId),
      results: [result]
    };

    render(<ConversationJobCards session={adversarialSession} onAction={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "查看详情" }));

    expect(screen.getByText("熟悉 React")).toBeVisible();
    unsafeSummaries.forEach((summary) => expect(screen.queryByText(summary)).not.toBeInTheDocument());
  });

  it("uses the legacy score explanation without exposing persisted internal evidence", async () => {
    const user = userEvent.setup();
    const { resultsSession } = makeJobMatchComponentFixtures();
    const result: JobMatchResult = { ...resultsSession.results.find((item) => item.id === "result-1")! };
    delete result.scoreBreakdown;
    result.evidence = [{
      ...result.evidence[0]!,
      summary: "Profile fact education[0].major matched requirement requirement-1 with profile_evidence_match"
    }];
    const legacySession: JobMatchSession = {
      ...resultsSession,
      postings: resultsSession.postings.filter((posting) => posting.id === result.postingId),
      results: [result]
    };

    render(<ConversationJobCards session={legacySession} onAction={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "查看详情" }));

    expect(screen.getByText("此结果使用旧版评分，重新匹配后可查看分项说明")).toBeVisible();
    expect(screen.queryByText(/Profile fact|education\[|requirement-1|profile_evidence_match/u)).not.toBeInTheDocument();
  });

  it("requires a second confirmation before selecting a conflict result", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const { resultsSession } = makeJobMatchComponentFixtures();
    const conflictSession: JobMatchSession = {
      ...resultsSession,
      postings: resultsSession.postings.filter((item) => item.id === "posting-1" || item.id === "posting-2"),
      results: resultsSession.results.filter((item) => item.id === "result-1" || item.id === "result-2")
    };

    render(<ConversationJobCards conversationId="conversation-1" session={conflictSession} onAction={onAction} />);

    const conflictCard = screen.getByRole("article", { name: "岗位：Backend Engineer" });
    await user.click(within(conflictCard).getByRole("button", { name: "选择此岗位" }));
    expect(onAction).not.toHaveBeenCalled();
    expect(within(conflictCard).getByText("存在明确冲突，请确认仍要选择")).toBeVisible();
    await user.click(within(conflictCard).getByRole("button", { name: "确认选择冲突岗位" }));

    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
      action: "select_conflict_result",
      resultId: "result-2",
      resultVersion: 2,
      postingContentHash: "sha256:posting-2",
      conflictSummaryHash: expect.any(String)
    }));
  });

  it("disables stale selection and offers guarded rematching", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const { staleSession } = makeJobMatchComponentFixtures();

    render(<ConversationJobCards conversationId="conversation-1" session={staleSession} onAction={onAction} />);

    expect(screen.getByText("结果已变化")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "选择此岗位" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
    await user.click(screen.getByRole("button", { name: "重新匹配" }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
      action: "rematch",
      sessionId: staleSession.id,
      sessionVersion: staleSession.version,
      idempotencyKey: `inline-job-match:${staleSession.id}:rematch:${staleSession.version}`
    }));
  });
});
