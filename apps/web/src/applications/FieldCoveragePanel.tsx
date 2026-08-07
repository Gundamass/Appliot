import type { ApplicationFieldAssessment, ApplicationFieldCoverage } from "@resume/contracts";
import { CheckCircle2, ChevronDown, CircleAlert, ListChecks } from "lucide-react";
import { useState } from "react";
import { EvidenceList } from "./EvidenceList.js";

interface FieldCoveragePanelProps {
  coverage: ApplicationFieldCoverage;
}

const STATUS_LABELS: Record<ApplicationFieldAssessment["status"], string> = {
  ready: "可填写",
  review: "已填写，待确认",
  missing: "自动填写失败",
  unsupported: "暂不支持",
  filled: "已填写"
};

export function FieldCoveragePanel({ coverage }: FieldCoveragePanelProps) {
  const [expanded, setExpanded] = useState(false);
  const attention = coverage.fields.filter((field) =>
    field.status === "review" || field.status === "missing" || field.status === "unsupported"
  );

  return <section className="field-coverage" aria-labelledby="field-coverage-title">
    <header className="field-coverage-header">
      <div className="field-coverage-heading">
        <span className="field-coverage-icon"><ListChecks aria-hidden="true" size={18} /></span>
        <div><h2 id="field-coverage-title">字段匹配</h2><p>仅展示需要你关注的映射结果</p></div>
      </div>
      <div className="coverage-summary" aria-label="字段匹配统计">
        <span className="filled"><CheckCircle2 aria-hidden="true" size={14} />已填写 {coverage.filled}</span>
        <span>可填写 {coverage.ready}</span>
        <span className="review">待确认 {coverage.review}</span>
        <span className="missing">需补充 {coverage.missing}</span>
        {coverage.unsupported > 0 && <span>暂不支持 {coverage.unsupported}</span>}
      </div>
    </header>

    {attention.length > 0 ? <>
      <button
        className="field-coverage-toggle"
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? "收起待处理字段" : "查看待处理字段"}
        onClick={() => setExpanded((value) => !value)}
      >
        <CircleAlert aria-hidden="true" size={16} />
        {expanded ? "收起待处理字段" : "查看待处理字段"}
        <span>{attention.length} 项</span>
        <ChevronDown aria-hidden="true" size={16} />
      </button>
      {expanded && <ul className="field-coverage-list">
        {attention.map((item) => <CoverageItem key={item.fieldId} item={item} />)}
      </ul>}
    </> : <p className="field-coverage-complete"><CheckCircle2 aria-hidden="true" size={16} />当前页面没有待处理字段</p>}
  </section>;
}

function CoverageItem({ item }: { item: ApplicationFieldAssessment }) {
  return <li className={`field-coverage-item ${item.status}`}>
    <header>
      <div><strong>{item.label}</strong><span>{STATUS_LABELS[item.status]}</span></div>
      <small>置信度 {Math.round(item.confidence * 100)}%</small>
    </header>
    <dl className="field-coverage-details">
      <div><dt>系统理解</dt><dd>{item.semantic ?? "尚未识别到对应档案字段"}</dd></div>
      <div><dt>匹配方式</dt><dd>{sourceLabel(item.source)}</dd></div>
      <div><dt>{item.status === "missing" ? "失败原因" : "审核提示"}</dt><dd>{item.reason}</dd></div>
    </dl>
    <EvidenceList evidence={item.evidence} />
  </li>;
}

function sourceLabel(source: ApplicationFieldAssessment["source"]): string {
  if (source === "dji_catalog") return "大疆字段目录";
  if (source === "exact") return "精确匹配";
  if (source === "semantic") return "语义匹配";
  if (source === "user") return "用户确认";
  return "暂无匹配";
}
