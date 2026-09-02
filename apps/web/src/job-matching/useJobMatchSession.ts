import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationJobMatchAction, ConversationJobMatchActionResult } from "@resume/contracts";
import type { ConversationJobMatchApi } from "../conversation/conversation-job-match-api.js";
import type { JobMatchApi, JobMatchSession } from "./api.js";

export type JobMatchLoadStatus = "loading" | "ready" | "error";
export interface JobMatchSessionHook { session: JobMatchSession | undefined; status: JobMatchLoadStatus; error: Error | undefined; refresh(): Promise<void> }
export interface JobMatchPollingOptions { intervalMs?: number }
export interface ConversationJobMatchSessionHook extends JobMatchSessionHook {
  execute(action: ConversationJobMatchAction): Promise<ConversationJobMatchActionResult>;
}

const STABLE_STATES = new Set([
  "awaiting_filter_confirmation", "awaiting_login", "awaiting_job_selection", "selected",
  "converted_to_application", "awaiting_challenge", "paused", "failed", "cancelled", "expired"
]);

export function useJobMatchSession(sessionId: string, api: JobMatchApi, options: JobMatchPollingOptions = {}): JobMatchSessionHook {
  const intervalMs = Math.max(500, options.intervalMs ?? 2000);
  const [session, setSession] = useState<JobMatchSession>();
  const [status, setStatus] = useState<JobMatchLoadStatus>("loading");
  const [error, setError] = useState<Error>();
  const current = useRef<JobMatchSession | undefined>(undefined);
  const requestKey = useMemo(() => Symbol("job-match-request"), [api, sessionId]);
  const inFlight = useRef<{ key: symbol; token: symbol } | undefined>(undefined);
  const refresh = useCallback(async () => {
    if (inFlight.current?.key === requestKey) return;
    const token = Symbol("job-match-read");
    inFlight.current = { key: requestKey, token };
    try {
      const next = await api.get(sessionId);
      if (inFlight.current?.token !== token) return;
      current.current = next;
      setSession(next);
      setStatus("ready");
      setError(undefined);
    } catch (cause) {
      if (inFlight.current?.token !== token) return;
      const next = cause instanceof Error ? cause : new Error("无法读取岗位匹配会话");
      setError(next);
      setStatus("error");
    } finally {
      if (inFlight.current?.token === token) inFlight.current = undefined;
    }
  }, [api, requestKey, sessionId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!STABLE_STATES.has(current.current?.state ?? "")) void refresh();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, refresh]);
  return { session, status, error, refresh };
}

export function useConversationJobMatchSession(
  sessionId: string,
  api: JobMatchApi,
  conversationApi: ConversationJobMatchApi,
  options: JobMatchPollingOptions = {}
): ConversationJobMatchSessionHook {
  const sessionHook = useJobMatchSession(sessionId, api, options);
  const execute = useCallback(async (action: ConversationJobMatchAction) => {
    const result = await conversationApi.execute(action);
    await sessionHook.refresh();
    return result;
  }, [conversationApi, sessionHook.refresh]);
  return { ...sessionHook, execute };
}
