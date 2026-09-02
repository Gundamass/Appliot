import type { ConversationCard, ConversationConfirmation } from "@resume/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { JobMatchApi, JobMatchSession } from "../job-matching/api.js";
import { ConversationCards } from "./ConversationCards.js";

const site = {
  company: "Baidu",
  recruitmentType: "campus" as const,
  query: "Baidu campus recruitment official",
  title: "Baidu Campus Recruitment",
  url: "https://campus.baidu.com/",
  domain: "campus.baidu.com",
  snippet: "校园招聘岗位",
  source: "tavily" as const
};

const choices = {
  kind: "recruitment_site_choices" as const,
  company: "百度",
  recruitmentType: "campus" as const,
  query: "百度 校园招聘 招聘 官网",
  candidates: [
    {
      title: "百度人才",
      url: "https://talent.baidu.com/",
      domain: "talent.baidu.com",
      snippet: "校园招聘岗位",
      source: "tavily" as const
    },
    {
      title: "百度招聘",
      url: "https://jobs.baidu.com/",
      domain: "jobs.baidu.com",
      snippet: "招聘岗位",
      source: "tavily" as const
    }
  ]
};

const jobMatchSession: JobMatchSession = {
  id: "match-1",
  version: 1,
  state: "awaiting_filter_confirmation",
  initialUrl: site.url,
  scoringVersion: "job-match-v1",
  profileRevision: 1,
  expectationRevision: 1,
  executionEpoch: 1,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  source: "baidu",
  adapterVersion: "baidu-v1",
  expectation: {
    revision: 1,
    confirmedAt: "2026-09-01T00:00:00.000Z",
    criteria: [{ kind: "target_role", values: ["前端工程师"], strength: "required" }]
  },
  postings: [],
  results: []
};

function renderCards(cards: ConversationCard[], pendingConfirmation?: ConversationConfirmation) {
  return render(
    <ConversationCards
      cards={cards}
      {...(pendingConfirmation === undefined ? {} : { pendingConfirmation })}
      onOpenApplication={vi.fn()}
      onConfirm={vi.fn()}
    />
  );
}

describe("ConversationCards recruitment flow", () => {
  it("lets the user choose a recruitment candidate before confirming it", () => {
    const onConfirm = vi.fn();
    const confirmation: ConversationConfirmation = {
      confirmationId: "confirmation-choices",
      action: "confirm_recruitment_site",
      target: choices
    };
    render(
      <ConversationCards
        cards={[{ type: "confirmation", confirmationId: confirmation.confirmationId, action: confirmation.action, target: choices }] as ConversationCard[]}
        pendingConfirmation={confirmation}
        onOpenApplication={vi.fn()}
        onConfirm={onConfirm}
      />
    );

    expect(screen.getByText("百度人才")).toBeTruthy();
    expect(screen.getByText("搜索候选，需你确认")).toBeTruthy();
    expect(screen.queryByText("官方入口")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /jobs\.baidu\.com/u }));
    fireEvent.click(screen.getByRole("button", { name: "确认使用此入口" }));
    expect(onConfirm).toHaveBeenCalledWith(
      "confirmation-choices",
      true,
      "https://jobs.baidu.com/"
    );
  });

  it("renders the verified recruitment entry and job-match session inline without an open-workbench button", async () => {
    render(
      <ConversationCards
        cards={[
          { type: "recruitment_site", ...site },
          {
            type: "job_match_session",
            sessionId: "match-1",
            initialUrl: site.url,
            state: "awaiting_filter_confirmation",
            postingCount: 12
          }
        ]}
        conversationId="conversation-1"
        jobMatchApi={{ get: vi.fn().mockResolvedValue(jobMatchSession) } as unknown as JobMatchApi}
        onJobMatchAction={vi.fn()}
        onOpenApplication={vi.fn()}
      />
    );

    expect(screen.getByText("Baidu Campus Recruitment")).toBeTruthy();
    expect(screen.getByText("官方入口")).toBeTruthy();
    expect(await screen.findByText("岗位匹配")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "打开岗位匹配" })).toBeNull();
  });

  it("uses action-specific confirmation copy for job recommendations", async () => {
    const action = "request_job_recommendations" as const;
    const approveLabel = "开始岗位推荐";
    const declineLabel = "暂不推荐";
    const onConfirm = vi.fn();
    const confirmation: ConversationConfirmation = {
      confirmationId: `confirmation-${action}`,
      action,
      target: { kind: "recruitment_site", ...site }
    };
    render(
      <ConversationCards
        cards={[{ type: "confirmation", confirmationId: confirmation.confirmationId, action, target: confirmation.target }] as ConversationCard[]}
        pendingConfirmation={confirmation}
        onOpenApplication={vi.fn()}
        onConfirm={onConfirm}
      />
    );

    expect(screen.getByRole("button", { name: approveLabel })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: declineLabel }));
    expect(onConfirm).toHaveBeenCalledWith(confirmation.confirmationId, false);
  });

  it("does not attach a newer confirmation token to an older same-action card", () => {
    const onConfirm = vi.fn();
    const oldConfirmation: ConversationConfirmation = {
      confirmationId: "confirmation-old",
      action: "request_job_recommendations",
      target: { kind: "recruitment_site", ...site }
    };
    const currentConfirmation: ConversationConfirmation = {
      confirmationId: "confirmation-current",
      action: "request_job_recommendations",
      target: {
        kind: "recruitment_site",
        ...site,
        title: "百度社会招聘",
        url: "https://jobs.baidu.com/",
        domain: "jobs.baidu.com"
      }
    };
    render(
      <ConversationCards
        cards={[
          { type: "confirmation", confirmationId: oldConfirmation.confirmationId, action: oldConfirmation.action, target: oldConfirmation.target },
          { type: "confirmation", confirmationId: currentConfirmation.confirmationId, action: currentConfirmation.action, target: currentConfirmation.target }
        ] as ConversationCard[]}
        pendingConfirmation={currentConfirmation}
        onOpenApplication={vi.fn()}
        onConfirm={onConfirm}
      />
    );

    const buttons = screen.getAllByRole("button", { name: "开始岗位推荐" });
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeEnabled();
    fireEvent.click(buttons[1]!);
    expect(onConfirm).toHaveBeenCalledWith(currentConfirmation.confirmationId, true, undefined);
  });
});
