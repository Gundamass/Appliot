import type { ConversationProcessEvent } from "@resume/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConversationProcessChain } from "./ConversationProcessChain.js";

const events: ConversationProcessEvent[] = [
  {
    id: "1",
    conversationId: "conversation-1",
    turnSequence: 1,
    stepId: "understand-request",
    type: "process_changed",
    stage: "understanding_request",
    status: "completed",
    summary: "请求已理解",
    createdAt: "2026-08-22T00:00:00.000Z"
  },
  {
    id: "2",
    conversationId: "conversation-1",
    turnSequence: 1,
    stepId: "search-1",
    type: "process_changed",
    stage: "searching_recruitment_site",
    status: "running",
    summary: "正在搜索官方招聘入口",
    createdAt: "2026-08-22T00:00:01.000Z"
  },
  {
    id: "3",
    conversationId: "conversation-1",
    turnSequence: 1,
    stepId: "site-found-1",
    type: "process_changed",
    stage: "recruitment_site_found",
    status: "completed",
    summary: "已找到招聘入口",
    createdAt: "2026-08-22T00:00:02.000Z"
  },
  {
    id: "4",
    conversationId: "conversation-1",
    turnSequence: 1,
    stepId: "wait-confirmation",
    type: "process_changed",
    stage: "waiting_for_confirmation",
    status: "running",
    summary: "等待你的确认",
    createdAt: "2026-08-22T00:00:03.000Z"
  }
];

describe("ConversationProcessChain", () => {
  it("shows the current process stage and bounded Chinese labels", () => {
    render(<ConversationProcessChain events={events} connectionStatus="connected" />);

    expect(screen.getByRole("heading", { name: "处理过程" })).toBeVisible();
    expect(screen.getByText("正在搜索官方招聘入口")).toBeVisible();
    expect(screen.getByText("已找到招聘入口")).toBeVisible();
    expect(screen.getByText("等待你的确认")).toBeVisible();
    expect(screen.getByText("实时连接")).toBeVisible();
    expect(screen.queryByText(/model|prompt|conversation-1/i)).toBeNull();
  });

  it("shows a recoverable disconnected state without inventing a process message", () => {
    render(<ConversationProcessChain events={[]} connectionStatus="disconnected" />);

    expect(screen.getByText("实时连接中断，历史过程仍可查看")).toBeVisible();
    expect(screen.getByText("暂时还没有过程记录")).toBeVisible();
  });
});
