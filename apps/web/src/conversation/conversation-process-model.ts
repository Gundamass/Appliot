import type { ConversationProcessEvent } from "@resume/contracts";

export interface ConversationProcessGroup {
  turnSequence: number;
  steps: ConversationProcessEvent[];
  active: boolean;
  failed: boolean;
  totalDurationMs: number;
}

// Keep the existing name for the chat trace while exposing the domain-neutral
// group name to inline projections such as job matching.
export type ConversationTurnProcess = ConversationProcessGroup;

export function groupConversationProcessEvents(
  events: readonly ConversationProcessEvent[]
): Map<number, ConversationProcessGroup> {
  const seenIds = new Set<string>();
  const byTurn = new Map<number, Map<string, ConversationProcessEvent>>();
  const stepOrder = new Map<number, string[]>();

  for (const event of [...events].sort(compareEventIds)) {
    if (seenIds.has(event.id)) continue;
    seenIds.add(event.id);
    const steps = byTurn.get(event.turnSequence) ?? new Map<string, ConversationProcessEvent>();
    const order = stepOrder.get(event.turnSequence) ?? [];
    if (!steps.has(event.stepId)) order.push(event.stepId);
    steps.set(event.stepId, event);
    byTurn.set(event.turnSequence, steps);
    stepOrder.set(event.turnSequence, order);
  }

  return new Map([...byTurn].map(([turnSequence, steps]) => {
    const ordered = (stepOrder.get(turnSequence) ?? [])
      .map((stepId) => steps.get(stepId)!)
      .filter((event): event is ConversationProcessEvent => event !== undefined);
    return [turnSequence, {
      turnSequence,
      steps: ordered,
      active: ordered.some(({ status }) => status === "running" || status === "waiting"),
      failed: ordered.some(({ status }) => status === "failed"),
      totalDurationMs: ordered.reduce((sum, event) => sum + (event.durationMs ?? 0), 0)
    }];
  }));
}

function compareEventIds(left: ConversationProcessEvent, right: ConversationProcessEvent): number {
  if (left.id.length !== right.id.length) return left.id.length - right.id.length;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
