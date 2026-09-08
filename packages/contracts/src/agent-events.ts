import { z } from "zod";

export const AgentEventTypeSchema = z.enum([
  "run_started",
  "intent_resolved",
  "clarification_requested",
  "clarification_received",
  "plan_created",
  "plan_revised",
  "agent_dispatched",
  "capability_called",
  "observation_received",
  "human_interrupt",
  "approval_granted",
  "checkpoint_saved",
  "retry_scheduled",
  "run_completed",
  "run_failed",
  "run_cancelled",
  "run_blocked",
  "run_expired"
]);

export type AgentEventType = z.infer<typeof AgentEventTypeSchema>;

export const AgentEventActorSchema = z.enum(["user", "runtime", "supervisor", "agent", "tool"]);
export type AgentEventActor = z.infer<typeof AgentEventActorSchema>;

export const AgentEventSchema = z.object({
  eventId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128),
  intentId: z.string().min(1).max(128).optional(),
  planId: z.string().min(1).max(128).optional(),
  planRevision: z.number().int().positive().optional(),
  stepId: z.string().min(1).max(128).optional(),
  type: AgentEventTypeSchema,
  timestamp: z.string().datetime(),
  actor: AgentEventActorSchema,
  payloadRef: z.string().min(1).max(256).optional(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/iu).optional(),
  redactionVersion: z.string().min(1).max(32)
}).strict();

export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const EventCursorSchema = z.string().min(1).max(256);
export type EventCursor = z.infer<typeof EventCursorSchema>;
