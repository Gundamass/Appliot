import type { ConversationSession } from "@resume/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConversationApiError, type ConversationApi } from "./api.js";

export interface ConversationHistoryOptions {
  api: ConversationApi;
  requestedConversationId?: string | undefined;
  onActiveConversationChange?(conversationId?: string): void;
}

export interface ConversationHistoryState {
  sessions: ConversationSession[];
  activeConversationId?: string;
  loading: boolean;
  error?: string;
  creating: boolean;
  deletingConversationId?: string;
  clearing: boolean;
  busy: boolean;
  refresh(): Promise<void>;
  create(): Promise<void>;
  select(conversationId: string): void;
  delete(conversationId: string): Promise<void>;
  deleteAll(): Promise<void>;
}

export function useConversationHistory({
  api,
  requestedConversationId,
  onActiveConversationChange
}: ConversationHistoryOptions): ConversationHistoryState {
  const [sessions, setSessions] = useState<ConversationSession[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [deletingConversationId, setDeletingConversationId] = useState<string>();
  const [clearing, setClearing] = useState(false);
  const sessionsRef = useRef<ConversationSession[]>([]);
  const activeConversationIdRef = useRef<string | undefined>(undefined);
  const operationVersionRef = useRef(0);

  const updateSessions = useCallback((next: ConversationSession[]): void => {
    sessionsRef.current = next;
    setSessions(next);
  }, []);

  const activate = useCallback((conversationId: string | undefined): void => {
    if (activeConversationIdRef.current === conversationId) return;
    activeConversationIdRef.current = conversationId;
    setActiveConversationId(conversationId);
    onActiveConversationChange?.(conversationId);
  }, [onActiveConversationChange]);

  const createConversation = useCallback(async (version = ++operationVersionRef.current): Promise<void> => {
    setCreating(true);
    setError(undefined);
    try {
      const created = await api.create();
      if (version !== operationVersionRef.current) return;
      const next = [created, ...sessionsRef.current.filter((session) => session.id !== created.id)];
      updateSessions(next);
      activate(created.id);
    } catch {
      if (version === operationVersionRef.current) setError("新建会话失败，请重试");
    } finally {
      if (version === operationVersionRef.current) setCreating(false);
    }
  }, [activate, api, updateSessions]);

  const refresh = useCallback(async (): Promise<void> => {
    const version = ++operationVersionRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await api.list();
      if (version !== operationVersionRef.current) return;
      updateSessions(next);
      // Let ChatHome validate a URL-provided identifier. The history endpoint
      // can race with a newly created session, and a missing identifier is
      // handled as a stale session there rather than silently opening another
      // listed conversation.
      const requested = requestedConversationId;
      const current = activeConversationIdRef.current !== undefined && next.some(({ id }) => id === activeConversationIdRef.current)
        ? activeConversationIdRef.current
        : undefined;
      const selected = requested ?? current ?? next[0]?.id;
      if (selected !== undefined) activate(selected);
      else await createConversation(version);
    } catch (cause) {
      if (version === operationVersionRef.current) setError(toHistoryError(cause));
    } finally {
      if (version === operationVersionRef.current) setLoading(false);
    }
  }, [activate, api, createConversation, requestedConversationId, updateSessions]);

  useEffect(() => {
    void refresh();
    return () => {
      operationVersionRef.current += 1;
    };
    // The requested identifier changes when selection is persisted in the URL;
    // it must not restart the initial list/create lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => {
    if (requestedConversationId === undefined) return;
    if (sessionsRef.current.some(({ id }) => id === requestedConversationId)) activate(requestedConversationId);
  }, [activate, requestedConversationId]);

  const select = useCallback((conversationId: string): void => {
    if (!sessionsRef.current.some(({ id }) => id === conversationId)) return;
    activate(conversationId);
  }, [activate]);

  const deleteConversation = useCallback(async (conversationId: string): Promise<void> => {
    const version = ++operationVersionRef.current;
    setDeletingConversationId(conversationId);
    setError(undefined);
    try {
      await api.delete(conversationId);
      if (version !== operationVersionRef.current) return;
      const next = sessionsRef.current.filter(({ id }) => id !== conversationId);
      updateSessions(next);
      if (activeConversationIdRef.current !== conversationId) return;
      const replacement = next[0]?.id;
      if (replacement !== undefined) activate(replacement);
      else await createConversation(version);
    } catch (cause) {
      if (version === operationVersionRef.current) setError(toHistoryError(cause, "删除会话失败，请重试"));
    } finally {
      if (version === operationVersionRef.current) setDeletingConversationId(undefined);
    }
  }, [activate, api, createConversation, updateSessions]);

  const deleteAll = useCallback(async (): Promise<void> => {
    const version = ++operationVersionRef.current;
    setClearing(true);
    setError(undefined);
    try {
      await api.deleteAll();
      if (version !== operationVersionRef.current) return;
      updateSessions([]);
      activate(undefined);
      await createConversation(version);
    } catch (cause) {
      if (version === operationVersionRef.current) setError(toHistoryError(cause, "清空历史会话失败，请重试"));
    } finally {
      if (version === operationVersionRef.current) setClearing(false);
    }
  }, [activate, api, createConversation, updateSessions]);

  return {
    sessions,
    ...(activeConversationId === undefined ? {} : { activeConversationId }),
    loading,
    ...(error === undefined ? {} : { error }),
    creating,
    ...(deletingConversationId === undefined ? {} : { deletingConversationId }),
    clearing,
    busy: creating || deletingConversationId !== undefined || clearing,
    refresh,
    create: createConversation,
    select,
    delete: deleteConversation,
    deleteAll
  };
}

function toHistoryError(error: unknown, fallback = "会话历史加载失败，请重试"): string {
  if (error instanceof ConversationApiError && error.status === 404) return "当前会话已不存在，请重新选择或新建会话";
  return fallback;
}
