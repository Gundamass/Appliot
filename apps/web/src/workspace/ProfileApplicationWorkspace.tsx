import { FilePlus2 } from "lucide-react";
import type { ApplicationTask, ProfileCompleteness } from "@resume/contracts";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { HealthApi } from "../api/health-client.js";
import type { ProfileApi, RagApi, SelfEvaluationReviewApi } from "../api/client.js";
import type { ApplicationApi } from "../applications/api.js";
import type { JobMatchApi } from "../job-matching/api.js";
import { JobMatchStartPanel } from "../job-matching/JobMatchStartPanel.js";
import { ProfilePage } from "../profile/ProfilePage.js";
import { ApplicationReviewInbox } from "../applications/ApplicationReviewInbox.js";
import { ApplicationStartPanel } from "../applications/ApplicationStartPanel.js";
import { WorkspaceFrame, type WorkspaceView } from "./WorkspaceFrame.js";

interface ProfileApplicationWorkspaceProps {
  profileApi: ProfileApi;
  applicationApi: ApplicationApi;
  jobMatchApi: Pick<JobMatchApi, "create">;
  healthApi?: HealthApi;
  reviewApi?: SelfEvaluationReviewApi;
  ragApi?: RagApi;
}

export function ProfileApplicationWorkspace({
  profileApi,
  applicationApi,
  jobMatchApi,
  healthApi,
  reviewApi,
  ragApi
}: ProfileApplicationWorkspaceProps) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("view");
  const view: WorkspaceView = requested === "apply" || requested === "reviews" ? requested : "profile";
  const [profileCompleteness, setProfileCompleteness] = useState<ProfileCompleteness>();
  const [tasks, setTasks] = useState<ApplicationTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState<string>();
  const [deletingTaskId, setDeletingTaskId] = useState<string>();
  const [taskActionError, setTaskActionError] = useState<string>();
  const [applicationMode, setApplicationMode] = useState<"job_match" | "direct_application">("job_match");
  const [prefilledApplicationUrl, setPrefilledApplicationUrl] = useState<string>();
  const [jobMatchBusy, setJobMatchBusy] = useState(false);

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
    if (view === "apply") void profileApi.getCompleteness().then(setProfileCompleteness).catch(() => setProfileCompleteness(undefined));
    if (view === "reviews") void loadTasks();
  }, [view, profileApi, applicationApi]);

  const selectView = (nextView: WorkspaceView) => {
    const next = new URLSearchParams(searchParams);
    if (nextView === "profile") next.delete("view");
    else next.set("view", nextView);
    setSearchParams(next, { replace: false });
  };

  return (
    <WorkspaceFrame activeView={view} onSelectView={selectView}>
        {view === "profile" ? (
          <section className="workspace-view" aria-labelledby="workspace-profile-title">
            <header className="workspace-view-header">
              <div><span>长期资料库</span><h1 id="workspace-profile-title">候选人档案</h1></div>
              <button className="button primary" type="button" onClick={() => selectView("apply")}>
                <FilePlus2 aria-hidden="true" size={16} />新建投递
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
        ) : view === "apply" ? (
          <section className="workspace-view" aria-labelledby="workspace-apply-title">
            <header className="workspace-view-header"><div><span>受控浏览器</span><h1 id="workspace-apply-title">新建投递</h1></div></header>
            <div className="workspace-panel-content">
              <div className="application-mode-switch" aria-label="新建投递模式">
                <button
                  type="button"
                  aria-pressed={applicationMode === "job_match"}
                  disabled={jobMatchBusy}
                  onClick={() => setApplicationMode("job_match")}
                >岗位匹配</button>
                <button
                  type="button"
                  aria-pressed={applicationMode === "direct_application"}
                  disabled={jobMatchBusy}
                  onClick={() => setApplicationMode("direct_application")}
                >直接投递</button>
              </div>
              {applicationMode === "job_match" ? <JobMatchStartPanel
                profileApi={profileApi}
                jobMatchApi={jobMatchApi}
                onSessionCreated={(sessionId) => navigate(`/job-match-sessions/${sessionId}`)}
                onApplicationForm={(applicationUrl) => {
                  setPrefilledApplicationUrl(applicationUrl);
                  setApplicationMode("direct_application");
                }}
                onOpenProfile={() => selectView("profile")}
                onBusyChange={setJobMatchBusy}
              /> : <ApplicationStartPanel
                profileCompleteness={profileCompleteness}
                applicationApi={applicationApi}
                {...(prefilledApplicationUrl === undefined ? {} : { initialApplicationUrl: prefilledApplicationUrl })}
                onTaskCreated={(taskId) => navigate(`/applications/${taskId}`)}
                onViewChange={() => selectView("profile")}
              />}
            </div>
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
