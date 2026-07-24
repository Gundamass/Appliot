import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { monitorMalformedLaunch } from "./server-launch-monitor.js";

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

describe("malformed launch monitoring", () => {
  it("times out with a sanitized error and reaps a non-listening child", async () => {
    const secret = "do-not-print-monitor-secret";
    const child = spawn(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(secret)}); setInterval(() => {}, 1000);`], {
      env: { NODE_ENV: "test" },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
    const port = await getFreePort();
    const startedAt = Date.now();
    let message = "";

    try {
      await monitorMalformedLaunch(child, port, 100);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("Malformed configuration process did not exit within 100 ms");
    expect(message).not.toContain(secret);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});
