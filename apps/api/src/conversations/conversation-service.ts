import { createHash, randomUUID } from "node:crypto";
import {
  ConversationContextSchema,
  ConversationConfirmInputSchema,
  ConversationHistoryClearResultSchema,
  ConversationMessageSchema,
  ConversationSessionSchema,
  ConversationSessionListSchema,
  ConversationTurnInputSchema,
  ConversationTurnResponseSchema,
  ConversationViewSchema,
  type ConversationConfirmation,
  type ConversationConfirmInput as ContractConversationConfirmInput,
  type ConversationContext,
  type ConversationMessage,
  type ConversationSession,
  type ConversationTurnResponse,
  type ConversationView
} from "@resume/contracts";
import type { ConversationGraph, ConversationGraphOutput } from "./conversation-graph.js";
import type { ConversationProcessEventBus } from "./conversation-events.js";
import type { ConversationRepository } from "./conversation-repository.js";

export type ConversationConfirmInput = ContractConversationConfirmInput;

export interface ConversationServiceDependencies {
  repository: ConversationRepository;
  graph: ConversationGraph;
  processEvents?: Pick<ConversationProcessEventBus, "clearConversation" | "clearAll">;
  now?: () => Date;
}

export interface ConversationService {
  create(): ConversationSession;
  list(): ConversationSession[];
  delete(conversationId: string): void;
  deleteAll(): { deletedCount: number };
  get(conversationId: string): ConversationView;
  send(conversationId: string, text: string, requestId?: string): Promise<ConversationTurnResponse>;
  confirm(conversationId: string, input: ConversationConfirmInput): Promise<ConversationTurnResponse>;
}

const ConversationIdSchema = ConversationSessionSchema.shape.id;
const RequestIdSchema = ConversationIdSchema;

export function createConversationService(
  dependencies: ConversationServiceDependencies
): ConversationService {
  const now = dependencies.now ?? (() => new Date());
  const locks = new Map<string, Promise<void>>();

  return {
    create() {
      return ConversationSessionSchema.parse(dependencies.repository.createConversation());
    },

    list() {
      return ConversationSessionListSchema.parse(dependencies.repository.listConversations());
    },

    delete(conversationId) {
      const id = requireConversationId(conversationId);
      if (!dependencies.repository.deleteConversation(id)) throw new Error("conversation_not_found");
      dependencies.processEvents?.clearConversation(id);
    },

    deleteAll() {
      const deletedCount = dependencies.repository.deleteAllConversations();
      dependencies.processEvents?.clearAll();
      return ConversationHistoryClearResultSchema.parse({ deletedCount });
    },

    get(conversationId) {
      return readView(dependencies.repository, conversationId);
    },

    async send(conversationId, rawText, suppliedRequestId) {
      const text = ConversationTurnInputSchema.parse({ text: rawText }).text;
      const id = requireConversationId(conversationId);
      const requestId = suppliedRequestId === undefined
        ? undefined
        : RequestIdSchema.parse(suppliedRequestId.trim());

      return withConversationLock(locks, id, async () => {
        requireConversation(dependencies.repository, id);
        const messages = dependencies.repository.listMessages(id);
        const expectedSequence = lastSequence(messages);
        const nextSequence = expectedSequence + 1;
        const effectiveRequestId = requestId ?? `message:${id}:${nextSequence}`;
        const existing = dependencies.repository.getTurn(id, effectiveRequestId);
        if (existing !== undefined) {
          if (existing.inputText !== text) throw new Error("conversation_idempotency_conflict");
          return existing.response;
        }

        const context = dependencies.repository.getContext(id);
        const output = await dependencies.graph.invoke({
          conversationId: id,
          turnSequence: nextSequence,
          text,
          context,
          sequence: nextSequence
        }, graphConfig(id));
        const response = normalizeResponse(output, id, nextSequence, context.version);
        const userMessage = message({
          id,
          sequence: nextSequence,
          role: "user",
          text,
          now
        });
        const stored = dependencies.repository.appendTurn({
          conversationId: id,
          requestId: effectiveRequestId,
          inputText: text,
          userMessage,
          assistantMessage: response.message,
          expectedSequence,
          expectedContextVersion: context.version,
          context: response.context,
          response
        });
        persistConfirmation(dependencies.repository, id, response.pendingConfirmation);
        return stored.response;
      });
    },

    async confirm(conversationId, rawInput) {
      const id = requireConversationId(conversationId);
      const input = parseConfirmationInput(rawInput);

      return withConversationLock(locks, id, async () => {
        requireConversation(dependencies.repository, id);
        const pending = dependencies.repository.peekConfirmation(id, input.confirmationId);
        if (pending === undefined) throw new Error("conversation_confirmation_invalid");

        const messages = dependencies.repository.listMessages(id);
        const expectedSequence = lastSequence(messages);
        const nextSequence = expectedSequence + 1;
        const context = dependencies.repository.getContext(id);
        const output = await dependencies.graph.invoke({
          conversationId: id,
          turnSequence: nextSequence,
          ...(pending.sourceTurnSequence === undefined
            ? {}
            : { confirmationSourceTurnSequence: pending.sourceTurnSequence }),
          context,
          sequence: nextSequence,
          confirmationId: input.confirmationId,
          approved: input.approved,
          ...(input.selectedUrl === undefined ? {} : { selectedUrl: input.selectedUrl })
        }, graphConfig(id));
        const response = normalizeResponse(output, id, nextSequence, context.version);
        const decisionText = input.approved ? "确认开始投递" : "取消开始投递";
        const userMessage = message({
          id,
          sequence: nextSequence,
          role: "user",
          text: decisionText,
          now
        });
        const selectionHash = createHash("sha256")
          .update(input.selectedUrl ?? "")
          .digest("hex")
          .slice(0, 16);
        const requestId = `confirmation:${input.confirmationId}:${input.approved ? "approved" : "declined"}:${selectionHash}`;
        const stored = dependencies.repository.appendTurn({
          conversationId: id,
          requestId,
          inputText: decisionText,
          userMessage,
          assistantMessage: response.message,
          expectedSequence,
          expectedContextVersion: context.version,
          context: response.context,
          response
        });
        persistConfirmation(dependencies.repository, id, response.pendingConfirmation);
        dependencies.repository.consumeConfirmation(id, pending.confirmationId);
        return stored.response;
      });
    }
  };
}

function readView(repository: ConversationRepository, conversationId: string): ConversationView {
  const id = requireConversationId(conversationId);
  const session = requireConversation(repository, id);
  const pendingConfirmation = repository.findPendingConfirmation(id);
  const view = {
    session,
    messages: hydrateLegacyConfirmationCards(repository.listMessages(id), pendingConfirmation),
    context: repository.getContext(id),
    ...(pendingConfirmation === undefined ? {} : { pendingConfirmation })
  };
  return ConversationViewSchema.parse(view);
}

function hydrateLegacyConfirmationCards(
  messages: ConversationMessage[],
  pending: ConversationConfirmation | undefined
): ConversationMessage[] {
  if (pending === undefined) return messages;
  const messageIndex = messages.findLastIndex((message) => message.role === "assistant"
    && message.cards.some((card) => card.type === "confirmation" && matchesPendingConfirmation(card, pending)));
  if (messageIndex < 0) return messages;

  return messages.map((message, index) => index !== messageIndex
    ? message
    : {
        ...message,
        cards: message.cards.map((card) => card.type === "confirmation" && matchesPendingConfirmation(card, pending)
          ? { ...card, confirmationId: pending.confirmationId }
          : card)
      });
}

function matchesPendingConfirmation(
  card: Extract<ConversationMessage["cards"][number], { type: "confirmation" }>,
  pending: ConversationConfirmation
): boolean {
  if (card.confirmationId !== undefined || card.action !== pending.action) return false;
  const target = card.target;
  const pendingTarget = pending.target;
  if (target.kind !== pendingTarget.kind) return false;
  if (target.kind === "recommendation" && pendingTarget.kind === "recommendation") {
    return target.sessionId === pendingTarget.sessionId
      && target.resultId === pendingTarget.resultId
      && target.postingContentHash === pendingTarget.postingContentHash;
  }
  if (target.kind === "recruitment_site_choices" && pendingTarget.kind === "recruitment_site_choices") {
    return target.company === pendingTarget.company
      && target.recruitmentType === pendingTarget.recruitmentType
      && target.query === pendingTarget.query
      && JSON.stringify(target.candidates) === JSON.stringify(pendingTarget.candidates);
  }
  if (target.kind === "recruitment_site" && pendingTarget.kind === "recruitment_site") {
    return target.company === pendingTarget.company
      && target.recruitmentType === pendingTarget.recruitmentType
      && target.query === pendingTarget.query
      && target.title === pendingTarget.title
      && target.url === pendingTarget.url
      && target.domain === pendingTarget.domain
      && target.snippet === pendingTarget.snippet
      && target.source === pendingTarget.source
      && target.sourceScore === pendingTarget.sourceScore;
  }
  return false;
}

function requireConversationId(value: string): string {
  return ConversationIdSchema.parse(value);
}

function requireConversation(repository: ConversationRepository, id: string): ConversationSession {
  const session = repository.getConversation(id);
  if (session === undefined) throw new Error("conversation_not_found");
  return ConversationSessionSchema.parse(session);
}

function lastSequence(messages: readonly ConversationMessage[]): number {
  const last = messages.at(-1);
  return last?.sequence ?? 0;
}

function message(input: {
  id: string;
  sequence: number;
  role: ConversationMessage["role"];
  text: string;
  now: () => Date;
}): ConversationMessage {
  return ConversationMessageSchema.parse({
    id: randomUUID(),
    sessionId: input.id,
    sequence: input.sequence,
    role: input.role,
    text: input.text,
    cards: [],
    createdAt: input.now().toISOString()
  });
}

function normalizeResponse(
  output: ConversationGraphOutput,
  conversationId: string,
  nextSequence: number,
  expectedContextVersion: number
): ConversationTurnResponse {
  const response = ConversationTurnResponseSchema.parse(output.response);
  if (response.message.sessionId !== conversationId) throw new Error("conversation_message_mismatch");
  if (response.context.version !== expectedContextVersion + 1) {
    throw new Error("conversation_context_conflict");
  }
  const assistantMessage = ConversationMessageSchema.parse({
    ...response.message,
    sequence: nextSequence + 1
  });
  const context = ConversationContextSchema.parse(response.context);
  return ConversationTurnResponseSchema.parse({
    ...response,
    message: assistantMessage,
    context
  });
}

function persistConfirmation(
  repository: ConversationRepository,
  conversationId: string,
  confirmation: ConversationConfirmation | undefined
): void {
  if (confirmation !== undefined) repository.putConfirmation(conversationId, confirmation);
}

function parseConfirmationInput(input: ConversationConfirmInput): ConversationConfirmInput {
  const parsed = ConversationConfirmInputSchema.safeParse(input);
  if (!parsed.success) throw new Error("conversation_confirmation_input_invalid");
  return {
    confirmationId: RequestIdSchema.parse(parsed.data.confirmationId.trim()),
    approved: parsed.data.approved,
    ...(parsed.data.selectedUrl === undefined ? {} : { selectedUrl: parsed.data.selectedUrl })
  };
}

function graphConfig(conversationId: string) {
  return { configurable: { thread_id: `conversation:${conversationId}` } };
}

async function withConversationLock<T>(
  locks: Map<string, Promise<void>>,
  conversationId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = locks.get(conversationId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  locks.set(conversationId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(conversationId) === current) locks.delete(conversationId);
  }
}
