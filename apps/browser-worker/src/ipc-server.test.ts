import { describe, expect, it, vi } from "vitest";
import { createIpcServer } from "./ipc-server.js";

describe("startIpcServer", () => {
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
