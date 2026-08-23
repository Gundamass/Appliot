import type { ConversationCard, ConversationConfirmation } from "@resume/contracts";
import { ArrowUpRight, BriefcaseBusiness, Check, FileCheck2, ListChecks, Search, ShieldCheck, Target, X } from "lucide-react";
import { useState } from "react";

interface ConversationCardsProps {
  cards: ConversationCard[];
  pendingConfirmation?: ConversationConfirmation;
  onOpenJobMatch(sessionId: string): void;
  onOpenApplication(taskId: string): void;
  onStartApplication?(card: Extract<ConversationCard, { type: "recommendation" }>): void;
  onConfirm?(confirmationId: string, approved: boolean): void;
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
    const confirmationId = pendingConfirmation?.confirmationId;
    return <ConfirmationCard key={`confirmation-${index}`} card={card} {...(confirmationId === undefined ? {} : { confirmationId })} {...(onConfirm === undefined ? {} : { onConfirm })} />;
  })}</div>;
}

function RecommendationCard({ card, onOpenJobMatch, onStartApplication }: { card: Extract<ConversationCard, { type: "recommendation" }>; onOpenJobMatch(sessionId: string): void; onStartApplication?: ConversationCardsProps["onStartApplication"] }) {
  return <article className="conversation-card recommendation-card"><div className="conversation-card-heading"><div><strong>{card.title}</strong><span>{card.company}</span></div><b>{card.score} 分</b></div><div className="conversation-evidence"><span>匹配依据 {card.evidenceCount} 项</span><span>已校验岗位</span></div><div className="conversation-card-actions"><button type="button" className="conversation-button" onClick={() => onOpenJobMatch(card.sessionId)}><Target aria-hidden="true" size={14} />查看匹配依据</button><button type="button" className="conversation-button primary" onClick={() => onStartApplication?.(card)}><BriefcaseBusiness aria-hidden="true" size={14} />开始投递</button></div></article>;
}

function TaskCard({ card, onOpenApplication }: { card: Extract<ConversationCard, { type: "application_task" }>; onOpenApplication(taskId: string): void }) {
  return <article className="conversation-card"><div className="conversation-card-heading"><div><strong>{card.title}</strong><span>{card.applicationUrl}</span></div><b className="task-state">{card.state}</b></div><div className="conversation-card-actions"><button type="button" className="conversation-button primary" onClick={() => onOpenApplication(card.taskId)}><FileCheck2 aria-hidden="true" size={14} />打开投递任务<ArrowUpRight aria-hidden="true" size={14} /></button></div></article>;
}

function ConfirmationCard({ card, confirmationId, onConfirm }: { card: Extract<ConversationCard, { type: "confirmation" }>; confirmationId?: string; onConfirm?: ConversationCardsProps["onConfirm"] }) {
  return <article className="conversation-card confirmation-card"><div className="confirmation-label"><ShieldCheck aria-hidden="true" size={15} />需要你的确认</div><strong>准备创建受控投递任务</strong><p>目标岗位：{card.target.resultId}</p><div className="conversation-card-actions"><button type="button" className="conversation-button primary" disabled={!confirmationId} onClick={() => confirmationId && onConfirm?.(confirmationId, true)}><Check aria-hidden="true" size={14} />确认进入投递</button><button type="button" className="conversation-button" disabled={!confirmationId} onClick={() => confirmationId && onConfirm?.(confirmationId, false)}><X aria-hidden="true" size={14} />暂不投递</button></div></article>;
}
