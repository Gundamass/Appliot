import type { ConversationSession } from "@resume/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type ConversationApi } from "./api.js";
import { useConversationHistory } from "./useConversationHistory.js";

const sessionOne: ConversationSession = {
  id: "conversation-1",
  title: "帮我投递百度校园招聘",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z"
};

const sessionTwo: ConversationSession = {
  id: "conversation-2",
  title: "准备大疆岗位",
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z"
};

function conversationApi(sessions: ConversationSession[]): ConversationApi {
  return {
    list: vi.fn().mockResolvedValue(sessions),
    create: vi.fn().mockResolvedValue({ ...sessionOne, id: "conversation-created", title: "新的求职对话" }),
    get: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteAll: vi.fn().mockResolvedValue({ deletedCount: sessions.length }),
    send: vi.fn(),
    confirm: vi.fn()
  };
}

function HistoryHarness({ api, requestedConversationId }: { api: ConversationApi; requestedConversationId?: string }) {
  const history = useConversationHistory({ api, requestedConversationId });
  return (
    <div>
      <output data-testid="active">{history.activeConversationId ?? "none"}</output>
      <output data-testid="count">{history.sessions.length}</output>
      <output data-testid="loading">{history.loading ? "loading" : "ready"}</output>
      <output data-testid="error">{history.error ?? ""}</output>
      {history.sessions.map((session) => <span key={session.id}>{session.title}</span>)}
      <button type="button" onClick={() => history.refresh()}>刷新会话</button>
      <button type="button" onClick={() => void history.delete("conversation-1")}>删除第一个会话</button>
      <button type="button" onClick={() => void history.deleteAll()}>清空会话</button>
    </div>
  );
}

describe("useConversationHistory", () => {
  it("loads the server history and selects the requested conversation without creating one", async () => {
    const api = conversationApi([sessionOne, sessionTwo]);
    render(<HistoryHarness api={api} requestedConversationId={sessionTwo.id} />);

    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent(sessionTwo.id));
    expect(api.list).toHaveBeenCalledOnce();
    expect(api.create).not.toHaveBeenCalled();
    expect(screen.getByTestId("count")).toHaveTextContent("2");
  });

  it("creates a fresh active conversation when history is empty", async () => {
    const api = conversationApi([]);
    render(<HistoryHarness api={api} />);

    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("conversation-created"));
    expect(api.create).toHaveBeenCalledOnce();
    expect(screen.getByTestId("count")).toHaveTextContent("1");
  });

  it("keeps the newest refresh response from being overwritten by an older response", async () => {
    let resolveFirst!: (value: ConversationSession[]) => void;
    let resolveSecond!: (value: ConversationSession[]) => void;
    const first = new Promise<ConversationSession[]>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<ConversationSession[]>((resolve) => { resolveSecond = resolve; });
    const api = conversationApi([]);
    vi.mocked(api.list).mockReturnValueOnce(first).mockReturnValueOnce(second);
    const user = userEvent.setup();
    render(<HistoryHarness api={api} />);

    await waitFor(() => expect(api.list).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "刷新会话" }));
    resolveSecond([sessionTwo]);
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent(sessionTwo.id));
    resolveFirst([sessionOne]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId("active")).toHaveTextContent(sessionTwo.id);
    expect(screen.getByText(sessionTwo.title)).toBeVisible();
    expect(screen.queryByText(sessionOne.title)).not.toBeInTheDocument();
  });

  it("selects the next conversation after deleting the active one", async () => {
    const api = conversationApi([sessionOne, sessionTwo]);
    const user = userEvent.setup();
    render(<HistoryHarness api={api} requestedConversationId={sessionOne.id} />);
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent(sessionOne.id));

    await user.click(screen.getByRole("button", { name: "删除第一个会话" }));

    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent(sessionTwo.id));
    expect(api.delete).toHaveBeenCalledWith(sessionOne.id);
    expect(screen.queryByText(sessionOne.title)).not.toBeInTheDocument();
  });

  it("creates a clean conversation after clearing all history", async () => {
    const api = conversationApi([sessionOne, sessionTwo]);
    const user = userEvent.setup();
    render(<HistoryHarness api={api} requestedConversationId={sessionOne.id} />);
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent(sessionOne.id));

    await user.click(screen.getByRole("button", { name: "清空会话" }));

    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("conversation-created"));
    expect(api.deleteAll).toHaveBeenCalledOnce();
    expect(api.create).toHaveBeenCalledOnce();
    expect(screen.getByTestId("count")).toHaveTextContent("1");
  });
});
