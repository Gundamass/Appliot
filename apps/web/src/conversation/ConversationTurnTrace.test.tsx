import type { ConversationProcessEvent } from "@resume/contracts";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ConversationTurnTrace } from "./ConversationTurnTrace.js";
import type { ConversationTurnProcess } from "./conversation-process-model.js";

function event(overrides: Partial<ConversationProcessEvent> = {}): ConversationProcessEvent {
  return {
    id: "1",
    conversationId: "conversation-1",
    turnSequence: 1,
    stepId: "search-1",
    type: "process_changed",
    stage: "searching_recruitment_site",
    status: "running",
    summary: "正在搜索百度校园招聘入口",
    tool: {
      name: "tavily_search",
      input: [{ label: "公司", value: "百度" }],
      result: "找到 3 个招聘入口"
    },
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides
  };
}

function process(overrides: Partial<ConversationTurnProcess> = {}): ConversationTurnProcess {
  const steps = overrides.steps ?? [event()];
  return {
    turnSequence: 1,
    steps,
    active: steps.some(({ status }) => status === "running" || status === "waiting"),
    failed: steps.some(({ status }) => status === "failed"),
    totalDurationMs: steps.reduce((sum, item) => sum + (item.durationMs ?? 0), 0),
    ...overrides
  };
}

describe("ConversationTurnTrace", () => {
  it("renders expanded tool details as unframed process points", () => {
    render(<ConversationTurnTrace process={process()} isLatestTurn />);

    expect(screen.getByRole("list", { name: "本轮执行过程" })).toBeVisible();
    expect(screen.getByText("Tavily Search")).toBeVisible();
    expect(screen.getByText("公司：百度")).toBeVisible();
    expect(screen.queryByText(/可审计执行摘要|隐私内容和密钥已隐藏/)).toBeNull();
    expect(screen.getByRole("button", { name: "收起执行过程" })).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps a latest running trace expanded after it becomes terminal", () => {
    const { rerender } = render(<ConversationTurnTrace process={process()} isLatestTurn />);
    rerender(<ConversationTurnTrace process={process({ active: false, steps: [event({ id: "2", status: "completed", summary: "搜索完成", durationMs: 1250 })] })} isLatestTurn />);

    expect(screen.getByRole("button", { name: "收起执行过程" })).toHaveAttribute("aria-expanded", "true");
  });

  it("collapses an older terminal trace and lets the user reopen it", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ConversationTurnTrace process={process()} isLatestTurn />);
    rerender(<ConversationTurnTrace process={process({ active: false, steps: [event({ id: "2", status: "completed", summary: "搜索完成" })] })} isLatestTurn={false} />);

    const expand = screen.getByRole("button", { name: "展开执行过程" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    await user.click(expand);
    expect(screen.getByRole("button", { name: "收起执行过程" })).toHaveAttribute("aria-expanded", "true");
  });

  it("shows only the public failure summary for a failed step", async () => {
    const failed = event({
      id: "3",
      stepId: "search-failed",
      status: "failed",
      summary: "招聘入口搜索暂时不可用",
      failure: { code: "TAVILY_UNAVAILABLE", summary: "招聘入口搜索暂时不可用", retryable: true }
    });
    render(<ConversationTurnTrace process={process({ active: false, failed: true, steps: [failed] })} isLatestTurn />);

    await userEvent.setup().click(screen.getByRole("button", { name: "展开执行过程" }));
    expect(screen.getByText("招聘入口搜索暂时不可用")).toBeVisible();
    expect(screen.queryByText("TAVILY_UNAVAILABLE")).toBeNull();
  });
});
