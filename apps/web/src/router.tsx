import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { createApplicationApi, type ApplicationApi } from "./applications/api.js";
import { ApplicationTaskPage } from "./applications/ApplicationTaskPage.js";
import { createProfileApi, createRagApi, createSelfEvaluationReviewApi } from "./api/client.js";
import { createHealthApi } from "./api/health-client.js";
import { ProfileApplicationWorkspace } from "./workspace/ProfileApplicationWorkspace.js";
import { createJobMatchApi, type JobMatchApi } from "./job-matching/api.js";
import { JobMatchWorkbench } from "./job-matching/JobMatchWorkbench.js";
import { useJobMatchSession } from "./job-matching/useJobMatchSession.js";
import { createConversationApi, type ConversationApi } from "./conversation/api.js";
import { WorkspaceFrame, type WorkspaceView } from "./workspace/WorkspaceFrame.js";

export function AppRouter({ applicationApi = createApplicationApi(), jobMatchApi = createJobMatchApi(), conversationApi = createConversationApi() }: { applicationApi?: ApplicationApi; jobMatchApi?: JobMatchApi; conversationApi?: ConversationApi }) {
  return <BrowserRouter><Routes>
    <Route path="/" element={<WorkspaceRoute applicationApi={applicationApi} jobMatchApi={jobMatchApi} conversationApi={conversationApi} />} />
    <Route path="/applications/new" element={<Navigate replace to="/" />} />
    <Route path="/applications/:taskId" element={<ApplicationTaskRoute api={applicationApi} />} />
    <Route path="/job-match-sessions/:sessionId" element={<JobMatchRoute api={jobMatchApi} />} />
    <Route path="*" element={<Navigate replace to="/" />} />
  </Routes></BrowserRouter>;
}

function JobMatchRoute({ api }: { api: JobMatchApi }) {
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const loaded = useJobMatchSession(sessionId ?? "", api);
  const selectWorkspaceView = (view: WorkspaceView) => {
    const destination = view === "profile" ? "/?view=profile" : view === "applications" ? "/?view=applications" : "/";
    navigate(destination);
  };
  if (loaded.status === "loading") return <WorkspaceFrame activeView="chat" onSelectView={selectWorkspaceView}><main className="job-match-workbench"><p>正在读取岗位匹配会话…</p></main></WorkspaceFrame>;
  if (loaded.error || !loaded.session) return <WorkspaceFrame activeView="chat" onSelectView={selectWorkspaceView}><main className="job-match-workbench"><p>岗位匹配会话暂时无法读取。</p></main></WorkspaceFrame>;
  const session = loaded.session;
  const guard = () => ({ sessionVersion: session.version, idempotencyKey: crypto.randomUUID() });
  return <WorkspaceFrame activeView="chat" onSelectView={selectWorkspaceView}><JobMatchWorkbench session={session} onPause={() => void api.pause(session.id, guard()).then(loaded.refresh)} onContinue={() => void api.continueExtraction(session.id, guard()).then(loaded.refresh)} onSelect={(result) => void api.select(session.id, { ...guard(), resultId: result.id, resultVersion: result.version, postingContentHash: result.postingContentHash }).then(loaded.refresh)} onSelectConflict={(result) => void conflictSummaryHash(result).then((conflictSummaryHash) => api.selectConflict(session.id, { ...guard(), resultId: result.id, resultVersion: result.version, postingContentHash: result.postingContentHash, conflictSummaryHash })).then(loaded.refresh)} onRematch={() => void api.rematch(session.id, guard()).then(loaded.refresh)} onConfirmFilters={() => void api.confirmFilters(session.id, session.expectation, guard()).then(loaded.refresh)} /></WorkspaceFrame>;
}

async function conflictSummaryHash(result: import("@resume/contracts").JobMatchResult): Promise<string> {
  const conflicts = result.outcomes.filter((outcome) => outcome.outcome === "conflict").map(({ requirementId, outcome, reasonCode }) => ({ requirementId, outcome, reasonCode })).sort((left, right) => left.requirementId === right.requirementId ? 0 : left.requirementId < right.requirementId ? -1 : 1);
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ resultId: result.id, resultVersion: result.version, postingContentHash: result.postingContentHash, conflicts })));
  return `sha256:${Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function WorkspaceRoute({ applicationApi, jobMatchApi, conversationApi }: { applicationApi: ApplicationApi; jobMatchApi: JobMatchApi; conversationApi: ConversationApi }) {
  return <ProfileApplicationWorkspace
    profileApi={createProfileApi()}
    applicationApi={applicationApi}
    jobMatchApi={jobMatchApi}
    healthApi={createHealthApi()}
    reviewApi={createSelfEvaluationReviewApi()}
    ragApi={createRagApi()}
    conversationApi={conversationApi}
  />;
}

function ApplicationTaskRoute({ api }: { api: ApplicationApi }) {
  const navigate = useNavigate();
  const { taskId } = useParams();
  return taskId ? <ApplicationTaskPage taskId={taskId} api={api} onNavigate={navigate} /> : <Navigate replace to="/applications/new" />;
}
