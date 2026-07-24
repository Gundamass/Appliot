import type { ChildProcess } from "node:child_process";
import { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<ExitResult> {
  if (hasExited(child)) return { code: child.exitCode, signal: child.signalCode };
  return await new Promise<ExitResult>((resolvePromise, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolvePromise({ code, signal });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Child process did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

export async function terminateChild(child: ChildProcess, timeoutMs = 2_000): Promise<ExitResult> {
  if (!hasExited(child)) child.kill("SIGKILL");
  return await waitForChildExit(child, timeoutMs);
}

async function isPortOpen(port: number, timeoutMs: number): Promise<boolean> {
  const socket = new Socket();
  return await new Promise<boolean>((resolvePromise) => {
    const finish = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
}

export async function monitorMalformedLaunch(
  child: ChildProcess,
  port: number,
  deadlineMs: number
): Promise<ExitResult> {
  const deadline = Date.now() + deadlineMs;
  try {
    while (!hasExited(child)) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`Malformed configuration process did not exit within ${deadlineMs} ms before opening port ${port}`);
      }
      if (await isPortOpen(port, Math.max(1, Math.min(100, remainingMs)))) {
        throw new Error(`Malformed configuration process opened port ${port}`);
      }
      await delay(Math.max(1, Math.min(20, deadline - Date.now())));
    }
    return await waitForChildExit(child, Math.max(1, deadline - Date.now()));
  } finally {
    await terminateChild(child);
  }
}
