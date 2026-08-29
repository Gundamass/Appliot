import type { ConversationCard, ConversationConfirmation } from "@resume/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

function renderCards(cards: ConversationCard[], pendingConfirmation?: ConversationConfirmation) {
  return render(
    <ConversationCards
      cards={cards}
      {...(pendingConfirmation === undefined ? {} : { pendingConfirmation })}
      onOpenJobMatch={vi.fn()}
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
        cards={[{ type: "confirmation", action: confirmation.action, target: choices }]}
        pendingConfirmation={confirmation}
        onOpenJobMatch={vi.fn()}
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

  it("renders the verified recruitment entry and job-match session as their own cards", async () => {
    const onOpenJobMatch = vi.fn();
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
        onOpenJobMatch={onOpenJobMatch}
        onOpenApplication={vi.fn()}
      />
    );

    expect(screen.getByText("Baidu Campus Recruitment")).toBeTruthy();
    expect(screen.getByText("官方入口")).toBeTruthy();
    expect(screen.getByText("12 个岗位待确认")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "打开岗位匹配" }));
    expect(onOpenJobMatch).toHaveBeenCalledWith("match-1");
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
        cards={[{ type: "confirmation", action, target: confirmation.target }]}
        pendingConfirmation={confirmation}
        onOpenJobMatch={vi.fn()}
        onOpenApplication={vi.fn()}
        onConfirm={onConfirm}
      />
    );

    expect(screen.getByRole("button", { name: approveLabel })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: declineLabel }));
    expect(onConfirm).toHaveBeenCalledWith(confirmation.confirmationId, false);
  });
});
