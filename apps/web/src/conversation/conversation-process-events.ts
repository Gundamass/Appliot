import {
  ConversationProcessEventSchema,
  ConversationProcessHistoryResetSchema,
  type ConversationProcessEvent,
  type ConversationProcessHistoryReset
} from "@resume/contracts";
import { useEffect, useState } from "react";

export interface ConversationProcessEventHandlers {
  onOpen(): void;
  onEvent(event: ConversationProcessEvent): void;
  onHistoryReset(event: ConversationProcessHistoryReset): void;
  onDisconnect(): void;
}

export type ConversationProcessEventConnection = (
  conversationId: string,
  handlers: ConversationProcessEventHandlers
) => () => void;

export const connectConversationProcessEvents: ConversationProcessEventConnection = (conversationId, handlers) => {
  if (typeof EventSource === "undefined") {
    handlers.onDisconnect();
    return () => undefined;
  }

  const source = new EventSource(`/api/conversations/${encodeURIComponent(conversationId)}/events`);

  const processEvent = (raw: Event): void => {
    if (!(raw instanceof MessageEvent)) return;
    const parsed = ConversationProcessEventSchema.safeParse(parseJson(raw.data));
    if (parsed.success && parsed.data.conversationId === conversationId) handlers.onEvent(parsed.data);
  };

  const historyReset = (raw: Event): void => {
    if (!(raw instanceof MessageEvent)) return;
    const parsed = ConversationProcessHistoryResetSchema.safeParse(parseJson(raw.data));
    if (parsed.success && parsed.data.conversationId === conversationId) handlers.onHistoryReset(parsed.data);
  };

  source.addEventListener("open", handlers.onOpen);
  source.addEventListener("process_changed", processEvent);
  source.addEventListener("history_reset", historyReset);
  source.addEventListener("error", handlers.onDisconnect);

  return () => source.close();
};

export function useConversationProcessEvents(
  conversationId: string | undefined,
  handlers: Pick<ConversationProcessEventHandlers, "onEvent" | "onHistoryReset">,
  connect: ConversationProcessEventConnection = connectConversationProcessEvents
): "connecting" | "connected" | "disconnected" {
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">(
    conversationId === undefined ? "disconnected" : "connecting"
  );

  useEffect(() => {
    let active = true;
    if (conversationId === undefined) {
      setStatus("disconnected");
      return () => {
        active = false;
      };
    }

    setStatus("connecting");
    const disconnect = connect(conversationId, {
      onOpen: () => {
        if (active) setStatus("connected");
      },
      onEvent: (event) => {
        if (active) handlers.onEvent(event);
      },
      onHistoryReset: (event) => {
        if (active) handlers.onHistoryReset(event);
      },
      onDisconnect: () => {
        if (active) setStatus("disconnected");
      }
    });

    return () => {
      active = false;
      disconnect();
    };
  }, [connect, conversationId, handlers.onEvent, handlers.onHistoryReset]);

  return status;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
