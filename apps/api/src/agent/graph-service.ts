import { z } from "zod";
import { Command } from "@langchain/langgraph";
import {
  AgentGraphStateSchema,
  ApplicationExecutionStateSchema,
  HumanResumeSchema,
  SubgraphNameSchema,
  type AgentGraphState,
  type HumanResume,
  type SubgraphName
} from "@resume/contracts";
import type { StoredTraceEvent, TraceSink } from "./trace-sink.js";
import { createMainGraph, type MainGraphDependencies } from "./main-graph.js";

const GraphStartInputSchema = z.object({
  threadId: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1),
  subgraph: SubgraphNameSchema,
  profileRevision: z.number().int().nonnegative(),
  application: ApplicationExecutionStateSchema.optional()
}).strict().superRefine((input, context) => {
  if (input.subgraph === "application" && input.application === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["application"],
      message: "application_start_state_required"
    });
  }
  if (input.subgraph !== "application" && input.application !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["application"],
      message: "application_start_state_unexpected"
    });
  }
});

export type GraphStartInput = z.infer<typeof GraphStartInputSchema>;

export interface ExecutionInvalidationInput {
  threadId: string;
  taskId: string;
  executionEpoch?: number;
}

export interface GraphServiceDependencies extends MainGraphDependencies {
  invalidateExecutionEpoch?: (input: ExecutionInvalidationInput) => Promise<void> | void;
}

export interface GraphService {
  start(input: GraphStartInput): Promise<AgentGraphState>;
  run(threadId: string): Promise<AgentGraphState>;
  resume(threadId: string, resume: HumanResume): Promise<AgentGraphState>;
  state(threadId: string): Promise<AgentGraphState | undefined>;
  cancel(threadId: string): Promise<AgentGraphState>;
  traces(threadId: string): StoredTraceEvent[];
}

export function createGraphService(dependencies: GraphServiceDependencies): GraphService {
  const graph = createMainGraph(dependencies);
  const runIds = new Map<string, string>();

  const readState = async (threadId: string): Promise<AgentGraphState | undefined> => {
    assertThreadId(threadId);
    const snapshot = await graph.getState(rootConfig(threadId));
    const parsed = AgentGraphStateSchema.safeParse(snapshot.values);
    if (!parsed.success) return undefined;
    runIds.set(threadId, parsed.data.runId);
    return parsed.data;
  };

  const requireState = async (threadId: string): Promise<AgentGraphState> => {
    const state = await readState(threadId);
    if (state === undefined) throw new Error("agent_thread_not_found");
    return state;
  };

  return {
    async start(input) {
      const parsed = GraphStartInputSchema.parse(input);
      const initialState = AgentGraphStateSchema.parse({
        threadId: parsed.threadId,
        runId: parsed.runId,
        taskId: parsed.taskId,
        graphVersion: "agent-v1",
        status: "running",
        profileRevision: parsed.profileRevision,
        currentSubgraph: parsed.subgraph,
        ...(parsed.application === undefined ? {} : { application: parsed.application }),
        auditEventIds: []
      });
      await graph.invoke(initialState, invocationConfig(parsed.threadId, parsed.subgraph));
      return requireState(parsed.threadId);
    },

    async run(threadId) {
      const current = await requireState(threadId);
      if (current.status !== "running") return current;
      await graph.invoke({}, invocationConfig(threadId, current.currentSubgraph));
      return requireState(threadId);
    },

    async resume(threadId, resume) {
      assertThreadId(threadId);
      const current = await requireState(threadId);
      const parsed = HumanResumeSchema.parse(resume);
      if (current.status !== "interrupted" || current.pendingInterrupt === undefined) {
        throw new Error("agent_resume_not_pending");
      }
      if (current.pendingInterrupt.id !== parsed.interruptId) {
        throw new Error("agent_resume_interrupt_mismatch");
      }
      await graph.invoke(new Command({ resume: parsed }), invocationConfig(threadId, current.currentSubgraph));
      return requireState(threadId);
    },

    async state(threadId) {
      return readState(threadId);
    },

    async cancel(threadId) {
      const current = await requireState(threadId);
      if (current.currentSubgraph === "application") {
        await dependencies.invalidateExecutionEpoch?.({
          threadId,
          taskId: current.taskId,
          ...(current.application === undefined ? {} : { executionEpoch: current.application.executionEpoch })
        });
      }
      await graph.updateState(rootConfig(threadId), {
        status: "cancelled",
        currentNode: "cancelled",
        pendingInterrupt: undefined,
        error: undefined
      }, "human_interrupt");
      return requireState(threadId);
    },

    traces(threadId) {
      const runId = runIds.get(threadId);
      return runId === undefined ? [] : dependencies.traceSink.list(runId);
    }
  };
}

function invocationConfig(threadId: string, subgraph: SubgraphName) {
  return {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: subgraph
    }
  };
}

function rootConfig(threadId: string) {
  return { configurable: { thread_id: threadId } };
}

function assertThreadId(threadId: string): void {
  if (threadId.length === 0) throw new Error("agent_thread_id_required");
}
