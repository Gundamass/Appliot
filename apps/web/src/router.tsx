import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { createApplicationApi, type ApplicationApi } from "./applications/api.js";
import { ApplicationTaskPage } from "./applications/ApplicationTaskPage.js";
import { createProfileApi, createRagApi, createSelfEvaluationReviewApi } from "./api/client.js";
import { createHealthApi } from "./api/health-client.js";
import { ProfileApplicationWorkspace } from "./workspace/ProfileApplicationWorkspace.js";

export function AppRouter({ applicationApi = createApplicationApi() }: { applicationApi?: ApplicationApi }) {
  return <BrowserRouter><Routes>
    <Route path="/" element={<WorkspaceRoute applicationApi={applicationApi} />} />
    <Route path="/applications/new" element={<Navigate replace to="/?view=apply" />} />
    <Route path="/applications/:taskId" element={<ApplicationTaskRoute api={applicationApi} />} />
    <Route path="*" element={<Navigate replace to="/" />} />
  </Routes></BrowserRouter>;
}

function WorkspaceRoute({ applicationApi }: { applicationApi: ApplicationApi }) {
  return <ProfileApplicationWorkspace
    profileApi={createProfileApi()}
    applicationApi={applicationApi}
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
