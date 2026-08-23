import type { ConversationCard, ConversationConfirmation, ConversationContext, ConversationMessage, ConversationSession } from "@resume/contracts";
import { MessageCircle, BriefcaseBusiness, ClipboardCheck, FileText, CircleHelp, ShieldCheck, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ConversationApiError, type ConversationApi } from "./api.js";
import { ChatMessageList } from "./ChatMessageList.js";
import { ConversationComposer } from "./ConversationComposer.js";
import { QuickStartCards } from "./ConversationCards.js";

interface ChatHomeProps {
  api: ConversationApi;
  onOpenJobMatch(sessionId: string): void;
  onOpenApplication(taskId: string): void;
  onNavigate?(view: "chat" | "jobs" | "applications" | "profile"): void;
}

export function ChatHome({ api, onOpenJobMatch, onOpenApplication, onNavigate }: ChatHomeProps) {
  const [session, setSession] = useState<ConversationSession>();
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [context, setContext] = useState<ConversationContext>({ version: 0, recentPostingIds: [] });
  const [pendingConfirmation, setPendingConfirmation] = useState<ConversationConfirmation>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const created = await api.create();
      const view = await api.get(created.id);
      setSession(view.session); setMessages(view.messages); setContext(view.context); setError(undefined);
    } catch (cause) { setError(toUserError(cause)); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const send = async (text: string) => {
    if (!session || sending) return;
    setSending(true); setError(undefined);
    const optimistic: ConversationMessage = { id: `local-user-${Date.now()}`, sessionId: session.id, sequence: (messages.at(-1)?.sequence ?? 0) + 1, role: "user", text, cards: [], createdAt: new Date().toISOString() };
    setMessages((current) => [...current, optimistic]);
    try {
      const response = await api.send(session.id, text);
      setMessages((current) => [...current, response.message]); setContext(response.context); setPendingConfirmation(response.pendingConfirmation); setError(undefined);
    } catch (cause) { setError(toUserError(cause)); }
    finally { setSending(false); }
  };

  const confirm = async (confirmationId: string, approved: boolean) => {
    if (!session || sending) return;
    setSending(true); setError(undefined);
    try {
      const response = await api.confirm(session.id, confirmationId, approved);
      setMessages((current) => [...current, response.message]); setContext(response.context); setPendingConfirmation(undefined); setError(undefined);
    } catch (cause) { setError(toUserError(cause)); }
    finally { setSending(false); }
  };

  const sendRecommendationRequest = (company: string) => { void send(`我想投递${company}`); };
  const sendProgressRequest = () => { void send("我投了哪些岗位？对应的网站有哪些？"); };
  const startApplication = (card: Extract<ConversationCard, { type: "recommendation" }>) => { void send(`开始投递${card.title}`); };

  return <div className="conversation-shell">
    <header className="conversation-topbar"><div className="conversation-brand"><span className="conversation-mark"><Sparkles aria-hidden="true" size={15} /></span><div><strong>岗位投递助手</strong><span>候选人工作台</span></div></div><div className="conversation-topmeta"><span className="conversation-online"><ShieldCheck aria-hidden="true" size={14} />受控浏览器已连接</span><span>桌面工作区</span></div></header>
    <div className="conversation-layout">
      <aside className="conversation-sidebar"><div className="conversation-sidebar-label">工作区</div><nav aria-label="候选人工作台"><button type="button" className="active" onClick={() => onNavigate?.("chat")}><MessageCircle aria-hidden="true" size={17} />对话首页</button><button type="button" onClick={() => onNavigate?.("jobs")}><BriefcaseBusiness aria-hidden="true" size={17} />我的岗位</button><button type="button" onClick={() => onNavigate?.("applications")}><ClipboardCheck aria-hidden="true" size={17} />投递进度</button><button type="button" onClick={() => onNavigate?.("profile")}><FileText aria-hidden="true" size={17} />我的简历</button></nav><div className="conversation-sidebar-label secondary">快捷入口</div><button type="button" className="conversation-help" onClick={() => onNavigate?.("chat")}><CircleHelp aria-hidden="true" size={17} />使用帮助</button><div className="conversation-profile"><span>林</span><div><strong>林晓宇</strong><small>产品经理</small></div></div></aside>
      <main className="conversation-main"><header className="conversation-main-heading"><div><h1>和助手聊聊你的求职计划</h1><p>可以从岗位推荐、投递进度或简历开始</p></div><span className="conversation-ready">● 已就绪</span></header><div className="conversation-message-area"><div className="conversation-date">今天</div><QuickStartCards onQuickRecommendation={sendRecommendationRequest} onQuickProgress={sendProgressRequest} /><ChatMessageList messages={messages} {...(pendingConfirmation === undefined ? {} : { pendingConfirmation })} onOpenJobMatch={onOpenJobMatch} onOpenApplication={onOpenApplication} onStartApplication={startApplication} onConfirm={confirm} />{error ? <p className="conversation-error" role="alert">{error}</p> : null}</div><ConversationComposer sending={sending} onSend={(text) => void send(text)} /></main>
      <aside className="conversation-context"><h2>当前上下文</h2><section><span>最近推荐</span><strong>{context.recentPostingIds.length > 0 ? `${context.recentPostingIds.length} 个岗位推荐` : "暂无岗位推荐"}</strong><small>{context.activeJobMatchSessionId ? "最近一次匹配会话" : "开始岗位推荐后会显示"}</small></section><section><span>当前投递</span><strong>{context.activeApplicationTaskId ? "有一个进行中的任务" : "暂无进行中的任务"}</strong><small>{context.activeApplicationTaskId ?? "确认后会出现在这里"}</small></section><section><span>简历</span><strong>产品经理简历 · v3</strong><small>当前用于岗位匹配</small></section></aside>
    </div>
  </div>;
}

function toUserError(error: unknown): string {
  if (error instanceof ConversationApiError) return error.message;
  return "对话暂时不可用，请稍后重试";
}
