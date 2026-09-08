import { JOB_RECOMMENDATION_LIMIT, type ConversationCard, type ConversationConfirmation, type ConversationJobMatchAction } from "@resume/contracts";
import { ArrowUpRight, BriefcaseBusiness, Check, ExternalLink, FileCheck2, ListChecks, Search, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { ConversationJobMatchFlow } from "./ConversationJobMatchFlow.js";
import type { ConversationProcessGroup } from "./conversation-process-model.js";
import type { JobMatchApi } from "../job-matching/api.js";
import { useJobMatchSession } from "../job-matching/useJobMatchSession.js";

interface ConversationCardsProps {
  cards: ConversationCard[];
  conversationId?: string;
  process?: ConversationProcessGroup;
  jobMatchApi?: JobMatchApi;
  onJobMatchAction?(action: ConversationJobMatchAction): void | Promise<void>;
  pendingConfirmation?: ConversationConfirmation;
  onOpenApplication(taskId: string): void;
  onStartApplication?(card: Extract<ConversationCard, { type: "recommendation" }>): void;
  onConfirm?(confirmationId: string, approved: boolean, selectedUrl?: string): void;
  onQuickRecommendation?(company: string): void;
  onQuickProgress?(): void;
}

export function QuickStartCards({ onQuickRecommendation, onQuickProgress }: Pick<ConversationCardsProps, "onQuickRecommendation" | "onQuickProgress">) {
  const [recommendationOpen, setRecommendationOpen] = useState(false);
  const [company, setCompany] = useState("");
  return (
    <section className="conversation-quickstart" aria-label="快速开始">
      <div className="conversation-quickstart-heading"><strong>快速开始</strong><span>选择一个入口即可开始</span></div>
      <div className="conversation-quickactions">
        {recommendationOpen ? (
          <div className="conversation-quickform">
            <label htmlFor="quick-company">想投递哪家公司？</label>
            <div className="conversation-quickform-row">
              <input id="quick-company" value={company} onChange={(event) => setCompany(event.target.value)} placeholder="例如：大疆" />
              <button type="button" className="conversation-button primary" disabled={!company.trim()} onClick={() => onQuickRecommendation?.(company.trim())}><Search aria-hidden="true" size={15} />搜索岗位</button>
            </div>
          </div>
        ) : (
          <button type="button" className="conversation-quickaction" onClick={() => setRecommendationOpen(true)}><Search aria-hidden="true" size={17} /><span><strong>岗位推荐</strong><small>输入想投递的公司，例如“大疆”</small></span></button>
        )}
        <button type="button" className="conversation-quickaction" onClick={() => onQuickProgress?.()}><ListChecks aria-hidden="true" size={17} /><span><strong>投递进度</strong><small>查看我投了哪些岗位和对应网站</small></span></button>
      </div>
    </section>
  );
}

export function ConversationCards({ cards, conversationId, process, jobMatchApi, onJobMatchAction, pendingConfirmation, onOpenApplication, onStartApplication, onConfirm }: ConversationCardsProps) {
  let recommendationCount = 0;
  return <div className="conversation-cards">{cards.map((card, index) => {
    if (card.type === "recommendation") {
      if (recommendationCount >= JOB_RECOMMENDATION_LIMIT) return null;
      recommendationCount += 1;
      return <RecommendationCard key={`${card.resultId}-${index}`} card={card} onStartApplication={onStartApplication} />;
    }
    if (card.type === "application_task") return <TaskCard key={`${card.taskId}-${index}`} card={card} onOpenApplication={onOpenApplication} />;
    if (card.type === "recruitment_site") return <RecruitmentSiteCard key={`${card.url}-${index}`} card={card} />;
    if (card.type === "job_match_session") return <JobMatchSessionCard
      key={`${card.sessionId}-${index}`}
      card={card}
      {...(conversationId === undefined ? {} : { conversationId })}
      {...(process === undefined ? {} : { process })}
      {...(jobMatchApi === undefined ? {} : { jobMatchApi })}
      {...(onJobMatchAction === undefined ? {} : { onJobMatchAction })}
    />;
    const confirmationId = card.confirmationId === pendingConfirmation?.confirmationId
      ? card.confirmationId
      : undefined;
    return <ConfirmationCard key={`confirmation-${index}`} card={card} {...(confirmationId === undefined ? {} : { confirmationId })} {...(onConfirm === undefined ? {} : { onConfirm })} />;
  })}</div>;
}

function RecommendationCard({ card, onStartApplication }: { card: Extract<ConversationCard, { type: "recommendation" }>; onStartApplication?: ConversationCardsProps["onStartApplication"] }) {
  return <article className="conversation-card recommendation-card"><div className="conversation-card-heading"><div><strong>{card.title}</strong><span>{card.company}</span></div><b>匹配度 {Math.round(card.score)}%</b></div><div className="conversation-evidence"><span>匹配依据 {card.evidenceCount} 项</span><span>已校验岗位</span></div><div className="conversation-card-actions"><button type="button" className="conversation-button primary" onClick={() => onStartApplication?.(card)}><BriefcaseBusiness aria-hidden="true" size={14} />开始投递</button></div></article>;
}

function TaskCard({ card, onOpenApplication }: { card: Extract<ConversationCard, { type: "application_task" }>; onOpenApplication(taskId: string): void }) {
  return <article className="conversation-card"><div className="conversation-card-heading"><div><strong>{card.title}</strong><span>{card.applicationUrl}</span></div><b className="task-state">{card.state}</b></div><div className="conversation-card-actions"><button type="button" className="conversation-button primary" onClick={() => onOpenApplication(card.taskId)}><FileCheck2 aria-hidden="true" size={14} />打开投递任务<ArrowUpRight aria-hidden="true" size={14} /></button></div></article>;
}

function RecruitmentSiteCard({ card }: { card: Extract<ConversationCard, { type: "recruitment_site" }> }) {
  return <article className="conversation-card recruitment-site-card"><div className="conversation-card-heading"><div><strong>{card.title}</strong><span>{card.company} · {card.domain}</span></div><b>官方入口</b></div><p className="conversation-card-url">{card.url}</p><div className="conversation-card-actions"><a className="conversation-button" href={card.url} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" size={14} />打开官方入口</a></div></article>;
}

function JobMatchSessionCard({ card, conversationId, process, jobMatchApi, onJobMatchAction }: {
  card: Extract<ConversationCard, { type: "job_match_session" }>;
  conversationId?: string;
  process?: ConversationProcessGroup;
  jobMatchApi?: JobMatchApi;
  onJobMatchAction?: ConversationCardsProps["onJobMatchAction"];
}) {
  if (conversationId === undefined || jobMatchApi === undefined || onJobMatchAction === undefined) {
    return <p className="conversation-job-match-error" role="alert">岗位匹配会话需要从所属对话恢复。</p>;
  }
  return <InlineJobMatchSession
    sessionId={card.sessionId}
    conversationId={conversationId}
    {...(process === undefined ? {} : { process })}
    jobMatchApi={jobMatchApi}
    onJobMatchAction={onJobMatchAction}
  />;
}

function InlineJobMatchSession({ sessionId, conversationId, process, jobMatchApi, onJobMatchAction }: {
  sessionId: string;
  conversationId: string;
  process?: ConversationProcessGroup;
  jobMatchApi: JobMatchApi;
  onJobMatchAction: NonNullable<ConversationCardsProps["onJobMatchAction"]>;
}) {
  const loaded = useJobMatchSession(sessionId, jobMatchApi);
  const [actionError, setActionError] = useState<string>();

  const executeAction = async (action: ConversationJobMatchAction) => {
    setActionError(undefined);
    try {
      await onJobMatchAction(action);
      await loaded.refresh();
    } catch {
      setActionError("岗位匹配操作暂时失败，请刷新后重试。");
    }
  };

  if (loaded.status === "loading") return <p className="conversation-job-match-status" role="status">正在读取岗位匹配会话…</p>;
  if (loaded.error !== undefined || loaded.session === undefined) return <p className="conversation-job-match-error" role="alert">岗位匹配会话暂时无法读取，请刷新后重试。</p>;
  return <>
    <ConversationJobMatchFlow
      conversationId={conversationId}
      session={loaded.session}
      {...(process === undefined ? {} : { process })}
      onAction={executeAction}
    />
    {actionError === undefined ? null : <p className="conversation-job-match-error" role="alert">{actionError}</p>}
  </>;
}

function ConfirmationCard({ card, confirmationId, onConfirm }: { card: Extract<ConversationCard, { type: "confirmation" }>; confirmationId?: string; onConfirm?: ConversationCardsProps["onConfirm"] }) {
  const copy = confirmationCopy(card);
  const candidates = card.target.kind === "recruitment_site_choices" ? card.target.candidates : [];
  const [selectedUrl, setSelectedUrl] = useState(candidates[0]?.url);
  return <article className="conversation-card confirmation-card"><div className="confirmation-label"><ShieldCheck aria-hidden="true" size={15} />需要你的确认</div><strong>{copy.title}</strong><p>{copy.target}</p>{candidates.length > 0 ? <div className="conversation-recruitment-choices" role="radiogroup" aria-label="招聘入口候选">{candidates.map((candidate) => <label key={candidate.url} className="conversation-recruitment-choice"><input type="radio" name={confirmationId ?? "recruitment-site"} value={candidate.url} checked={selectedUrl === candidate.url} onChange={() => setSelectedUrl(candidate.url)} /><span><strong>{candidate.title}</strong><small>{candidate.domain} · {candidate.snippet}</small></span></label>)}</div> : null}<div className="conversation-card-actions"><button type="button" className="conversation-button primary" disabled={!confirmationId || (candidates.length > 0 && selectedUrl === undefined)} onClick={() => confirmationId && onConfirm?.(confirmationId, true, selectedUrl)}><Check aria-hidden="true" size={14} />{copy.approve}</button><button type="button" className="conversation-button" disabled={!confirmationId} onClick={() => confirmationId && onConfirm?.(confirmationId, false)}><X aria-hidden="true" size={14} />{copy.decline}</button></div></article>;
}

function confirmationCopy(card: Extract<ConversationCard, { type: "confirmation" }>): {
  title: string;
  target: string;
  approve: string;
  decline: string;
} {
  if (card.action === "start_application") {
    if (card.target.kind === "application_url") {
      return {
        title: "准备开始识别并填写",
        target: card.target.url,
        approve: "确认开始填写",
        decline: "暂不填写"
      };
    }
    return {
      title: "准备创建受控投递任务",
      target: `目标岗位：${card.target.kind === "recommendation" ? card.target.resultId : "当前岗位"}`,
      approve: "确认进入投递",
      decline: "暂不投递"
    };
  }
  const target = card.target.kind === "recruitment_site" || card.target.kind === "recruitment_site_choices" ? card.target : undefined;
  if (card.action === "confirm_recruitment_site") {
    return {
      title: "请选择要使用的招聘入口",
      target: "搜索候选，需你确认",
      approve: "确认使用此入口",
      decline: "暂不使用"
    };
  }
  return {
    title: "是否开始岗位推荐？",
    target: `招聘入口：${target?.company ?? "当前公司"}`,
    approve: "开始岗位推荐",
    decline: "暂不推荐"
  };
}

