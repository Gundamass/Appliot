import type { JobMatchResult } from "@resume/contracts";
import { useState } from "react";
import type { JobMatchSession } from "./api.js";

interface Props {
  session: JobMatchSession;
  onPause?(): void;
  onContinue(): void;
  onSelect(result: JobMatchResult): void;
  onSelectConflict(result: JobMatchResult): void;
  onRematch(): void;
  onConfirmFilters?(): void;
}

export function JobMatchWorkbench({ session, onPause, onContinue, onSelect, onSelectConflict, onRematch, onConfirmFilters }: Props) {
  const results = session.results ?? [];
  const postings = session.postings ?? [];
  const criteria = session.expectation?.criteria ?? [];
  const postingTitles = new Map(postings.map((posting) => [posting.id, posting.title]));
  const [pendingConflict, setPendingConflict] = useState<JobMatchResult>();
  const selected = results.find((result) => result.id === session.selectedResultId);
  const recommendations = results.filter((result) => !result.outcomes.some((outcome) => outcome.outcome === "conflict"));
  const conflicts = results.filter((result) => result.outcomes.some((outcome) => outcome.outcome === "conflict"));
  const active = selected ?? recommendations[0] ?? conflicts[0];
  const hasStaleResults = results.some((result) => result.stale);
  const needsContinue = !hasStaleResults && (session.state === "paused" || session.state === "awaiting_login" || session.state === "awaiting_challenge");
  return <main className="job-match-workbench">
    <header className="job-match-header"><div><span>岗位匹配工作台</span><h1>岗位匹配</h1></div><span className="job-match-state">{stateLabel(session.state)}</span></header>
    <section className="job-match-top" aria-labelledby="job-match-filters">
      <div><h2 id="job-match-filters">已确认筛选条件</h2><FilterPlanView session={session} />{session.state === "awaiting_filter_confirmation" && onConfirmFilters ? <button className="button primary" type="button" onClick={() => onConfirmFilters()}>确认筛选并读取岗位</button> : null}</div>
      <dl className="job-match-budget"><div><dt>来源</dt><dd>{session.source ?? "待识别"} · {session.adapterVersion ?? "本地判断"}</dd></div><div><dt>读取进度</dt><dd>{session.cursor?.pagesRead ?? 0} 页 / {session.cursor?.newJobs ?? postings.length} 个新岗位</dd></div></dl>
    </section>
    <section className="job-match-columns">
      <div className="job-match-lists">
        <JobList title="推荐岗位" results={recommendations} activeId={active?.id} postingTitles={postingTitles} onSelect={onSelect} empty="暂无满足条件的岗位" />
        <JobList title="最接近但有冲突" results={conflicts} activeId={active?.id} postingTitles={postingTitles} onSelect={setPendingConflict} empty="暂无明确冲突岗位" conflict />
      </div>
      <section className="job-match-detail" aria-label="岗位详情">
        {active ? <ResultDetail result={active} /> : <p className="job-match-empty">读取完成后将在这里显示岗位详情。</p>}
      </section>
    </section>
    <footer className="job-match-actions">
      {session.state === "selected" ? <p>已选择，尚未创建投递任务</p> : null}
      {pendingConflict && !hasStaleResults ? <div className="job-match-conflict-confirm"><p>该岗位存在明确冲突，请确认仍要选择。</p><button className="button secondary" type="button" onClick={() => setPendingConflict(undefined)}>取消</button><button className="button danger" type="button" onClick={() => { onSelectConflict(pendingConflict); setPendingConflict(undefined); }}>确认选择冲突岗位</button></div> : null}
      {hasStaleResults ? <button className="button secondary" type="button" onClick={onRematch}>重新匹配</button> : null}
      {!hasStaleResults && session.state === "extracting_jobs" && onPause ? <button className="button secondary" type="button" onClick={onPause}>暂停读取</button> : null}
      {needsContinue ? <button className="button primary" type="button" onClick={onContinue}>继续读取</button> : null}
    </footer>
  </main>;
}

function FilterPlanView({ session }: { session: JobMatchSession }) {
  const criteria = session.expectation?.criteria ?? [];
  if (session.filterPlan === undefined) {
    return <div className="job-match-filters">
      {criteria.map((criterion, index) => <div key={`${criterion.kind}:${index}`}><span>{criterionLabel(criterion.kind)}</span><p>{criterion.values.join("、")}</p></div>)}
      <p>网站映射暂不可用</p>
    </div>;
  }
  return <div className="job-match-filters">
    {session.filterPlan.mapped.map((mapped) => {
      const criterion = criteria[mapped.criterionIndex];
      return <div key={`mapped:${mapped.criterionIndex}:${mapped.key}`}>
        <span>{criterionLabel(criterion?.kind ?? mapped.key)} · {mapped.key}</span>
        <p>网站筛选：{mapped.values.join("、")}</p>
      </div>;
    })}
    {session.filterPlan.localOnly.map((local) => {
      const criterion = criteria[local.criterionIndex];
      return <div key={`local:${local.criterionIndex}:${local.reasonCode}`}>
        <span>{criterionLabel(criterion?.kind ?? local.reasonCode)}</span>
        <p>仅本地判断：{criterion?.values.join("、") ?? "-"}</p>
      </div>;
    })}
  </div>;
}

function JobList({ title, results, activeId, postingTitles, onSelect, empty, conflict }: { title: string; results: JobMatchResult[]; activeId: string | undefined; postingTitles: ReadonlyMap<string, string>; onSelect(result: JobMatchResult): void; empty: string; conflict?: boolean }) {
  return <section className="job-match-list"><header><h2>{title}</h2><span>{results.length}</span></header>{results.length === 0 ? <p>{empty}</p> : <ul>{results.map((result) => <li key={result.id}><button type="button" aria-pressed={result.id === activeId} disabled={result.stale} onClick={() => onSelect(result)}><strong>{postingTitles.get(result.postingId) ?? result.id}</strong><span>{Math.round(result.rankingScore)} 分 · {result.stale ? "结果已过期" : conflict ? "有冲突" : "可考虑"}</span></button></li>)}</ul>}</section>;
}

function ResultDetail({ result }: { result: JobMatchResult }) {
  return <article><header><span>匹配详情</span><h2>评分 {Math.round(result.fitScore)} / 100</h2><p>置信度 {Math.round(result.confidence)} / 100</p></header><div className="job-match-outcomes"><span className="satisfied"><strong>满足</strong> {result.outcomes.filter((item) => item.outcome === "satisfied").length}</span><span className="unknown"><strong>未知</strong> {result.outcomes.filter((item) => item.outcome === "unknown").length}</span><span className="conflict"><strong>冲突</strong> {result.outcomes.filter((item) => item.outcome === "conflict").length}</span></div><section><h3>证据</h3>{result.evidence.length ? <ul>{result.evidence.map((item) => <li key={item.evidenceId}>{item.summary}</li>)}</ul> : <p>暂无直接证据</p>}</section><section><h3>差距</h3>{result.gaps.length ? <ul>{result.gaps.map((gap) => <li key={gap.requirementId}>{gap.summary}</li>)}</ul> : <p>暂无差距</p>}</section></article>;
}

function stateLabel(state: JobMatchSession["state"]): string { return ({ awaiting_filter_confirmation: "等待确认", awaiting_login: "等待登录", awaiting_challenge: "等待人工处理", extracting_jobs: "正在读取", matching_jobs: "正在匹配", awaiting_job_selection: "等待选岗", selected: "已选岗位", paused: "已暂停" } as Record<string, string>)[state] ?? state; }

function criterionLabel(kind: string): string { return ({ target_role: "目标岗位", location: "地点", employment_type: "用工类型", industry: "行业", work_mode: "办公方式", salary: "薪资" } as Record<string, string>)[kind] ?? kind; }
