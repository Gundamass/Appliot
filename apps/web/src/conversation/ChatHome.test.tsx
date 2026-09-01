import type {
  ConversationConfirmation,
  ConversationMessage,
  ConversationSession,
  ConversationProcessEvent,
  ConversationTurnResponse,
  ConversationView
} from "@resume/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationApiError, type ConversationApi } from "./api.js";
import { ChatHome } from "./ChatHome.js";

const session: ConversationSession = {
  id: "conversation-1",
  title: "新的求职对话",
  createdAt: "2026-08-23T01:00:00.000Z",
  updatedAt: "2026-08-23T01:00:00.000Z"
};

function message(role: ConversationMessage["role"], text: string, sequence: number): ConversationMessage {
  return {
    id: `${role}-${sequence}`,
    sessionId: session.id,
    sequence,
    role,
    text,
    cards: [],
    createdAt: `2026-08-23T01:0${sequence}:00.000Z`
  };
}

function view(messages: ConversationMessage[] = [message("assistant", "可以开始岗位匹配", 1)]): ConversationView {
  return { session, messages, context: { version: 0, recentPostingIds: [] } };
}

function viewFor(sessionId: string, text: string): ConversationView {
  return {
    session: { ...session, id: sessionId },
    messages: [{ ...message("assistant", text, 1), id: `assistant-${sessionId}`, sessionId }],
    context: { version: 0, recentPostingIds: [] }
  };
}

function turn(text: string, pendingConfirmation?: ConversationConfirmation, assistantSequence = 3): ConversationTurnResponse {
  const cards = pendingConfirmation === undefined ? [] : [confirmationCard(pendingConfirmation)];
  return {
    message: { ...message("assistant", text, assistantSequence), cards },
    cards,
    context: { version: 1, recentPostingIds: [] },
    ...(pendingConfirmation === undefined ? {} : { pendingConfirmation, confirmationId: pendingConfirmation.confirmationId })
  };
}

function processEvent(overrides: Partial<ConversationProcessEvent> = {}): ConversationProcessEvent {
  return {
    id: "1",
    conversationId: session.id,
    turnSequence: 1,
    stepId: "step-1",
    type: "process_changed",
    stage: "understanding_request",
    status: "running",
    summary: "正在理解你的请求",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides
  };
}

function confirmationCard(confirmation: ConversationConfirmation): ConversationTurnResponse["cards"][number] {
  return {
    type: "confirmation",
    confirmationId: confirmation.confirmationId,
    action: confirmation.action,
    target: confirmation.target
  } as ConversationTurnResponse["cards"][number];
}

function fakeConversationApi(initialView = view()) {
  const api: ConversationApi = {
    create: vi.fn().mockResolvedValue(session),
    get: vi.fn().mockResolvedValue(initialView),
    send: vi.fn().mockResolvedValue(turn("收到")),
    confirm: vi.fn().mockResolvedValue(turn("投递任务已创建"))
  };
  return api;
}

class FakeProcessEventSource extends EventTarget {
  static latest: FakeProcessEventSource;

  constructor(readonly url: string) {
    super();
    FakeProcessEventSource.latest = this;
  }

  close(): void {
    // The test only needs the EventSource lifecycle surface.
  }
}

describe("ChatHome", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("restores an existing requested conversation without creating a replacement", async () => {
    const api = fakeConversationApi(viewFor("conversation-restored", "restored history"));
    render(<ChatHome api={api} initialSessionId="conversation-restored" onOpenJobMatch={vi.fn()} onOpenApplication={vi.fn()} />);

    expect(await screen.findByText("restored history")).toBeVisible();
    expect(api.get).toHaveBeenCalledWith("conversation-restored");
    expect(api.create).not.toHaveBeenCalled();
  });

  it("creates one replacement only when the requested conversation is missing", async () => {
    const api = fakeConversationApi(viewFor(session.id, "replacement history"));
    const onSessionResolved = vi.fn();
    vi.mocked(api.get)
      .mockRejectedValueOnce(new ConversationApiError("missing", "conversation_not_found", 404));

    render(<ChatHome api={api} initialSessionId="stale-id" onSessionResolved={onSessionResolved} onOpenJobMatch={vi.fn()} onOpenApplication={vi.fn()} />);

    expect(await screen.findByText("replacement history")).toBeVisible();
    expect(api.get).toHaveBeenNthCalledWith(1, "stale-id");
    expect(api.create).toHaveBeenCalledOnce();
    expect(api.get).toHaveBeenNthCalledWith(2, session.id);
    expect(onSessionResolved).toHaveBeenCalledWith(session.id);
  });

  it("does not replace a requested conversation when the service is unavailable", async () => {
    const api = fakeConversationApi();
    vi.mocked(api.get).mockRejectedValue(new ConversationApiError("unavailable", "conversation_service_unavailable", 503));

    render(<ChatHome api={api} initialSessionId="conversation-unavailable" onOpenJobMatch={vi.fn()} onOpenApplication={vi.fn()} />);

    expect(await screen.findByRole("alert")).toBeVisible();
    expect(api.get).toHaveBeenCalledWith("conversation-unavailable");
    expect(api.create).not.toHaveBeenCalled();
  });

  it("renders history and sends a bounded message", async () => {
    const api = fakeConversationApi();
    const user = userEvent.setup();
    render(<ChatHome api={api} onOpenJobMatch={vi.fn()} onOpenApplication={vi.fn()} />);

    expect(await screen.findByText("可以开始岗位匹配")).toBeVisible();
    const composer = screen.getByRole("textbox", { name: "输入消息" });
    await user.type(composer, "我投了哪些岗位");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(api.send).toHaveBeenCalledWith(session.id, "我投了哪些岗位"));
    expect(screen.getByText("我投了哪些岗位")).toBeVisible();
  });

  it("shows live process updates for the loaded conversation", async () => {
    vi.stubGlobal("EventSource", FakeProcessEventSource);
    const api = fakeConversationApi();
    const user = userEvent.setup();
    render(<ChatHome api={api} onOpenJobMatch={vi.fn()} onOpenApplication={vi.fn()} />);

    expect(await screen.findByText("可以开始岗位匹配")).toBeVisible();
    const source = FakeProcessEventSource.latest;
    source.dispatchEvent(new Event("open"));
    expect(await screen.findByText("实时连接")).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "输入消息" }), "查看投递进度");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(session.id, "查看投递进度"));
    source.dispatchEvent(new MessageEvent("process_changed", { data: JSON.stringify(processEvent({
      id: "1",
      turnSequence: 2,
      stepId: "progress-1",
      stage: "loading_application_progress",
      summary: "正在查询投递进度"
    })) }));

    expect(await screen.findByText("正在查询投递进度")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "处理过程" })).toBeNull();
  });

  it("places each process trace below its owning user message", async () => {
    vi.stubGlobal("EventSource", FakeProcessEventSource);
    const api = fakeConversationApi(view([]));
    vi.mocked(api.send)
      .mockResolvedValueOnce(turn("第一轮回复", undefined, 2))
      .mockResolvedValueOnce(turn("第二轮回复", undefined, 4));
    const user = userEvent.setup();
    render(<ChatHome api={api} onOpenJobMatch={vi.fn()} onOpenApplication={vi.fn()} />);

    const composer = screen.getByRole("textbox", { name: "输入消息" });
    await user.type(composer, "第一轮请求");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    await user.type(composer, "第二轮请求");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));

    const source = FakeProcessEventSource.latest;
    source.dispatchEvent(new MessageEvent("process_changed", { data: JSON.stringify(processEvent({
      id: "2",
      turnSequence: 1,
      stepId: "recruitment-search-1",
      stage: "recruitment_site_found",
      summary: "找到百度招聘入口"
    })) }));
    source.dispatchEvent(new MessageEvent("process_changed", { data: JSON.stringify(processEvent({
      id: "3",
      turnSequence: 3,
      stepId: "progress-3",
      stage: "loading_application_progress",
      summary: "正在查询投递进度"
    })) }));

    const firstTurn = await screen.findByTestId("conversation-turn-1");
    const secondTurn = await screen.findByTestId("conversation-turn-3");
    expect(within(firstTurn).getByText("找到百度招聘入口")).toBeVisible();
    expect(within(firstTurn).queryByText("正在查询投递进度")).toBeNull();
    expect(within(secondTurn).getByText("正在查询投递进度")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "处理过程" })).toBeNull();
  });

  it("asks for explicit approval before confirming a task creation", async () => {
    const confirmation: ConversationConfirmation = {
      confirmationId: "confirmation-1",
      action: "start_application",
      target: { kind: "recommendation", sessionId: "match-1", resultId: "result-1" }
    };
    const api = fakeConversationApi();
    vi.mocked(api.send).mockResolvedValue(turn("开始投递前请确认", confirmation));
    const user = userEvent.setup();
    render(<ChatHome api={api} onOpenJobMatch={vi.fn()} onOpenApplication={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: "输入消息" }), "投递第一份");
    await user.click(screen.getByRole("button", { name: "发送" }));
    const confirmButton = await screen.findByRole("button", { name: "确认进入投递" });
    await user.click(confirmButton);

    expect(api.confirm).toHaveBeenCalledWith(session.id, "confirmation-1", true);
  });

  it("inserts an optimistic confirmation turn before its process events arrive", async () => {
    const confirmation: ConversationConfirmation = {
      confirmationId: "confirmation-optimistic",
      action: "start_application",
      target: { kind: "recommendation", sessionId: "match-1", resultId: "result-1" }
    };
    const api = fakeConversationApi();
    vi.mocked(api.send).mockResolvedValue(turn("开始投递前请确认", confirmation, 2));
    let resolveConfirmation!: (response: ConversationTurnResponse) => void;
    vi.mocked(api.confirm).mockReturnValue(new Promise<ConversationTurnResponse>((resolve) => {
      resolveConfirmation = resolve;
    }));
    const user = userEvent.setup();
    render(<ChatHome api={api} onOpenJobMatch={vi.fn()} onOpenApplication={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: "输入消息" }), "投递第一份");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.click(await screen.findByRole("button", { name: "确认进入投递" }));

    const confirmationTurn = await screen.findByTestId("conversation-turn-3");
    expect(within(confirmationTurn).getByText("确认开始投递")).toBeVisible();
    resolveConfirmation(turn("投递任务已创建", undefined, 4));
    await waitFor(() => expect(api.confirm).toHaveBeenCalledWith(session.id, "confirmation-optimistic", true));
  });

  it("keeps the follow-up recruitment confirmation actionable after approving an entry", async () => {
    const entryConfirmation: ConversationConfirmation = {
      confirmationId: "confirmation-entry",
      action: "confirm_recruitment_site",
      target: {
        kind: "recruitment_site_choices",
        company: "百度",
        recruitmentType: "campus",
        query: "百度 校园招聘 招聘 官网",
        candidates: [{
          title: "百度校园招聘",
          url: "https://campus.baidu.com/",
          domain: "campus.baidu.com",
          snippet: "校园招聘岗位",
          source: "tavily"
        }]
      }
    };
    const recommendationConfirmation: ConversationConfirmation = {
      confirmationId: "confirmation-recommendations",
      action: "request_job_recommendations",
      target: {
        kind: "recruitment_site",
        company: "百度",
        recruitmentType: "campus",
        query: "百度 校园招聘 招聘 官网",
        title: "百度校园招聘",
        url: "https://campus.baidu.com/",
        domain: "campus.baidu.com",
        snippet: "校园招聘岗位",
        source: "tavily"
      }
    };
    const api = fakeConversationApi();
    vi.mocked(api.send).mockResolvedValue(turn("请选择招聘入口", entryConfirmation));
    vi.mocked(api.confirm).mockResolvedValueOnce(turn("招聘入口已确认", recommendationConfirmation));
    const user = userEvent.setup();
    render(<ChatHome api={api} onOpenJobMatch={vi.fn()} onOpenApplication={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: "输入消息" }), "帮我投递百度校招");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.click(await screen.findByRole("button", { name: "确认使用此入口" }));

    const recommendationButton = await screen.findByRole("button", { name: "开始岗位推荐" });
    expect(recommendationButton).toBeEnabled();
    await user.click(recommendationButton);
    expect(api.confirm).toHaveBeenLastCalledWith(session.id, "confirmation-recommendations", true);
  });

  it("restores an actionable confirmation from the loaded conversation view", async () => {
    const confirmation: ConversationConfirmation = {
      confirmationId: "confirmation-restored",
      action: "request_job_recommendations",
      target: {
        kind: "recruitment_site",
        company: "百度",
        recruitmentType: "campus",
        query: "百度 校园招聘 招聘 官网",
        title: "百度校园招聘",
        url: "https://campus.baidu.com/",
        domain: "campus.baidu.com",
        snippet: "校园招聘岗位",
        source: "tavily"
      }
    };
    const restoredMessage = {
      ...message("assistant", "招聘入口已确认", 1),
      cards: [confirmationCard(confirmation)]
    };
    const api = fakeConversationApi({
      ...view([restoredMessage]),
      pendingConfirmation: confirmation
    } as ConversationView);
    const user = userEvent.setup();
    render(<ChatHome api={api} onOpenJobMatch={vi.fn()} onOpenApplication={vi.fn()} />);

    const recommendationButton = await screen.findByRole("button", { name: "开始岗位推荐" });
    expect(recommendationButton).toBeEnabled();
    await user.click(recommendationButton);
    expect(api.confirm).toHaveBeenCalledWith(session.id, confirmation.confirmationId, true);
  });

  it("offers quick starts for company recommendations and application progress", async () => {
    const api = fakeConversationApi();
    const user = userEvent.setup();
    render(<ChatHome api={api} onOpenJobMatch={vi.fn()} onOpenApplication={vi.fn()} />);

    await screen.findByText("快速开始");
    await user.click(screen.getByRole("button", { name: /岗位推荐/ }));
    expect(screen.getByPlaceholderText("例如：大疆")).toBeVisible();
    await user.type(screen.getByPlaceholderText("例如：大疆"), "大疆");
    await user.click(screen.getByRole("button", { name: "搜索岗位" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(session.id, "我想投递大疆"));

    await user.click(within(screen.getByLabelText("快速开始")).getByRole("button", { name: /投递进度/ }));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(session.id, "我投了哪些岗位？对应的网站有哪些？"));
  });

  it("shows remaining characters and keeps send disabled for blank input", async () => {
    const api = fakeConversationApi();
    const user = userEvent.setup();
    render(<ChatHome api={api} onOpenJobMatch={vi.fn()} onOpenApplication={vi.fn()} />);
    const composer = screen.getByRole("textbox", { name: "输入消息" });

    expect(screen.getByText("500 字剩余")).toBeVisible();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    await user.type(composer, "岗位");
    expect(screen.getByText("498 字剩余")).toBeVisible();
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });
});
