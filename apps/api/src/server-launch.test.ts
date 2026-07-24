import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(packageRoot, "../..");
const testEnvironment = { NODE_ENV: "test" };
const timeoutMs = 10_000;

interface LaunchedServer {
  child: ChildProcessWithoutNullStreams;
  output(): string;
}

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function buildApi(): void {
  const buildCommand = process.platform === "win32"
    ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "corepack pnpm run build"] }
    : { command: "corepack", args: ["pnpm", "run", "build"] };
  const build = spawnSync(buildCommand.command, buildCommand.args, {
    cwd: packageRoot,
    encoding: "utf8"
  });
  expect(build.status, build.stderr || build.stdout).toBe(0);
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not allocate a test port");
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

function launchServer(cwd: string, script: string, env: NodeJS.ProcessEnv): LaunchedServer {
  const child = spawn(process.execPath, [script], {
    cwd,
    env,
    stdio: "pipe",
    windowsHide: true
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  child.stderr.on("data", (chunk: string) => { output += chunk; });
  return { child, output: () => output };
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeout = timeoutMs): Promise<ExitResult> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise<ExitResult>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("Server process did not exit in time")), timeout);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForHttp(url: string, launched: LaunchedServer): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (launched.child.exitCode !== null || launched.child.signalCode !== null) {
      throw new Error(`Server exited before ${url} was available: ${launched.output()}`);
    }
    try {
      const response = await fetch(url);
      if (response.status === 200) return response;
      lastError = new Error(`Expected 200 from ${url}, received ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastError)}\n${launched.output()}`);
}

async function isPortOpen(port: number): Promise<boolean> {
  const socket = new (await import("node:net")).Socket();
  return await new Promise<boolean>((resolvePromise) => {
    const finish = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(100);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
}

async function assertPortStaysClosedUntilExit(launched: LaunchedServer, port: number): Promise<ExitResult> {
  while (launched.child.exitCode === null && launched.child.signalCode === null) {
    if (await isPortOpen(port)) throw new Error(`Server opened port ${port} with malformed configuration`);
    await delay(20);
  }
  return await waitForExit(launched.child);
}

async function terminate(launched: LaunchedServer): Promise<ExitResult> {
  if (launched.child.exitCode === null && launched.child.signalCode === null) {
    launched.child.kill("SIGTERM");
  }
  return await waitForExit(launched.child);
}

describe("production API artifact", () => {
  it("starts the built API in degraded mode and shuts down cleanly", async () => {
    buildApi();
    const directory = await mkdtemp(resolve(tmpdir(), "resume-api-launch-"));
    const port = await getFreePort();
    const launched = launchServer(workspaceRoot, "apps/api/dist/server.js", {
      ...testEnvironment,
      DATABASE_FILE: resolve(directory, "resume-assistant.sqlite"),
      API_PORT: String(port)
    });

    try {
      const response = await waitForHttp(`http://127.0.0.1:${port}/api/health/adapters`, launched);
      expect(response.status).toBe(200);
      const exit = await terminate(launched);
      expect(exit).toEqual(process.platform === "win32"
        ? { code: null, signal: "SIGTERM" }
        : { code: 0, signal: null });
    } finally {
      if (launched.child.exitCode === null && launched.child.signalCode === null) {
        launched.child.kill("SIGKILL");
        await waitForExit(launched.child, 2_000).catch(() => undefined);
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exits before opening a port when a DeepSeek group is malformed", async () => {
    buildApi();
    const directory = await mkdtemp(resolve(tmpdir(), "resume-api-invalid-launch-"));
    const port = await getFreePort();
    const launched = launchServer(packageRoot, "dist/server.js", {
      ...testEnvironment,
      DATABASE_FILE: resolve(directory, "resume-assistant.sqlite"),
      API_PORT: String(port),
      DEEPSEEK_BASE_URL: "https://api.deepseek.com"
    });

    try {
      const exit = await assertPortStaysClosedUntilExit(launched, port);
      expect(exit.code).not.toBe(0);
      expect(exit.signal).toBeNull();
    } finally {
      if (launched.child.exitCode === null && launched.child.signalCode === null) {
        launched.child.kill("SIGKILL");
        await waitForExit(launched.child, 2_000).catch(() => undefined);
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
