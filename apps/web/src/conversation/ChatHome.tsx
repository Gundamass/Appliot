import type { ConversationCard, ConversationConfirmation, ConversationContext, ConversationJobMatchAction, ConversationMessage, ConversationProcessEvent, ConversationSession, ConversationView } from "@resume/contracts";
import { LoaderCircle, Wifi, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConversationApiError, type ConversationApi } from "./api.js";
import { ChatMessageList } from "./ChatMessageList.js";
import { ConversationComposer } from "./ConversationComposer.js";
import { QuickStartCards } from "./ConversationCards.js";
import { ConversationJobMatchApiError, createConversationJobMatchApi, type ConversationJobMatchApi } from "./conversation-job-match-api.js";
import { useConversationProcessEvents } from "./conversation-process-events.js";
import { groupConversationProcessEvents } from "./conversation-process-model.js";
import { createJobMatchApi, type JobMatchApi } from "../job-matching/api.js";

const defaultJobMatchApi = createJobMatchApi();
const defaultConversationJobMatchApi = createConversationJobMatchApi();

function confirmationDecisionText(
  action: ConversationConfirmation["action"],
  approved: boolean
): string {
  if (action === "confirm_recruitment_site") {
    return approved ? "确认使用此入口" : "暂不使用此入口";
  }
  if (action === "request_job_recommendations") {
    return approved ? "开始岗位推荐" : "暂不推荐";
  }
  return approved ? "确认开始投递" : "取消开始投递";
}

interface ChatHomeProps {
  api: ConversationApi;
  jobMatchApi?: JobMatchApi;
  conversationJobMatchApi?: ConversationJobMatchApi;
  initialSessionId?: string;
  createIfMissing?: boolean;
  initialNotice?: string;
  onSessionResolved?(sessionId: string): void;
  onBusyChange?(busy: boolean): void;
  onOpenApplication(taskId: string): void;
}

export function ChatHome({ api, jobMatchApi = defaultJobMatchApi, conversationJobMatchApi = defaultConversationJobMatchApi, initialSessionId, createIfMissing = true, initialNotice, onSessionResolved, onBusyChange, onOpenApplication }: ChatHomeProps) {
  const [session, setSession] = useState<ConversationSession>();
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [context, setContext] = useState<ConversationContext>({ version: 0, recentPostingIds: [] });
  const [pendingConfirmation, setPendingConfirmation] = useState<ConversationConfirmation>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [processEvents, setProcessEvents] = useState<ConversationProcessEvent[]>([]);
  const resolvedSessionId = useRef<string | undefined>(undefined);
  const operationVersion = useRef(0);
  const activeSessionId = useRef<string | undefined>(undefined);

  const onProcessEvent = useCallback((event: ConversationProcessEvent) => {
    setProcessEvents((current) => {
      if (current.some((candidate) => candidate.id === event.id)) return current;
      return [...current, event].slice(-200);
    });
  }, []);
  const onProcessHistoryReset = useCallback(() => {
    setProcessEvents([]);
  }, []);
  const processConnectionStatus = useConversationProcessEvents(session?.id, {
    onEvent: onProcessEvent,
    onHistoryReset: onProcessHistoryReset
  });
  const processByTurn = useMemo(() => groupConversationProcessEvents(processEvents), [processEvents]);

  useEffect(() => {
    if (initialSessionId !== undefined && resolvedSessionId.current === initialSessionId) return;
    const version = ++operationVersion.current;
    let active = true;
    activeSessionId.current = undefined;
    setSession(undefined);
    setMessages([]);
    setContext({ version: 0, recentPostingIds: [] });
    setPendingConfirmation(undefined);
    setProcessEvents([]);
    setSending(false);
    setError(undefined);
    const load = async () => {
      try {
        let view: ConversationView | undefined;
        if (initialSessionId !== undefined) {
          try {
            view = await api.get(initialSessionId);
          } catch (cause) {
            if (!isMissingConversation(cause)) throw cause;
          }
        }
        if (view === undefined && createIfMissing) {
          const created = await api.create();
          view = await api.get(created.id);
        }
        if (!active || version !== operationVersion.current || view === undefined) return;
        resolvedSessionId.current = view.session.id;
        activeSessionId.current = view.session.id;
        setSession(view.session); setMessages(view.messages); setContext(view.context); setPendingConfirmation(view.pendingConfirmation); setProcessEvents([]); setError(undefined);
        onSessionResolved?.(view.session.id);
      } catch (cause) {
        if (active && version === operationVersion.current) setError(toUserError(cause));
      }
    };
    void load();
    return () => { active = false; };
  }, [api, createIfMissing, initialSessionId, onSessionResolved]);

  useEffect(() => {
    onBusyChange?.(sending);
  }, [onBusyChange, sending]);

  const send = async (text: string) => {
    if (!session || sending) return;
    const sessionId = session.id;
    const version = operationVersion.current;
    setSending(true); setError(undefined);
    const optimistic: ConversationMessage = { id: `local-user-${Date.now()}`, sessionId, sequence: (messages.at(-1)?.sequence ?? 0) + 1, role: "user", text, cards: [], createdAt: new Date().toISOString() };
    setMessages((current) => [...current, optimistic]);
    try {
      const response = await api.send(sessionId, text);
      if (version !== operationVersion.current || activeSessionId.current !== sessionId) return;
      setMessages((current) => [...current, response.message]); setContext(response.context); setPendingConfirmation(response.pendingConfirmation); setError(undefined);
    } catch (cause) {
      if (version === operationVersion.current && activeSessionId.current === sessionId) setError(toUserError(cause));
    }
    finally { if (version === operationVersion.current && activeSessionId.current === sessionId) setSending(false); }
  };

  const confirm = async (confirmationId: string, approved: boolean, selectedUrl?: string) => {
    if (!session || sending) return;
    const sessionId = session.id;
    const version = operationVersion.current;
    setSending(true); setError(undefined);
    const action = pendingConfirmation?.confirmationId === confirmationId
      ? pendingConfirmation.action
      : "start_application";
    const decisionText = confirmationDecisionText(action, approved);
    const optimistic: ConversationMessage = { id: `local-confirmation-${Date.now()}`, sessionId, sequence: (messages.at(-1)?.sequence ?? 0) + 1, role: "user", text: decisionText, cards: [], createdAt: new Date().toISOString() };
    setMessages((current) => [...current, optimistic]);
    try {
      const response = selectedUrl === undefined
        ? await api.confirm(sessionId, confirmationId, approved)
        : await api.confirm(sessionId, confirmationId, approved, selectedUrl);
      if (version !== operationVersion.current || activeSessionId.current !== sessionId) return;
      setMessages((current) => [...current, response.message]); setContext(response.context); setPendingConfirmation(response.pendingConfirmation); setError(undefined);
    } catch (cause) {
      if (version === operationVersion.current && activeSessionId.current === sessionId) setError(toUserError(cause));
    }
    finally { if (version === operationVersion.current && activeSessionId.current === sessionId) setSending(false); }
  };

  const executeJobMatchAction = async (action: ConversationJobMatchAction) => {
    if (!session || sending) return;
    const sessionId = session.id;
    const version = operationVersion.current;
    setSending(true); setError(undefined);
    const optimistic: ConversationMessage = {
      id: `local-job-match-${Date.now()}`,
      sessionId,
      sequence: (messages.at(-1)?.sequence ?? 0) + 1,
      role: "user",
      text: jobMatchActionLabel(action),
      cards: [],
      createdAt: new Date().toISOString()
    };
    setMessages((current) => [...current, optimistic]);
    try {
      const response = await conversationJobMatchApi.execute(action);
      if (version !== operationVersion.current || activeSessionId.current !== sessionId) return;
      setMessages((current) => current.some((message) => message.id === response.message.id)
        ? current
        : [...current, response.message]);
      setContext(response.context);
      setPendingConfirmation(undefined);
      setError(undefined);
    } catch (cause) {
      if (version === operationVersion.current && activeSessionId.current === sessionId) setError(toUserError(cause));
    } finally {
      if (version === operationVersion.current && activeSessionId.current === sessionId) setSending(false);
    }
  };

  const sendRecommendationRequest = (company: string) => { void send(`我想投递${company}`); };
  const sendProgressRequest = () => { void send("我投了哪些岗位？对应的网站有哪些？"); };
  const startApplication = (card: Extract<ConversationCard, { type: "recommendation" }>) => { void send(`开始投递${card.title}`); };

  return <div className="conversation-workspace-content">
    <div className="conversation-content-layout">
      <main className="conversation-main"><header className="conversation-main-heading"><div><h1>和助手聊聊你的求职计划</h1><p>可以从岗位推荐、投递进度或简历开始</p></div><div className="conversation-heading-status"><span className="conversation-ready">● 已就绪</span>{session === undefined ? null : <ProcessConnectionStatus status={processConnectionStatus} />}</div></header><div className="conversation-message-area"><div className="conversation-date">今天</div>{initialNotice === undefined ? null : <p className="conversation-info" role="status">{initialNotice}</p>}<QuickStartCards onQuickRecommendation={sendRecommendationRequest} onQuickProgress={sendProgressRequest} /><ChatMessageList messages={messages} processByTurn={processByTurn} {...(messages.filter(({ role }) => role === "user").at(-1)?.sequence === undefined ? {} : { latestUserSequence: messages.filter(({ role }) => role === "user").at(-1)!.sequence })} {...(pendingConfirmation === undefined ? {} : { pendingConfirmation })} onOpenApplication={onOpenApplication} jobMatchApi={jobMatchApi} onJobMatchAction={executeJobMatchAction} onStartApplication={startApplication} onConfirm={confirm} />{error ? <p className="conversation-error" role="alert">{error}</p> : null}</div><ConversationComposer sending={sending} onSend={(text) => void send(text)} /></main>
      <aside className="conversation-context"><h2>当前上下文</h2><section><span>最近推荐</span><strong>{context.recentPostingIds.length > 0 ? `${context.recentPostingIds.length} 个岗位推荐` : "暂无岗位推荐"}</strong><small>{context.activeJobMatchSessionId ? "最近一次匹配会话" : "开始岗位推荐后会显示"}</small></section><section><span>当前投递</span><strong>{context.activeApplicationTaskId ? "有一个进行中的任务" : "暂无进行中的任务"}</strong><small>{context.activeApplicationTaskId ?? "确认后会出现在这里"}</small></section><section><span>简历</span><strong>产品经理简历 · v3</strong><small>当前用于岗位匹配</small></section></aside>
    </div>
  </div>;
}

function ProcessConnectionStatus({ status }: { status: "connecting" | "connected" | "disconnected" }) {
  if (status === "connected") return <span className="conversation-process-connection connected"><Wifi aria-hidden="true" size={14} />实时连接</span>;
  if (status === "connecting") return <span className="conversation-process-connection connecting"><LoaderCircle aria-hidden="true" size={14} />正在连接实时过程</span>;
  return <span className="conversation-process-connection disconnected"><WifiOff aria-hidden="true" size={14} />实时连接中断，历史过程仍可查看</span>;
}

function toUserError(error: unknown): string {
  if (error instanceof ConversationApiError || error instanceof ConversationJobMatchApiError) {
    switch (error.code) {
      case "recommendation_context_missing":
      case "recommendation_ordinal_1_missing":
      case "recommendation_not_found":
        return "当前没有可确定的目标岗位，请先打开岗位匹配结果。";
      case "recommendation_stale":
      case "job_match_posting_changed":
        return "岗位匹配结果已变化，请刷新岗位匹配后再试。";
      case "browser_worker_unavailable":
      case "browser_open_unavailable":
        return "受控浏览器暂时不可用，可以稍后重试或打开已有投递任务。";
      case "challenge_required":
      case "browser_challenge_required":
        return "投递页面需要额外验证，请手动接管浏览器完成验证后再继续。";
      case "policy_rejected":
      case "application_submission_locked":
        return "当前策略不允许提交，提交已锁定；请先检查投递审核要求。";
      case "conversation_confirmation_invalid":
      case "confirmation_invalid":
        return "这条确认已失效或已经使用，请重新发起投递。";
      case "conversation_input_invalid":
        return "消息最多 500 字，请缩短后重试。";
      case "TAVILY_NOT_CONFIGURED":
        return "联网搜索尚未配置。你可以配置 Tavily，或粘贴该公司的官方招聘链接。";
      case "TAVILY_TIMEOUT":
      case "TAVILY_UNAVAILABLE":
        return "招聘入口搜索暂时不可用。你可以稍后重试，或粘贴该公司的官方招聘链接。";
      case "TAVILY_PROTOCOL_ERROR":
      case "NO_SAFE_CANDIDATE":
        return "暂时没有找到可确认的招聘入口。请换一种公司名称，或粘贴官方招聘链接。";
      case "recruitment_site_selection_invalid":
        return "所选招聘入口已失效，请重新搜索并确认。";
      case "job_match_version_conflict":
      case "job_match_result_version_conflict":
      case "job_match_result_stale":
      case "job_match_conflict_confirmation_stale":
        return "岗位匹配结果已变化，请刷新后重试。";
      case "conversation_job_match_not_owned":
      case "job_match_session_not_found":
        return "这条岗位匹配记录已无法在当前对话中恢复。";
      default:
        return "对话暂时不可用，请稍后重试。";
    }
  }
  return "对话暂时不可用，请稍后重试";
}

function jobMatchActionLabel(action: ConversationJobMatchAction): string {
  return ({
    confirm_filters: "确认岗位筛选条件",
    adjust_filters: "调整岗位筛选条件",
    pause: "暂停读取岗位",
    continue: "继续读取岗位",
    rematch: "重新匹配岗位",
    select_result: "选择岗位",
    select_conflict_result: "确认选择冲突岗位"
  } as Record<ConversationJobMatchAction["action"], string>)[action.action];
}

function isMissingConversation(error: unknown): boolean {
  return error instanceof ConversationApiError && error.status === 404;
}
