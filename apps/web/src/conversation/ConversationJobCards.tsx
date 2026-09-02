import type { ConversationJobMatchAction, JobMatchResult } from "@resume/contracts";
import { BriefcaseBusiness, Check, ChevronDown, ChevronUp, ExternalLink, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { JobMatchSession } from "../job-matching/api.js";

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
  const results = useMemo(() => {
    const recommendations = session.results.filter((result) => !hasConflict(result));
    const conflicts = session.results.filter(hasConflict);
    return [...recommendations, ...conflicts];
  }, [session.results]);
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
              conversationId={ownerConversationId}
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
  conversationId: string;
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
  const summary = result.evidence[0]?.summary ?? result.gaps[0]?.summary ?? "暂无直接匹配依据";
  const stale = result.stale;
  return (
    <article className={`conversation-job-card${conflicts > 0 ? " conflict" : ""}${stale ? " stale" : ""}${selected ? " selected" : ""}`} aria-label={`岗位：${posting.title}`}>
      <header className="conversation-job-card-heading">
        <div>
          <strong>{posting.title}</strong>
          <span>{posting.organization}</span>
        </div>
        <div className="conversation-job-card-score">
          <b>{Math.round(result.fitScore)} 分</b>
          <small>置信度 {Math.round(result.confidence)}</small>
        </div>
      </header>
      <div className="conversation-job-card-meta">
        <span>{posting.location ?? "地点待确认"}</span>
        <span>{posting.employmentType ?? "用工类型待确认"}</span>
        <span>来源：{sourceLabel(posting.source)}</span>
      </div>
      <div className="conversation-job-card-outcomes" aria-label="匹配统计">
        <span className="satisfied">满足 {countOutcomes(result, "satisfied")}</span>
        <span className="unknown">未知 {countOutcomes(result, "unknown")}</span>
        <span className="conflict">冲突 {conflicts}</span>
      </div>
      <div className="conversation-job-card-highlight">
        <span>{result.evidence.length > 0 ? "匹配依据" : "主要差距"}</span>
        <p>{summary}</p>
      </div>
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
      {expanded ? <JobCardDetails result={result} /> : null}
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

function JobCardDetails({ result }: { result: JobMatchResult }) {
  return (
    <div className="conversation-job-card-details">
      <section>
        <h4>匹配依据</h4>
        {result.evidence.length > 0 ? <ul>{result.evidence.map((item) => <li key={item.evidenceId}>{item.summary}</li>)}</ul> : <p>暂无直接证据</p>}
      </section>
      <section>
        <h4>差距与风险</h4>
        {result.gaps.length > 0 ? <ul>{result.gaps.map((gap) => <li key={gap.requirementId}>{gap.summary}</li>)}</ul> : <p>暂无明确差距</p>}
      </section>
    </div>
  );
}

function hasConflict(result: JobMatchResult): boolean {
  return result.outcomes.some((outcome) => outcome.outcome === "conflict");
}

function countOutcomes(result: JobMatchResult, outcome: "satisfied" | "unknown" | "conflict"): number {
  return result.outcomes.filter((item) => item.outcome === outcome).length;
}

function sourceLabel(source: JobMatchSession["postings"][number]["source"]): string {
  return ({ baidu: "百度招聘", dji: "大疆招聘", moka: "Moka 招聘" } as Record<string, string>)[source] ?? source;
}

function selectionAction(conversationId: string, session: JobMatchSession, result: JobMatchResult): ConversationJobMatchAction {
  return {
    conversationId,
    sessionId: session.id,
    action: "select_result",
    sessionVersion: session.version,
    idempotencyKey: actionKey("select_result", session.version, result.id),
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
    idempotencyKey: actionKey("rematch", session.version)
  };
}

async function confirmConflict(onAction: ConversationJobCardsProps["onAction"], conversationId: string, session: JobMatchSession, result: JobMatchResult): Promise<void> {
  const conflictSummaryHash = await createConflictSummaryHash(result);
  await onAction({
    conversationId,
    sessionId: session.id,
    action: "select_conflict_result",
    sessionVersion: session.version,
    idempotencyKey: actionKey("select_conflict_result", session.version, result.id),
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

function actionKey(action: string, version: number, resultId?: string): string {
  return `inline-job-match:${action}:${version}${resultId === undefined ? "" : `:${resultId}`}`.slice(0, 128);
}

function dispatch(onAction: ConversationJobCardsProps["onAction"], action: ConversationJobMatchAction): void {
  void onAction(action);
}
