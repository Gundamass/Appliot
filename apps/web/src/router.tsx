import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { useEffect } from "react";
import { createApplicationApi, type ApplicationApi } from "./applications/api.js";
import { ApplicationTaskPage } from "./applications/ApplicationTaskPage.js";
import { createProfileApi, createRagApi, createSelfEvaluationReviewApi } from "./api/client.js";
import { createHealthApi } from "./api/health-client.js";
import { ProfileApplicationWorkspace } from "./workspace/ProfileApplicationWorkspace.js";
import { createJobMatchApi, type JobMatchApi } from "./job-matching/api.js";
import { createConversationApi, type ConversationApi } from "./conversation/api.js";
import { createConversationJobMatchApi, type ConversationJobMatchApi } from "./conversation/conversation-job-match-api.js";
import { WorkspaceFrame, type WorkspaceView } from "./workspace/WorkspaceFrame.js";

export function AppRouter({ applicationApi = createApplicationApi(), jobMatchApi = createJobMatchApi(), conversationApi = createConversationApi(), conversationJobMatchApi = createConversationJobMatchApi() }: { applicationApi?: ApplicationApi; jobMatchApi?: JobMatchApi; conversationApi?: ConversationApi; conversationJobMatchApi?: ConversationJobMatchApi }) {
  return <BrowserRouter><Routes>
    <Route path="/" element={<WorkspaceRoute applicationApi={applicationApi} jobMatchApi={jobMatchApi} conversationApi={conversationApi} conversationJobMatchApi={conversationJobMatchApi} />} />
    <Route path="/applications/new" element={<Navigate replace to="/" />} />
    <Route path="/applications/:taskId" element={<ApplicationTaskRoute api={applicationApi} />} />
    <Route path="/job-match-sessions/:sessionId" element={<JobMatchRoute api={jobMatchApi} />} />
    <Route path="*" element={<Navigate replace to="/" />} />
  </Routes></BrowserRouter>;
}

function JobMatchRoute({ api }: { api: JobMatchApi }) {
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const selectWorkspaceView = (view: WorkspaceView) => {
    const destination = view === "profile" ? "/?view=profile" : view === "applications" ? "/?view=applications" : "/";
    navigate(destination);
  };
  useEffect(() => {
    let active = true;
    const redirect = (conversationId: string | undefined, notice?: string) => {
      if (!active) return;
      const destination = conversationId === undefined
        ? "/"
        : `/?${new URLSearchParams({ conversation: conversationId }).toString()}`;
      navigate(destination, {
        replace: true,
        ...(notice === undefined ? {} : { state: { jobMatchRecoveryNotice: notice } })
      });
    };
    if (sessionId === undefined || sessionId.trim() === "") {
      redirect(readRecentConversationId(), "这条岗位匹配记录无法在当前对话中恢复。");
      return () => { active = false; };
    }
    void api.findOwningConversation(sessionId)
      .then(({ conversationId }) => redirect(conversationId))
      .catch(() => redirect(readRecentConversationId(), "这条岗位匹配记录无法在当前对话中恢复。"));
    return () => { active = false; };
  }, [api, navigate, sessionId]);
  return <WorkspaceFrame activeView="chat" onSelectView={selectWorkspaceView}><main className="job-match-redirect"><p>正在恢复岗位匹配对话…</p></main></WorkspaceFrame>;
}

function WorkspaceRoute({ applicationApi, jobMatchApi, conversationApi, conversationJobMatchApi }: { applicationApi: ApplicationApi; jobMatchApi: JobMatchApi; conversationApi: ConversationApi; conversationJobMatchApi: ConversationJobMatchApi }) {
  return <ProfileApplicationWorkspace
    profileApi={createProfileApi()}
    applicationApi={applicationApi}
    jobMatchApi={jobMatchApi}
    healthApi={createHealthApi()}
    reviewApi={createSelfEvaluationReviewApi()}
    ragApi={createRagApi()}
    conversationApi={conversationApi}
    conversationJobMatchApi={conversationJobMatchApi}
  />;
}

const recentConversationStorageKey = "resume-application-assistant.recent-conversation-id";

function readRecentConversationId(): string | undefined {
  try {
    const value = window.localStorage.getItem(recentConversationStorageKey)?.trim();
    return value === undefined || value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}

function ApplicationTaskRoute({ api }: { api: ApplicationApi }) {
  const navigate = useNavigate();
  const { taskId } = useParams();
  return taskId ? <ApplicationTaskPage taskId={taskId} api={api} onNavigate={navigate} /> : <Navigate replace to="/applications/new" />;
}
