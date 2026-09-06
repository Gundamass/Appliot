import type { ConversationJobMatchAction, JobMatchResult } from "@resume/contracts";
import { BriefcaseBusiness, Check, ChevronDown, ChevronUp, ExternalLink, ShieldAlert } from "lucide-react";
import { JOB_RECOMMENDATION_LIMIT } from "@resume/contracts";
import { useEffect, useMemo, useState } from "react";
import type { JobMatchSession } from "../job-matching/api.js";
import { createJobMatchActionKey } from "./job-match-action-key.js";

export interface ConversationJobCardsProps {
  conversationId?: string;
  session: JobMatchSession;
  onAction(action: ConversationJobMatchAction): void | Promise<void>;
}

export function ConversationJobCards({ conversationId, session, onAction }: ConversationJobCardsProps) {
  const ownerConversationId = conversationId ?? session.id;
  const [expandedResultId, setExpandedResultId] = useState<string>();
  const [pendingConflictId, setPendingConflictId] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const results = useMemo(() => visibleJobResults(session), [session.postings, session.results]);
  const postings = useMemo(() => new Map(session.postings.map((posting) => [posting.id, posting])), [session.postings]);
  const hasStaleResults = session.results.some((result) => result.stale);

  useEffect(() => {
    if (pendingConflictId !== undefined && !session.results.some((result) => result.id === pendingConflictId && !result.stale)) {
      setPendingConflictId(undefined);
    }
  }, [pendingConflictId, session.results]);

  if (results.length === 0) {
    return <p className="conversation-job-match-empty">当前还没有可展示的岗位结果，完成读取后会显示在这里。</p>;
  }

  return (
    <section className="conversation-job-card-section" aria-label="岗位推荐结果">
      {hasStaleResults ? (
        <div className="conversation-job-match-notice stale" role="status">
          <span>结果已变化</span>
          <small>招聘页面或匹配资料已经更新，旧结果暂不能选择。</small>
          <button type="button" className="conversation-button" onClick={() => dispatch(onAction, rematchAction(ownerConversationId, session))}>重新匹配</button>
        </div>
      ) : null}
      <div className="conversation-job-card-grid">
        {results.map((result) => {
          const posting = postings.get(result.postingId);
          if (posting === undefined) return null;
          return (
            <JobCard
              key={result.id}
              result={result}
              posting={posting}
              selected={session.selectedResultId === result.id}
              expanded={expandedResultId === result.id}
              pendingConflict={pendingConflictId === result.id}
              canSelect={session.state === "awaiting_job_selection" && !result.stale}
              onToggleDetails={() => setExpandedResultId((current) => current === result.id ? undefined : result.id)}
              onSelect={() => {
                setActionError(undefined);
                if (hasConflict(result)) {
                  setPendingConflictId(result.id);
                  return;
                }
                dispatch(onAction, selectionAction(ownerConversationId, session, result));
              }}
              onCancelConflict={() => setPendingConflictId(undefined)}
              onConfirmConflict={() => {
                setActionError(undefined);
                void confirmConflict(onAction, ownerConversationId, session, result)
                  .then(() => setPendingConflictId(undefined))
                  .catch(() => {
                    setActionError("冲突确认摘要生成失败，请刷新后重试。");
                  });
              }}
              {...(actionError === undefined ? {} : { actionError })}
            />
          );
        })}
      </div>
    </section>
  );
}

interface JobCardProps {
  result: JobMatchResult;
  posting: JobMatchSession["postings"][number];
  selected: boolean;
  expanded: boolean;
  pendingConflict: boolean;
  canSelect: boolean;
  onToggleDetails(): void;
  onSelect(): void;
  onCancelConflict(): void;
  onConfirmConflict(): void;
  actionError?: string;
}

function JobCard({
  result,
  posting,
  selected,
  expanded,
  pendingConflict,
  canSelect,
  onToggleDetails,
  onSelect,
  onCancelConflict,
  onConfirmConflict,
  actionError
}: JobCardProps) {
  const conflicts = countOutcomes(result, "conflict");
  const stale = result.stale;
  return (
    <article className={`conversation-job-card${conflicts > 0 ? " conflict" : ""}${stale ? " stale" : ""}${selected ? " selected" : ""}`} aria-label={`岗位：${posting.title}`}>
      <header className="conversation-job-card-heading">
        <strong>{posting.title}</strong>
        <div className="conversation-job-card-score">
          <b>匹配度 {Math.round(result.fitScore)}%</b>
        </div>
      </header>
      {stale ? <p className="conversation-job-card-stale">结果已变化，暂不能选择</p> : null}
      {selected ? <p className="conversation-job-card-selected"><Check aria-hidden="true" size={14} />已选择，等待受控投递确认</p> : null}
      {pendingConflict && !stale ? (
        <div className="conversation-job-card-conflict-confirm" role="alert">
          <p>存在明确冲突，请确认仍要选择</p>
          <button type="button" className="conversation-button" onClick={onCancelConflict}>取消</button>
          <button type="button" className="conversation-button danger" onClick={onConfirmConflict}>确认选择冲突岗位</button>
        </div>
      ) : null}
      {actionError && pendingConflict ? <p className="conversation-job-card-error" role="alert">{actionError}</p> : null}
      {expanded ? <JobCardDetails result={result} posting={posting} /> : null}
      <footer className="conversation-job-card-actions">
        <button type="button" className="conversation-button" aria-expanded={expanded} onClick={onToggleDetails}>
          {expanded ? <ChevronUp aria-hidden="true" size={14} /> : <ChevronDown aria-hidden="true" size={14} />}查看详情
        </button>
        <button type="button" className="conversation-button primary" disabled={!canSelect || selected} onClick={onSelect}>
          {conflicts > 0 ? <ShieldAlert aria-hidden="true" size={14} /> : <BriefcaseBusiness aria-hidden="true" size={14} />}
          {selected ? "已选择" : "选择此岗位"}
        </button>
        <a className="conversation-button" href={posting.canonicalUrl} target="_blank" rel="noreferrer">
          <ExternalLink aria-hidden="true" size={14} />岗位页面
        </a>
      </footer>
    </article>
  );
}

function JobCardDetails({ result, posting }: { result: JobMatchResult; posting: JobCardProps["posting"] }) {
  const advantages = requirementExplanations(result, posting, "satisfied");
  const unknowns = requirementExplanations(result, posting, "unknown");
  const conflicts = requirementExplanations(result, posting, "conflict");
  return (
    <div className="conversation-job-card-details">
      <ExplanationSection title="匹配优势" items={advantages} empty="暂无明确匹配优势" />
      <ExplanationSection title="待确认条件" items={unknowns} empty="暂无待确认条件" />
      <ExplanationSection title="差距与风险" items={conflicts} empty="暂无明确差距" />
      <section className="conversation-job-card-score-details">
        <h4>匹配度如何得出</h4>
        {result.scoreBreakdown === undefined ? (
          <p>此结果使用旧版评分，重新匹配后可查看分项说明</p>
        ) : (
          <ul>
            {result.scoreBreakdown.dimensions.map((dimension) => (
              <li key={dimension.dimension}>{dimension.label} {formatScore(dimension.earned)}/{formatScore(dimension.available)}</li>
            ))}
            <li className="total">总分 {formatScore(result.scoreBreakdown.total)}/100</li>
          </ul>
        )}
      </section>
    </div>
  );
}

function ExplanationSection({ title, items, empty }: { title: string; items: readonly string[]; empty: string }) {
  return (
    <section>
      <h4>{title}</h4>
      {items.length > 0 ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul> : <p>{empty}</p>}
    </section>
  );
}

function requirementExplanations(
  result: JobMatchResult,
  posting: JobCardProps["posting"],
  outcome: "satisfied" | "unknown" | "conflict"
): string[] {
  const outcomeByRequirement = new Map(result.outcomes.map((item) => [item.requirementId, item.outcome]));
  return posting.requirements.flatMap((requirement) => {
    if (outcomeByRequirement.get(requirement.id) !== outcome) return [];
    if (outcome !== "satisfied" || result.scoreBreakdown === undefined) return [requirement.sourceEvidence];
    const summaries = result.evidence
      .filter((item) => item.requirementId === requirement.id && isUserFacingExplanation(item.summary))
      .map((item) => item.summary);
    return [requirement.sourceEvidence, ...summaries.filter((summary) => summary !== requirement.sourceEvidence)];
  });
}

function isUserFacingExplanation(summary: string): boolean {
  return !(/Profile\s+fact|[a-z_][a-z0-9_]*\[\d+\](?:\.[a-z_][a-z0-9_]*)?|\b(?:requirement|evidence|fact)(?:Id)?[-_:]\s*[a-z0-9]|\b[a-z]+(?:_[a-z0-9]+)+\b/iu.test(summary));
}

function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}

export function visibleJobResults(session: JobMatchSession): JobMatchResult[] {
  const postings = new Map(session.postings.map((posting) => [posting.id, posting]));
  return [...session.results]
    .filter((result) => postings.has(result.postingId))
    .sort((left, right) => right.fitScore - left.fitScore
      || right.confidence - left.confidence
      || postings.get(left.postingId)!.canonicalUrl.localeCompare(postings.get(right.postingId)!.canonicalUrl))
    .slice(0, JOB_RECOMMENDATION_LIMIT);
}

function hasConflict(result: JobMatchResult): boolean {
  return result.outcomes.some((outcome) => outcome.outcome === "conflict");
}

function countOutcomes(result: JobMatchResult, outcome: "satisfied" | "unknown" | "conflict"): number {
  return result.outcomes.filter((item) => item.outcome === outcome).length;
}

function selectionAction(conversationId: string, session: JobMatchSession, result: JobMatchResult): ConversationJobMatchAction {
  return {
    conversationId,
    sessionId: session.id,
    action: "select_result",
    sessionVersion: session.version,
    idempotencyKey: createJobMatchActionKey(session.id, "select_result", session.version, result.id),
    resultId: result.id,
    resultVersion: result.version,
    postingContentHash: result.postingContentHash
  };
}

function rematchAction(conversationId: string, session: JobMatchSession): ConversationJobMatchAction {
  return {
    conversationId,
    sessionId: session.id,
    action: "rematch",
    sessionVersion: session.version,
    idempotencyKey: createJobMatchActionKey(session.id, "rematch", session.version)
  };
}

async function confirmConflict(onAction: ConversationJobCardsProps["onAction"], conversationId: string, session: JobMatchSession, result: JobMatchResult): Promise<void> {
  const conflictSummaryHash = await createConflictSummaryHash(result);
  await onAction({
    conversationId,
    sessionId: session.id,
    action: "select_conflict_result",
    sessionVersion: session.version,
    idempotencyKey: createJobMatchActionKey(session.id, "select_conflict_result", session.version, result.id),
    resultId: result.id,
    resultVersion: result.version,
    postingContentHash: result.postingContentHash,
    conflictSummaryHash
  });
}

export async function createConflictSummaryHash(result: JobMatchResult): Promise<string> {
  const conflicts = result.outcomes
    .filter((outcome) => outcome.outcome === "conflict")
    .map(({ requirementId, outcome, reasonCode }) => ({ requirementId, outcome, reasonCode }))
    .sort((left, right) => left.requirementId === right.requirementId ? 0 : left.requirementId < right.requirementId ? -1 : 1);
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error("crypto_subtle_unavailable");
  const payload = JSON.stringify({
    resultId: result.id,
    resultVersion: result.version,
    postingContentHash: result.postingContentHash,
    conflicts
  });
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return `sha256:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function dispatch(onAction: ConversationJobCardsProps["onAction"], action: ConversationJobMatchAction): void {
  void onAction(action);
}
