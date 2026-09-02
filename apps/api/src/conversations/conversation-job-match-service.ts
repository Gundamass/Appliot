import { createHash, randomUUID } from "node:crypto";
import {
  ConversationCardSchema,
  ConversationContextSchema,
  ConversationJobMatchActionResultSchema,
  ConversationJobMatchActionSchema,
  ConversationMessageSchema,
  ConversationTurnResponseSchema,
  type ConversationCard,
  type ConversationContext,
  type ConversationJobMatchAction,
  type ConversationJobMatchActionResult,
  type ConversationMessage,
  type ConversationProcessFailure,
  type ConversationProcessStage
} from "@resume/contracts";
import { z } from "zod";
import type { ConversationRepository, ConversationTurnRecord } from "./conversation-repository.js";
import type { ConversationProcessEventBus } from "./conversation-events.js";
import { createConversationProcessTrace } from "./conversation-process-trace.js";
import type { createJobMatchService } from "../job-matching/job-match-service.js";
import type { JobMatchAggregate } from "../job-matching/job-match-repository.js";

type JobMatchService = ReturnType<typeof createJobMatchService>;
type ProcessTrace = ReturnType<typeof createConversationProcessTrace>;
type ProcessTraceStep = ReturnType<ProcessTrace["start"]>;

export interface ConversationJobMatchServiceDependencies {
  conversations: ConversationRepository;
  jobMatches: JobMatchService;
  processEvents?: ConversationProcessEventBus;
  now?: () => Date;
}

export interface ConversationJobMatchService {
  execute(
    conversationId: string,
    input: ConversationJobMatchAction
  ): Promise<ConversationJobMatchActionResult>;
  findOwningConversation(sessionId: string): Promise<{ conversationId: string } | undefined>;
}

const ConversationIdSchema = z.string().trim().min(1).max(256);
const JobMatchSessionIdSchema = z.string().trim().min(1).max(256);

export function createConversationJobMatchService(
  dependencies: ConversationJobMatchServiceDependencies
): ConversationJobMatchService {
  const now = dependencies.now ?? (() => new Date());
  const locks = new Map<string, Promise<void>>();

  const findOwningConversation = async (rawSessionId: string): Promise<{ conversationId: string } | undefined> => {
    const sessionId = JobMatchSessionIdSchema.parse(rawSessionId);
    const repository = dependencies.conversations as ConversationRepository & {
      getJobMatchSessionLink?: ConversationRepository["getJobMatchSessionLink"];
      findConversationByJobMatchSession?: ConversationRepository["findConversationByJobMatchSession"];
    };
    if (typeof repository.findConversationByJobMatchSession === "function") {
      const conversation = repository.findConversationByJobMatchSession(sessionId);
      if (conversation !== undefined) return { conversationId: conversation.id };
    }
    if (typeof repository.getJobMatchSessionLink === "function") {
      const link = repository.getJobMatchSessionLink(sessionId);
      if (link !== undefined) return { conversationId: link.conversationId };
    }
    return undefined;
  };

  const execute = async (
    rawConversationId: string,
    rawInput: ConversationJobMatchAction
  ): Promise<ConversationJobMatchActionResult> => {
    const conversationId = ConversationIdSchema.parse(rawConversationId);
    const input = ConversationJobMatchActionSchema.parse(rawInput);
    if (input.conversationId !== conversationId) {
      throw new Error("conversation_job_match_conversation_mismatch");
    }

    return withConversationLock(locks, conversationId, async () => {
      if (dependencies.conversations.getConversation(conversationId) === undefined) {
        throw new Error("conversation_not_found");
      }

      const requestId = actionRequestId(conversationId, input.idempotencyKey);
      const payload = stableJson(input);
      const existing = dependencies.conversations.getTurn(conversationId, requestId);
      if (existing !== undefined) {
        if (existing.inputText !== payload) throw new Error("conversation_idempotency_conflict");
        return replayActionResult(input, existing, dependencies.jobMatches);
      }

      const current = dependencies.jobMatches.get(input.sessionId);
      if (current.id !== input.sessionId) throw new Error("job_match_session_not_found");
      const owner = await findOwningConversation(input.sessionId);
      if (owner === undefined || owner.conversationId !== conversationId) {
        throw new Error("conversation_job_match_not_owned");
      }

      const messages = dependencies.conversations.listMessages(conversationId);
      const expectedSequence = lastSequence(messages);
      const turnSequence = expectedSequence + 1;
      const trace = createActionProcessTrace(dependencies, conversationId, turnSequence);
      const understanding = trace?.start({
        stepId: "understanding-request",
        stage: "understanding_request",
        summary: "正在理解岗位匹配操作"
      });
      understanding?.complete({ summary: `已识别：${actionLabel(input)}` });
      let activeStep: ProcessTraceStep | undefined = trace?.start(actionProcessStep(input));

      try {
        await dispatchAction(dependencies.jobMatches, input);
        const isSelection = input.action === "select_result" || input.action === "select_conflict_result";
        if (isSelection) {
          activeStep?.complete({ summary: "岗位选择已通过版本和内容校验" });
          activeStep = trace?.start({
            stepId: "persist-selection",
            stage: "generating_response",
            summary: "正在保存岗位选择"
          });
        }

        const aggregate = dependencies.jobMatches.get(input.sessionId);
        const cards = projectCards(aggregate);
        const context = nextContext(dependencies.conversations.getContext(conversationId), aggregate);
        const timestamp = now().toISOString();
        const assistantMessage = ConversationMessageSchema.parse({
          id: randomUUID(),
          sessionId: conversationId,
          sequence: turnSequence + 1,
          role: "assistant",
          text: actionMessage(input),
          cards,
          createdAt: timestamp
        });
        const userMessage = ConversationMessageSchema.parse({
          id: randomUUID(),
          sessionId: conversationId,
          sequence: turnSequence,
          role: "user",
          text: actionUserMessage(input),
          cards: [],
          createdAt: timestamp
        });
        const response = ConversationTurnResponseSchema.parse({
          message: assistantMessage,
          cards,
          context
        });
        const stored = dependencies.conversations.appendTurn({
          conversationId,
          requestId,
          inputText: payload,
          userMessage,
          assistantMessage,
          expectedSequence,
          expectedContextVersion: context.version - 1,
          context,
          response
        });
        if (activeStep !== undefined) {
          if (input.action === "pause") {
            activeStep.wait({ summary: "岗位匹配已暂停，等待你继续" });
          } else {
            activeStep.complete({ summary: "岗位匹配操作已完成" });
          }
          activeStep = undefined;
        }
        if (stored.response.message.id !== assistantMessage.id) {
          return replayActionResult(input, stored, dependencies.jobMatches);
        }
        return actionResult(aggregate, response);
      } catch (error) {
        if (activeStep !== undefined) finishFailedProcessStep(activeStep, input, error);
        throw error;
      }
    });
  };

  return { execute, findOwningConversation };
}

function createActionProcessTrace(
  dependencies: ConversationJobMatchServiceDependencies,
  conversationId: string,
  turnSequence: number
): ProcessTrace | undefined {
  if (dependencies.processEvents === undefined) return undefined;
  return createConversationProcessTrace({
    conversationId,
    turnSequence,
    emit: (event) => dependencies.processEvents!.emit(event),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now })
  });
}

function actionProcessStep(input: ConversationJobMatchAction): {
  stepId: string;
  stage: ConversationProcessStage;
  summary: string;
} {
  switch (input.action) {
    case "confirm_filters":
      return {
        stepId: "apply-filters",
        stage: "reading_recruitment_site",
        summary: "正在应用已确认的岗位筛选"
      };
    case "adjust_filters":
      return {
        stepId: "apply-filters",
        stage: "reading_recruitment_site",
        summary: "正在应用更新后的岗位筛选"
      };
    case "pause":
      return {
        stepId: "pause-job-match",
        stage: "processing_confirmation",
        summary: "正在暂停岗位匹配"
      };
    case "continue":
      return {
        stepId: "read-recruitment-site",
        stage: "reading_recruitment_site",
        summary: "正在读取已确认的招聘页面"
      };
    case "rematch":
      return {
        stepId: "match-jobs",
        stage: "matching_jobs",
        summary: "正在根据当前条件重新匹配岗位"
      };
    case "select_result":
    case "select_conflict_result":
      return {
        stepId: "validate-selection",
        stage: "processing_confirmation",
        summary: "正在验证岗位选择"
      };
  }
}

function finishFailedProcessStep(
  step: ProcessTraceStep,
  input: ConversationJobMatchAction,
  error: unknown
): void {
  if (isWaitingError(error)) {
    step.wait({ summary: waitingSummary(input) });
    return;
  }
  const code = safeErrorCode(error);
  const failure: ConversationProcessFailure = {
    code: processFailureCode(code),
    summary: processFailureSummary(code),
    retryable: !NON_RETRYABLE_PROCESS_ERRORS.has(code)
  };
  step.fail({ summary: failure.summary, failure });
}

function isWaitingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /(?:challenge|captcha|login|auth)/iu.test(message);
}

function waitingSummary(input: ConversationJobMatchAction): string {
  if (input.action === "continue") {
    return "招聘页面需要登录或额外验证，请完成验证后再点击继续。";
  }
  return "操作需要登录或额外验证，请完成验证后再试。";
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Za-z0-9_:-]+$/u.test(message) ? message : "conversation_job_match_operation_failed";
}

function processFailureCode(code: string): string {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  return normalized.slice(0, 64) || "CONVERSATION_JOB_MATCH_OPERATION_FAILED";
}

function processFailureSummary(code: string): string {
  if (code === "job_match_version_conflict"
    || code === "job_match_result_stale"
    || code === "job_match_posting_changed") {
    return "岗位匹配结果已变化，请刷新后重试。";
  }
  if (code === "conversation_job_match_not_owned") {
    return "当前岗位匹配不属于这段对话，无法继续操作。";
  }
  return "岗位匹配操作暂时未完成，请稍后重试。";
}

const NON_RETRYABLE_PROCESS_ERRORS = new Set([
  "conversation_job_match_not_owned",
  "job_match_session_not_found",
  "job_match_result_not_found",
  "job_match_selection_not_allowed",
  "job_match_application_redirect"
]);

async function dispatchAction(jobMatches: JobMatchService, input: ConversationJobMatchAction): Promise<void> {
  const guard = {
    sessionVersion: input.sessionVersion,
    idempotencyKey: input.idempotencyKey
  };
  switch (input.action) {
    case "confirm_filters":
    case "adjust_filters":
      await jobMatches.confirmFilters(input.sessionId, input.expectation, guard);
      return;
    case "pause":
      await jobMatches.pause(input.sessionId, guard);
      return;
    case "continue":
      await jobMatches.continueExtraction(input.sessionId, guard);
      return;
    case "rematch":
      await jobMatches.rematch(input.sessionId, guard);
      return;
    case "select_result":
      await jobMatches.select(input.sessionId, {
        ...guard,
        resultId: input.resultId,
        resultVersion: input.resultVersion,
        postingContentHash: input.postingContentHash
      });
      return;
    case "select_conflict_result":
      await jobMatches.selectConflict(input.sessionId, {
        ...guard,
        resultId: input.resultId,
        resultVersion: input.resultVersion,
        postingContentHash: input.postingContentHash,
        conflictSummaryHash: input.conflictSummaryHash
      });
      return;
  }
}

function actionResult(
  aggregate: JobMatchAggregate,
  response: ReturnType<typeof ConversationTurnResponseSchema.parse>
): ConversationJobMatchActionResult {
  return ConversationJobMatchActionResultSchema.parse({
    sessionId: aggregate.id,
    state: aggregate.state,
    version: aggregate.version,
    turnSequence: Math.max(1, response.message.sequence - 1),
    message: response.message,
    cards: response.cards,
    context: response.context,
    ...(aggregate.applicationTaskId === undefined ? {} : { applicationTaskId: aggregate.applicationTaskId })
  });
}

async function replayActionResult(
  input: ConversationJobMatchAction,
  turn: ConversationTurnRecord,
  jobMatches: JobMatchService
): Promise<ConversationJobMatchActionResult> {
  const aggregate = jobMatches.get(input.sessionId);
  return actionResult(aggregate, turn.response);
}

function projectCards(aggregate: JobMatchAggregate): ConversationCard[] {
  const sessionCard = ConversationCardSchema.parse({
    type: "job_match_session",
    sessionId: aggregate.id,
    initialUrl: aggregate.initialUrl,
    state: aggregate.state,
    postingCount: aggregate.postings.length
  });
  const postingById = new Map(aggregate.postings.map((posting) => [posting.id, posting]));
  const recommendations = aggregate.results
    .filter((result) => !result.stale)
    .sort((left, right) => right.rankingScore - left.rankingScore || left.id.localeCompare(right.id))
    .flatMap((result) => {
      const posting = postingById.get(result.postingId);
      if (posting === undefined) return [];
      return [ConversationCardSchema.parse({
        type: "recommendation",
        sessionId: aggregate.id,
        resultId: result.id,
        title: posting.title,
        company: posting.organization,
        score: result.rankingScore,
        evidenceCount: result.evidence.length,
        postingContentHash: result.postingContentHash
      })];
    })
    .slice(0, 19);
  return [sessionCard, ...recommendations];
}

function nextContext(context: ConversationContext, aggregate: JobMatchAggregate): ConversationContext {
  const recentPostingIds = unique([
    ...aggregate.results.map((result) => result.postingId),
    ...context.recentPostingIds
  ]).slice(0, 50);
  const selectedResult = aggregate.selectedResultId === undefined
    ? undefined
    : aggregate.results.find((result) => result.id === aggregate.selectedResultId);
  return ConversationContextSchema.parse({
    ...context,
    activeJobMatchSessionId: aggregate.id,
    recentPostingIds,
    version: context.version + 1,
    ...(selectedResult === undefined ? {} : { selectedPostingId: selectedResult.postingId }),
    ...(aggregate.applicationTaskId === undefined ? {} : { activeApplicationTaskId: aggregate.applicationTaskId })
  });
}

function actionUserMessage(input: ConversationJobMatchAction): string {
  return `岗位匹配操作：${actionLabel(input)}`;
}

function actionMessage(input: ConversationJobMatchAction): string {
  switch (input.action) {
    case "confirm_filters": return "筛选条件已确认，正在提取岗位。";
    case "adjust_filters": return "筛选条件已更新，正在重新匹配岗位。";
    case "pause": return "岗位匹配已暂停。需要继续时可以再次启动。";
    case "continue": return "已继续岗位匹配，正在读取招聘页面。";
    case "rematch": return "已根据当前条件重新匹配岗位。";
    case "select_result": return "已选择这个岗位，下一步将进入受控投递确认。";
    case "select_conflict_result": return "已确认岗位信息中的冲突并选择该岗位，下一步将进入受控投递确认。";
  }
}

function actionLabel(input: ConversationJobMatchAction): string {
  switch (input.action) {
    case "confirm_filters": return "确认筛选条件";
    case "adjust_filters": return "调整筛选条件";
    case "pause": return "暂停匹配";
    case "continue": return "继续匹配";
    case "rematch": return "重新匹配";
    case "select_result": return "选择岗位";
    case "select_conflict_result": return "确认冲突并选择岗位";
  }
}

function actionRequestId(conversationId: string, idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(`${conversationId}\u0000${idempotencyKey}`)
    .digest("hex");
  return `job-match-action:${digest}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function lastSequence(messages: readonly ConversationMessage[]): number {
  return messages.at(-1)?.sequence ?? 0;
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
