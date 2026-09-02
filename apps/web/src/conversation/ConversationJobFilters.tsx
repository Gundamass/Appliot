import type { ConversationJobMatchAction } from "@resume/contracts";
import type { JobMatchSession } from "../job-matching/api.js";

export interface ConversationJobFiltersProps {
  conversationId?: string;
  session: JobMatchSession;
  onAction(action: ConversationJobMatchAction): void | Promise<void>;
  onAdjustFilters?(): void;
}

export function ConversationJobFilters({ conversationId, session, onAction, onAdjustFilters }: ConversationJobFiltersProps) {
  const ownerConversationId = conversationId ?? session.id;
  const expectation = session.expectation;
  const criteria = expectation.criteria;
  const mappedIndexes = new Set<number>();
  const localIndexes = new Set<number>();
  const mapped = session.filterPlan?.mapped ?? [];
  const localOnly = session.filterPlan?.localOnly ?? [];

  mapped.forEach(({ criterionIndex }) => mappedIndexes.add(criterionIndex));
  localOnly.forEach(({ criterionIndex }) => localIndexes.add(criterionIndex));

  return (
    <section className="conversation-job-filter-summary" aria-label="岗位筛选条件">
      <header className="conversation-job-filter-heading">
        <div>
          <span>筛选条件</span>
          <strong>确认后读取招聘页面</strong>
        </div>
        <span className="conversation-job-filter-state">等待确认</span>
      </header>
      <dl className="conversation-job-filter-list">
        {mapped.map((item) => {
          const criterion = criteria[item.criterionIndex];
          return (
            <div key={`mapped:${item.criterionIndex}:${item.key}`}>
              <dt>{criterionLabel(criterion?.kind ?? item.key)}</dt>
              <dd>网站筛选：{item.values.join("、")}</dd>
            </div>
          );
        })}
        {localOnly.map((item) => {
          const criterion = criteria[item.criterionIndex];
          return (
            <div key={`local:${item.criterionIndex}:${item.reasonCode}`}>
              <dt>{criterionLabel(criterion?.kind ?? item.reasonCode)}</dt>
              <dd>仅本地判断：{criterion?.values.join("、") ?? "待确认"}</dd>
            </div>
          );
        })}
        {criteria.map((criterion, index) => {
          if (mappedIndexes.has(index) || localIndexes.has(index)) return null;
          return (
            <div key={`unmapped:${criterion.kind}:${index}`}>
              <dt>{criterionLabel(criterion.kind)}</dt>
              <dd>仅本地判断：{criterion.values.join("、")}</dd>
            </div>
          );
        })}
        {criteria.length === 0 ? (
          <div>
            <dt>筛选条件</dt>
            <dd>尚未形成有效筛选条件</dd>
          </div>
        ) : null}
      </dl>
      <div className="conversation-job-filter-actions">
        <button
          type="button"
          className="conversation-button primary"
          onClick={() => onAction({
            conversationId: ownerConversationId,
            sessionId: session.id,
            action: "confirm_filters",
            sessionVersion: session.version,
            idempotencyKey: actionKey("confirm_filters", session.version),
            expectation
          })}
        >
          确认筛选并读取岗位
        </button>
        <button
          type="button"
          className="conversation-button"
          onClick={() => onAdjustFilters?.() ?? onAction({
            conversationId: ownerConversationId,
            sessionId: session.id,
            action: "adjust_filters",
            sessionVersion: session.version,
            idempotencyKey: actionKey("adjust_filters", session.version),
            expectation
          })}
        >
          调整筛选条件
        </button>
      </div>
    </section>
  );
}

function actionKey(action: string, version: number): string {
  return `inline-job-match:${action}:${version}`;
}

function criterionLabel(kind: string): string {
  return ({
    target_role: "目标岗位",
    location: "地点",
    employment_type: "用工类型",
    industry: "行业",
    work_mode: "办公方式",
    salary: "薪资"
  } as Record<string, string>)[kind] ?? kind;
}
