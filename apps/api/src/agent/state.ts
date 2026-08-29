import { Annotation } from "@langchain/langgraph";
import { AgentGraphStateSchema, type AgentGraphState } from "@resume/contracts";

function appendUnique(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])];
}

function replaceValue<T>(_left: T | undefined, right: T | undefined): T | undefined {
  return right;
}

/**
 * The graph persists only references and bounded decisions. Nested subgraph
 * state is replaced as one unit so a stale partial update cannot merge facts
 * from different document, matching, or browser executions.
 */
export const AgentGraphStateAnnotation = Annotation.Root({
  threadId: Annotation<string>,
  runId: Annotation<string>,
  taskId: Annotation<string>,
  graphVersion: Annotation<"agent-v1">,
  status: Annotation<AgentGraphState["status"]>,
  profileRevision: Annotation<number>,
  expectationRevision: Annotation<number | undefined>,
  selectedJobId: Annotation<string | undefined>,
  currentSubgraph: Annotation<AgentGraphState["currentSubgraph"]>,
  currentNode: Annotation<string | undefined>,
  pendingInterrupt: Annotation<AgentGraphState["pendingInterrupt"]>({
    reducer: replaceValue,
    default: () => undefined
  }),
  resumeIngestion: Annotation<AgentGraphState["resumeIngestion"]>({
    reducer: replaceValue,
    default: () => undefined
  }),
  jobMatching: Annotation<AgentGraphState["jobMatching"]>({
    reducer: replaceValue,
    default: () => undefined
  }),
  application: Annotation<AgentGraphState["application"]>({
    reducer: replaceValue,
    default: () => undefined
  }),
  error: Annotation<AgentGraphState["error"]>({
    reducer: replaceValue,
    default: () => undefined
  }),
  auditEventIds: Annotation<string[]>({
    reducer: appendUnique,
    default: () => []
  })
});

export type LangGraphAgentState = typeof AgentGraphStateAnnotation.State;
export type LangGraphAgentStateUpdate = typeof AgentGraphStateAnnotation.Update;

export function parseAgentGraphState(value: unknown): AgentGraphState {
  return AgentGraphStateSchema.parse(value);
}
