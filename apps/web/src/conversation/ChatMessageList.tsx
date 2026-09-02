import type { ConversationConfirmation, ConversationJobMatchAction, ConversationMessage } from "@resume/contracts";
import { Sparkles } from "lucide-react";
import type { JobMatchApi } from "../job-matching/api.js";
import { ConversationCards } from "./ConversationCards.js";
import { ConversationTurnTrace } from "./ConversationTurnTrace.js";
import type { ConversationProcessGroup, ConversationTurnProcess } from "./conversation-process-model.js";

interface ChatMessageListProps {
  messages: ConversationMessage[];
  pendingConfirmation?: ConversationConfirmation;
  onOpenApplication(taskId: string): void;
  jobMatchApi: JobMatchApi;
  onJobMatchAction(action: ConversationJobMatchAction): void | Promise<void>;
  onStartApplication?(card: Extract<ConversationMessage["cards"][number], { type: "recommendation" }>): void;
  onConfirm?(confirmationId: string, approved: boolean, selectedUrl?: string): void;
  processByTurn?: ReadonlyMap<number, ConversationTurnProcess>;
  latestUserSequence?: number;
}

export function ChatMessageList({ messages, pendingConfirmation, onOpenApplication, jobMatchApi, onJobMatchAction, onStartApplication, onConfirm, processByTurn = new Map(), latestUserSequence }: ChatMessageListProps) {
  const latestSequence = latestUserSequence ?? messages.filter(({ role }) => role === "user").at(-1)?.sequence;
  return <section className="conversation-messages" aria-label="对话消息" aria-live="polite">{messages.length === 0 ? <p className="conversation-empty">从下面的快速开始开始吧。</p> : messages.map((message, index) => {
    const process = processForMessage(messages, index, processByTurn);
    const article = <MessageArticle key={`${message.id}-${index}`} message={message} {...(pendingConfirmation === undefined ? {} : { pendingConfirmation })} onOpenApplication={onOpenApplication} jobMatchApi={jobMatchApi} onJobMatchAction={onJobMatchAction} {...(process === undefined ? {} : { process })} {...(onStartApplication === undefined ? {} : { onStartApplication })} {...(onConfirm === undefined ? {} : { onConfirm })} />;
    if (message.role !== "user") return article;
    return <section key={`${message.id}-${index}`} className="conversation-turn-group" data-testid={`conversation-turn-${message.sequence}`}>
      {article}
      {process && !hasInlineJobMatchCard(messages[index + 1]) ? <ConversationTurnTrace process={process} isLatestTurn={message.sequence === latestSequence} /> : null}
    </section>;
  })}</section>;
}

interface MessageArticleProps {
  message: ConversationMessage;
  pendingConfirmation?: ConversationConfirmation;
  onOpenApplication(taskId: string): void;
  jobMatchApi: JobMatchApi;
  onJobMatchAction(action: ConversationJobMatchAction): void | Promise<void>;
  process?: ConversationProcessGroup;
  onStartApplication?: ChatMessageListProps["onStartApplication"];
  onConfirm?: ChatMessageListProps["onConfirm"];
}

function MessageArticle({ message, pendingConfirmation, onOpenApplication, jobMatchApi, onJobMatchAction, process, onStartApplication, onConfirm }: MessageArticleProps) {
  return <article className={`conversation-message ${message.role}`}><div className="conversation-message-avatar">{message.role === "assistant" ? <Sparkles aria-hidden="true" size={15} /> : "我"}</div><div className="conversation-bubble"><p>{message.text}</p>{message.cards.length > 0 ? <ConversationCards cards={message.cards} conversationId={message.sessionId} jobMatchApi={jobMatchApi} onJobMatchAction={onJobMatchAction} {...(pendingConfirmation === undefined ? {} : { pendingConfirmation })} {...(process === undefined ? {} : { process })} onOpenApplication={onOpenApplication} {...(onStartApplication === undefined ? {} : { onStartApplication })} {...(onConfirm === undefined ? {} : { onConfirm })} /> : null}</div></article>;
}

function processForMessage(messages: readonly ConversationMessage[], index: number, processByTurn: ReadonlyMap<number, ConversationTurnProcess>): ConversationTurnProcess | undefined {
  const message = messages[index];
  if (message === undefined) return undefined;
  if (message.role === "user") return processByTurn.get(message.sequence);
  const owner = messages.slice(0, index).reverse().find((candidate) => candidate.role === "user");
  return owner === undefined ? undefined : processByTurn.get(owner.sequence);
}

function hasInlineJobMatchCard(message: ConversationMessage | undefined): boolean {
  return message?.role === "assistant" && message.cards.some((card) => card.type === "job_match_session");
}
