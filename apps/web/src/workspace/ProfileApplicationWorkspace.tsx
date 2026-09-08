import { MessageCircle } from "lucide-react";
import type { ApplicationTask } from "@resume/contracts";
import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { HealthApi } from "../api/health-client.js";
import type { ProfileApi, RagApi, SelfEvaluationReviewApi } from "../api/client.js";
import type { ApplicationApi } from "../applications/api.js";
import type { JobMatchApi } from "../job-matching/api.js";
import { ProfilePage } from "../profile/ProfilePage.js";
import { ApplicationReviewInbox } from "../applications/ApplicationReviewInbox.js";
import type { ConversationApi } from "../conversation/api.js";
import { ChatHome } from "../conversation/ChatHome.js";
import type { ConversationJobMatchApi } from "../conversation/conversation-job-match-api.js";
import { useConversationHistory } from "../conversation/useConversationHistory.js";
import { WorkspaceFrame, type WorkspaceView } from "./WorkspaceFrame.js";

const conversationSearchParameter = "conversation";
const recentConversationStorageKey = "resume-application-assistant.recent-conversation-id";

interface ProfileApplicationWorkspaceProps {
  profileApi: ProfileApi;
  applicationApi: ApplicationApi;
  jobMatchApi: JobMatchApi;
  conversationJobMatchApi?: ConversationJobMatchApi;
  healthApi?: HealthApi;
  reviewApi?: SelfEvaluationReviewApi;
  ragApi?: RagApi;
  conversationApi: ConversationApi;
}

export function ProfileApplicationWorkspace({
  profileApi,
  applicationApi,
  jobMatchApi,
  conversationJobMatchApi,
  healthApi,
  reviewApi,
  ragApi,
  conversationApi
}: ProfileApplicationWorkspaceProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("view");
  const view = normalizeWorkspaceView(requested);
  const conversationId = normalizeConversationId(searchParams.get(conversationSearchParameter)) ?? readRecentConversationId();
  const legacyRecoveryNotice = readLegacyRecoveryNotice(location.state);
  const [tasks, setTasks] = useState<ApplicationTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState<string>();
  const [deletingTaskId, setDeletingTaskId] = useState<string>();
  const [taskActionError, setTaskActionError] = useState<string>();
  const [chatBusy, setChatBusy] = useState(false);

  const loadTasks = async () => {
    setTasksLoading(true);
    setTasksError(undefined);
    try {
      setTasks(await applicationApi.list());
    } catch {
      setTasksError("待处理任务加载失败，请重试");
    } finally {
      setTasksLoading(false);
    }
  };

  const deleteTask = async (task: ApplicationTask) => {
    setDeletingTaskId(task.id);
    setTaskActionError(undefined);
    try {
      if (task.commands.includes("cancel")) {
        await applicationApi.command(task.id, { type: "cancel" });
      }
      if (!applicationApi.delete) throw new Error("当前客户端不支持删除任务");
      await applicationApi.delete(task.id);
      setTasks((current) => current.filter((candidate) => candidate.id !== task.id));
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "任务删除失败，请重试；任务记录仍已保留。");
    } finally {
      setDeletingTaskId(undefined);
    }
  };

  useEffect(() => {
    if (view === "applications") void loadTasks();
  }, [view, profileApi, applicationApi]);

  const selectView = (nextView: WorkspaceView) => {
    const next = new URLSearchParams(searchParams);
    if (nextView === "chat") next.delete("view");
    else next.set("view", nextView);
    setSearchParams(next, { replace: false });
  };

  const rememberConversation = useCallback((sessionId?: string) => {
    if (sessionId === undefined) {
      removeRecentConversationId();
      setSearchParams((current) => {
        if (!current.has(conversationSearchParameter)) return current;
        const next = new URLSearchParams(current);
        next.delete(conversationSearchParameter);
        return next;
      }, { replace: true });
      return;
    }
    writeRecentConversationId(sessionId);
    setSearchParams((current) => {
      if (current.get(conversationSearchParameter) === sessionId) return current;
      const next = new URLSearchParams(current);
      next.set(conversationSearchParameter, sessionId);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const conversationHistory = useConversationHistory({
    api: conversationApi,
    ...(conversationId === undefined ? {} : { requestedConversationId: conversationId }),
    onActiveConversationChange: rememberConversation
  });

  const conversationNavigation = {
    active: view === "chat",
    sessions: conversationHistory.sessions,
    ...(conversationHistory.activeConversationId === undefined ? {} : { activeConversationId: conversationHistory.activeConversationId }),
    loading: conversationHistory.loading,
    ...(conversationHistory.error === undefined ? {} : { error: conversationHistory.error }),
    busy: conversationHistory.busy || chatBusy,
    creating: conversationHistory.creating,
    ...(conversationHistory.deletingConversationId === undefined ? {} : { deletingConversationId: conversationHistory.deletingConversationId }),
    clearing: conversationHistory.clearing,
    onOpenChat: () => selectView("chat"),
    onCreate: () => { void conversationHistory.create(); },
    onSelect: (selectedConversationId: string) => {
      conversationHistory.select(selectedConversationId);
      selectView("chat");
    },
    onDelete: (conversationIdToDelete: string) => { void conversationHistory.delete(conversationIdToDelete); },
    onDeleteAll: () => { void conversationHistory.deleteAll(); },
    onRetry: () => { void conversationHistory.refresh(); }
  };

  return (
    <WorkspaceFrame activeView={view} onSelectView={selectView} conversationNavigation={conversationNavigation}>
        {view === "chat" ? (
          conversationHistory.activeConversationId === undefined ? (
            <section className="workspace-view conversation-loading" aria-labelledby="conversation-loading-title">
              <p id="conversation-loading-title" role="status">{conversationHistory.error ?? (conversationHistory.creating ? "正在创建对话…" : "正在加载会话…")}</p>
            </section>
          ) : (
            <ChatHome
              api={conversationApi}
              jobMatchApi={jobMatchApi}
              {...(conversationJobMatchApi === undefined ? {} : { conversationJobMatchApi })}
              initialSessionId={conversationHistory.activeConversationId}
              {...(legacyRecoveryNotice === undefined ? {} : { initialNotice: legacyRecoveryNotice })}
              onSessionResolved={rememberConversation}
              onBusyChange={setChatBusy}
              onOpenApplication={(taskId) => navigate(`/applications/${taskId}`)}
            />
          )
        ) : view === "profile" ? (
          <section className="workspace-view" aria-labelledby="workspace-profile-title">
            <header className="workspace-view-header">
              <div><span>长期资料库</span><h1 id="workspace-profile-title">我的简历</h1></div>
              <button className="button primary" type="button" onClick={() => selectView("chat")}>
                <MessageCircle aria-hidden="true" size={16} />开始对话
              </button>
            </header>
            <ProfilePage
              api={profileApi}
              embedded
              {...(healthApi ? { healthApi } : {})}
              {...(reviewApi ? { reviewApi } : {})}
              {...(ragApi ? { ragApi } : {})}
            />
          </section>
        ) : (
          <section className="workspace-view" aria-labelledby="workspace-reviews-title">
            <header className="workspace-view-header"><div><span>人工接管</span><h1 id="workspace-reviews-title">投递审核</h1></div></header>
            <div className="workspace-panel-content"><ApplicationReviewInbox
              tasks={tasks}
              onDeleteTask={deleteTask}
              {...(deletingTaskId === undefined ? {} : { deletingTaskId })}
              actionError={taskActionError}
              loading={tasksLoading}
              error={tasksError}
              onRetry={() => void loadTasks()}
              onOpenTask={(taskId) => navigate(`/applications/${taskId}`)}
            /></div>
          </section>
        )}
    </WorkspaceFrame>
  );
}

function normalizeWorkspaceView(requested: string | null): WorkspaceView {
  if (requested === "jobs" || requested === "apply") return "chat";
  if (requested === "applications" || requested === "reviews") return "applications";
  if (requested === "profile") return "profile";
  return "chat";
}

function readLegacyRecoveryNotice(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const notice = (state as { jobMatchRecoveryNotice?: unknown }).jobMatchRecoveryNotice;
  return typeof notice === "string" && notice.trim() !== "" ? notice : undefined;
}

function normalizeConversationId(value: string | null): string | undefined {
  const id = value?.trim();
  return id === undefined || id.length === 0 ? undefined : id;
}

function readRecentConversationId(): string | undefined {
  try {
    return normalizeConversationId(window.localStorage.getItem(recentConversationStorageKey));
  } catch {
    return undefined;
  }
}

function writeRecentConversationId(sessionId: string): void {
  try {
    window.localStorage.setItem(recentConversationStorageKey, sessionId);
  } catch {
    // Browser privacy settings can disable local storage; URL persistence still works.
  }
}

function removeRecentConversationId(): void {
  try {
    window.localStorage.removeItem(recentConversationStorageKey);
  } catch {
    // Browser privacy settings can disable local storage; the URL remains authoritative.
  }
}
