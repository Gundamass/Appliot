import type { JobExpectationSnapshot } from "@resume/contracts";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { JobMatchSession } from "../job-matching/api.js";
import { ConversationJobFilters } from "./ConversationJobFilters.js";

const expectation: JobExpectationSnapshot = {
  revision: 5,
  confirmedAt: "2026-09-02T00:00:00.000Z",
  criteria: [
    { kind: "target_role", values: ["Frontend Engineer"], strength: "required" },
    { kind: "location", values: ["深圳"], strength: "preferred" },
    { kind: "employment_type", values: ["校招"], strength: "preferred" }
  ]
};

function makeJobMatchComponentFixtures(): JobMatchSession {
  return {
    id: "session-filter-fixture",
    version: 8,
    state: "awaiting_filter_confirmation",
    initialUrl: "https://talent.baidu.com/campus",
    scoringVersion: "job-match-v1",
    profileRevision: 2,
    expectationRevision: expectation.revision,
    executionEpoch: 1,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    entryKind: "job_list",
    source: "baidu",
    adapterVersion: "baidu-campus-v1",
    expectation,
    filterPlan: {
      source: "baidu",
      adapterVersion: "baidu-campus-v1",
      mapped: [
        { criterionIndex: 0, key: "keyword", values: ["Frontend Engineer"] },
        { criterionIndex: 2, key: "type", values: ["校招"] }
      ],
      localOnly: [{ criterionIndex: 1, reasonCode: "unsupported_filter" }]
    },
    postings: [],
    results: []
  };
}

describe("ConversationJobFilters", () => {
  it("shows mapped and local conditions and emits the current guarded version", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const session = makeJobMatchComponentFixtures();

    render(
      <ConversationJobFilters
        conversationId="conversation-1"
        session={session}
        onAction={onAction}
      />
    );

    expect(screen.getByText("网站筛选：Frontend Engineer")).toBeVisible();
    expect(screen.getByText("仅本地判断：深圳")).toBeVisible();
    expect(screen.getByText("网站筛选：校招")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "确认筛选并读取岗位" }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conversation-1",
      sessionId: session.id,
      action: "confirm_filters",
      sessionVersion: session.version,
      idempotencyKey: "inline-job-match:session-filter-fixture:confirm_filters:8",
      expectation: session.expectation
    }));
  });
});
