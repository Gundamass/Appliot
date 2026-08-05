import { FilePlus2 } from "lucide-react";
import type { ApplicationTask, ProfileCompleteness } from "@resume/contracts";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { HealthApi } from "../api/health-client.js";
import type { ProfileApi, RagApi, SelfEvaluationReviewApi } from "../api/client.js";
import type { ApplicationApi } from "../applications/api.js";
import { ProfilePage } from "../profile/ProfilePage.js";
import { ApplicationReviewInbox } from "../applications/ApplicationReviewInbox.js";
import { ApplicationStartPanel } from "../applications/ApplicationStartPanel.js";
import { WorkspaceFrame, type WorkspaceView } from "./WorkspaceFrame.js";

interface ProfileApplicationWorkspaceProps {
  profileApi: ProfileApi;
  applicationApi: ApplicationApi;
  healthApi?: HealthApi;
  reviewApi?: SelfEvaluationReviewApi;
  ragApi?: RagApi;
}

export function ProfileApplicationWorkspace({
  profileApi,
  applicationApi,
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
            <div className="workspace-panel-content"><ApplicationStartPanel
              profileCompleteness={profileCompleteness}
              applicationApi={applicationApi}
              onTaskCreated={(taskId) => navigate(`/applications/${taskId}`)}
              onViewChange={() => selectView("profile")}
            /></div>
          </section>
        ) : (
          <section className="workspace-view" aria-labelledby="workspace-reviews-title">
            <header className="workspace-view-header"><div><span>人工接管</span><h1 id="workspace-reviews-title">投递审核</h1></div></header>
            <div className="workspace-panel-content"><ApplicationReviewInbox
              tasks={tasks}
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
