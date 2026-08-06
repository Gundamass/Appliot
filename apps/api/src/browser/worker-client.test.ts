import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionPolicy } from "@resume/action-policy";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserWorkerClient } from "./worker-client.js";

const clients: BrowserWorkerClient[] = [];
const servers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true
  })));
});

describe("BrowserWorkerClient", () => {
  it("rejects forged request-bound activity without resolving a pending request", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "resume-browser-activity-"));
    temporaryDirectories.push(profileDir);
    const client = await BrowserWorkerClient.start({
      profileDir,
      headless: true,
      workerEntry: fileURLToPath(new URL("./fixtures/activity-worker.ts", import.meta.url))
    });
    clients.push(client);
    const events: unknown[] = [];
    client.onActivity((activity) => events.push(activity));

    await expect(client.observe("task-1")).resolves.toMatchObject({ type: "snapshot" });
    expect(events).toEqual([{ type: "page_stable", taskId: "task-1", fingerprint: "page_fixture" }]);
  });

  it("continues notifying activity listeners after one throws", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "resume-browser-listener-"));
    temporaryDirectories.push(profileDir);
    const client = await BrowserWorkerClient.start({
      profileDir,
      headless: true,
      workerEntry: fileURLToPath(new URL("./fixtures/activity-worker.ts", import.meta.url))
    });
    clients.push(client);
    const received: unknown[] = [];
    client.onActivity(() => { throw new Error("listener failure"); });
    client.onActivity((activity) => received.push(activity));

    await expect(client.observe("task-1")).resolves.toMatchObject({ type: "snapshot" });

    expect(received).toEqual([{ type: "page_stable", taskId: "task-1", fingerprint: "page_fixture" }]);
  });

  it("notifies activity subscribers when the worker disconnects", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "resume-browser-disconnect-"));
    temporaryDirectories.push(profileDir);
    const client = await BrowserWorkerClient.start({
      profileDir,
      headless: true,
      workerEntry: fileURLToPath(new URL("./fixtures/activity-worker.ts", import.meta.url))
    });
    clients.push(client);
    const events: unknown[] = [];
    client.onActivity((activity) => events.push(activity));

    await client.observe("task-1");
    await client.stop();
    clients.splice(clients.indexOf(client), 1);

    expect(events).toContainEqual({ type: "worker_disconnected", taskId: "task-1", code: "IPC_DISCONNECTED" });
  });

  it("terminates the child process when startup fails", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "resume-browser-failure-"));
    temporaryDirectories.push(profileDir);

    await expect(BrowserWorkerClient.start({
      profileDir,
      headless: true,
      workerEntry: fileURLToPath(new URL("./fixtures/failing-worker.ts", import.meta.url))
    })).rejects.toThrow("测试启动失败");

    await new Promise((resolve) => setTimeout(resolve, 700));
    await expect(readFile(join(profileDir, "worker-exit.txt"), "utf8")).resolves.toBe("terminated");
  });

  it("terminates the child process when graceful shutdown times out", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "resume-browser-unresponsive-"));
    temporaryDirectories.push(profileDir);
    const client = await BrowserWorkerClient.start({
      profileDir,
      headless: true,
      requestTimeoutMs: 500,
      workerEntry: fileURLToPath(new URL("./fixtures/unresponsive-worker.ts", import.meta.url))
    });
    clients.push(client);

    await expect(client.stop()).resolves.toBeUndefined();
    clients.splice(clients.indexOf(client), 1);

    await expect(readFile(join(profileDir, "worker-exit.txt"), "utf8")).resolves.toBe("terminated");
  });

  it("persists a manual login session and rejects non-web URLs", async () => {
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      if (request.url === "/login") {
        response.setHeader("Set-Cookie", "resume_session=active; Path=/; Max-Age=3600; SameSite=Lax");
        response.end("<!doctype html><title>已登录</title>");
        return;
      }

      const authenticated = request.headers.cookie?.includes("resume_session=active") ?? false;
      response.end(`<!doctype html><title>${authenticated ? "会话已恢复" : "需要登录"}</title>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("测试服务器没有分配 TCP 端口");
    }

    const profileDir = await mkdtemp(join(tmpdir(), "resume-browser-profile-"));
    temporaryDirectories.push(profileDir);
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const firstClient = await BrowserWorkerClient.start({ profileDir, headless: true });
    clients.push(firstClient);
    await expect(firstClient.open("task-1", `${baseUrl}/login`)).resolves.toMatchObject({
      type: "opened",
      title: "已登录"
    });
    await firstClient.releaseTask("task-1");
    await expect(firstClient.open("task-2", `${baseUrl}/account`)).resolves.toMatchObject({
      type: "opened",
      title: "会话已恢复"
    });
    await firstClient.stop();
    clients.splice(clients.indexOf(firstClient), 1);

    const secondClient = await BrowserWorkerClient.start({ profileDir, headless: true });
    clients.push(secondClient);
    await expect(secondClient.open("task-1", `${baseUrl}/account`)).resolves.toMatchObject({
      type: "opened",
      title: "会话已恢复"
    });
    await expect(secondClient.open("task-1", "file:///C:/Windows/win.ini")).rejects.toThrow(
      "仅允许 HTTP 或 HTTPS 地址"
    );
  }, 30_000);

  it("observes and executes an approval signed by the API process", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end('<!doctype html><title>申请</title><label for="name">姓名</label><input id="name">');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-browser-ipc-"));
    temporaryDirectories.push(profileDir);
    const approvalKey = Buffer.alloc(32, 4);
    const client = await BrowserWorkerClient.start({ profileDir, headless: true, approvalKey });
    clients.push(client);
    await client.open("task-ipc", `http://127.0.0.1:${address.port}/apply`);
    const observed = await client.observe("task-ipc");
    const field = observed.snapshot.fields.find((candidate) => candidate.label === "姓名");
    if (!field) throw new Error("没有观察到姓名字段");
    const approval = new ActionPolicy(approvalKey).approve({
      taskId: observed.snapshot.taskId,
      snapshotId: observed.snapshot.id,
      targetId: field.id,
      operation: "fill"
    }, observed.snapshot);

    const result = await client.execute({
      type: "fill",
      taskId: observed.snapshot.taskId,
      snapshotId: observed.snapshot.id,
      fieldId: field.id,
      value: "何清",
      approval: approval.token
    });
    expect(result).toMatchObject({ status: "applied", actualValue: "何清" });
  }, 30_000);
});
