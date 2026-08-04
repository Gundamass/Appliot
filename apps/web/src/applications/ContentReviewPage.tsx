import type { ApplicationContentReview } from "@resume/contracts";
import { AlertTriangle, Check, FileDiff, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApplicationEvidenceDrawer } from "./ApplicationEvidenceDrawer.js";
import { EvidenceList } from "./EvidenceList.js";

interface ContentReviewPageProps {
  review: ApplicationContentReview;
  busy: boolean;
  canApprove: boolean;
  canReject: boolean;
  onApprove(value: string): void | Promise<void>;
  onReject(): void | Promise<void>;
}

export function ContentReviewPage({ review, busy, canApprove, canReject, onApprove, onReject }: ContentReviewPageProps) {
  const [finalValue, setFinalValue] = useState(review.draft);
  const [evidenceTrigger, setEvidenceTrigger] = useState<HTMLButtonElement>();
  const blocked = review.status === "blocked" || review.unsupportedClaims.length > 0;
  const reviewSignature = `${review.id}\u0000${review.draft}`;
  const previousReviewSignature = useRef(reviewSignature);

  useEffect(() => {
    if (previousReviewSignature.current === reviewSignature) return;
    previousReviewSignature.current = reviewSignature;
    setFinalValue(review.draft);
    setEvidenceTrigger(undefined);
  }, [review.draft, reviewSignature]);

  return (
    <section className="content-review-page" aria-labelledby="content-review-title">
      <header>
        <div className="review-section-icon"><FileDiff aria-hidden="true" size={19} /></div>
        <div><span>填写前人工确认</span><h2 id="content-review-title">审核{review.fieldLabel}</h2></div>
      </header>

      <div className="content-review-columns">
        <article><h3>资料原文</h3><p>{review.original || "暂无原始内容"}</p></article>
        <article><h3>建议草稿</h3><p>{review.draft}</p></article>
        <label><span>最终填写内容</span><textarea aria-label="最终填写内容" value={finalValue} disabled={busy || blocked || !canApprove} onChange={(event) => setFinalValue(event.target.value)} /></label>
      </div>

      <div className="content-review-details">
        <section aria-labelledby="content-review-reasons"><h3 id="content-review-reasons">调整与审核理由</h3>{review.reasons.length === 0 ? <p className="empty-review-detail">该字段需要你确认后才能填写</p> : <ul>{review.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}</section>
        <EvidenceList evidence={review.evidence} onInspect={setEvidenceTrigger} />
      </div>

      {blocked && <div className="content-review-warning" role="alert"><AlertTriangle aria-hidden="true" size={18} /><div><strong>草稿未通过事实校验</strong><p>{review.unsupportedClaims.join("；") || "当前内容无法安全采用"}</p></div></div>}

      {((!blocked && canApprove) || canReject) && <div className="content-review-actions">
        {!blocked && canApprove && <>
          <button className="button primary" type="button" disabled={busy || finalValue.trim() === ""} onClick={() => void onApprove(finalValue)}><Check aria-hidden="true" size={16} />采用最终稿</button>
          <button className="button secondary" type="button" disabled={busy || review.original.trim() === ""} onClick={() => void onApprove(review.original)}><RotateCcw aria-hidden="true" size={16} />继续使用原文</button>
        </>}
        {canReject && <button className="button quiet danger" type="button" disabled={busy} onClick={() => void onReject()}><X aria-hidden="true" size={16} />拒绝并停止</button>}
      </div>}
      {evidenceTrigger && <ApplicationEvidenceDrawer review={review} returnFocusTo={evidenceTrigger} onClose={() => setEvidenceTrigger(undefined)} />}
    </section>
  );
}
