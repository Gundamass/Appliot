import type { AdapterStatus, RagFieldInspection, RagFieldRequest } from "@resume/contracts";
import { useState } from "react";
import type { RagApi } from "../api/client.js";
import { ServiceStatus } from "../health/ServiceStatus.js";

const initialRequest: RagFieldRequest = {
  taskId: "task-1",
  fieldId: "city",
  semantic: "preferences.city",
  label: "期望城市",
  type: "text"
};

const DECISION_STATUS_LABELS: Record<RagFieldInspection["decision"]["status"], string> = {
  verified_auto: "已自动验证",
  needs_review: "需要审核",
  needs_question: "需要追问",
  blocked: "已阻止"
};

const STRATEGY_LABELS: Record<RagFieldInspection["plan"]["strategy"][number], string> = {
  exact: "精确匹配",
  keyword: "关键词检索",
  embedding: "语义检索"
};

const SOURCE_LABELS: Record<RagFieldInspection["plan"]["requiredSources"][number], string> = {
  application: "本次任务",
  profile: "长期资料"
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
    catch { setError("字段解析失败，请重试"); }
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
    } catch { setError("修正内容保存失败，请重试"); }
    finally { setBusy(undefined); }
  };

  return (
    <section className="rag-workspace" aria-labelledby="rag-title">
      <div className="review-heading">
        <div><h2 id="rag-title">字段证据工作区</h2><p>解析并修正本次任务中的字段</p></div>
        {embeddingStatus && <ServiceStatus statuses={[embeddingStatus]} />}
      </div>
      <div className="rag-form-grid">
        <label>任务 ID<input value={request.taskId} onChange={(event) => update("taskId", event.target.value)} /></label>
        <label>字段 ID<input value={request.fieldId} onChange={(event) => update("fieldId", event.target.value)} /></label>
        <label>语义路径<input value={request.semantic} onChange={(event) => update("semantic", event.target.value)} /></label>
        <label>字段名称<input value={request.label} onChange={(event) => update("label", event.target.value)} /></label>
      </div>
      <button className="button primary" type="button" disabled={busy !== undefined} onClick={() => void resolve()}>{busy === "resolve" ? "解析中" : "解析字段"}</button>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {inspection && <div className="rag-result">
        <dl>
          <div><dt>状态</dt><dd>{DECISION_STATUS_LABELS[inspection.decision.status]}</dd></div>
          <div><dt>检索策略</dt><dd>{inspection.plan.strategy.map((strategy) => STRATEGY_LABELS[strategy]).join("、")}</dd></div>
          <div><dt>检索来源</dt><dd>{inspection.plan.requiredSources.map((source) => SOURCE_LABELS[source]).join("、")}</dd></div>
          <div><dt>置信度</dt><dd>{inspection.decision.confidence.toFixed(2)}</dd></div>
        </dl>
        {inspection.decision.question && <p className="rag-question">{inspection.decision.question}</p>}
        <section aria-labelledby="rag-evidence"><h3 id="rag-evidence">检索证据</h3>{inspection.decision.evidence.length === 0 ? <p>暂无证据</p> : <ul>{inspection.decision.evidence.map((item, index) => <li key={`${item.documentId}-${item.page}-${index}`}>{item.text}</li>)}</ul>}</section>
        <div className="rag-correction">
          <label>修正值<input aria-label="修正值" value={correction} onChange={(event) => setCorrection(event.target.value)} /></label>
          <label className="check-control"><input type="checkbox" checked={promote} onChange={(event) => setPromote(event.target.checked)} />推广到长期资料</label>
          {promote && <label>长期资料 ID<input value={profileFactId} onChange={(event) => setProfileFactId(event.target.value)} /></label>}
          <button className="button secondary" type="button" disabled={busy !== undefined || correction.trim() === "" || (promote && profileFactId.trim() === "")} onClick={() => void answer()}>{busy === "answer" ? "保存中" : promote ? "推广修正内容" : "仅保存到本次任务"}</button>
        </div>
      </div>}
    </section>
  );
}
