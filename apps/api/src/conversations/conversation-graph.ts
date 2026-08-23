import { createHash, randomUUID } from "node:crypto";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import {
  ConversationCardSchema,
  ConversationContextSchema,
  ConversationIntentSchema,
  ConversationMessageSchema,
  ConversationTurnResponseSchema,
  type ConversationCard,
  type ConversationConfirmation,
  type ConversationContext,
  type ConversationIntent,
  type ConversationTarget,
  type ConversationTurnResponse
} from "@resume/contracts";
import type { TraceSink } from "../agent/trace-sink.js";
import {
  createConversationToolRegistry,
  type ConversationToolContext,
  type ConversationToolDependencies,
  type ConversationToolName,
  type ConversationToolResult
} from "./conversation-tools.js";
import { z } from "zod";

const ConversationIdSchema = z.string().min(1).max(256);
const ConfirmationIdSchema = z.string().min(1).max(256);

const ConversationGraphInputSchema = z.object({
  conversationId: ConversationIdSchema,
  text: z.string().trim().min(1).max(500).optional(),
  context: ConversationContextSchema,
  sequence: z.number().int().nonnegative().optional(),
  confirmationId: ConfirmationIdSchema.optional(),
  approved: z.boolean().optional()
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
  now?: () => Date;
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
  kind: "recommendation" | "task";
  sessionId?: string;
  resultId?: string;
  postingId?: string;
  postingContentHash?: string;
  taskId?: string;
}

interface GraphState {
  conversationId: string;
  text?: string;
  context: ConversationContext;
  sequence: number;
  inputKind: InputKind;
  confirmationId?: string;
  approved?: boolean;
  intent?: ConversationIntent;
  target?: ResolvedTarget;
  resolutionError?: string;
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
  text: Annotation<string | undefined>({ reducer: replaceValue, default: () => undefined }),
  context: Annotation<ConversationContext>,
  sequence: Annotation<number>({ reducer: replaceValue, default: () => 0 }),
  inputKind: Annotation<InputKind>({ reducer: replaceValue, default: () => "message" }),
  confirmationId: Annotation<string | undefined>({ reducer: replaceValue, default: () => undefined }),
  approved: Annotation<boolean | undefined>({ reducer: replaceValue, default: () => undefined }),
  intent: Annotation<ConversationIntent | undefined>({ reducer: replaceValue, default: () => undefined }),
  target: Annotation<ResolvedTarget | undefined>({ reducer: replaceValue, default: () => undefined }),
  resolutionError: Annotation<string | undefined>({ reducer: replaceValue, default: () => undefined }),
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
        context: parsed.context,
        ...(parsed.text === undefined ? {} : { text: parsed.text }),
        ...(parsed.sequence === undefined ? {} : { sequence: parsed.sequence }),
        ...(parsed.confirmationId === undefined ? {} : { confirmationId: parsed.confirmationId }),
        ...(parsed.approved === undefined ? {} : { approved: parsed.approved })
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
  if (state.inputKind === "confirmation") {
    const pending = confirmations.peek(state.conversationId, state.confirmationId!);
    if (pending === undefined) {
      return {
        intent: unknownIntent(),
        resolutionError: "confirmation_invalid",
        traceIds: trace(dependencies, nodeEvent(state, "classify_intent", "unknown", "confirmation_invalid"), state.traceIds)
      };
    }
    return {
      intent: ConversationIntentSchema.parse({
        kind: "start_application",
        target: {
          kind: "recommendation",
          id: pending.target.resultId
        },
        requiresConfirmation: true
      }),
      traceIds: trace(dependencies, nodeEvent(state, "classify_intent", "confirmation", "confirmation_received"), state.traceIds)
    };
  }

  const fallback = deterministicIntent(state.text!);
  if (dependencies.modelProvider === undefined) {
    return { intent: fallback, traceIds: trace(dependencies, nodeEvent(state, "classify_intent", fallback.kind, "deterministic_fallback"), state.traceIds) };
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
      return { intent, traceIds: trace(dependencies, nodeEvent(state, "classify_intent", "unknown", "model_output_invalid"), state.traceIds) };
    }
    const intent = normalizeIntent(parsed.data);
    return { intent, traceIds: trace(dependencies, nodeEvent(state, "classify_intent", intent.kind, "model_structured"), state.traceIds) };
  } catch {
    return { intent: fallback, traceIds: trace(dependencies, nodeEvent(state, "classify_intent", fallback.kind, "model_unavailable_fallback"), state.traceIds) };
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
    const target = resolveRecommendationByIds(dependencies, pending.target.sessionId, pending.target.resultId);
    if (target.error !== undefined || target.value === undefined) {
      return { resolutionError: target.error ?? "recommendation_not_found" };
    }
    return { target: target.value };
  }

  const target = intent.target;
  if (target === undefined) {
    if (intent.kind === "start_application" || intent.kind === "start_application_and_show_status" || intent.kind === "show_application_task") {
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
  return { resolutionError: "job_match_session_target_unsupported" };
}

function policyGate(state: GraphState): Partial<GraphState> {
  if (state.resolutionError !== undefined || state.intent?.kind === "unknown" || state.intent?.kind === "help") {
    return { route: "persist" };
  }
  if (state.inputKind === "confirmation" || state.intent?.kind === "start_application" || state.intent?.kind === "start_application_and_show_status") {
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
  if (state.inputKind === "confirmation") {
    const pending = confirmations.consume(state.conversationId, state.confirmationId!);
    if (pending === undefined) {
      return {
        cards: [],
        assistantText: "这条确认已失效或已经使用，请重新发起投递。",
        consumedConfirmationId: state.confirmationId!,
        traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "rejected", "confirmation_invalid"), state.traceIds)
      };
    }
    if (state.approved !== true) {
      return {
        cards: [],
        assistantText: "已取消进入投递，当前没有创建新的投递任务。",
        consumedConfirmationId: pending.confirmationId,
        traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "cancelled", "confirmation_declined"), state.traceIds)
      };
    }
    try {
      const target = state.target;
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
        return {
          cards: [],
          assistantText: userFacingError(code),
          consumedConfirmationId: pending.confirmationId,
          traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "failed", code), invocation.traceIds)
        };
      }
      const toolResult = invocation.result;
      return {
        cards: toolResult.cards,
        toolResult,
        assistantText: "已创建受控投递任务，可以打开任务工作台继续处理。",
        consumedConfirmationId: pending.confirmationId,
        contextPatch: {
          activeJobMatchSessionId: target.sessionId,
          ...(target.postingId === undefined ? {} : { selectedPostingId: target.postingId }),
          ...(toolResult.task?.id === undefined ? {} : { activeApplicationTaskId: toolResult.task.id })
        },
        traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "completed", "application_task_created"), invocation.traceIds)
      };
    } catch (error) {
      const code = errorCode(error);
      return {
        cards: [],
        assistantText: userFacingError(code),
        consumedConfirmationId: pending.confirmationId,
        traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "failed", code), state.traceIds)
      };
    }
  }

  if (state.target?.kind !== "recommendation" || state.target.sessionId === undefined || state.target.resultId === undefined || state.target.postingContentHash === undefined) {
    return {
      cards: [],
      assistantText: "请先从当前岗位推荐中明确选择一个岗位。",
      traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "clarification", "recommendation_target_required"), state.traceIds)
    };
  }
  const confirmation: ConversationConfirmation = {
    confirmationId: randomUUID(),
    action: "start_application",
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
    action: "start_application",
    target: confirmation.target
  });
  return {
    cards: [card],
    pendingConfirmation: confirmation,
    assistantText: "已找到目标岗位。进入受控投递前需要你的确认。",
    traceIds: trace(dependencies, nodeEvent(state, "prepare_side_effect", "pending", "confirmation_required"), state.traceIds)
  };
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
  try {
    const result = await registry.invoke(name, input, toolContext(state));
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
        durationMs: elapsedMs(startedAt)
      }, state.traceIds)
    };
  } catch (error) {
    const code = errorCode(error);
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
  const assistantText = state.assistantText
    ?? (state.resolutionError === undefined ? defaultAssistantText(intent.kind) : userFacingError(state.resolutionError));
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
  return {
    context: nextContext,
    response,
    intent,
    traceIds: trace(dependencies, nodeEvent(state, "persist_turn", "completed", "turn_persisted"), state.traceIds)
  };
}

function deterministicIntent(text: string): ConversationIntent {
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
    ...(state.context.activeApplicationTaskId === undefined ? {} : { activeApplicationTaskId: state.context.activeApplicationTaskId })
  };
}

function readText(kind: ConversationIntent["kind"], count: number): string {
  if (kind === "list_application_tasks" || kind === "show_application_task") {
    return count === 0 ? "目前还没有已创建的投递任务。" : "这是当前已创建的投递任务。";
  }
  if (kind === "list_recommendations" || kind === "show_recommendation") {
    return count === 0 ? "当前没有可展示的岗位推荐。" : "这是当前岗位匹配结果。";
  }
  return defaultAssistantText(kind);
}

function defaultAssistantText(kind: ConversationIntent["kind"]): string {
  if (kind === "help") return "我可以帮你查看岗位推荐、查看投递任务，并在确认后创建受控投递任务。";
  return "目前只能帮你查看岗位匹配、投递任务，或在确认后创建投递任务。";
}

function userFacingError(code: string): string {
  switch (code) {
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
  if (error instanceof Error && /^[a-z0-9_:-]+$/u.test(error.message)) return error.message;
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
