import { describe, expect, it, vi } from "vitest";
import { createIpcServer } from "./ipc-server.js";

describe("startIpcServer", () => {
  it("dispatches job observation and epoch-authorized mutations", async () => {
    const sent: unknown[] = [];
    let messageListener: ((message: unknown) => void) | undefined;
    const ipc = {
      on: (_event: string, listener: (message: unknown) => void) => { messageListener = listener; },
      send: (message: unknown, callback?: (error: null) => void) => {
        sent.push(message);
        callback?.(null);
        return true;
      },
      disconnect: vi.fn(),
      stderr: { write: vi.fn() }
    };
    const snapshot = {
      id: "job-snapshot-1",
      ownerId: "jm-1",
      url: "https://jobs.example.test/list",
      title: "Jobs",
      capturedAt: "2026-08-16T00:00:00.000Z",
      entryHint: "job_list",
      visibleText: ["Jobs"],
      jobCards: [],
      filterState: [],
      pagination: { kind: "page", current: 1, hasNext: true },
      boundaries: []
    } as const;
    const observeJob = vi.fn(async () => snapshot);
    const applyJobFilters = vi.fn(async () => ({ ...snapshot, filterState: [{ key: "location", values: ["深圳"] }] }));
    const advanceJobPage = vi.fn(async () => ({ ...snapshot, pagination: { kind: "page" as const, current: 2, hasNext: false } }));
    const session = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      subscribeActivity: vi.fn(() => () => undefined),
      observeJob,
      applyJobFilters,
      advanceJobPage
    };
    createIpcServer(session as never, ipc);
    messageListener?.({ requestId: "handshake", request: { type: "handshake", approvalKey: "a".repeat(43) } });
    await vi.waitFor(() => expect(sent).toContainEqual({ requestId: "handshake", response: { type: "ready" } }));

    const plan = { source: "moka", adapterVersion: "moka-job-v1", mapped: [], localOnly: [] };
    messageListener?.({ requestId: "observe", request: { type: "capture_job_snapshot", ownerId: "jm-1" } });
    messageListener?.({ requestId: "filter", request: { type: "apply_job_filters", ownerId: "jm-1", plan, executionEpoch: 5 } });
    messageListener?.({ requestId: "advance", request: { type: "advance_job_page", ownerId: "jm-1", cursor: "page-2", executionEpoch: 5 } });

    await vi.waitFor(() => expect(advanceJobPage).toHaveBeenCalledWith("jm-1", "page-2", 5));
    expect(observeJob).toHaveBeenCalledWith("jm-1");
    expect(applyJobFilters).toHaveBeenCalledWith("jm-1", plan, 5);
    expect(sent).toContainEqual({ requestId: "observe", response: { type: "job_snapshot", snapshot } });
    expect(sent).toContainEqual(expect.objectContaining({ requestId: "filter", response: expect.objectContaining({ type: "job_filter_result" }) }));
    expect(sent).toContainEqual(expect.objectContaining({ requestId: "advance", response: expect.objectContaining({ type: "job_page_advanced" }) }));
  });

  it("forwards only contract-valid unsolicited activity messages", async () => {
    const sent: unknown[] = [];
    let messageListener: ((message: unknown) => void) | undefined;
    const ipc = {
      on: vi.fn((event: string, listener: (message: unknown) => void) => {
        if (event === "message") messageListener = listener;
      }),
      send: (message: unknown, callback?: (error: null) => void) => {
        sent.push(message);
        callback?.(null);
        return true;
      },
      disconnect: vi.fn(),
      stderr: { write: vi.fn() }
    };
    const subscribeActivity = vi.fn();
    const session = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      subscribeActivity
    };
    createIpcServer(session as never, ipc);

    messageListener?.({
      requestId: "handshake-1",
      request: { type: "handshake", approvalKey: "a".repeat(43) }
    });
    await vi.waitFor(() => expect(subscribeActivity).toHaveBeenCalledOnce());
    const listener = subscribeActivity.mock.calls[0]?.[0] as (activity: unknown) => void;
    listener({ type: "page_stable", taskId: "task-1", fingerprint: "page_safe" });
    listener({ type: "user_activity", taskId: "task-1", fieldId: "field-1", activity: "input", value: "secret" });

    await vi.waitFor(() => expect(sent).toContainEqual({
      response: {
        type: "activity",
        activity: { type: "page_stable", taskId: "task-1", fingerprint: "page_safe" }
      }
    }));
    expect(JSON.stringify(sent)).not.toContain("secret");
  });

  it("applies execution invalidation immediately while an older command is awaiting", async () => {
    const sent: unknown[] = [];
    let messageListener: ((message: unknown) => void) | undefined;
    const ipc = {
      on: (_event: string, listener: (message: unknown) => void) => { messageListener = listener; },
      send: (message: unknown, callback?: (error: null) => void) => {
        sent.push(message);
        callback?.(null);
        return true;
      },
      disconnect: vi.fn(),
      stderr: { write: vi.fn() }
    };
    let finishExecution!: () => void;
    const execute = vi.fn(() => new Promise<void>((resolve) => { finishExecution = resolve; }));
    const invalidateExecution = vi.fn();
    const session = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      subscribeActivity: vi.fn(() => () => undefined),
      execute,
      invalidateExecution
    };
    createIpcServer(session as never, ipc);
    messageListener?.({
      requestId: "handshake-1",
      request: { type: "handshake", approvalKey: "a".repeat(43) }
    });
    await vi.waitFor(() => expect(sent).toContainEqual({ requestId: "handshake-1", response: { type: "ready" } }));

    messageListener?.({
      requestId: "execute-1",
      request: {
        type: "execute",
        executionEpoch: 1,
        command: {
          type: "fill",
          taskId: "task-1",
          snapshotId: "snapshot-1",
          nodeRef: { documentId: "document-identity", nodeId: "node-identity-01", observedAt: 0 },
          executionEpoch: 1,
          fieldId: "field-1",
          value: "safe",
          approval: "approval-1"
        }
      }
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    messageListener?.({
      requestId: "invalidate-1",
      request: { type: "invalidate_execution", taskId: "task-1", executionEpoch: 2 }
    });
    await vi.waitFor(() => expect(invalidateExecution).toHaveBeenCalledWith("task-1", 2));
    finishExecution();
  });

  it("binds automatic activity to the active execute request only", async () => {
    const sent: unknown[] = [];
    let messageListener: ((message: unknown) => void) | undefined;
    const ipc = {
      on: (_event: string, listener: (message: unknown) => void) => { messageListener = listener; },
      send: (message: unknown, callback?: (error: null) => void) => {
        sent.push(message);
        callback?.(null);
        return true;
      },
      disconnect: vi.fn(),
      stderr: { write: vi.fn() }
    };
    let activityListener: ((activity: unknown) => void) | undefined;
    let finishExecution!: (response: unknown) => void;
    const execute = vi.fn(() => new Promise((resolve) => { finishExecution = resolve; }));
    const session = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      subscribeActivity: vi.fn((listener: (activity: unknown) => void) => {
        activityListener = listener;
        return () => undefined;
      }),
      execute
    };
    createIpcServer(session as never, ipc);
    messageListener?.({
      requestId: "handshake-1",
      request: { type: "handshake", approvalKey: "a".repeat(43) }
    });
    await vi.waitFor(() => expect(sent).toContainEqual({
      requestId: "handshake-1",
      response: { type: "ready" }
    }));

    messageListener?.({
      requestId: "execute-1",
      request: {
        type: "execute",
        executionEpoch: 1,
        command: {
          type: "fill",
          taskId: "task-1",
          snapshotId: "snapshot-1",
          nodeRef: { documentId: "document-identity", nodeId: "node-identity-01", observedAt: 0 },
          executionEpoch: 1,
          fieldId: "field-1",
          value: "safe",
          approval: "approval-1"
        }
      }
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    activityListener?.({ type: "page_changed", taskId: "task-1" });
    await vi.waitFor(() => expect(sent).toContainEqual({
      requestId: "execute-1",
      response: {
        type: "activity",
        activity: { type: "page_changed", taskId: "task-1" }
      }
    }));

    finishExecution({
      type: "execution_result",
      taskId: "task-1",
      snapshotId: "snapshot-2",
      commandType: "fill",
      status: "applied",
      snapshot: {
        id: "snapshot-2",
        taskId: "task-1",
        url: "https://example.com/apply",
        title: "Application",
        stage: "application_form",
        frameRef: { documentId: "document-identity", kind: "main" },
        mutationEpoch: 0,
        fields: [],
        actions: [],
        errors: []
      },
      actualValue: "safe",
      errors: []
    });
    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({
      requestId: "execute-1",
      response: expect.objectContaining({ type: "execution_result" })
    })));

    activityListener?.({ type: "page_stable", taskId: "task-1", fingerprint: "user-change" });
    await vi.waitFor(() => expect(sent).toContainEqual({
      response: {
        type: "activity",
        activity: { type: "page_stable", taskId: "task-1", fingerprint: "user-change" }
      }
    }));
  });

  it("releases one task session without shutting down the browser context", async () => {
    const sent: unknown[] = [];
    let messageListener: ((message: unknown) => void) | undefined;
    const ipc = {
      on: (_event: string, listener: (message: unknown) => void) => { messageListener = listener; },
      send: (message: unknown, callback?: (error: null) => void) => {
        sent.push(message);
        callback?.(null);
        return true;
      },
      disconnect: vi.fn(),
      stderr: { write: vi.fn() }
    };
    const releaseTask = vi.fn();
    const session = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      subscribeActivity: vi.fn(() => () => undefined),
      releaseTask
    };
    createIpcServer(session as never, ipc);
    messageListener?.({
      requestId: "handshake-1",
      request: { type: "handshake", approvalKey: "a".repeat(43) }
    });
    await vi.waitFor(() => expect(sent).toContainEqual({
      requestId: "handshake-1",
      response: { type: "ready" }
    }));

    messageListener?.({
      requestId: "release-1",
      request: { type: "release_task", taskId: "task-1" }
    });

    await vi.waitFor(() => expect(releaseTask).toHaveBeenCalledWith("task-1"));
    expect(sent).toContainEqual({
      requestId: "release-1",
      response: { type: "released", taskId: "task-1" }
    });
  });
});
