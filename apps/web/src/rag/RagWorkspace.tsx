import type { AdapterStatus, RagFieldInspection, RagFieldRequest } from "@resume/contracts";
import { useState } from "react";
import type { RagApi } from "../api/client.js";
import { ServiceStatus } from "../health/ServiceStatus.js";

const initialRequest: RagFieldRequest = {
  taskId: "task-1",
  fieldId: "city",
  semantic: "preferences.city",
  label: "Preferred city",
  type: "text"
};

export function RagWorkspace({ api, embeddingStatus }: { api: RagApi; embeddingStatus?: AdapterStatus }) {
  const [request, setRequest] = useState(initialRequest);
  const [correction, setCorrection] = useState("");
  const [inspection, setInspection] = useState<RagFieldInspection>();
  const [promote, setPromote] = useState(false);
  const [profileFactId, setProfileFactId] = useState("");
  const [busy, setBusy] = useState<"resolve" | "answer">();
  const [error, setError] = useState<string>();

  const update = (key: keyof RagFieldRequest, value: string) => {
    setRequest((current) => ({ ...current, [key]: value }));
    setInspection(undefined);
  };
  const resolve = async () => {
    if (busy) return;
    setBusy("resolve"); setError(undefined);
    try { setInspection(await api.resolve(request)); }
    catch { setError("Field resolution failed"); }
    finally { setBusy(undefined); }
  };
  const answer = async () => {
    if (busy || correction.trim() === "" || (promote && profileFactId.trim() === "")) return;
    setBusy("answer"); setError(undefined);
    try {
      const result = await api.answer({
        ...request,
        value: correction,
        ...(promote ? { promoteToProfile: true, profileFactId: profileFactId.trim() } : {})
      });
      setInspection(result.inspection);
    } catch { setError("Correction could not be saved"); }
    finally { setBusy(undefined); }
  };

  return (
    <section className="rag-workspace" aria-labelledby="rag-title">
      <div className="review-heading">
        <div><h2 id="rag-title">Field evidence workspace</h2><p>Local task resolution and correction</p></div>
        {embeddingStatus && <ServiceStatus statuses={[embeddingStatus]} />}
      </div>
      <div className="rag-form-grid">
        <label>Task ID<input value={request.taskId} onChange={(event) => update("taskId", event.target.value)} /></label>
        <label>Field ID<input value={request.fieldId} onChange={(event) => update("fieldId", event.target.value)} /></label>
        <label>Semantic<input value={request.semantic} onChange={(event) => update("semantic", event.target.value)} /></label>
        <label>Label<input value={request.label} onChange={(event) => update("label", event.target.value)} /></label>
      </div>
      <button className="button primary" type="button" disabled={busy !== undefined} onClick={() => void resolve()}>{busy === "resolve" ? "Resolving" : "Resolve field"}</button>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {inspection && <div className="rag-result">
        <dl>
          <div><dt>Status</dt><dd>{inspection.decision.status}</dd></div>
          <div><dt>Strategy</dt><dd>{inspection.plan.strategy.join(", ")}</dd></div>
          <div><dt>Sources</dt><dd>{inspection.plan.requiredSources.join(", ")}</dd></div>
          <div><dt>Confidence</dt><dd>{inspection.decision.confidence.toFixed(2)}</dd></div>
        </dl>
        {inspection.decision.question && <p className="rag-question">{inspection.decision.question}</p>}
        <section aria-labelledby="rag-evidence"><h3 id="rag-evidence">Retrieved evidence</h3>{inspection.decision.evidence.length === 0 ? <p>None</p> : <ul>{inspection.decision.evidence.map((item, index) => <li key={`${item.documentId}-${item.page}-${index}`}>{item.text}</li>)}</ul>}</section>
        <div className="rag-correction">
          <label>Correction<input aria-label="Correction" value={correction} onChange={(event) => setCorrection(event.target.value)} /></label>
          <label className="check-control"><input type="checkbox" checked={promote} onChange={(event) => setPromote(event.target.checked)} />Promote to profile</label>
          {promote && <label>Profile fact ID<input value={profileFactId} onChange={(event) => setProfileFactId(event.target.value)} /></label>}
          <button className="button secondary" type="button" disabled={busy !== undefined || correction.trim() === "" || (promote && profileFactId.trim() === "")} onClick={() => void answer()}>{busy === "answer" ? "Saving" : promote ? "Promote correction" : "Save for this task"}</button>
        </div>
      </div>}
    </section>
  );
}
