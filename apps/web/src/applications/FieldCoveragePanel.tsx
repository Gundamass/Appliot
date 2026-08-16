import type { ApplicationFieldAssessment, ApplicationFieldCoverage } from "@resume/contracts";
import { CheckCircle2, ChevronDown, ListChecks } from "lucide-react";
import { EvidenceList } from "./EvidenceList.js";

interface FieldCoveragePanelProps {
  coverage: ApplicationFieldCoverage;
}

const STATUS_LABELS: Record<ApplicationFieldAssessment["status"], string> = {
  ready: "可填写",
  review: "已填写，待确认",
  missing: "自动填写失败",
  failed: "填写失败",
  unsupported: "暂不支持",
  filled: "已填写"
};

export function FieldCoveragePanel({ coverage }: FieldCoveragePanelProps) {
  const groups = groupCoverageFields(coverage.fields);

  return <details className="field-coverage" aria-label="查看填写明细">
    <summary className="field-coverage-toggle">
      <ListChecks aria-hidden="true" size={16} />
      <span>查看填写明细</span>
      <small>{coverage.total} 项</small>
      <ChevronDown aria-hidden="true" size={16} />
    </summary>
    <div className="field-coverage-body">
      <header className="field-coverage-header">
        <div className="field-coverage-heading">
          <span className="field-coverage-icon"><ListChecks aria-hidden="true" size={18} /></span>
          <div><h2>字段填写明细</h2><p>招聘字段与候选人档案的匹配、填写和回读结果</p></div>
        </div>
        <div className="coverage-summary" aria-label="字段匹配统计">
          <span className="filled"><CheckCircle2 aria-hidden="true" size={14} />已填写 {coverage.filled}</span>
          <span>可填写 {coverage.ready}</span>
          <span className="review">待确认 {coverage.review}</span>
          <span className="missing">需补充 {coverage.missing}</span>
          {coverage.failed > 0 && <span className="failed">填写失败 {coverage.failed}</span>}
          {coverage.unsupported > 0 && <span>暂不支持 {coverage.unsupported}</span>}
        </div>
      </header>
      {groups.length > 0 ? <div className="field-coverage-groups">
        {groups.map((group, index) => <section className="field-coverage-group" key={group.label} aria-labelledby={`field-coverage-group-${index}`}>
          <h3 id={`field-coverage-group-${index}`}>{group.label}</h3>
          <ul className="field-coverage-list">
            {group.fields.map((item) => <CoverageItem key={item.fieldId} item={item} />)}
          </ul>
        </section>)}
      </div> : <p className="field-coverage-complete"><CheckCircle2 aria-hidden="true" size={16} />当前页面还没有字段记录</p>}
    </div>
  </details>;
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
      <div><dt>{item.status === "missing" || item.status === "failed" ? "处理结果" : "审核提示"}</dt><dd>{displayReason(item)}</dd></div>
    </dl>
    <EvidenceList evidence={item.evidence} />
  </li>;
}

const GROUP_LABELS: Record<string, string> = {
  basics: "基本信息",
  education: "教育经历",
  work: "实习与工作",
  projects: "项目经历",
  awards: "获奖经历",
  languages: "语言能力"
};

function groupCoverageFields(fields: ApplicationFieldAssessment[]): Array<{ label: string; fields: ApplicationFieldAssessment[] }> {
  const groups = new Map<string, ApplicationFieldAssessment[]>();
  for (const field of fields) {
    const root = field.semantic?.match(/^[^.[]+/u)?.[0] ?? "other";
    const label = GROUP_LABELS[root] ?? "其他字段";
    const current = groups.get(label) ?? [];
    current.push(field);
    groups.set(label, current);
  }
  return [...groups].map(([label, groupedFields]) => ({ label, fields: groupedFields }));
}

function displayReason(item: ApplicationFieldAssessment): string {
  if (item.status === "missing" && item.source === "none") {
    return "已跳过：当前栏目没有达到阈值的档案字段";
  }
  return item.reason;
}

function sourceLabel(source: ApplicationFieldAssessment["source"]): string {
  if (source === "dji_catalog") return "大疆字段目录";
  if (source === "exact") return "精确匹配";
  if (source === "semantic") return "语义匹配";
  if (source === "user") return "用户确认";
  return "暂无匹配";
}
