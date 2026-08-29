import type { ConversationCard, ConversationConfirmation } from "@resume/contracts";
import { ArrowUpRight, BriefcaseBusiness, Check, ExternalLink, FileCheck2, ListChecks, Search, ShieldCheck, Target, X } from "lucide-react";
import { useState } from "react";

interface ConversationCardsProps {
  cards: ConversationCard[];
  pendingConfirmation?: ConversationConfirmation;
  onOpenJobMatch(sessionId: string): void;
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

export function ConversationCards({ cards, pendingConfirmation, onOpenJobMatch, onOpenApplication, onStartApplication, onConfirm }: ConversationCardsProps) {
  return <div className="conversation-cards">{cards.map((card, index) => {
    if (card.type === "recommendation") return <RecommendationCard key={`${card.resultId}-${index}`} card={card} onOpenJobMatch={onOpenJobMatch} onStartApplication={onStartApplication} />;
    if (card.type === "application_task") return <TaskCard key={`${card.taskId}-${index}`} card={card} onOpenApplication={onOpenApplication} />;
    if (card.type === "recruitment_site") return <RecruitmentSiteCard key={`${card.url}-${index}`} card={card} />;
    if (card.type === "job_match_session") return <JobMatchSessionCard key={`${card.sessionId}-${index}`} card={card} onOpenJobMatch={onOpenJobMatch} />;
    const confirmationId = pendingConfirmation?.action === card.action
      ? pendingConfirmation.confirmationId
      : undefined;
    return <ConfirmationCard key={`confirmation-${index}`} card={card} {...(confirmationId === undefined ? {} : { confirmationId })} {...(onConfirm === undefined ? {} : { onConfirm })} />;
  })}</div>;
}

function RecommendationCard({ card, onOpenJobMatch, onStartApplication }: { card: Extract<ConversationCard, { type: "recommendation" }>; onOpenJobMatch(sessionId: string): void; onStartApplication?: ConversationCardsProps["onStartApplication"] }) {
  return <article className="conversation-card recommendation-card"><div className="conversation-card-heading"><div><strong>{card.title}</strong><span>{card.company}</span></div><b>{card.score} 分</b></div><div className="conversation-evidence"><span>匹配依据 {card.evidenceCount} 项</span><span>已校验岗位</span></div><div className="conversation-card-actions"><button type="button" className="conversation-button" onClick={() => onOpenJobMatch(card.sessionId)}><Target aria-hidden="true" size={14} />查看匹配依据</button><button type="button" className="conversation-button primary" onClick={() => onStartApplication?.(card)}><BriefcaseBusiness aria-hidden="true" size={14} />开始投递</button></div></article>;
}

function TaskCard({ card, onOpenApplication }: { card: Extract<ConversationCard, { type: "application_task" }>; onOpenApplication(taskId: string): void }) {
  return <article className="conversation-card"><div className="conversation-card-heading"><div><strong>{card.title}</strong><span>{card.applicationUrl}</span></div><b className="task-state">{card.state}</b></div><div className="conversation-card-actions"><button type="button" className="conversation-button primary" onClick={() => onOpenApplication(card.taskId)}><FileCheck2 aria-hidden="true" size={14} />打开投递任务<ArrowUpRight aria-hidden="true" size={14} /></button></div></article>;
}

function RecruitmentSiteCard({ card }: { card: Extract<ConversationCard, { type: "recruitment_site" }> }) {
  return <article className="conversation-card recruitment-site-card"><div className="conversation-card-heading"><div><strong>{card.title}</strong><span>{card.company} · {card.domain}</span></div><b>官方入口</b></div><p className="conversation-card-url">{card.url}</p><div className="conversation-card-actions"><a className="conversation-button" href={card.url} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" size={14} />打开官方入口</a></div></article>;
}

function JobMatchSessionCard({ card, onOpenJobMatch }: { card: Extract<ConversationCard, { type: "job_match_session" }>; onOpenJobMatch(sessionId: string): void }) {
  return <article className="conversation-card job-match-session-card"><div className="conversation-card-heading"><div><strong>岗位匹配会话</strong><span>{stateLabel(card.state)}</span></div><b>{card.postingCount} 个岗位待确认</b></div><div className="conversation-evidence"><span>招聘入口已确认</span><span>岗位推荐将在匹配工作台继续</span></div><div className="conversation-card-actions"><button type="button" className="conversation-button primary" onClick={() => onOpenJobMatch(card.sessionId)}><Target aria-hidden="true" size={14} />打开岗位匹配</button></div></article>;
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

function stateLabel(state: string): string {
  return ({
    awaiting_filter_confirmation: "等待确认筛选条件",
    awaiting_login: "等待登录",
    awaiting_challenge: "等待人工验证",
    extracting_jobs: "正在读取岗位",
    matching_jobs: "正在匹配岗位",
    awaiting_job_selection: "等待选择岗位",
    selected: "已选择岗位",
    paused: "已暂停"
  } as Record<string, string>)[state] ?? state;
}
