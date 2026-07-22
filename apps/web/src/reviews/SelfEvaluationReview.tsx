import type { SelfEvaluationReview as SelfEvaluationReviewModel } from "@resume/contracts";
import { useEffect, useRef, useState } from "react";

interface SelfEvaluationReviewProps {
  draft: SelfEvaluationReviewModel;
  onApprove(draft: string): Promise<SelfEvaluationReviewModel>;
  onKeepOriginal(): Promise<SelfEvaluationReviewModel>;
}

export function SelfEvaluationReview({ draft, onApprove, onKeepOriginal }: SelfEvaluationReviewProps) {
  const [review, setReview] = useState(draft);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(draft.draft);
  const [busy, setBusy] = useState<"approve" | "keep">();
  const [error, setError] = useState<string>();
  const [completion, setCompletion] = useState<"adopted" | "kept">();
  const editRef = useRef<HTMLTextAreaElement>(null);
  const adoptRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const blocked = review.status === "blocked" || review.unsupportedClaims.length > 0;
  const terminal = review.status === "approved";

  useEffect(() => { if (editing) editRef.current?.focus(); }, [editing]);
  useEffect(() => {
    if (draft.taskId !== review.taskId || draft.status === "needs_review") {
      setReview(draft); setValue(draft.draft); setEditing(false); setError(undefined); setCompletion(undefined);
    }
  }, [draft, review.taskId]);
  useEffect(() => { if (completion) statusRef.current?.focus(); }, [completion]);

  const run = async (action: "approve" | "keep") => {
    if (busy || terminal || (action === "approve" && blocked)) return;
    setBusy(action); setError(undefined);
    try {
      const next = action === "approve" ? await onApprove(value) : await onKeepOriginal();
      setReview(next);
      setEditing(false);
      setCompletion(action === "approve" ? "adopted" : "kept");
    } catch {
      setError(action === "approve" ? "采用失败，请重试" : "保留原文失败，请重试");
    } finally { setBusy(undefined); }
  };

  return (
    <section className="self-evaluation-review" aria-label="自我评价审核">
      <div className="self-evaluation-columns">
        <article><h2>原始自我评价</h2><p>{review.original}</p></article>
        <article><h2>岗位微调稿</h2>{editing ? <textarea ref={editRef} aria-label="编辑岗位微调稿" value={value} disabled={busy !== undefined} onChange={(event) => setValue(event.target.value)} /> : <p>{value}</p>}</article>
      </div>
      <div className="self-evaluation-details">
        <section aria-labelledby="tailoring-reasons"><h3 id="tailoring-reasons">调整原因</h3><ul>{review.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></section>
        <section aria-labelledby="tailoring-evidence"><h3 id="tailoring-evidence">支持证据</h3><ul>{review.evidence.map((item, index) => <li key={`${item.documentId}-${item.page}-${index}`}>{evidenceLabel(item)}：{item.text}</li>)}</ul></section>
      </div>
      {blocked && <p className="unsupported-claims" role="alert">不支持的声明：{review.unsupportedClaims.join("、")}</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {terminal && <p ref={statusRef} className="review-status" role="status" tabIndex={-1}>{completion === "kept" ? "已继续使用原文" : "已采用此版本"}</p>}
      <div className="self-evaluation-actions">
        {!terminal && <>
          {editing ? <button className="button primary" type="button" disabled={blocked || busy !== undefined || value.trim() === ""} onClick={() => void run("approve")}>{busy === "approve" ? "采用中" : "采用编辑稿"}</button> : <button ref={adoptRef} className="button primary" type="button" disabled={blocked || busy !== undefined} onClick={() => void run("approve")}>{busy === "approve" ? "采用中" : "采用此版本"}</button>}
          {!editing && <button className="button secondary" type="button" disabled={busy !== undefined} onClick={() => setEditing(true)}>编辑后采用</button>}
          {editing && <button className="button secondary" type="button" disabled={busy !== undefined} onClick={() => { setEditing(false); setValue(review.draft); adoptRef.current?.focus(); }}>取消编辑</button>}
          <button className="button quiet" type="button" disabled={busy !== undefined} onClick={() => void run("keep")}>{busy === "keep" ? "保存中" : "继续使用原文"}</button>
        </>}
      </div>
    </section>
  );
}

function evidenceLabel(evidence: SelfEvaluationReviewModel["evidence"][number]): string {
  if (evidence.extraction === "user") return "用户确认";
  return evidence.extraction === "ocr" ? `OCR 第 ${evidence.page} 页` : `PDF 第 ${evidence.page} 页`;
}
