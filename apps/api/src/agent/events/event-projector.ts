import { AgentEventSchema, type AgentEvent } from "@resume/contracts";
import type { AgentEventType } from "./event-types.js";

export interface ProjectedAgentEvent {
  readonly id: string;
  readonly event: AgentEventType;
  readonly data: AgentEvent;
}

export function projectAgentEvent(value: AgentEvent): ProjectedAgentEvent {
  const event = AgentEventSchema.parse(value);
  return { id: event.eventId, event: event.type, data: event };
}

export function formatAgentSseEvent(value: AgentEvent): string {
  const projected = projectAgentEvent(value);
  return `id: ${projected.id}\nevent: ${projected.event}\ndata: ${JSON.stringify(projected.data)}\n\n`;
}
