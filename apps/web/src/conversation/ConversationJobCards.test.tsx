import type { JobExpectationSnapshot } from "@resume/contracts";
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
  const posting = {
    id: "posting-1",
    source: "baidu" as const,
    canonicalUrl: "https://talent.baidu.com/jobs/frontend-1",
    title: "Frontend Engineer",
    organization: "百度",
    location: "深圳",
    employmentType: "校招",
    description: "负责前端开发。",
    requirements: [{ id: "requirement-1", category: "skill" as const, normalizedValue: "React", required: true, sourceEvidence: "熟悉 React" }],
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
  const results = [
    {
      id: "result-1",
      version: 4,
      sessionId: "session-cards",
      postingId: posting.id,
      fitScore: 91,
      confidence: 86,
      rankingScore: 89,
      outcomes: [{ requirementId: "requirement-1", outcome: "satisfied" as const, reasonCode: "profile_evidence" }],
      evidence: [{ requirementId: "requirement-1", evidenceId: "evidence-1", source: "confirmed_fact" as const, quality: 0.96, summary: "匹配依据：简历中有 React 项目经验" }],
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
      sessionId: "session-cards",
      postingId: conflictPosting.id,
      fitScore: 62,
      confidence: 68,
      rankingScore: 59,
      outcomes: [{ requirementId: "requirement-1", outcome: "conflict" as const, reasonCode: "experience_conflict" }],
      evidence: [],
      gaps: [{ requirementId: "requirement-1", outcome: "conflict" as const, summary: "岗位要求与当前资料存在冲突" }],
      scoringVersion: "job-match-v1" as const,
      profileRevision: 2,
      expectationRevision: expectation.revision,
      postingContentHash: conflictPosting.contentHash,
      stale: false
    }
  ];
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
    postings: [posting, conflictPosting],
    results
  };
  return {
    resultsSession: session,
    staleSession: { ...session, id: "session-stale", results: results.map((result) => ({ ...result, sessionId: "session-stale", stale: true })) }
  };
}

describe("ConversationJobMatchCards", () => {
  it("expands details and selects a normal result with real references", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const { resultsSession } = makeJobMatchComponentFixtures();

    render(<ConversationJobCards conversationId="conversation-1" session={resultsSession} onAction={onAction} />);

    const normalCard = screen.getByRole("article", { name: "岗位：Frontend Engineer" });
    expect(within(normalCard).getByText("百度")).toBeVisible();
    await user.click(within(normalCard).getByRole("button", { name: "查看详情" }));
    expect(within(normalCard).getByRole("heading", { name: "匹配依据" })).toBeVisible();
    await user.click(within(normalCard).getByRole("button", { name: "选择此岗位" }));

    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conversation-1",
      sessionId: resultsSession.id,
      action: "select_result",
      sessionVersion: resultsSession.version,
      resultId: "result-1",
      resultVersion: 4,
      postingContentHash: "sha256:posting-1"
    }));
  });

  it("requires a second confirmation before selecting a conflict result", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const { resultsSession } = makeJobMatchComponentFixtures();

    render(<ConversationJobCards conversationId="conversation-1" session={resultsSession} onAction={onAction} />);

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
      sessionVersion: staleSession.version
    }));
  });
});
