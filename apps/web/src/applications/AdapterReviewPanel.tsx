import {
  HintPackDefinitionSchema,
  type AdapterReviewSummary,
  type HintPackDefinition,
  type HumanCertificationDecision
} from "@resume/contracts";
import { CheckCircle2, CircleAlert, RotateCw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type DecisionInput = Pick<HumanCertificationDecision, "decision" | "aiReviewUnavailable" | "acknowledgedAiUnavailable">;

interface AdapterReviewPanelProps {
  review: AdapterReviewSummary;
  busy: boolean;
  onReplay(): void;
  onAiReview(): void;
  onRevise(definition: HintPackDefinition): void;
  onDecision(input: DecisionInput): void;
}

const ASSERTION_LABELS: Record<string, string> = {
  schema_valid: "结构符合约束",
  policy_safe: "动作策略安全",
  mapping_one_to_one: "字段映射唯一",
  control_type_compatible: "控件类型兼容",
  section_compatible: "栏目位置兼容",
  target_value: "目标值正确",
  unrelated_unchanged: "无关字段未改变",
  repeat_order: "重复栏目顺序稳定",
  stable_readback: "回读结果稳定",
  boundary_paused: "越界场景已暂停",
  challenge_paused: "风控场景已暂停",
  zero_submit: "提交次数为零",
  pii_free_trace: "审计轨迹无个人信息"
};

const SEVERITY_LABELS: Record<string, string> = {
  info: "提示",
  warning: "注意",
  error: "阻断"
};

export function AdapterReviewPanel({ review, busy, onReplay, onAiReview, onRevise, onDecision }: AdapterReviewPanelProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [definition, setDefinition] = useState<HintPackDefinition | undefined>(review.proposal?.definition);

  useEffect(() => {
    setDefinition(review.proposal?.definition);
    setAcknowledged(false);
  }, [review.proposal?.proposalId]);

  const hardPassed = useMemo(() => (
    review.replayReports.length > 0
      && review.replayReports.every((report) => report.status === "passed"
        && report.submissionCount === 0
        && report.assertions.every((assertion) => assertion.passed))
  ), [review.replayReports]);
  const parsedDefinition = definition === undefined ? undefined : HintPackDefinitionSchema.safeParse(definition);
  const canCertify = hardPassed && (review.aiReview !== undefined || (review.aiReviewUnavailable && acknowledged));

  return <section className="adapter-review-panel" aria-label="ATS 适配认证">
    <header className="adapter-review-header">
      <div>
        <span>只读观察与受控认证</span>
        <h3>当前网站尚无认证适配包</h3>
        <p>认证完成前不会向真实招聘页面写入任何字段，也不会执行提交动作。</p>
      </div>
      <ShieldCheck aria-hidden="true" size={23} />
    </header>

    <section className="adapter-review-section">
      <div className="adapter-review-section-heading">
        <div><span>第一层</span><h4>确定性校验</h4></div>
        <strong className={hardPassed ? "passed" : "pending"}>{hardPassed ? "已通过" : "待运行"}</strong>
      </div>
      {review.replayReports.length > 0 ? <ul className="adapter-review-checks">
        {review.replayReports.flatMap((report) => report.assertions).map((assertion, index) => <li key={`${assertion.code}-${index}`} className={assertion.passed ? "passed" : "failed"}>
          {assertion.passed ? <CheckCircle2 aria-hidden="true" size={15} /> : <CircleAlert aria-hidden="true" size={15} />}
          <span><strong>{ASSERTION_LABELS[assertion.code] ?? "确定性断言"}</strong><small>{assertion.detail}</small></span>
        </li>)}
      </ul> : <p className="adapter-review-empty">尚未运行合成资料回放。</p>}
      <button className="button secondary" type="button" disabled={busy || review.proposal === undefined} onClick={onReplay}>
        <RotateCw aria-hidden="true" size={15} />运行合成资料回放
      </button>
    </section>

    <section className="adapter-review-section">
      <div className="adapter-review-section-heading">
        <div><span>第二层</span><h4>AI 辅助审阅</h4></div>
        <strong className={review.aiReview ? "passed" : review.aiReviewUnavailable ? "warning" : "pending"}>
          {review.aiReview ? "已完成" : review.aiReviewUnavailable ? "暂不可用" : "待运行"}
        </strong>
      </div>
      {review.aiReview ? <ul className="adapter-review-findings">
        {review.aiReview.findings.length > 0 ? review.aiReview.findings.map((finding, index) => <li key={`${finding.code}-${index}`} className={finding.severity}>
          <strong>{SEVERITY_LABELS[finding.severity] ?? "提示"}</strong><span>{finding.explanation}</span>
        </li>) : <li className="info">AI 未发现需要补充说明的事项。</li>}
      </ul> : <p className="adapter-review-empty">AI 只提供审阅建议，不能替代人工认证。</p>}
      <button className="button secondary" type="button" disabled={busy || !hardPassed} onClick={onAiReview}>
        <RotateCw aria-hidden="true" size={15} />请求 AI 审阅回放
      </button>
    </section>

    <section className="adapter-review-section">
      <div className="adapter-review-section-heading">
        <div><span>第三层</span><h4>人工最终认证</h4></div>
        <strong className="pending">等待决定</strong>
      </div>
      {review.aiReviewUnavailable && <label className="adapter-review-acknowledgement">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.currentTarget.checked)}
        />
        我已确认 AI 审阅不可用，仍由人工承担最终判断
      </label>}
      <div className="adapter-review-actions">
        <button className="button primary" type="button" disabled={busy || !canCertify} onClick={() => onDecision({
          decision: "certify",
          aiReviewUnavailable: review.aiReviewUnavailable,
          acknowledgedAiUnavailable: acknowledged
        })}>认证此版本</button>
        <button className="button quiet danger" type="button" disabled={busy} onClick={() => onDecision({
          decision: "reject",
          aiReviewUnavailable: review.aiReviewUnavailable,
          acknowledgedAiUnavailable: false
        })}>拒绝</button>
      </div>
    </section>

    {definition && <section className="adapter-review-section adapter-review-mapping">
      <div className="adapter-review-section-heading">
        <div><span>可选操作</span><h4>调整结构化映射</h4></div>
        <strong className="pending">生成新版本</strong>
      </div>
      <p className="adapter-review-help">修改只会创建不可变的新候选版本，必须重新通过回放和人工认证。</p>
      {definition.fieldRules.length > 0 ? <div className="adapter-review-mappings">
        {definition.fieldRules.map((rule, index) => <label key={rule.ruleId}>
          <span>字段映射 {index + 1}</span>
          <input
            aria-label={`${rule.ruleId} 档案路径`}
            value={rule.profilePath}
            onChange={(event) => setDefinition({
              ...definition,
              fieldRules: definition.fieldRules.map((item, itemIndex) => itemIndex === index
                ? { ...item, profilePath: event.currentTarget.value }
                : item)
            })}
          />
        </label>)}
      </div> : <p className="adapter-review-empty">当前候选版本没有字段映射。</p>}
      {parsedDefinition && !parsedDefinition.success && <p className="inline-error" role="alert">档案路径格式不合法，无法创建新版本。</p>}
      <button className="button secondary" type="button" disabled={busy || parsedDefinition?.success !== true} onClick={() => {
        if (parsedDefinition?.success) onRevise(parsedDefinition.data);
      }}>保存为新版本并重新回放</button>
    </section>}
  </section>;
}

