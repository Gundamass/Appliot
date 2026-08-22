import { z } from "zod";
import { END, START, StateGraph, interrupt } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import {
  ApplicationExecutionStateSchema,
  GraphErrorSchema,
  GraphStatusSchema,
  HumanInterruptSchema,
  HumanResumeSchema,
  JobMatchingStateSchema,
  ResumeIngestionStateSchema,
  type AgentGraphState,
  type HumanResume,
  type SubgraphName
} from "@resume/contracts";
import type { TraceSink } from "./trace-sink.js";
import {
  AgentGraphStateAnnotation,
  parseAgentGraphState,
  type LangGraphAgentState,
  type LangGraphAgentStateUpdate
} from "./state.js";

const SubgraphPortResultSchema = z.object({
  status: GraphStatusSchema,
  currentNode: z.string().min(1).max(120).optional(),
  pendingInterrupt: HumanInterruptSchema.optional(),
  error: GraphErrorSchema.optional(),
  resumeIngestion: ResumeIngestionStateSchema.optional(),
  jobMatching: JobMatchingStateSchema.optional(),
  application: ApplicationExecutionStateSchema.optional()
}).strict().superRefine((result, context) => {
  if (result.status === "interrupted" && result.pendingInterrupt === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "subgraph_interrupt_missing" });
  }
  if (result.status !== "interrupted" && result.pendingInterrupt !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "subgraph_interrupt_unexpected" });
  }
});

export type SubgraphPortResult = z.infer<typeof SubgraphPortResultSchema>;

export interface SubgraphPortInput {
  state: AgentGraphState;
  resume?: HumanResume;
}

export type SubgraphPort = (input: SubgraphPortInput) => Promise<SubgraphPortResult> | SubgraphPortResult;

export interface MainGraphDependencies {
  checkpointer: BaseCheckpointSaver;
  traceSink: TraceSink;
  resumeIngestion?: SubgraphPort;
  jobMatching?: SubgraphPort;
  application?: SubgraphPort;
}

export function createMainGraph(dependencies: MainGraphDependencies) {
  const execute = (subgraph: SubgraphName, state: LangGraphAgentState, resume?: HumanResume) =>
    executeSubgraph(dependencies, subgraph, state, resume);

  return new StateGraph(AgentGraphStateAnnotation)
    .addNode("resume_ingestion", (state) => execute("resume_ingestion", state))
    .addNode("job_matching", (state) => execute("job_matching", state))
    .addNode("application_execution", (state) => execute("application", state))
    .addNode("human_interrupt", (state) => {
      const agentState = parseAgentGraphState(state);
      if (agentState.pendingInterrupt === undefined) {
        return failedUpdate(agentState, "agent_interrupt_missing", "human_interrupt");
      }
      const resume = HumanResumeSchema.parse(interrupt(agentState.pendingInterrupt));
      return execute(agentState.currentSubgraph, state, resume);
    })
    .addConditionalEdges(START, (state) => state.currentSubgraph, {
      resume_ingestion: "resume_ingestion",
      job_matching: "job_matching",
      application: "application_execution"
    })
    .addConditionalEdges("resume_ingestion", afterSubgraph)
    .addConditionalEdges("job_matching", afterSubgraph)
    .addConditionalEdges("application_execution", afterSubgraph)
    .addConditionalEdges("human_interrupt", afterSubgraph)
    .compile({ checkpointer: dependencies.checkpointer });
}

async function executeSubgraph(
  dependencies: MainGraphDependencies,
  subgraph: SubgraphName,
  state: LangGraphAgentState,
  resume?: HumanResume
): Promise<LangGraphAgentStateUpdate> {
  const agentState = parseAgentGraphState(state);
  const port = portFor(dependencies, subgraph);
  if (port === undefined) return failedUpdate(agentState, "agent_subgraph_unavailable", subgraph);

  let rawResult: unknown;
  try {
    rawResult = await port({
      state: agentState,
      ...(resume === undefined ? {} : { resume })
    });
  } catch {
    return failedUpdate(agentState, "agent_subgraph_execution_failed", subgraph);
  }

  const parsed = SubgraphPortResultSchema.safeParse(rawResult);
  if (!parsed.success) return failedUpdate(agentState, "agent_subgraph_result_invalid", subgraph);
  return resultUpdate(dependencies.traceSink, agentState, parsed.data);
}

function portFor(dependencies: MainGraphDependencies, subgraph: SubgraphName): SubgraphPort | undefined {
  switch (subgraph) {
    case "resume_ingestion":
      return dependencies.resumeIngestion;
    case "job_matching":
      return dependencies.jobMatching;
    case "application":
      return dependencies.application;
  }
}

function resultUpdate(
  traceSink: TraceSink,
  state: AgentGraphState,
  result: SubgraphPortResult
): LangGraphAgentStateUpdate {
  const currentNode = result.currentNode ?? state.currentNode ?? state.currentSubgraph;
  const update: Record<string, unknown> = {
    status: result.status,
    currentNode,
    pendingInterrupt: result.status === "interrupted" ? result.pendingInterrupt : undefined,
    error: result.status === "failed" ? result.error ?? {
      code: "agent_subgraph_failed",
      retryable: false,
      node: currentNode
    } : undefined
  };
  if (result.resumeIngestion !== undefined) update.resumeIngestion = result.resumeIngestion;
  if (result.jobMatching !== undefined) update.jobMatching = result.jobMatching;
  if (result.application !== undefined) update.application = result.application;

  if (result.status === "interrupted") {
    const pendingInterrupt = result.pendingInterrupt!;
    update.auditEventIds = [traceSink.record({
      runId: state.runId,
      taskId: state.taskId,
      node: currentNode,
      kind: "interrupt",
      outcome: "pending",
      reasonCode: pendingInterrupt.reasonCode,
      evidenceIds: pendingInterrupt.evidenceIds,
      counts: { questions: pendingInterrupt.questionIds.length }
    })];
  }
  return update as LangGraphAgentStateUpdate;
}

function failedUpdate(
  state: AgentGraphState,
  code: string,
  node: string
): LangGraphAgentStateUpdate {
  return {
    status: "failed",
    currentNode: node,
    pendingInterrupt: undefined,
    error: { code, retryable: false, node }
  };
}

function afterSubgraph(state: LangGraphAgentState): "human_interrupt" | typeof END {
  return state.status === "interrupted" ? "human_interrupt" : END;
}
