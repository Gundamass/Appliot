import { z } from "zod";
import {
  AgentEventSchema,
  AgentEventTypeSchema,
  EventCursorSchema,
  type AgentEvent,
  type AgentEventActor,
  type AgentEventType,
  type EventCursor
} from "@resume/contracts";

export { AgentEventSchema, AgentEventTypeSchema, EventCursorSchema };
export type { AgentEvent, AgentEventActor, AgentEventType, EventCursor };

/** Input accepted by the authoritative event log before it allocates identity and time. */
export const AgentEventDraftSchema = AgentEventSchema.omit({ eventId: true, timestamp: true });
export type AgentEventDraft = z.infer<typeof AgentEventDraftSchema>;

export interface AgentEventReplay {
  readonly events: AgentEvent[];
  readonly nextCursor?: EventCursor;
}
