import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { BrowserWorkerClient } from "./browser/worker-client.js";
import { monitorMalformedLaunch, terminateChild, waitForChildExit, type ExitResult } from "./server-launch-monitor.js";

const packageRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(packageRoot, "../..");
const testEnvironment = { NODE_ENV: "test" };
const timeoutMs = 10_000;

interface LaunchedServer {
  child: ChildProcessWithoutNullStreams;
  output(): string;
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

async function terminate(launched: LaunchedServer): Promise<ExitResult> {
  if (launched.child.exitCode === null && launched.child.signalCode === null) {
    launched.child.kill("SIGTERM");
  }
  return await waitForChildExit(launched.child, timeoutMs);
}

describe("production API artifact", () => {
  it("starts the bundled browser worker without the TypeScript loader", async () => {
    buildApi();
    const directory = await mkdtemp(resolve(tmpdir(), "resume-browser-worker-build-"));
    const client = await BrowserWorkerClient.start({
      profileDir: resolve(directory, "profile"),
      headless: true,
      workerEntry: resolve(packageRoot, "dist/browser-worker.js")
    });

    try {
      await expect(client.stop()).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

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
        await terminateChild(launched.child).catch(() => undefined);
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

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
      const exit = await monitorMalformedLaunch(launched.child, port, timeoutMs);
      expect(exit.code).not.toBe(0);
      expect(exit.signal).toBeNull();
    } finally {
      if (launched.child.exitCode === null && launched.child.signalCode === null) {
        await terminateChild(launched.child).catch(() => undefined);
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
