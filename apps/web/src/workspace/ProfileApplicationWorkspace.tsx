import { MessageCircle } from "lucide-react";
import type { ApplicationTask } from "@resume/contracts";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { HealthApi } from "../api/health-client.js";
import type { ProfileApi, RagApi, SelfEvaluationReviewApi } from "../api/client.js";
import type { ApplicationApi } from "../applications/api.js";
import type { JobMatchApi } from "../job-matching/api.js";
import { ProfilePage } from "../profile/ProfilePage.js";
import { ApplicationReviewInbox } from "../applications/ApplicationReviewInbox.js";
import type { ConversationApi } from "../conversation/api.js";
import { ChatHome } from "../conversation/ChatHome.js";
import { WorkspaceFrame, type WorkspaceView } from "./WorkspaceFrame.js";

interface ProfileApplicationWorkspaceProps {
  profileApi: ProfileApi;
  applicationApi: ApplicationApi;
  jobMatchApi: Pick<JobMatchApi, "create">;
  healthApi?: HealthApi;
  reviewApi?: SelfEvaluationReviewApi;
  ragApi?: RagApi;
  conversationApi: ConversationApi;
}

export function ProfileApplicationWorkspace({
  profileApi,
  applicationApi,
  healthApi,
  reviewApi,
  ragApi,
  conversationApi
}: ProfileApplicationWorkspaceProps) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("view");
  const view = normalizeWorkspaceView(requested);
  const [tasks, setTasks] = useState<ApplicationTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState<string>();
  const [deletingTaskId, setDeletingTaskId] = useState<string>();
  const [taskActionError, setTaskActionError] = useState<string>();

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

  if (view === "chat") return <ChatHome api={conversationApi} onOpenJobMatch={(sessionId) => navigate(`/job-match-sessions/${sessionId}`)} onOpenApplication={(taskId) => navigate(`/applications/${taskId}`)} onNavigate={selectView} />;

  return (
    <WorkspaceFrame activeView={view} onSelectView={selectView}>
        {view === "profile" ? (
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
