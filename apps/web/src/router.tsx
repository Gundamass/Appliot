import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { createApplicationApi, type ApplicationApi } from "./applications/api.js";
import { ApplicationTaskPage } from "./applications/ApplicationTaskPage.js";
import { createProfileApi, createRagApi, createSelfEvaluationReviewApi } from "./api/client.js";
import { createHealthApi } from "./api/health-client.js";
import { ProfileApplicationWorkspace } from "./workspace/ProfileApplicationWorkspace.js";
import { createJobMatchApi, type JobMatchApi } from "./job-matching/api.js";
import { JobMatchWorkbench } from "./job-matching/JobMatchWorkbench.js";
import { useJobMatchSession } from "./job-matching/useJobMatchSession.js";

export function AppRouter({ applicationApi = createApplicationApi(), jobMatchApi = createJobMatchApi() }: { applicationApi?: ApplicationApi; jobMatchApi?: JobMatchApi }) {
  return <BrowserRouter><Routes>
    <Route path="/" element={<WorkspaceRoute applicationApi={applicationApi} jobMatchApi={jobMatchApi} />} />
    <Route path="/applications/new" element={<Navigate replace to="/?view=apply" />} />
    <Route path="/applications/:taskId" element={<ApplicationTaskRoute api={applicationApi} />} />
    <Route path="/job-match-sessions/:sessionId" element={<JobMatchRoute api={jobMatchApi} />} />
    <Route path="*" element={<Navigate replace to="/" />} />
  </Routes></BrowserRouter>;
}

function JobMatchRoute({ api }: { api: JobMatchApi }) {
  const { sessionId } = useParams();
  const loaded = useJobMatchSession(sessionId ?? "", api);
  if (loaded.status === "loading") return <main className="job-match-workbench"><p>正在读取岗位匹配会话…</p></main>;
  if (loaded.error || !loaded.session) return <main className="job-match-workbench"><p>岗位匹配会话暂时无法读取。</p></main>;
  const session = loaded.session;
  const guard = () => ({ sessionVersion: session.version, idempotencyKey: crypto.randomUUID() });
  return <JobMatchWorkbench session={session} onPause={() => void api.pause(session.id, guard()).then(loaded.refresh)} onContinue={() => void api.continueExtraction(session.id, guard()).then(loaded.refresh)} onSelect={(result) => void api.select(session.id, { ...guard(), resultId: result.id, resultVersion: result.version, postingContentHash: result.postingContentHash }).then(loaded.refresh)} onSelectConflict={(result) => void conflictSummaryHash(result).then((conflictSummaryHash) => api.selectConflict(session.id, { ...guard(), resultId: result.id, resultVersion: result.version, postingContentHash: result.postingContentHash, conflictSummaryHash })).then(loaded.refresh)} onRematch={() => void api.rematch(session.id, guard()).then(loaded.refresh)} onConfirmFilters={() => void api.confirmFilters(session.id, session.expectation, guard()).then(loaded.refresh)} />;
}

async function conflictSummaryHash(result: import("@resume/contracts").JobMatchResult): Promise<string> {
  const conflicts = result.outcomes.filter((outcome) => outcome.outcome === "conflict").map(({ requirementId, outcome, reasonCode }) => ({ requirementId, outcome, reasonCode })).sort((left, right) => left.requirementId === right.requirementId ? 0 : left.requirementId < right.requirementId ? -1 : 1);
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ resultId: result.id, resultVersion: result.version, postingContentHash: result.postingContentHash, conflicts })));
  return `sha256:${Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function WorkspaceRoute({ applicationApi, jobMatchApi }: { applicationApi: ApplicationApi; jobMatchApi: JobMatchApi }) {
  return <ProfileApplicationWorkspace
    profileApi={createProfileApi()}
    applicationApi={applicationApi}
    jobMatchApi={jobMatchApi}
    healthApi={createHealthApi()}
    reviewApi={createSelfEvaluationReviewApi()}
    ragApi={createRagApi()}
  />;
}

function ApplicationTaskRoute({ api }: { api: ApplicationApi }) {
  const navigate = useNavigate();
  const { taskId } = useParams();
  return taskId ? <ApplicationTaskPage taskId={taskId} api={api} onNavigate={navigate} /> : <Navigate replace to="/applications/new" />;
}
