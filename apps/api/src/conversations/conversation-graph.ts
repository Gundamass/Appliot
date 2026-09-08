import { createHash, randomUUID } from "node:crypto";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import {
  ConversationCardSchema,
  ConversationContextSchema,
  ConversationIntentSchema,
  ConversationMessageSchema,
  RecruitmentSiteSearchResultSchema,
  VerifiedRecruitmentSiteSchema,
  ConversationTurnResponseSchema,
  type ConversationCard,
  type ConversationConfirmation,
  type ConversationContext,
  type ConversationIntent,
  type ConversationProcessStage,
  type ConversationProcessFailure,
  type ConversationProcessToolSummary,
  type ConversationTarget,
  type ConversationTurnResponse,
  type RecruitmentSearchRequest,
  type RecruitmentSiteCandidate,
  type RecruitmentSiteSearchResult,
  type VerifiedRecruitmentSite
} from "@resume/contracts";
import type { TraceSink } from "../agent/trace-sink.js";
import {
  createConversationToolRegistry,
  type ConversationToolContext,
  type ConversationToolDependencies,
  type ConversationToolName,
  type ConversationToolResult
} from "./conversation-tools.js";
import type { ConversationProcessEventBus, ConversationProcessEventInput } from "./conversation-events.js";
import { createConversationProcessTrace } from "./conversation-process-trace.js";
import { summarizeToolResult, summarizeToolStart } from "./conversation-process-summaries.js";
import { z } from "zod";
import { validatePublicHttpsUrl } from "../recruitment-search/public-https-url.js";

const ConversationIdSchema = z.string().min(1).max(256);
const ConfirmationIdSchema = z.string().min(1).max(256);
const HttpsUrlSchema = z.string().url().max(2_048).refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, "recruitment_url_must_be_https");

const ConversationGraphInputSchema = z.object({
  conversationId: ConversationIdSchema,
  turnSequence: z.number().int().positive(),
  confirmationSourceTurnSequence: z.number().int().positive().optional(),
  text: z.string().trim().min(1).max(500).optional(),
  context: ConversationContextSchema,
  sequence: z.number().int().nonnegative().optional(),
  confirmationId: ConfirmationIdSchema.optional(),
  approved: z.boolean().optional(),
  selectedUrl: HttpsUrlSchema.optional()
}).strict().superRefine((input, context) => {
  const isConfirmation = input.confirmationId !== undefined;
  if (!isConfirmation && input.text === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: "conversation_text_required" });
  }
  if (isConfirmation && input.approved === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["approved"], message: "confirmation_decision_required" });
  }
});

export type ConversationGraphInput = z.input<typeof ConversationGraphInputSchema>;

export interface ConversationGraphDependencies extends ConversationToolDependencies {
  checkpointer?: BaseCheckpointSaver;
  traceSink?: TraceSink;
  processEvents?: ConversationProcessEventBus;
  now?: () => Date;
  validatePublicHttpsUrl?: typeof validatePublicHttpsUrl;
  confirmationStore?: ConversationConfirmationStore;
  modelProvider?: {
    generateStructured(input: {
      system: string;
      user: string;
      schema: z.ZodType;
      jsonExample: unknown;
    }): Promise<unknown>;
  };
}

export interface ConversationConfirmationStore {
  put(conversationId: string, value: ConversationConfirmation): void;
  peek(conversationId: string, id: string): ConversationConfirmation | undefined;
  consume(conversationId: string, id: string): ConversationConfirmation | undefined;
}

export interface ConversationGraphOutput {
  response: ConversationTurnResponse;
  context: ConversationContext;
  intent?: ConversationIntent;
  traceIds: string[];
}

export interface ConversationGraph {
  invoke(input: ConversationGraphInput, config?: unknown): Promise<ConversationGraphOutput>;
}

type Route = "read" | "side_effect" | "persist";
type InputKind = "message" | "confirmation";

interface ResolvedTarget {
  kind: "recommendation" | "task" | "recruitment_site" | "application_url";
  sessionId?: string;
  resultId?: string;
  postingId?: string;
  postingContentHash?: string;
  taskId?: string;
  recruitmentSite?: VerifiedRecruitmentSite;
  recruitmentCompany?: string;
  recruitmentType?: RecruitmentSearchRequest["recruitmentType"];
  applicationUrl?: string;
}

interface GraphState {
  conversationId: string;
  turnSequence: number;
  confirmationSourceTurnSequence?: number;
  text?: string;
  context: ConversationContext;
  sequence: number;
  inputKind: InputKind;
  confirmationId?: string;
  approved?: boolean;
  selectedUrl?: string;
  intent?: ConversationIntent;
  target?: ResolvedTarget;
  resolutionError?: string;
  failureCode?: string;
  route: Route;
  cards: ConversationCard[];
  assistantText?: string;
  pendingConfirmation?: ConversationConfirmation;
  consumedConfirmationId?: string;
  contextPatch?: Partial<ConversationContext>;
  toolResult?: ConversationToolResult;
  response?: ConversationTurnResponse;
  traceIds: string[];
}

type ToolInvocationResult =
  | { ok: true; result: ConversationToolResult; traceIds: string[] }
  | { ok: false; error: unknown; traceIds: string[] };

const GraphStateAnnotation = Annotation.Root({
  conversationId: Annotation<string>,
  turnSequence: Annotation<number>({ reducer: replaceValue, default: () => 1 }),
  confirmationSourceTurnSequence: Annotation<number | undefined>({ reducer: replaceValue, default: () => undefined }),
  text: Annotation<string | undefined>({ reducer: replaceValue, default: () => undefined }),
  context: Annotation<ConversationContext>,
  sequence: Annotation<number>({ reducer: replaceValue, default: () => 0 }),
  inputKind: Annotation<InputKind>({ reducer: replaceValue, default: () => "message" }),
  confirmationId: Annotation<string | undefined>({ reducer: replaceValue, default: () => undefined }),
  approved: Annotation<boolean | undefined>({ reducer: replaceValue, default: () => undefined }),
  selectedUrl: Annotation<string | undefined>({ reducer: replaceValue, default: () => undefined }),
  intent: Annotation<ConversationIntent | undefined>({ reducer: replaceValue, default: () => undefined }),
  target: Annotation<ResolvedTarget | undefined>({ reducer: replaceValue, default: () => undefined }),
  resolutionError: Annotation<string | undefined>({ reducer: replaceValue, default: () => undefined }),
  failureCode: Annotation<string | undefined>({ reducer: replaceValue, default: () => undefined }),
  route: Annotation<Route>({ reducer: replaceValue, default: () => "persist" }),
  cards: Annotation<ConversationCard[]>({ reducer: replaceValue, default: () => [] }),
  assistantText: Annotation<string | undefined>({ reducer: replaceValue, default: () => undefined }),
  pendingConfirmation: Annotation<ConversationConfirmation | undefined>({ reducer: replaceValue, default: () => undefined }),
  consumedConfirmationId: Annotation<string | undefined>({ reducer: replaceValue, default: () => undefined }),
  contextPatch: Annotation<Partial<ConversationContext> | undefined>({ reducer: replaceValue, default: () => undefined }),
  toolResult: Annotation<ConversationToolResult | undefined>({ reducer: replaceValue, default: () => undefined }),
  response: Annotation<ConversationTurnResponse | undefined>({ reducer: replaceValue, default: () => undefined }),
  traceIds: Annotation<string[]>({ reducer: replaceValue, default: () => [] })
});

export function createConversationGraph(dependencies: ConversationGraphDependencies): ConversationGraph {
  const registry = createConversationToolRegistry(dependencies);
  const confirmations = dependencies.confirmationStore ?? createMemoryConfirmationStore();
  const now = dependencies.now ?? (() => new Date());
  const compileOptions = dependencies.checkpointer === undefined
    ? {}
    : { checkpointer: dependencies.checkpointer };

  const compiled = new StateGraph(GraphStateAnnotation)
    .addNode("load_context", (state) => loadContext(dependencies, state as unknown as GraphState) as never)
    .addNode("classify_intent", (state) => classifyIntent(dependencies, confirmations, state as unknown as GraphState) as never)
    .addNode("resolve_target", (state) => resolveTarget(dependencies, confirmations, state as unknown as GraphState) as never)
    .addNode("policy_gate", (state) => policyGate(state as unknown as GraphState) as never)
    .addNode("execute_read", (state) => executeRead(dependencies, registry, state as unknown as GraphState) as never)
    .addNode("prepare_side_effect", (state) => prepareSideEffect(dependencies, registry, confirmations, state as unknown as GraphState) as never)
    .addNode("persist_turn", (state) => persistTurn(dependencies, now, state as unknown as GraphState) as never)
    .addEdge(START, "load_context")
    .addEdge("load_context", "classify_intent")
    .addEdge("classify_intent", "resolve_target")
    .addEdge("resolve_target", "policy_gate")
    .addConditionalEdges("policy_gate", (state) => state.route, {
      read: "execute_read",
      side_effect: "prepare_side_effect",
      persist: "persist_turn"
    })
    .addEdge("execute_read", "persist_turn")
    .addEdge("prepare_side_effect", "persist_turn")
    .addEdge("persist_turn", END)
    .compile(compileOptions);

  return {
    async invoke(input, config) {
      const parsed = ConversationGraphInputSchema.parse(input);
      const graphInput = {
        conversationId: parsed.conversationId,
        turnSequence: parsed.turnSequence,
        confirmationSourceTurnSequence: parsed.confirmationSourceTurnSequence,
        context: parsed.context,
        text: parsed.text,
        sequence: parsed.sequence ?? 0,
        confirmationId: parsed.confirmationId,
        approved: parsed.approved,
        selectedUrl: parsed.selectedUrl,
        intent: undefined,
        target: undefined,
        resolutionError: undefined,
        failureCode: undefined,
        route: "persist" as const,
        cards: [],
        assistantText: undefined,
        pendingConfirmation: undefined,
        consumedConfirmationId: undefined,
        contextPatch: undefined,
        toolResult: undefined,
        response: undefined,
        traceIds: []
      };
      const result = await compiled.invoke(graphInput, config as never);
      const output = result as unknown as Partial<GraphState>;
      if (output.response === undefined) throw new Error("conversation_response_missing");
      return {
        response: output.response,
        context: output.context ?? parsed.context,
        ...(output.intent === undefined ? {} : { intent: output.intent }),
        traceIds: output.traceIds ?? []
      };
    }
  };
}

function loadContext(
  dependencies: ConversationGraphDependencies,
  state: GraphState
): Partial<GraphState> {
  const parsed = ConversationContextSchema.parse(state.context);
  const inputKind: InputKind = state.confirmationId === undefined ? "message" : "confirmation";
  const traceIds = trace(dependencies, {
    conversationId: state.conversationId,
    node: "load_context",
    kind: "node",
    outcome: "loaded",
    reasonCode: "context_loaded"
  }, state.traceIds);
  return {
    context: parsed,
    inputKind,
    sequence: state.sequence,
    traceIds
  };
}

async function classifyIntent(
  dependencies: ConversationGraphDependencies,
  confirmations: ConversationConfirmationStore,
  state: GraphState
): Promise<Partial<GraphState>> {
  const understanding = processTraceFor(dependencies, state).start({
    stepId: "understand-request",
    stage: "understanding_request",
    summary: "正在理解你的请求"
  });
  const finish = (result: Partial<GraphState>): Partial<GraphState> => {
    understanding.complete({
      summary: result.intent === undefined ? "请求已处理" : intentSummary(result.intent)
    });
    return result;
  };

  if (state.inputKind === "confirmation") {
    const pending = confirmations.peek(state.conversationId, state.confirmationId!);
    if (pending === undefined) {
      return finish({
        intent: unknownIntent(),
        resolutionError: "confirmation_invalid",
        traceIds: trace(dependencies, nodeEvent(state, "classify_intent", "unknown", "confirmation_invalid"), state.traceIds)
      });
    }
    return finish({
      intent: confirmationIntent(pending),
      traceIds: trace(dependencies, nodeEvent(state, "classify_intent", "confirmation", "confirmation_received"), state.traceIds)
    });
  }

  const fallback = deterministicIntent(state.text!);
  const manualUrl = extractSingleHttpsUrl(state.text!);
  if (manualUrl !== undefined && hasExplicitFillingIntent(state.text!)) {
    const intent = ConversationIntentSchema.parse({
      kind: "start_application",
      target: { kind: "application_url", url: manualUrl },
      requiresConfirmation: true
    });
    return finish({
      intent,
      traceIds: trace(dependencies, nodeEvent(state, "classify_intent", intent.kind, "direct_application_url"), state.traceIds)
    });
  }
  if (manualUrl !== undefined && isBareUrlMessage(state.text!, manualUrl)) {
    return finish({
      intent: unknownIntent(),
      assistantText: "你想填写这个申请页面，还是用它进行岗位推荐？请在网址前补充“填写”或“岗位推荐”。",
      traceIds: trace(dependencies, nodeEvent(state, "classify_intent", "unknown", "application_url_purpose_required"), state.traceIds)
    });
  }
  if (manualUrl !== undefined && state.context.lastRecruitmentRequest !== undefined && hasRecruitmentUrlIntent(state.text!)) {
    const last = state.context.lastRecruitmentRequest;
    const intent = ConversationIntentSchema.parse({
      kind: "discover_recruitment_site",
      target: { kind: "recruitment_site", company: last.companyName, recruitmentType: last.recruitmentType },
      requiresConfirmation: false
    });
    return finish({
      intent,
      traceIds: trace(dependencies, nodeEvent(state, "classify_intent", intent.kind, "manual_recruitment_url"), state.traceIds)
    });
  }
  if (fallback.kind !== "unknown") {
    return finish({ intent: fallback, traceIds: trace(dependencies, nodeEvent(state, "classify_intent", fallback.kind, "deterministic_intent"), state.traceIds) });
  }
  if (dependencies.modelProvider === undefined) {
    return finish({ intent: fallback, traceIds: trace(dependencies, nodeEvent(state, "classify_intent", fallback.kind, "deterministic_fallback"), state.traceIds) });
  }

  try {
    const raw = await dependencies.modelProvider.generateStructured({
      system: "你是受限的求职工作台意图分类器。只能返回允许的 ConversationIntent JSON，不得生成工具名、URL、浏览器命令或数据库 ID。",
      user: state.text!,
      schema: ConversationIntentSchema,
      jsonExample: { kind: "list_recommendations", requiresConfirmation: false }
    });
    const parsed = ConversationIntentSchema.safeParse(raw);
    if (!parsed.success) {
      const intent = unknownIntent();
      return finish({ intent, traceIds: trace(dependencies, nodeEvent(state, "classify_intent", "unknown", "model_output_invalid"), state.traceIds) });
    }
    const intent = normalizeIntent(parsed.data);
    return finish({ intent, traceIds: trace(dependencies, nodeEvent(state, "classify_intent", intent.kind, "model_structured"), state.traceIds) });
  } catch {
    return finish({ intent: fallback, traceIds: trace(dependencies, nodeEvent(state, "classify_intent", fallback.kind, "model_unavailable_fallback"), state.traceIds) });
  }
}

function resolveTarget(
  dependencies: ConversationGraphDependencies,
  confirmations: ConversationConfirmationStore,
  state: GraphState
): Partial<GraphState> {
  const intent = state.intent ?? unknownIntent();
  if (state.inputKind === "confirmation") {
    const pending = confirmations.peek(state.conversationId, state.confirmationId!);
    if (pending === undefined) return { resolutionError: "confirmation_invalid" };
    if (pending.target.kind === "recruitment_site_choices") {
      return {
        target: {
          kind: "recruitment_site",
          recruitmentCompany: pending.target.company,
          recruitmentType: pending.target.recruitmentType
        },
        traceIds: trace(dependencies, nodeEvent(state, "resolve_target", "resolved", "recruitment_site_choices_resolved"), state.traceIds)
      };
    }
    if (pending.target.kind === "recruitment_site") {
      const recruitmentSite = siteFromConfirmationTarget(pending.target);
      if (recruitmentSite === undefined) return { resolutionError: "recruitment_site_invalid" };
      return {
        target: {
          kind: "recruitment_site",
          recruitmentSite
        },
        traceIds: trace(dependencies, nodeEvent(state, "resolve_target", "resolved", "recruitment_site_resolved"), state.traceIds)
      };
    }
    if (pending.target.kind === "application_url") {
      return {
        target: { kind: "application_url", applicationUrl: pending.target.url },
        traceIds: trace(dependencies, nodeEvent(state, "resolve_target", "resolved", "application_url_resolved"), state.traceIds)
      };
    }
    const target = resolveRecommendationByIds(dependencies, pending.target.sessionId, pending.target.resultId);
    if (target.error !== undefined || target.value === undefined) {
      return { resolutionError: target.error ?? "recommendation_not_found" };
    }
    return { target: target.value };
  }

  const target = intent.target;
  if (target === undefined) {
    if (intent.kind === "start_application" || intent.kind === "start_application_and_show_status" || intent.kind === "show_application_task" || intent.kind === "request_job_recommendations") {
      if (intent.kind === "request_job_recommendations" && state.context.verifiedRecruitmentSite !== undefined) {
        return {
          target: { kind: "recruitment_site", recruitmentSite: state.context.verifiedRecruitmentSite }
        };
      }
      return { resolutionError: "target_required" };
    }
    return {};
  }
  if (target.kind === "recommendation") {
    const sessionId = state.context.activeJobMatchSessionId;
    if (sessionId === undefined) return { resolutionError: "recommendation_context_missing" };
    const resultId = target.ordinal === undefined
      ? target.id
      : state.context.recentPostingIds[target.ordinal - 1];
    if (resultId === undefined) {
      return { resolutionError: `recommendation_ordinal_${target.ordinal ?? 0}_missing` };
    }
    const aggregate = dependencies.jobMatchRepository.get(sessionId);
    if (aggregate === undefined) return { resolutionError: "job_match_session_not_found" };
    const result = aggregate.results.find((candidate) =>
      target.ordinal === undefined ? candidate.id === resultId : candidate.postingId === resultId
    );
    if (result === undefined) return { resolutionError: "recommendation_not_found" };
    const posting = aggregate.postings.find((candidate) => candidate.id === result.postingId);
    if (posting === undefined) return { resolutionError: "recommendation_posting_not_found" };
    if (result.stale) return { resolutionError: "recommendation_stale" };
    return {
      target: {
        kind: "recommendation",
        sessionId,
        resultId: result.id,
        postingId: posting.id,
        postingContentHash: result.postingContentHash
      },
      traceIds: trace(dependencies, nodeEvent(state, "resolve_target", "resolved", "recommendation_resolved"), state.traceIds)
    };
  }
  if (target.kind === "task") {
    const taskId = target.id ?? state.context.activeApplicationTaskId;
    if (taskId === undefined || dependencies.applicationTasks.get(taskId) === undefined) {
      return { resolutionError: "application_task_not_found" };
    }
    return {
      target: { kind: "task", taskId },
      traceIds: trace(dependencies, nodeEvent(state, "resolve_target", "resolved", "task_resolved"), state.traceIds)
    };
  }
  if (target.kind === "recruitment_site") {
    if (target.company === undefined || target.recruitmentType === undefined) {
      return { resolutionError: "recruitment_company_required" };
    }
    return {
      target: {
        kind: "recruitment_site",
        recruitmentCompany: target.company,
        recruitmentType: target.recruitmentType
      }
    };
  }
  if (target.kind === "application_url") {
    if (target.url === undefined) return { resolutionError: "application_url_required" };
    return {
      target: { kind: "application_url", applicationUrl: target.url },
      traceIds: trace(dependencies, nodeEvent(state, "resolve_target", "resolved", "application_url_resolved"), state.traceIds)
    };
  }
  return { resolutionError: "job_match_session_target_unsupported" };
}

function policyGate(state: GraphState): Partial<GraphState> {
  if (state.resolutionError !== undefined || state.intent?.kind === "unknown" || state.intent?.kind === "help") {
    return { route: "persist" };
  }
  if (
    state.inputKind === "confirmation"
    || state.intent?.kind === "start_application"
    || state.intent?.kind === "start_application_and_show_status"
    || state.intent?.kind === "discover_recruitment_site"
    || state.intent?.kind === "request_job_recommendations"
  ) {
    return { route: "side_effect" };
  }
  return { route: "read" };
}

async function executeRead(
  dependencies: ConversationGraphDependencies,
  registry: ReturnType<typeof createConversationToolRegistry>,
  state: GraphState
): Promise<Partial<GraphState>> {
  const intent = state.intent ?? unknownIntent();
  let traceIds = state.traceIds;
  try {
    let toolResult: ConversationToolResult = { cards: [] };
    let invocation: ToolInvocationResult | undefined;
    if (intent.kind === "list_recommendations") {
      invocation = await invokeTool(dependencies, registry, state, "execute_read", "list_recommendations", {
        ...(state.context.activeJobMatchSessionId === undefined ? {} : { sessionId: state.context.activeJobMatchSessionId })
      });
    } else if (intent.kind === "show_recommendation" && state.target?.kind === "recommendation") {
      invocation = await invokeTool(dependencies, registry, state, "execute_read", "show_recommendation", {
        sessionId: state.target.sessionId,
        resultId: state.target.resultId
      });
    } else if (intent.kind === "list_application_tasks") {
      invocation = await invokeTool(dependencies, registry, state, "execute_read", "list_application_tasks", {});
    } else if (intent.kind === "show_application_task" && state.target?.kind === "task") {
      invocation = await invokeTool(dependencies, registry, state, "execute_read", "show_application_task", { taskId: state.target.taskId });
    }
    if (invocation !== undefined) {
      traceIds = invocation.traceIds;
      if (!invocation.ok) {
        const code = errorCode(invocation.error);
        return {
          cards: [],
          assistantText: userFacingError(code),
          failureCode: code,
          traceIds: trace(dependencies, nodeEvent(state, "execute_read", "failed", code), traceIds)
        };
      }
      toolResult = invocation.result;
    }
    const text = readText(intent.kind, toolResult.cards.length);
    return {
      cards: toolResult.cards,
      toolResult,
      assistantText: text,
      traceIds: trace(dependencies, nodeEvent(state, "execute_read", "completed", `read_${intent.kind}`), traceIds)
    };
  } catch (error) {
    const code = errorCode(error);
    return {
      cards: [],
      assistantText: userFacingError(code),
      failureCode: code,
      traceIds: trace(dependencies, nodeEvent(state, "execute_read", "failed", code), traceIds)
    };
  }
}

async function prepareSideEffect(
  dependencies: ConversationGraphDependencies,
  registry: ReturnType<typeof createConversationToolRegistry>,
  confirmations: ConversationConfirmationStore,
  state: GraphState
): Promise<Partial<GraphState>> {
  const pending = state.inputKind === "confirmation"
    ? confirmations.peek(state.conversationId, state.confirmationId!)
    : undefined;
  if (pending !== undefined && state.confirmationSourceTurnSequence !== undefined) {
    completeWaitingStep(dependencies, state, pending);
  }
  const processing = state.inputKind === "confirmation"
    ? processTraceFor(dependencies, state).start({
      stepId: "processing-confirmation",
      stage: "processing_confirmation",
      summary: "正在处理你的确认"
    })
    : undefined;
  const finishProcessing = (result: Partial<GraphState>): Partial<GraphState> => {
    if (processing === undefined) return result;
    if (result.failureCode === undefined) {
      processing.complete({ summary: "确认已处理" });
    } else {
      const failure = publicProcessFailure(result.failureCode);
      processing.fail({ summary: failure.summary, failure });
    }
    return result;
  };

  if (state.inputKind !== "confirmation" && state.intent?.kind === "discover_recruitment_site") {
    return prepareRecruitmentDiscovery(dependencies, registry, confirmations, state);
  }

  if (state.inputKind !== "confirmation" && state.intent?.kind === "request_job_recommendations") {
    return prepareRecruitmentRequestConfirmation(dependencies, confirmations, state);
  }

  if (state.inputKind !== "confirmation" && state.target?.kind === "application_url") {
    return prepareDirectApplicationConfirmation(dependencies, confirmations, state);
  }

  if (pending?.action === "start_application") {
    const consumed = confirmations.consume(state.conversationId, state.confirmationId!);
    if (consumed === undefined) {
      return finishProcessing({
        cards: [],
        assistantText: "这条确认已失效或已经使用，请重新发起投递。",
        consumedConfirmationId: state.confirmationId!,
        failureCode: "confirmation_invalid",
        traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "rejected", "confirmation_invalid"), state.traceIds)
      });
    }
    if (state.approved !== true) {
      return finishProcessing({
        cards: [],
        assistantText: "已取消进入投递，当前没有创建新的投递任务。",
        consumedConfirmationId: consumed.confirmationId,
        traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "cancelled", "confirmation_declined"), state.traceIds)
      });
    }
    try {
      const target = state.target;
      if (target?.kind === "application_url" && target.applicationUrl !== undefined) {
        const invocation = await invokeTool(dependencies, registry, state, "prepare_side_effect", "create_application_task", {
          applicationUrl: target.applicationUrl
        });
        if (!invocation.ok) {
          const code = errorCode(invocation.error);
          return finishProcessing({
            cards: [],
            assistantText: userFacingError(code),
            consumedConfirmationId: consumed.confirmationId,
            failureCode: code,
            traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "failed", code), invocation.traceIds)
          });
        }
        const toolResult = invocation.result;
        return finishProcessing({
          cards: toolResult.cards,
          toolResult,
          assistantText: "已创建受控填写任务，可以打开任务工作台继续处理。",
          consumedConfirmationId: consumed.confirmationId,
          contextPatch: {
            ...(toolResult.task?.id === undefined ? {} : { activeApplicationTaskId: toolResult.task.id })
          },
          traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "completed", "direct_application_task_created"), invocation.traceIds)
        });
      }
      if (target?.kind !== "recommendation" || target.sessionId === undefined || target.resultId === undefined || target.postingContentHash === undefined) {
        throw new Error("recommendation_target_invalid");
      }
      const invocation = await invokeTool(dependencies, registry, state, "prepare_side_effect", "create_application_task", {
        sessionId: target.sessionId,
        resultId: target.resultId,
        postingContentHash: target.postingContentHash
      });
      if (!invocation.ok) {
        const code = errorCode(invocation.error);
        return finishProcessing({
          cards: [],
          assistantText: userFacingError(code),
          consumedConfirmationId: consumed.confirmationId,
          failureCode: code,
          traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "failed", code), invocation.traceIds)
        });
      }
      const toolResult = invocation.result;
      return finishProcessing({
        cards: toolResult.cards,
        toolResult,
        assistantText: "已创建受控投递任务，可以打开任务工作台继续处理。",
        consumedConfirmationId: consumed.confirmationId,
        contextPatch: {
          activeJobMatchSessionId: target.sessionId,
          ...(target.postingId === undefined ? {} : { selectedPostingId: target.postingId }),
          ...(toolResult.task?.id === undefined ? {} : { activeApplicationTaskId: toolResult.task.id })
        },
        traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "completed", "application_task_created"), invocation.traceIds)
      });
    } catch (error) {
      const code = errorCode(error);
      return finishProcessing({
        cards: [],
        assistantText: userFacingError(code),
        consumedConfirmationId: consumed.confirmationId,
        failureCode: code,
        traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "failed", code), state.traceIds)
      });
    }
  }

  if (state.inputKind === "confirmation") {
    return finishProcessing(await prepareRecruitmentConfirmation(dependencies, registry, confirmations, state, pending));
  }

  if (state.target?.kind !== "recommendation" || state.target.sessionId === undefined || state.target.resultId === undefined || state.target.postingContentHash === undefined) {
    return {
      cards: [],
      assistantText: "请先从当前岗位推荐中明确选择一个岗位。",
      failureCode: "recommendation_target_required",
      traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "clarification", "recommendation_target_required"), state.traceIds)
    };
  }

  const confirmation: ConversationConfirmation = {
    confirmationId: randomUUID(),
    action: "start_application",
    sourceTurnSequence: state.turnSequence,
    target: {
      kind: "recommendation",
      sessionId: state.target.sessionId,
      resultId: state.target.resultId,
      postingContentHash: state.target.postingContentHash
    }
  };
  confirmations.put(state.conversationId, confirmation);
  const card = ConversationCardSchema.parse({
    type: "confirmation",
    confirmationId: confirmation.confirmationId,
    action: "start_application",
    target: confirmation.target
  });
  recordWaitingStep(dependencies, state, confirmation.action);
  return {
    cards: [card],
    pendingConfirmation: confirmation,
    assistantText: "已找到目标岗位。进入受控投递前需要你的确认。",
    traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "pending", "confirmation_required"), state.traceIds)
  };
}

async function prepareRecruitmentDiscovery(
  dependencies: ConversationGraphDependencies,
  registry: ReturnType<typeof createConversationToolRegistry>,
  confirmations: ConversationConfirmationStore,
  state: GraphState
): Promise<Partial<GraphState>> {
  const target = state.target;
  const company = target?.recruitmentCompany ?? state.intent?.target?.company;
  const recruitmentType = target?.recruitmentType ?? state.intent?.target?.recruitmentType ?? "unknown";
  if (company === undefined) {
    return {
      cards: [],
      assistantText: "请告诉我想投递的公司名称，例如“帮我投递百度校园招聘”。",
      traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "clarification", "recruitment_company_required"), state.traceIds)
    };
  }
  const request: RecruitmentSearchRequest = { companyName: company, recruitmentType };
  const manualUrl = extractSingleHttpsUrl(state.text ?? "");
  if (manualUrl !== undefined && state.context.lastRecruitmentRequest !== undefined) {
    return prepareManualRecruitmentLink(
      dependencies,
      confirmations,
      state,
      state.context.lastRecruitmentRequest,
      manualUrl
    );
  }
  const invocation = await invokeTool(dependencies, registry, state, "prepare_side_effect", "discover_recruitment_site", {
    company,
    recruitmentType
  });
  if (!invocation.ok) {
    const code = errorCode(invocation.error);
    return {
      cards: [],
      assistantText: userFacingError(code),
      failureCode: code,
      contextPatch: { lastRecruitmentRequest: request, verifiedRecruitmentSite: undefined },
      traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "failed", code), invocation.traceIds)
    };
  }
  const search = invocation.result.recruitmentSearch;
  if (search === undefined || search.candidates.length === 0) {
    return {
      cards: [],
      assistantText: userFacingError("NO_SAFE_CANDIDATE"),
      failureCode: "NO_SAFE_CANDIDATE",
      contextPatch: { lastRecruitmentRequest: request, verifiedRecruitmentSite: undefined },
      traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "failed", "NO_SAFE_CANDIDATE"), invocation.traceIds)
    };
  }
  const validatedSearch = validateRecruitmentSearchResult(dependencies, state, search);
  if (validatedSearch === undefined) {
    return {
      cards: [],
      assistantText: userFacingError("NO_SAFE_CANDIDATE"),
      failureCode: "NO_SAFE_CANDIDATE",
      contextPatch: { lastRecruitmentRequest: request, verifiedRecruitmentSite: undefined },
      traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "failed", "NO_SAFE_CANDIDATE"), invocation.traceIds)
    };
  }
  const confirmation = recruitmentChoicesConfirmation(state.turnSequence, company, recruitmentType, validatedSearch);
  confirmations.put(state.conversationId, confirmation);
  recordWaitingStep(dependencies, state, confirmation.action);
  return {
    cards: [confirmationCard(confirmation)],
    toolResult: { ...invocation.result, recruitmentSearch: validatedSearch },
    pendingConfirmation: confirmation,
    contextPatch: { lastRecruitmentRequest: request, verifiedRecruitmentSite: undefined },
    assistantText: `已找到${company}的招聘入口候选，共 ${validatedSearch.candidates.length} 个。搜索候选，需你确认后才会继续。`,
    traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "pending", "recruitment_site_choices_confirmation_required"), invocation.traceIds)
  };
}

async function prepareDirectApplicationConfirmation(
  dependencies: ConversationGraphDependencies,
  confirmations: ConversationConfirmationStore,
  state: GraphState
): Promise<Partial<GraphState>> {
  const rawUrl = state.target?.kind === "application_url" ? state.target.applicationUrl : undefined;
  if (rawUrl === undefined) {
    return { cards: [], assistantText: userFacingError("application_url_required"), failureCode: "application_url_required" };
  }
  const validator = dependencies.validatePublicHttpsUrl ?? validatePublicHttpsUrl;
  let validated: { url: string; domain: string };
  try {
    validated = await validator(rawUrl);
  } catch {
    return {
      cards: [],
      assistantText: userFacingError("unsafe_application_url"),
      failureCode: "unsafe_application_url",
      traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "rejected", "unsafe_application_url"), state.traceIds)
    };
  }
  const confirmation: ConversationConfirmation = {
    confirmationId: randomUUID(),
    action: "start_application",
    sourceTurnSequence: state.turnSequence,
    target: { kind: "application_url", url: validated.url }
  };
  confirmations.put(state.conversationId, confirmation);
  recordWaitingStep(dependencies, state, confirmation.action);
  return {
    cards: [confirmationCard(confirmation)],
    pendingConfirmation: confirmation,
    assistantText: "已识别为申请填写页面。开始识别并填写前需要你的确认。",
    traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "pending", "direct_application_confirmation_required"), state.traceIds)
  };
}

function validateRecruitmentSearchResult(
  dependencies: ConversationGraphDependencies,
  state: GraphState,
  search: RecruitmentSiteSearchResult
): RecruitmentSiteSearchResult | undefined {
  const validation = processTraceFor(dependencies, state).start({
    stepId: "validate-recruitment-site",
    stage: "validating_recruitment_site",
    summary: "正在校验招聘入口",
    tool: recruitmentUrlGuardSummary()
  });
  const candidates = search.candidates.filter((candidate) => {
    try {
      const url = new URL(candidate.url);
      return url.protocol === "https:"
        && url.username === ""
        && url.password === ""
        && url.hostname !== "";
    } catch {
      return false;
    }
  });
  if (candidates.length === 0) {
    const failure = publicProcessFailure("NO_SAFE_CANDIDATE");
    validation.fail({
      summary: failure.summary,
      tool: recruitmentUrlGuardSummary(),
      failure
    });
    return undefined;
  }
  const validated = RecruitmentSiteSearchResultSchema.parse({ ...search, candidates });
  validation.complete({
    summary: "招聘入口已通过安全校验",
    tool: recruitmentUrlGuardSummary(`保留 ${validated.candidates.length} 个安全候选`)
  });
  return validated;
}

async function prepareManualRecruitmentLink(
  dependencies: ConversationGraphDependencies,
  confirmations: ConversationConfirmationStore,
  state: GraphState,
  request: RecruitmentSearchRequest,
  rawUrl: string
): Promise<Partial<GraphState>> {
  const validator = dependencies.validatePublicHttpsUrl ?? validatePublicHttpsUrl;
  const validation = processTraceFor(dependencies, state).start({
    stepId: "validate-recruitment-site",
    stage: "validating_recruitment_site",
    summary: "正在校验招聘入口",
    tool: recruitmentUrlGuardSummary()
  });
  let validated: { url: string; domain: string };
  try {
    validated = await validator(rawUrl);
  } catch {
    const failure = publicProcessFailure("unsafe_recruitment_url");
    validation.fail({
      summary: failure.summary,
      tool: recruitmentUrlGuardSummary(),
      failure
    });
    return {
      cards: [],
      assistantText: userFacingError("unsafe_recruitment_url"),
      failureCode: "unsafe_recruitment_url",
      contextPatch: { lastRecruitmentRequest: request, verifiedRecruitmentSite: undefined },
      traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "rejected", "unsafe_recruitment_url"), state.traceIds)
    };
  }
  validation.complete({
    summary: "招聘入口已通过安全校验",
    tool: recruitmentUrlGuardSummary("链接已通过公网 HTTPS 校验")
  });
  const candidate: RecruitmentSiteCandidate = {
    title: `${request.companyName}招聘入口`,
    url: validated.url,
    domain: validated.domain,
    snippet: "用户提供的招聘链接，仍需确认后使用。",
    source: "user"
  };
  const search: RecruitmentSiteSearchResult = RecruitmentSiteSearchResultSchema.parse({
    query: recruitmentQuery(request.companyName, request.recruitmentType),
    candidates: [candidate]
  });
  const confirmation = recruitmentChoicesConfirmation(state.turnSequence, request.companyName, request.recruitmentType, search);
  confirmations.put(state.conversationId, confirmation);
  return {
    cards: [confirmationCard(confirmation)],
    pendingConfirmation: confirmation,
    contextPatch: { lastRecruitmentRequest: request, verifiedRecruitmentSite: undefined },
    assistantText: "已收到你提供的招聘链接。它仍需经过确认后才能使用。",
    traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "pending", "manual_recruitment_url_confirmation_required"), state.traceIds)
  };
}

function prepareRecruitmentRequestConfirmation(
  dependencies: ConversationGraphDependencies,
  confirmations: ConversationConfirmationStore,
  state: GraphState
): Partial<GraphState> {
  const site = state.context.verifiedRecruitmentSite;
  if (site === undefined) {
    return {
      cards: [],
      assistantText: userFacingError("recruitment_site_confirmation_required"),
      failureCode: "recruitment_site_confirmation_required"
    };
  }
  const confirmation = recruitmentConfirmation(state.turnSequence, "request_job_recommendations", site);
  confirmations.put(state.conversationId, confirmation);
  recordWaitingStep(dependencies, state, confirmation.action);
  return {
    cards: [recruitmentSiteCard(site), confirmationCard(confirmation)],
    pendingConfirmation: confirmation,
    contextPatch: { verifiedRecruitmentSite: site },
    assistantText: "官方招聘入口已确认。需要我继续为你做岗位推荐吗？"
  };
}

async function prepareRecruitmentConfirmation(
  dependencies: ConversationGraphDependencies,
  registry: ReturnType<typeof createConversationToolRegistry>,
  confirmations: ConversationConfirmationStore,
  state: GraphState,
  pending: ConversationConfirmation | undefined
): Promise<Partial<GraphState>> {
  if (pending === undefined || (pending.target.kind !== "recruitment_site" && pending.target.kind !== "recruitment_site_choices")) {
    return {
      cards: [],
      assistantText: userFacingError("confirmation_invalid"),
      failureCode: "confirmation_invalid",
      ...(state.confirmationId === undefined ? {} : { consumedConfirmationId: state.confirmationId })
    };
  }
  const consumed = confirmations.consume(state.conversationId, pending.confirmationId);
  if (consumed === undefined) {
    return {
      cards: [],
      assistantText: userFacingError("confirmation_invalid"),
      failureCode: "confirmation_invalid",
      consumedConfirmationId: pending.confirmationId
    };
  }
  if (pending.target.kind === "recruitment_site_choices") {
    if (state.approved !== true) {
      return {
        cards: [],
        assistantText: "已取消使用这些招聘入口候选，不会创建岗位匹配会话。",
        consumedConfirmationId: consumed.confirmationId,
        contextPatch: { verifiedRecruitmentSite: undefined }
      };
    }
    if (state.selectedUrl === undefined) {
      return {
        cards: [],
        assistantText: userFacingError("recruitment_site_selection_invalid"),
        failureCode: "recruitment_site_selection_invalid",
        consumedConfirmationId: consumed.confirmationId
      };
    }
    const selectedUrl = normalizeSelectedUrl(state.selectedUrl);
    const candidate = selectedUrl === undefined
      ? undefined
      : pending.target.candidates.find((item) => item.url === selectedUrl);
    if (candidate === undefined) {
      return {
        cards: [],
        assistantText: userFacingError("recruitment_site_selection_invalid"),
        failureCode: "recruitment_site_selection_invalid",
        consumedConfirmationId: consumed.confirmationId
      };
    }
    const site = VerifiedRecruitmentSiteSchema.parse({
      company: pending.target.company,
      recruitmentType: pending.target.recruitmentType,
      query: pending.target.query,
      ...candidate
    });
    const nextConfirmation = recruitmentConfirmation(state.turnSequence, "request_job_recommendations", site);
    confirmations.put(state.conversationId, nextConfirmation);
    recordWaitingStep(dependencies, state, nextConfirmation.action);
    return {
      cards: [recruitmentSiteCard(site), confirmationCard(nextConfirmation)],
      pendingConfirmation: nextConfirmation,
      contextPatch: { verifiedRecruitmentSite: site },
      consumedConfirmationId: consumed.confirmationId,
      assistantText: "招聘入口已确认。需要我继续为你做岗位推荐吗？"
    };
  }
  const site = siteFromConfirmationTarget(pending.target);
  if (site === undefined) {
    return {
      cards: [],
      assistantText: userFacingError("recruitment_site_invalid"),
      failureCode: "recruitment_site_invalid",
      consumedConfirmationId: consumed.confirmationId
    };
  }
  if (state.approved !== true) {
    return {
      cards: [recruitmentSiteCard(site)],
      assistantText: pending.action === "confirm_recruitment_site"
        ? "已取消使用这个招聘入口，不会创建岗位匹配会话。"
        : "好的，暂不进行岗位推荐。",
      consumedConfirmationId: consumed.confirmationId,
      contextPatch: pending.action === "confirm_recruitment_site"
        ? { verifiedRecruitmentSite: undefined }
        : { verifiedRecruitmentSite: site }
    };
  }
  if (pending.action === "confirm_recruitment_site") {
    const nextConfirmation = recruitmentConfirmation(state.turnSequence, "request_job_recommendations", site);
    confirmations.put(state.conversationId, nextConfirmation);
    recordWaitingStep(dependencies, state, nextConfirmation.action);
    return {
      cards: [recruitmentSiteCard(site), confirmationCard(nextConfirmation)],
      pendingConfirmation: nextConfirmation,
      contextPatch: { verifiedRecruitmentSite: site },
      consumedConfirmationId: consumed.confirmationId,
      assistantText: "官方招聘入口已确认。需要我继续为你做岗位推荐吗？"
    };
  }

  const invocation = await invokeTool(dependencies, registry, state, "prepare_side_effect", "create_job_match_session", {});
  if (!invocation.ok) {
    const code = errorCode(invocation.error);
    return {
      cards: [],
      assistantText: userFacingError(code),
      failureCode: code,
      consumedConfirmationId: consumed.confirmationId,
      traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "failed", code), invocation.traceIds)
    };
  }
  const session = invocation.result.jobMatchSession;
  if (session === undefined) {
    return {
      cards: [],
      assistantText: userFacingError("job_match_session_missing"),
      failureCode: "job_match_session_missing",
      consumedConfirmationId: consumed.confirmationId,
      traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "failed", "job_match_session_missing"), invocation.traceIds)
    };
  }
  return {
    cards: invocation.result.cards,
    toolResult: invocation.result,
    assistantText: "已进入岗位匹配工作台，完成筛选确认后会展示岗位推荐。",
    consumedConfirmationId: consumed.confirmationId,
    contextPatch: {
      verifiedRecruitmentSite: site,
      activeJobMatchSessionId: session.sessionId,
      recentPostingIds: session.postingIds
    },
    traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "completed", "job_match_session_created"), invocation.traceIds)
  };
}

function recruitmentConfirmation(
  sourceTurnSequence: number,
  action: "request_job_recommendations",
  site: VerifiedRecruitmentSite
): ConversationConfirmation {
  return {
    confirmationId: randomUUID(),
    action,
    sourceTurnSequence,
    target: { kind: "recruitment_site", ...site }
  };
}

function recruitmentChoicesConfirmation(
  sourceTurnSequence: number,
  company: string,
  recruitmentType: RecruitmentSearchRequest["recruitmentType"],
  search: RecruitmentSiteSearchResult
): ConversationConfirmation {
  return {
    confirmationId: randomUUID(),
    action: "confirm_recruitment_site",
    sourceTurnSequence,
    target: {
      kind: "recruitment_site_choices",
      company,
      recruitmentType,
      query: search.query,
      candidates: search.candidates
    }
  };
}

function confirmationCard(confirmation: ConversationConfirmation): ConversationCard {
  return ConversationCardSchema.parse({
    type: "confirmation",
    confirmationId: confirmation.confirmationId,
    action: confirmation.action,
    target: confirmation.target
  });
}

function recruitmentSiteCard(site: VerifiedRecruitmentSite): ConversationCard {
  return ConversationCardSchema.parse({ type: "recruitment_site", ...site });
}

function siteFromConfirmationTarget(
  target: Extract<ConversationConfirmation["target"], { kind: "recruitment_site" }>
): VerifiedRecruitmentSite | undefined {
  const { kind: _kind, ...site } = target;
  const parsed = VerifiedRecruitmentSiteSchema.safeParse(site);
  return parsed.success ? parsed.data : undefined;
}

async function invokeTool(
  dependencies: ConversationGraphDependencies,
  registry: ReturnType<typeof createConversationToolRegistry>,
  state: GraphState,
  node: string,
  name: ConversationToolName,
  input: unknown
): Promise<ToolInvocationResult> {
  const startedAt = Date.now();
  const toolStart = summarizeToolStart(name, input);
  const processStep = processTraceFor(dependencies, state).start({
    stepId: toolStepId(name),
    stage: toolProcessStage(name),
    summary: toolProcessSummary(name),
    tool: { ...toolStart, result: "执行中" }
  });
  try {
    const result = await registry.invoke(name, input, toolContext(state));
    const tool = summarizeToolResult(name, input, result);
    processStep.complete({
      summary: tool.result ?? "工具执行完成",
      tool
    });
    return {
      ok: true,
      result,
      traceIds: trace(dependencies, {
        conversationId: state.conversationId,
        node,
        kind: "tool_call",
        toolName: name,
        outcome: "completed",
        reasonCode: "tool_completed",
        durationMs: elapsedMs(startedAt),
        counts: { results: result.cards.length }
      }, state.traceIds)
    };
  } catch (error) {
    const code = errorCode(error);
    const failure = publicProcessFailure(code);
    processStep.fail({
      summary: failure.summary,
      tool: toolStart,
      failure
    });
    return {
      ok: false,
      error,
      traceIds: trace(dependencies, {
        conversationId: state.conversationId,
        node,
        kind: "tool_call",
        toolName: name,
        outcome: "failed",
        reasonCode: code,
        errorCode: code,
        durationMs: elapsedMs(startedAt)
      }, state.traceIds)
    };
  }
}

function persistTurn(
  dependencies: ConversationGraphDependencies,
  now: () => Date,
  state: GraphState
): Partial<GraphState> {
  const intent = state.intent ?? unknownIntent();
  const failureCode = state.failureCode ?? state.resolutionError;
  const generating = failureCode === undefined
    ? processTraceFor(dependencies, state).start({
      stepId: "generate-response",
      stage: "generating_response",
      summary: "正在生成回复"
    })
    : undefined;
  const assistantText = state.assistantText
    ?? (failureCode === undefined ? defaultAssistantText(intent.kind) : userFacingError(failureCode));
  const cards = (Array.isArray(state.cards) ? state.cards : []).map((card) => ConversationCardSchema.parse(card));
  const sequence = Number.isSafeInteger(state.sequence) && state.sequence >= 0 ? state.sequence : 0;
  const nextContext = ConversationContextSchema.parse({
    ...state.context,
    ...(state.contextPatch ?? {}),
    lastIntent: intent,
    version: state.context.version + 1
  });
  const message = ConversationMessageSchema.parse({
    id: randomUUID(),
    sessionId: state.conversationId,
    sequence: Math.max(1, sequence + 1),
    role: "assistant",
    text: assistantText,
    cards,
    intent,
    createdAt: now().toISOString()
  });
  const response = ConversationTurnResponseSchema.parse({
    message,
    cards,
    context: nextContext,
    ...(state.pendingConfirmation === undefined ? {} : { pendingConfirmation: state.pendingConfirmation, confirmationId: state.pendingConfirmation.confirmationId }),
    ...(state.consumedConfirmationId === undefined ? {} : { consumedConfirmationId: state.consumedConfirmationId })
  });
  if (generating !== undefined) {
    generating.complete({ summary: "回复已生成" });
  } else if (failureCode !== undefined) {
    emitProcessEventInput(dependencies, {
      conversationId: state.conversationId,
      turnSequence: state.turnSequence,
      stepId: "process-failed",
      stage: "failed",
      status: "failed",
      summary: userFacingError(failureCode),
      failure: publicProcessFailure(failureCode)
    });
  }
  return {
    context: nextContext,
    response,
    intent,
    traceIds: trace(dependencies, nodeEvent(state, "persist_turn", "completed", "turn_persisted"), state.traceIds)
  };
}

function confirmationIntent(confirmation: ConversationConfirmation): ConversationIntent {
  if (confirmation.action === "start_application") {
    if (confirmation.target.kind === "application_url") {
      return ConversationIntentSchema.parse({
        kind: "start_application",
        target: confirmation.target,
        requiresConfirmation: true
      });
    }
    return ConversationIntentSchema.parse({
      kind: "start_application",
      target: { kind: "recommendation", id: confirmation.target.resultId },
      requiresConfirmation: true
    });
  }
  return ConversationIntentSchema.parse({
    kind: confirmation.action === "confirm_recruitment_site"
      ? "discover_recruitment_site"
      : "request_job_recommendations",
    target: { kind: "recruitment_site", company: confirmation.target.company, recruitmentType: confirmation.target.recruitmentType },
    requiresConfirmation: true
  });
}

function deterministicIntent(text: string): ConversationIntent {
  const recruitmentRequest = extractRecruitmentRequest(text);
  if (recruitmentRequest !== undefined) {
    return ConversationIntentSchema.parse({
      kind: "discover_recruitment_site",
      target: {
        kind: "recruitment_site",
        company: recruitmentRequest.company,
        recruitmentType: recruitmentRequest.recruitmentType
      },
      requiresConfirmation: false
    });
  }
  const ordinal = extractOrdinal(text);
  const target = ordinal === undefined ? undefined : { kind: "recommendation" as const, ordinal };
  if (/\u6295\u9012/u.test(text) && ordinal !== undefined && !/[\u67e5\u770b\u8fdb\u5ea6\u72b6\u6001]/u.test(text)) {
    return ConversationIntentSchema.parse({ kind: "start_application", target, requiresConfirmation: true });
  }
  if (/投递[\s\S]*(查看|看看|查询)[\s\S]*(进度|状态)|投递[\s\S]*进度/u.test(text)) {
    return ConversationIntentSchema.parse({ kind: "start_application_and_show_status", target, requiresConfirmation: true });
  }
  if (/投递|申请/u.test(text) && ordinal !== undefined) {
    return ConversationIntentSchema.parse({ kind: "start_application", target, requiresConfirmation: true });
  }
  if (/我投了哪些|投递了哪些|我的投递|投递任务/u.test(text)) {
    return ConversationIntentSchema.parse({ kind: "list_application_tasks" });
  }
  if (/第\s*(?:\d+|[一二三四五六七八九十])[个份]?\s*(?:岗位|职位)|查看匹配|推荐岗位|岗位推荐/u.test(text)) {
    return ConversationIntentSchema.parse({
      kind: ordinal === undefined ? "list_recommendations" : "show_recommendation",
      ...(target === undefined ? {} : { target })
    });
  }
  if (/帮助|能做什么|怎么用/u.test(text)) return ConversationIntentSchema.parse({ kind: "help" });
  return unknownIntent();
}

function extractRecruitmentRequest(text: string): { company: string; recruitmentType: RecruitmentSearchRequest["recruitmentType"] } | undefined {
  const typedMatch = /(?:投递|申请|查找|搜索|看看|查看)(?:一下|一份)?\s*([\p{L}\p{N}][\p{L}\p{N}&·_.-]{1,79}?)(?:的)?(校园招聘|校招|社会招聘|社招|实习招聘|实习|招聘官网)/u.exec(text);
  if (typedMatch?.[1] !== undefined && typedMatch[2] !== undefined) {
    const type = typedMatch[2];
    return {
      company: typedMatch[1].trim(),
      recruitmentType: /校园招聘|校招/u.test(type)
        ? "campus"
        : /社会招聘|社招/u.test(type)
          ? "social"
          : /实习招聘|实习/u.test(type)
            ? "internship"
            : "unknown"
    };
  }
  if (/(?:校园招聘|校招|社会招聘|社招|实习招聘|实习|招聘官网)/u.test(text)) return undefined;
  if (/开始投递/u.test(text)) return undefined;
  const shortRequest = /^(?:我想|帮我|请)?\s*投递(?:一下)?\s*([\p{L}\p{N}][\p{L}\p{N}&·_.-]{1,79})\s*$/u.exec(text.trim());
  const company = shortRequest?.[1]?.trim();
  if (company === undefined || /^第(?:\d+|[零一二两三四五六七八九十百千万]+)(?:个|份|项)?$/u.test(company)) {
    return undefined;
  }
  return { company, recruitmentType: "unknown" };
}

function extractSingleHttpsUrl(text: string): string | undefined {
  const matches = [...text.matchAll(/https:\/\/[^\s<>"']+/giu)]
    .map((match) => match[0]?.replace(/[),.;!?，。；！？]+$/u, ""))
    .filter((value): value is string => value !== undefined);
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizeSelectedUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return undefined;
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function recruitmentQuery(company: string, recruitmentType: RecruitmentSearchRequest["recruitmentType"]): string {
  const labels = {
    campus: "校园招聘",
    social: "社会招聘",
    internship: "实习招聘",
    unknown: "招聘"
  } as const;
  return `${company} ${labels[recruitmentType]} 招聘 官网`;
}

function extractOrdinal(text: string): number | undefined {
  const match = /第\s*(\d+|零|一|二|两|三|四|五|六|七|八|九|十)\s*(?:个|份|项)?/u.exec(text);
  if (match === null) return undefined;
  const value = match[1];
  if (value === undefined) return undefined;
  if (/^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 100 ? parsed : undefined;
  }
  const values: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const parsed = values[value];
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function normalizeIntent(intent: ConversationIntent): ConversationIntent {
  if (intent.kind === "start_application" || intent.kind === "start_application_and_show_status") {
    return { ...intent, requiresConfirmation: true };
  }
  return { ...intent, requiresConfirmation: false };
}

function unknownIntent(): ConversationIntent {
  return ConversationIntentSchema.parse({ kind: "unknown", requiresConfirmation: false });
}

function resolveRecommendationByIds(
  dependencies: ConversationGraphDependencies,
  sessionId: string,
  resultId: string
): { value?: ResolvedTarget; error?: string } {
  const aggregate = dependencies.jobMatchRepository.get(sessionId);
  if (aggregate === undefined) return { error: "job_match_session_not_found" };
  const result = aggregate.results.find((candidate) => candidate.id === resultId);
  if (result === undefined) return { error: "recommendation_not_found" };
  if (result.stale) return { error: "recommendation_stale" };
  const posting = aggregate.postings.find((candidate) => candidate.id === result.postingId);
  if (posting === undefined) return { error: "recommendation_posting_not_found" };
  return {
    value: {
      kind: "recommendation",
      sessionId,
      resultId,
      postingId: posting.id,
      postingContentHash: result.postingContentHash
    }
  };
}

function toolContext(state: GraphState): ConversationToolContext {
  return {
    conversationId: state.conversationId,
    recentPostingIds: state.context.recentPostingIds,
    ...(state.context.activeJobMatchSessionId === undefined ? {} : { activeJobMatchSessionId: state.context.activeJobMatchSessionId }),
    ...(state.context.selectedPostingId === undefined ? {} : { selectedPostingId: state.context.selectedPostingId }),
    ...(state.context.activeApplicationTaskId === undefined ? {} : { activeApplicationTaskId: state.context.activeApplicationTaskId }),
    ...(state.context.verifiedRecruitmentSite === undefined ? {} : { verifiedRecruitmentSite: state.context.verifiedRecruitmentSite })
  };
}

function hasExplicitFillingIntent(text: string): boolean {
  return /填写|填表|填写申请|申请表|开始识别并填写/u.test(text);
}

function hasRecruitmentUrlIntent(text: string): boolean {
  return /招聘|岗位推荐|职位推荐|招聘入口|官方入口|招聘官网/u.test(text);
}

function isBareUrlMessage(text: string, url: string): boolean {
  return text.trim().replace(/[),.;!?，。；！？]+$/u, "") === url;
}

function processTraceFor(
  dependencies: ConversationGraphDependencies,
  state: GraphState
) {
  return createConversationProcessTrace({
    conversationId: state.conversationId,
    turnSequence: state.turnSequence,
    emit: (event: ConversationProcessEventInput) => dependencies.processEvents?.emit(event),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now })
  });
}

function emitProcessEventInput(
  dependencies: ConversationGraphDependencies,
  event: ConversationProcessEventInput
): void {
  try {
    dependencies.processEvents?.emit(event);
  } catch {
    // Process visibility is best effort and must not change the conversation result.
  }
}

function intentSummary(intent: ConversationIntent): string {
  switch (intent.kind) {
    case "discover_recruitment_site":
      return "已识别为招聘入口搜索请求";
    case "request_job_recommendations":
      return "已识别为岗位推荐请求";
    case "list_recommendations":
    case "show_recommendation":
      return "已识别为岗位推荐查询";
    case "list_application_tasks":
    case "show_application_task":
      return "已识别为投递进度查询";
    case "start_application":
    case "start_application_and_show_status":
      return "已识别为受控投递请求";
    case "help":
      return "已识别为帮助请求";
    case "unknown":
      return "暂未识别出可执行的求职操作";
  }
}

function toolStepId(name: ConversationToolName): string {
  return `tool-${name.replaceAll("_", "-")}`;
}

function toolProcessStage(name: ConversationToolName): ConversationProcessStage {
  switch (name) {
    case "discover_recruitment_site":
      return "searching_recruitment_site";
    case "create_job_match_session":
      return "creating_job_match_session";
    case "list_recommendations":
    case "show_recommendation":
      return "loading_recommendations";
    case "list_application_tasks":
    case "show_application_task":
      return "loading_application_progress";
    case "create_application_task":
      return "creating_application_task";
  }
}

function toolProcessSummary(name: ConversationToolName): string {
  switch (name) {
    case "discover_recruitment_site":
      return "正在搜索官方招聘入口";
    case "create_job_match_session":
      return "正在读取招聘页面并准备岗位匹配";
    case "list_recommendations":
    case "show_recommendation":
      return "正在读取岗位推荐";
    case "list_application_tasks":
    case "show_application_task":
      return "正在读取投递进度";
    case "create_application_task":
      return "正在创建受控投递任务";
  }
}

function recordWaitingStep(
  dependencies: ConversationGraphDependencies,
  state: GraphState,
  action: ConversationConfirmation["action"]
): void {
  const waiting = processTraceFor(dependencies, state).start({
    stepId: waitingStepId(action, state.turnSequence),
    stage: "waiting_for_confirmation",
    summary: "等待你的确认"
  });
  waiting.wait({ summary: "等待你的确认" });
}

function completeWaitingStep(
  dependencies: ConversationGraphDependencies,
  state: GraphState,
  pending: ConversationConfirmation
): void {
  const sourceTurnSequence = state.confirmationSourceTurnSequence ?? pending.sourceTurnSequence;
  if (sourceTurnSequence === undefined) return;
  emitProcessEventInput(dependencies, {
    conversationId: state.conversationId,
    turnSequence: state.turnSequence,
    stepId: waitingStepId(pending.action, sourceTurnSequence),
    stage: "waiting_for_confirmation",
    status: "completed",
    summary: "已收到你的确认",
    durationMs: 0
  });
}

function waitingStepId(
  action: ConversationConfirmation["action"],
  sourceTurnSequence: number
): string {
  return `waiting-${action.replaceAll("_", "-")}-${sourceTurnSequence}`;
}

function publicProcessFailure(code: string): ConversationProcessFailure {
  return {
    code: "PROCESS_STEP_FAILED",
    summary: userFacingError(code),
    retryable: !NON_RETRYABLE_PROCESS_ERRORS.has(code)
  };
}

const NON_RETRYABLE_PROCESS_ERRORS = new Set([
  "confirmation_invalid",
  "job_expectation_required",
  "job_match_application_redirect",
  "recommendation_context_missing",
  "recommendation_not_found",
  "recommendation_ordinal_1_missing",
  "recommendation_stale",
  "recommendation_target_required",
  "recruitment_company_required",
  "recruitment_site_confirmation_required",
  "recruitment_site_invalid",
  "recruitment_site_selection_invalid",
  "unsafe_recruitment_url",
  "unsupported_job_entry"
]);

function recruitmentUrlGuardSummary(result?: string): ConversationProcessToolSummary {
  return {
    name: "url_guard",
    input: [{ label: "范围", value: "公开招聘入口" }],
    ...(result === undefined ? {} : { result })
  };
}

function readText(kind: ConversationIntent["kind"], count: number): string {
  if (kind === "discover_recruitment_site") return "正在查找官方校园招聘入口。";
  if (kind === "request_job_recommendations") return "请确认是否继续进行岗位推荐。";
  if (kind === "list_application_tasks" || kind === "show_application_task") {
    return count === 0 ? "目前还没有已创建的投递任务。" : "这是当前已创建的投递任务。";
  }
  if (kind === "list_recommendations" || kind === "show_recommendation") {
    return count === 0 ? "当前没有可展示的岗位推荐。" : "这是当前岗位匹配结果。";
  }
  return defaultAssistantText(kind);
}

function defaultAssistantText(kind: ConversationIntent["kind"]): string {
  if (kind === "discover_recruitment_site") return "正在查找官方校园招聘入口。";
  if (kind === "request_job_recommendations") return "请确认是否继续进行岗位推荐。";
  if (kind === "help") return "我可以帮你查看岗位推荐、查看投递任务，并在确认后创建受控投递任务。";
  return "目前只能帮你查看岗位匹配、投递任务，或在确认后创建投递任务。";
}

function userFacingError(code: string): string {
  if (code === "TAVILY_NOT_CONFIGURED") return "联网搜索尚未配置。你可以配置 Tavily，或粘贴该公司的官方招聘链接。";
  if (code === "TAVILY_TIMEOUT" || code === "TAVILY_UNAVAILABLE") return "招聘入口搜索暂时不可用。你可以稍后重试，或粘贴该公司的官方招聘链接。";
  if (code === "TAVILY_PROTOCOL_ERROR" || code === "NO_SAFE_CANDIDATE") return "暂时没有找到可确认的招聘入口。请换一种公司名称，或粘贴官方招聘链接。";
  if (code === "recruitment_site_selection_invalid") return "所选招聘入口已失效，请重新搜索并确认。";
  if (code === "unsafe_recruitment_url") return "这个招聘链接未通过公网 HTTPS 安全校验，请粘贴公开的官方招聘链接。";
  if (code === "unsafe_application_url") return "这个填写链接未通过公网 HTTPS 安全校验，请粘贴公开的申请页面链接。";
  if (code === "application_url_required") return "请提供要填写的完整 HTTPS 申请页面链接。";
  if (code === "recruitment_site_confirmation_required") return "请先确认已找到的官方招聘入口。";
  if (code === "recruitment_site_invalid") return "招聘入口校验失败，请重新搜索官方入口。";
  if (code === "job_match_create_unavailable") return "岗位匹配服务暂时不可用，请稍后重试。";
  if (code === "job_expectation_required") return "开始岗位推荐前，请先补充并确认岗位期望（例如工作城市或职位方向）。";
  if (code === "unsupported_job_entry") return "当前招聘页面结构尚未识别，请确认链接打开的是岗位列表或岗位详情页。";
  if (code === "job_match_application_redirect") return "当前入口直接打开了申请页面，暂时无法从这里生成岗位推荐。";
  if (code === "job_match_session_missing") return "岗位匹配会话没有成功创建，请稍后重试。";
  switch (code) {
    case "tool_execution_failed":
      return "岗位推荐执行失败，请检查受控浏览器和招聘页面后重试。";
    case "conversation_operation_failed":
      return "对话操作执行失败，请稍后重试。";
    case "recommendation_context_missing":
    case "recommendation_ordinal_1_missing":
    case "recommendation_not_found":
      return "当前没有可确定的目标岗位，请先打开岗位匹配结果。";
    case "recommendation_stale":
    case "job_match_posting_changed":
      return "岗位匹配结果已变化，请刷新岗位匹配后再试。";
    case "browser_worker_unavailable":
    case "browser_open_unavailable":
      return "受控浏览器暂时不可用，可以稍后重试或打开已有投递任务。";
    case "browser_lease_in_use":
    case "browser_task_in_use":
      return "受控浏览器正在处理其他岗位匹配或投递任务，请等待当前任务完成或先暂停它后再试。";
    case "challenge_required":
    case "browser_challenge_required":
      return "投递页面需要额外验证，请手动接管浏览器完成验证后再继续。";
    case "policy_rejected":
    case "application_submission_locked":
      return "当前策略不允许提交，提交已锁定；请先检查投递审核要求。";
    case "confirmation_invalid":
      return "这条确认已失效或已经使用，请重新发起投递。";
    default:
      return "这项操作暂时无法完成，请检查当前岗位匹配或投递任务。";
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z0-9_:-]+$/u.test(error.message)) return error.message;
  return "conversation_operation_failed";
}

function nodeEvent(
  state: GraphState,
  node: string,
  outcome: string,
  reasonCode: string
) {
  return {
    conversationId: state.conversationId,
    node,
    kind: "node" as const,
    outcome,
    reasonCode: normalizeReason(reasonCode)
  };
}

function trace(
  dependencies: ConversationGraphDependencies,
  input: {
    conversationId: string;
    node: string;
    kind: "node" | "tool_call" | "model_decision" | "interrupt" | "checkpoint" | "safety_block";
    outcome: string;
    reasonCode: string;
    toolName?: string;
    confidence?: number;
    durationMs?: number;
    errorCode?: string;
    counts?: Record<string, number>;
  },
  existing: string[]
): string[] {
  if (dependencies.traceSink === undefined) return existing;
  try {
    const id = dependencies.traceSink.record({
      runId: input.conversationId,
      taskId: input.conversationId,
      node: `conversation_${input.node}`,
      kind: input.kind,
      outcome: input.outcome.slice(0, 80),
      reasonCode: normalizeReason(input.reasonCode),
      contentHash: createHash("sha256").update(input.conversationId).digest("hex"),
      ...(input.toolName === undefined ? {} : { toolName: input.toolName }),
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      ...(input.durationMs === undefined ? {} : { durationMs: elapsedDuration(input.durationMs) }),
      ...(input.counts === undefined ? {} : { counts: input.counts }),
      ...(input.errorCode === undefined ? {} : { errorCode: normalizeReason(input.errorCode) })
    });
    return [...existing, id];
  } catch {
    return existing;
  }
}

function elapsedMs(startedAt: number): number {
  return elapsedDuration(Date.now() - startedAt);
}

function elapsedDuration(value: number): number {
  return Math.min(86_400_000, Math.max(0, Math.floor(value)));
}

function normalizeReason(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_:-]/g, "_").slice(0, 80) || "conversation_event";
}

function replaceValue<T>(_left: T, right: T): T {
  return right;
}

function createMemoryConfirmationStore(): ConversationConfirmationStore {
  const values = new Map<string, ConversationConfirmation>();
  const key = (conversationId: string, confirmationId: string) => `${conversationId}\u0000${confirmationId}`;
  return {
    put(conversationId, value) { values.set(key(conversationId, value.confirmationId), value); },
    peek(conversationId, id) { return values.get(key(conversationId, id)); },
    consume(conversationId, id) {
      const value = values.get(key(conversationId, id));
      if (value !== undefined) values.delete(key(conversationId, id));
      return value;
    }
  };
}
