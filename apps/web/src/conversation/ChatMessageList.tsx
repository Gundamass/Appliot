import type { ConversationConfirmation, ConversationMessage } from "@resume/contracts";
import { Sparkles } from "lucide-react";
import { ConversationCards } from "./ConversationCards.js";
import { ConversationTurnTrace } from "./ConversationTurnTrace.js";
import type { ConversationTurnProcess } from "./conversation-process-model.js";

interface ChatMessageListProps {
  messages: ConversationMessage[];
  pendingConfirmation?: ConversationConfirmation;
  onOpenJobMatch(sessionId: string): void;
  onOpenApplication(taskId: string): void;
  onStartApplication?(card: Extract<ConversationMessage["cards"][number], { type: "recommendation" }>): void;
  onConfirm?(confirmationId: string, approved: boolean, selectedUrl?: string): void;
  processByTurn?: ReadonlyMap<number, ConversationTurnProcess>;
  latestUserSequence?: number;
}

export function ChatMessageList({ messages, pendingConfirmation, onOpenJobMatch, onOpenApplication, onStartApplication, onConfirm, processByTurn = new Map(), latestUserSequence }: ChatMessageListProps) {
  const latestSequence = latestUserSequence ?? messages.filter(({ role }) => role === "user").at(-1)?.sequence;
  return <section className="conversation-messages" aria-label="对话消息" aria-live="polite">{messages.length === 0 ? <p className="conversation-empty">从下面的快速开始开始吧。</p> : messages.map((message, index) => {
    const article = <MessageArticle key={`${message.id}-${index}`} message={message} {...(pendingConfirmation === undefined ? {} : { pendingConfirmation })} onOpenJobMatch={onOpenJobMatch} onOpenApplication={onOpenApplication} {...(onStartApplication === undefined ? {} : { onStartApplication })} {...(onConfirm === undefined ? {} : { onConfirm })} />;
    if (message.role !== "user") return article;
    const process = processByTurn.get(message.sequence);
    return <section key={`${message.id}-${index}`} className="conversation-turn-group" data-testid={`conversation-turn-${message.sequence}`}>
      {article}
      {process ? <ConversationTurnTrace process={process} isLatestTurn={message.sequence === latestSequence} /> : null}
    </section>;
  })}</section>;
}

function MessageArticle({ message, pendingConfirmation, onOpenJobMatch, onOpenApplication, onStartApplication, onConfirm }: Omit<ChatMessageListProps, "messages" | "processByTurn" | "latestUserSequence"> & { message: ConversationMessage }) {
  return <article className={`conversation-message ${message.role}`}><div className="conversation-message-avatar">{message.role === "assistant" ? <Sparkles aria-hidden="true" size={15} /> : "我"}</div><div className="conversation-bubble"><p>{message.text}</p>{message.cards.length > 0 ? <ConversationCards cards={message.cards} {...(pendingConfirmation === undefined ? {} : { pendingConfirmation })} onOpenJobMatch={onOpenJobMatch} onOpenApplication={onOpenApplication} {...(onStartApplication === undefined ? {} : { onStartApplication })} {...(onConfirm === undefined ? {} : { onConfirm })} /> : null}</div></article>;
}
