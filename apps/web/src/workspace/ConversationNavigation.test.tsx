import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConversationSession } from "@resume/contracts";
import { ConversationNavigation, type ConversationNavigationProps } from "./ConversationNavigation.js";

const sessions: ConversationSession[] = [
  {
    id: "conversation-1",
    title: "帮我投递百度校园招聘",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z"
  },
  {
    id: "conversation-2",
    title: "准备大疆岗位",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z"
  },
  {
    id: "conversation-3",
    title: "查看投递进度",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z"
  }
];

function props(overrides: Partial<ConversationNavigationProps> = {}): ConversationNavigationProps {
  return {
    active: true,
    sessions,
    activeConversationId: "conversation-1",
    loading: false,
    busy: false,
    creating: false,
    clearing: false,
    onOpenChat: vi.fn(),
    onCreate: vi.fn(),
    onSelect: vi.fn(),
    onDelete: vi.fn(),
    onDeleteAll: vi.fn(),
    onRetry: vi.fn(),
    ...overrides
  };
}

describe("ConversationNavigation", () => {
  it("renders an expandable conversation tree and new-session action", () => {
    render(<ConversationNavigation {...props()} />);

    expect(screen.getByRole("button", { name: "对话首页" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "新建会话" })).toBeVisible();
    expect(screen.getByText("帮我投递百度校园招聘")).toBeVisible();
    expect(screen.getByText("准备大疆岗位")).toBeVisible();
  });

  it("opens top and row menus with their scoped destructive action", async () => {
    const user = userEvent.setup();
    render(<ConversationNavigation {...props()} />);

    await user.click(screen.getByRole("button", { name: "对话首页更多操作" }));
    expect(screen.getByRole("menu")).toHaveTextContent("清空历史会话");
    await user.click(screen.getByRole("button", { name: "会话操作：帮我投递百度校园招聘" }));
    expect(screen.getByRole("menu")).toHaveTextContent("删除会话");
  });

  it("opens data-retention confirmation dialogs for delete and clear", async () => {
    const user = userEvent.setup();
    render(<ConversationNavigation {...props()} />);

    await user.click(screen.getByRole("button", { name: "会话操作：帮我投递百度校园招聘" }));
    await user.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "删除会话" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "会话消息和执行过程将被删除，岗位匹配和投递任务会保留。此操作无法撤销。"
    );
    await user.click(screen.getByRole("button", { name: "取消" }));

    await user.click(screen.getByRole("button", { name: "对话首页更多操作" }));
    await user.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "清空历史会话" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "全部对话消息和执行过程将被删除，岗位匹配和投递任务会保留。此操作无法撤销。"
    );
  });

  it("closes menus and dialogs with cancel or Escape", async () => {
    const user = userEvent.setup();
    render(<ConversationNavigation {...props()} />);

    await user.click(screen.getByRole("button", { name: "对话首页更多操作" }));
    expect(screen.getByRole("menu")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(screen.getByRole("button", { name: "对话首页更多操作" }));
    await user.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "清空历史会话" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disables current deletion and clear while the conversation is busy", async () => {
    const user = userEvent.setup();
    render(<ConversationNavigation {...props({ busy: true })} />);

    await user.click(screen.getByRole("button", { name: "对话首页更多操作" }));
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "清空历史会话" })).toBeDisabled();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "会话操作：帮我投递百度校园招聘" }));
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "删除会话" })).toBeDisabled();
  });

  it("routes selection, opening chat, and confirmed deletion to callbacks", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    render(<ConversationNavigation {...callbacks} />);

    await user.click(screen.getByText("准备大疆岗位"));
    await user.click(screen.getByRole("button", { name: "会话操作：准备大疆岗位" }));
    await user.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "删除会话" }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    await user.click(screen.getByRole("button", { name: "对话首页" }));

    expect(callbacks.onOpenChat).toHaveBeenCalledOnce();
    expect(callbacks.onSelect).toHaveBeenCalledWith("conversation-2");
    expect(callbacks.onDelete).toHaveBeenCalledWith("conversation-2");
  });

  it("keeps loading and retry states inside the conversation list", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = render(<ConversationNavigation {...props({ loading: true })} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在加载会话");

    rerender(<ConversationNavigation {...props({ error: "无法加载会话", onRetry })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("无法加载会话");
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
