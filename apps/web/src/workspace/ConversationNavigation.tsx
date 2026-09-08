import { ChevronDown, ChevronUp, MessageCircle, MoreHorizontal, SquarePen, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ConversationSession } from "@resume/contracts";

export interface ConversationNavigationProps {
  active: boolean;
  sessions: ConversationSession[];
  activeConversationId?: string;
  loading: boolean;
  error?: string;
  busy: boolean;
  creating: boolean;
  deletingConversationId?: string;
  clearing: boolean;
  onOpenChat(): void;
  onCreate(): void;
  onSelect(conversationId: string): void;
  onDelete(conversationId: string): void;
  onDeleteAll(): void;
  onRetry(): void;
}

type PendingConfirmation =
  | { type: "single"; conversationId: string }
  | { type: "all" };

export function ConversationNavigation({
  active,
  sessions,
  activeConversationId,
  loading,
  error,
  busy,
  creating,
  deletingConversationId,
  clearing,
  onOpenChat,
  onCreate,
  onSelect,
  onDelete,
  onDeleteAll,
  onRetry
}: ConversationNavigationProps) {
  const [expanded, setExpanded] = useState(true);
  const [openMenu, setOpenMenu] = useState<string>();
  const [pending, setPending] = useState<PendingConfirmation>();

  useEffect(() => {
    if (openMenu === undefined && pending === undefined) return;

    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOpenMenu(undefined);
      setPending(undefined);
    };
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest("[data-conversation-menu-root]") !== null) return;
      setOpenMenu(undefined);
    };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [openMenu, pending]);

  const requestDelete = (conversationId: string): void => {
    setOpenMenu(undefined);
    setPending({ type: "single", conversationId });
  };

  const requestDeleteAll = (): void => {
    setOpenMenu(undefined);
    setPending({ type: "all" });
  };

  const confirmPending = (): void => {
    if (pending === undefined) return;
    const action = pending;
    setPending(undefined);
    if (action.type === "all") onDeleteAll();
    else onDelete(action.conversationId);
  };

  return (
    <div className="workspace-conversation-navigation" data-conversation-menu-root>
      <div
        className="workspace-conversation-home-row"
        data-active={active || undefined}
        data-open={openMenu === "history" || undefined}
      >
        <button
          type="button"
          className="workspace-conversation-home"
          aria-expanded={expanded}
          onClick={() => {
            onOpenChat();
            setExpanded((value) => !value);
          }}
        >
          <MessageCircle aria-hidden="true" size={18} />
          <span>对话首页</span>
          {expanded ? <ChevronUp aria-hidden="true" size={16} /> : <ChevronDown aria-hidden="true" size={16} />}
        </button>
        <button
          type="button"
          className="workspace-more-button"
          aria-label="对话首页更多操作"
          aria-haspopup="menu"
          aria-expanded={openMenu === "history"}
          disabled={clearing}
          onClick={() => setOpenMenu((value) => value === "history" ? undefined : "history")}
        >
          <MoreHorizontal aria-hidden="true" size={18} />
        </button>
        {openMenu === "history" && (
          <div className="workspace-context-menu" role="menu" aria-label="对话首页更多操作菜单">
            <button
              type="button"
              role="menuitem"
              className="workspace-menu-action workspace-destructive-action"
              disabled={busy || clearing}
              onClick={requestDeleteAll}
            >
              <Trash2 aria-hidden="true" size={15} />
              <span>清空历史会话</span>
            </button>
          </div>
        )}
      </div>

      {expanded && (
        <div className="workspace-conversation-list" aria-label="历史会话">
          <button
            type="button"
            className="workspace-new-conversation"
            disabled={creating}
            aria-busy={creating || undefined}
            onClick={onCreate}
          >
            <SquarePen aria-hidden="true" size={16} />
            <span>{creating ? "正在新建会话" : "新建会话"}</span>
          </button>

          {loading && <div className="workspace-conversation-state" role="status">正在加载会话…</div>}
          {!loading && error !== undefined && (
            <div className="workspace-conversation-state workspace-conversation-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={onRetry}>重试</button>
            </div>
          )}
          {!loading && error === undefined && sessions.length === 0 && (
            <div className="workspace-conversation-state">暂无历史会话</div>
          )}
          {!loading && error === undefined && sessions.map((session) => {
            const menuKey = `session:${session.id}`;
            const current = session.id === activeConversationId;
            const deleting = deletingConversationId === session.id;
            return (
              <div
                key={session.id}
                className="workspace-session-row"
                data-active={current || undefined}
                data-conversation-menu-root
              >
                <button
                  type="button"
                  className="workspace-session-main"
                  aria-current={current ? "page" : undefined}
                  onClick={() => onSelect(session.id)}
                >
                  <span className="workspace-session-title">{session.title}</span>
                  <time dateTime={session.updatedAt}>{formatConversationTime(session.updatedAt)}</time>
                </button>
                <button
                  type="button"
                  className="workspace-session-more"
                  aria-label={`会话操作：${session.title}`}
                  aria-haspopup="menu"
                  aria-expanded={openMenu === menuKey}
                  disabled={deleting}
                  onClick={() => setOpenMenu((value) => value === menuKey ? undefined : menuKey)}
                >
                  <MoreHorizontal aria-hidden="true" size={17} />
                </button>
                {openMenu === menuKey && (
                  <div className="workspace-context-menu workspace-session-menu" role="menu" aria-label={`会话操作：${session.title}`}>
                    <button
                      type="button"
                      role="menuitem"
                      className="workspace-menu-action workspace-destructive-action"
                      disabled={busy && current}
                      onClick={() => requestDelete(session.id)}
                    >
                      <Trash2 aria-hidden="true" size={15} />
                      <span>{deleting ? "正在删除" : "删除会话"}</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {pending !== undefined && (
        <div className="workspace-conversation-dialog-backdrop">
          <div
            className="workspace-conversation-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="conversation-history-confirmation-title"
            data-conversation-menu-root
          >
            <h2 id="conversation-history-confirmation-title">
              {pending.type === "all" ? "清空历史会话" : "删除会话"}
            </h2>
            <p>
              {pending.type === "all"
                ? "全部对话消息和执行过程将被删除，岗位匹配和投递任务会保留。此操作无法撤销。"
                : "会话消息和执行过程将被删除，岗位匹配和投递任务会保留。此操作无法撤销。"}
            </p>
            <div className="workspace-conversation-dialog-actions">
              <button type="button" onClick={() => setPending(undefined)}>取消</button>
              <button type="button" className="workspace-destructive-action" onClick={confirmPending}>
                {pending.type === "all" ? "确认清空" : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatConversationTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return "刚刚";
  if (elapsedMinutes < 60) return `${elapsedMinutes}分钟前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(timestamp);
}
