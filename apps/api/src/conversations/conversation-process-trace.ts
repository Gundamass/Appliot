import type {
  ConversationProcessFailure,
  ConversationProcessStage,
  ConversationProcessToolSummary
} from "@resume/contracts";
import type { ConversationProcessEventInput } from "./conversation-events.js";

interface TraceStepStart {
  stepId: string;
  stage: ConversationProcessStage;
  summary: string;
  tool?: ConversationProcessToolSummary;
}

interface TraceStepTerminal {
  summary: string;
  tool?: ConversationProcessToolSummary;
}

interface TraceStepFailureTerminal extends TraceStepTerminal {
  failure: ConversationProcessFailure;
}

export function createConversationProcessTrace(input: {
  conversationId: string;
  turnSequence: number;
  emit(event: ConversationProcessEventInput): unknown;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  const safeEmit = (event: ConversationProcessEventInput): void => {
    try {
      input.emit(event);
    } catch {
      // Process visibility is best effort and cannot change the conversation result.
    }
  };

  return {
    start(step: TraceStepStart) {
      const startedAt = now().getTime();
      safeEmit({
        ...step,
        conversationId: input.conversationId,
        turnSequence: input.turnSequence,
        status: "running"
      });

      const finish = (
        status: "completed" | "waiting" | "failed",
        terminal: TraceStepTerminal,
        failure?: ConversationProcessFailure
      ): void => {
        safeEmit({
          ...step,
          ...terminal,
          conversationId: input.conversationId,
          turnSequence: input.turnSequence,
          status,
          durationMs: Math.max(0, now().getTime() - startedAt),
          ...(failure === undefined ? {} : { failure })
        });
      };

      return {
        complete(terminal: TraceStepTerminal): void {
          finish("completed", terminal);
        },
        wait(terminal: TraceStepTerminal): void {
          finish("waiting", terminal);
        },
        fail(terminal: TraceStepFailureTerminal): void {
          finish("failed", terminal, terminal.failure);
        }
      };
    }
  };
}
