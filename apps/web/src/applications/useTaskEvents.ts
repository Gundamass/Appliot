import {
  ApplicationTaskEventSchema,
  ApplicationTaskHistoryResetSchema,
  type ApplicationTaskProgressEvent,
  type ApplicationTaskHistoryReset
} from "@resume/contracts";
import { useEffect, useState } from "react";

export interface TaskEventHandlers {
  onOpen(): void;
  onEvent(event: ApplicationTaskProgressEvent): void;
  onHistoryReset(event: ApplicationTaskHistoryReset): void;
  onDisconnect(): void;
}

export type TaskEventConnection = (taskId: string, handlers: TaskEventHandlers) => () => void;

export const connectTaskEvents: TaskEventConnection = (taskId, handlers) => {
  const source = new EventSource(`/api/applications/${encodeURIComponent(taskId)}/events`);
  const taskEvent = (raw: Event) => {
    if (!(raw instanceof MessageEvent)) return;
    const parsed = ApplicationTaskEventSchema.safeParse(parseJson(raw.data));
    if (parsed.success) handlers.onEvent(parsed.data);
  };
  const historyReset = (raw: Event) => {
    if (!(raw instanceof MessageEvent)) return;
    const parsed = ApplicationTaskHistoryResetSchema.safeParse(parseJson(raw.data));
    if (parsed.success) handlers.onHistoryReset(parsed.data);
  };
  source.addEventListener("open", handlers.onOpen);
  source.addEventListener("state_changed", taskEvent);
  source.addEventListener("execution_progress_changed", taskEvent);
  source.addEventListener("browser_activity", taskEvent);
  source.addEventListener("operation_started", taskEvent);
  source.addEventListener("operation_completed", taskEvent);
  source.addEventListener("operation_failed", taskEvent);
  source.addEventListener("task_paused", taskEvent);
  source.addEventListener("task_resumed", taskEvent);
  source.addEventListener("history_reset", historyReset);
  source.addEventListener("error", handlers.onDisconnect);
  return () => source.close();
};

export function useTaskEvents(
  taskId: string,
  handlers: Pick<TaskEventHandlers, "onEvent" | "onHistoryReset">,
  connect: TaskEventConnection = connectTaskEvents
): "connecting" | "connected" | "disconnected" {
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");

  useEffect(() => {
    let active = true;
    setStatus("connecting");
    const disconnect = connect(taskId, {
      onOpen: () => { if (active) setStatus("connected"); },
      onEvent: (event) => { if (active) handlers.onEvent(event); },
      onHistoryReset: (event) => { if (active) handlers.onHistoryReset(event); },
      onDisconnect: () => { if (active) setStatus("disconnected"); }
    });
    return () => {
      active = false;
      disconnect();
    };
  }, [connect, handlers.onEvent, handlers.onHistoryReset, taskId]);

  return status;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}
