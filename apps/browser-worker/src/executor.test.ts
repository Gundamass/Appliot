import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionPolicy } from "@resume/action-policy";
import type { ExecutableCommand, FormSnapshot, WorkerActivity } from "@resume/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSessionManager } from "./session-manager.js";

const sessions: BrowserSessionManager[] = [];
const servers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.stop()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true
  })));
});

  it("blocks an ambiguously labelled intermediate action when it is a submit control", async () => {
    let submissions = 0;
    const server = createServer(async (request, response) => {
      if (request.method === "POST") {
        submissions += 1;
        for await (const _chunk of request) { /* drain request */ }
        response.end("submitted");
        return;
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Application</title>
        <form method="post" action="/submit">
          <label for="email">Email</label><input id="email" name="email" value="me@example.com">
          <button type="submit">Continue</button>
        </form>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-ambiguous-submit-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 11);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-ambiguous-submit", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-ambiguous-submit");
    const action = snapshot.actions.find((candidate) => candidate.text === "Continue");
    if (!action) throw new Error("ambiguous action was not observed");
    expect(action.class).toBe("intermediate_navigation");
    const result = await session.execute(approvedClick(policy, snapshot, action.id));

    expect(result.status).toBe("blocked");
    expect(result.errors).toEqual(["unsafe_intermediate_action"]);
    expect(submissions).toBe(0);
  }, 30_000);

  it("blocks native submission triggered by an otherwise in-page button", async () => {
    let submissions = 0;
    const server = createServer(async (request, response) => {
      if (request.method === "POST") {
        submissions += 1;
        for await (const _chunk of request) { /* drain request */ }
        response.end("submitted");
        return;
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Application</title>
        <form id="application" method="post" action="/submit">
          <label for="email">Email</label><input id="email" name="email" value="me@example.com">
        </form>
        <button type="button" onclick="document.querySelector('#application').requestSubmit()">Next</button>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-scripted-submit-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 12);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-scripted-submit", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-scripted-submit");
    const action = snapshot.actions.find((candidate) => candidate.text === "Next");
    if (!action) throw new Error("in-page action was not observed");
    const result = await session.execute(approvedClick(policy, snapshot, action.id));

    expect(result.status).toBe("blocked");
    expect(result.errors).toEqual(["terminal_submission_blocked"]);
    expect(submissions).toBe(0);
  }, 30_000);

  it("allows an approved same-origin GET intermediate link", async () => {
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      if (request.url === "/next") {
        response.end("<!doctype html><title>Second step</title><p>Progressed</p>");
        return;
      }
      response.end(`<!doctype html><title>Application</title>
        <label for="email">Email</label><input id="email" name="email" value="me@example.com">
        <a role="button" href="/next">Next</a>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-safe-get-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 13);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    const activities: WorkerActivity[] = [];
    session.subscribeActivity((activity) => activities.push(activity));
    await session.open("task-safe-get", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-safe-get");
    const action = snapshot.actions.find((candidate) => candidate.text === "Next");
    if (!action) throw new Error("safe GET action was not observed");
    const result = await session.execute(approvedClick(policy, snapshot, action.id));

    expect(result.status).toBe("applied");
    expect(result.snapshot.title).toBe("Second step");
    expect(activities.filter((activity) => activity.type === "user_activity")).toEqual([]);
  }, 30_000);

function approvedFill(
  policy: ActionPolicy,
  snapshot: FormSnapshot,
  fieldId: string,
  value: unknown
): ExecutableCommand {
  const approval = policy.approve({
    taskId: snapshot.taskId,
    snapshotId: snapshot.id,
    targetId: fieldId,
    operation: "fill"
  }, snapshot);
  return {
    type: "fill",
    taskId: snapshot.taskId,
    snapshotId: snapshot.id,
    fieldId,
    value,
    approval: approval.token
  };
}

function approvedSelect(
  policy: ActionPolicy,
  snapshot: FormSnapshot,
  fieldId: string,
  value: string
): ExecutableCommand {
  const approval = policy.approve({
    taskId: snapshot.taskId,
    snapshotId: snapshot.id,
    targetId: fieldId,
    operation: "select"
  }, snapshot);
  return {
    type: "select",
    taskId: snapshot.taskId,
    snapshotId: snapshot.id,
    fieldId,
    value,
    approval: approval.token
  };
}

function approvedClick(policy: ActionPolicy, snapshot: FormSnapshot, actionId: string): ExecutableCommand {
  const approval = policy.approve({
    taskId: snapshot.taskId,
    snapshotId: snapshot.id,
    targetId: actionId,
    operation: "click_intermediate"
  }, snapshot);
  return {
    type: "click_intermediate",
    taskId: snapshot.taskId,
    snapshotId: snapshot.id,
    actionId,
    approval: approval.token
  };
}

function approvedUpload(
  policy: ActionPolicy,
  snapshot: FormSnapshot,
  fieldId: string,
  fileId: string
): ExecutableCommand {
  const approval = policy.approve({
    taskId: snapshot.taskId,
    snapshotId: snapshot.id,
    targetId: fieldId,
    operation: "upload"
  }, snapshot);
  return {
    type: "upload",
    taskId: snapshot.taskId,
    snapshotId: snapshot.id,
    fieldId,
    fileId,
    approval: approval.token
  };
}

describe("controlled browser executor", () => {
  it("does not report executor fills as user activity but still reports later manual input", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Application</title>
        <label for="email">Email</label><input id="email" name="email">`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-activity-guard-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 7);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    const activities: WorkerActivity[] = [];
    session.subscribeActivity((activity) => activities.push(activity));
    await session.open("task-guard", `http://127.0.0.1:${address.port}/apply`);
    const snapshot = await session.observe("task-guard");
    const email = snapshot.fields.find((field) => field.label === "Email");
    if (!email) throw new Error("email field was not observed");

    await session.execute(approvedFill(policy, snapshot, email.id, "agent@example.com"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(activities.filter((activity) => activity.type === "user_activity")).toEqual([]);

    const page = (session as unknown as { page: { locator(selector: string): { fill(value: string): Promise<void> } } }).page;
    await page.locator("#email").fill("manual@example.com");
    await vi.waitFor(() => expect(activities.filter((activity) => activity.type === "user_activity")).toHaveLength(1));
  }, 30_000);

  it("fills by opaque field ID, reads back the value, and blocks a stale snapshot", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
        <title>招聘申请</title>
        <form>
          <label for="email">邮箱</label>
          <input id="email" name="email" type="email" required>
          <button type="button">下一步</button>
          <button type="submit">提交申请</button>
        </form>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-executor-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 9);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-1", `http://127.0.0.1:${address.port}/apply`);

    const original = await session.observe("task-1");
    const email = original.fields.find((field) => field.label === "邮箱");
    if (!email) throw new Error("没有观察到邮箱字段");

    const command = approvedFill(policy, original, email.id, "me@example.com");
    const result = await session.execute(command);
    expect(result).toMatchObject({
      status: "applied",
      actualValue: "me@example.com",
      errors: []
    });
    expect(result.snapshot.id).not.toBe(original.id);
    expect(result.snapshot.fields.find((field) => field.id === email.id)?.currentValue).toBe("me@example.com");

    const stale = await session.execute(approvedFill(policy, original, email.id, "other@example.com"));
    expect(stale.status).toBe("blocked");
    expect(stale.errors).toContain("stale_snapshot");
  }, 30_000);

  it("handles checkbox, date, select, and approved intermediate navigation", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
        <title>基本信息</title>
        <form>
          <label for="consent">同意隐私条款</label>
          <input id="consent" name="consent" type="checkbox">
          <label for="available">到岗日期</label>
          <input id="available" name="available" type="date">
          <label for="role">岗位方向</label>
          <select id="role" name="role">
            <option value="">请选择</option>
            <option value="backend">后端开发</option>
            <option value="frontend">前端开发</option>
          </select>
          <button type="button" onclick="document.title='第二步'">下一步</button>
          <button type="submit">提交申请</button>
        </form>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-controls-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 5);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-2", `http://127.0.0.1:${address.port}/apply`);

    let snapshot = await session.observe("task-2");
    const checkbox = snapshot.fields.find((field) => field.label === "同意隐私条款");
    if (!checkbox) throw new Error("没有观察到复选框");
    let result = await session.execute(approvedFill(policy, snapshot, checkbox.id, true));
    expect(result).toMatchObject({ status: "applied", actualValue: true });

    snapshot = result.snapshot;
    const date = snapshot.fields.find((field) => field.label === "到岗日期");
    if (!date) throw new Error("没有观察到日期字段");
    result = await session.execute(approvedFill(policy, snapshot, date.id, "2026-08-01"));
    expect(result).toMatchObject({ status: "applied", actualValue: "2026-08-01" });

    snapshot = result.snapshot;
    const select = snapshot.fields.find((field) => field.label === "岗位方向");
    if (!select) throw new Error("没有观察到下拉框");
    result = await session.execute(approvedSelect(policy, snapshot, select.id, "后端开发"));
    expect(result).toMatchObject({ status: "applied", actualValue: "backend" });

    snapshot = result.snapshot;
    const next = snapshot.actions.find((action) => action.text === "下一步");
    if (!next) throw new Error("没有观察到下一步操作");
    result = await session.execute(approvedClick(policy, snapshot, next.id));
    expect(result.status).toBe("applied");
    expect(result.snapshot.title).toBe("第二步");
  }, 30_000);

  it("selects a custom year combobox by opening and choosing a visible option", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>DJI Apply</title>
        <div class="apply-field-date">
          <div class="title-date">起止时间</div>
          <div class="ctrl-date">
            <div id="year" role="combobox" aria-label="年" tabindex="0">年</div>
            <div id="year-options" role="listbox" hidden>
              <div role="option">2025</div>
              <div role="option">2026</div>
            </div>
          </div>
        </div>
        <script>
          const year = document.querySelector('#year');
          const list = document.querySelector('#year-options');
          year.addEventListener('click', () => { list.hidden = false; });
          list.addEventListener('click', (event) => {
            const option = event.target.closest('[role=option]');
            if (!option) return;
            year.textContent = option.textContent;
            list.hidden = true;
          });
        </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-custom-select-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 15);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-custom-select", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-custom-select");
    const year = snapshot.fields.find((field) => field.label === "起止时间 年");
    if (!year) throw new Error("custom year control was not observed");
    const result = await session.execute(approvedSelect(policy, snapshot, year.id, "2026"));

    expect(result).toMatchObject({
      status: "applied",
      actualValue: "2026",
      errors: []
    });
  }, 30_000);

  it("fails an intermediate click that produces no observable page change", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
        <title>基本信息</title>
        <form>
          <label for="email">邮箱</label>
          <input id="email" name="email" value="me@example.com">
          <button type="button">下一步</button>
        </form>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-no-progress-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 4);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-no-progress", `http://127.0.0.1:${address.port}/apply`);

    const original = await session.observe("task-no-progress");
    const next = original.actions.find((action) => action.text === "下一步");
    if (!next) throw new Error("没有观察到下一步操作");
    const result = await session.execute(approvedClick(policy, original, next.id));

    expect(result.status).toBe("failed");
    expect(result.errors).toEqual(["intermediate_no_progress"]);
    expect(result.snapshot.url).toBe(original.url);
  }, 30_000);

  it("uploads only a file resolved from an opaque file ID", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
        <title>附件上传</title>
        <label for="resume">附件</label>
        <input id="attachment" name="attachment" type="file">`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-upload-"));
    temporaryDirectories.push(profileDir);
    const resumePath = join(profileDir, "resume.pdf");
    await writeFile(resumePath, "%PDF-1.4 test", "utf8");
    const key = Buffer.alloc(32, 3);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({
      profileDir,
      headless: true,
      fileResolver: async (fileId) => fileId === "resume-file-1" ? resumePath : undefined
    });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-3", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-3");
    const upload = snapshot.fields.find((field) => field.label === "附件");
    if (!upload) throw new Error("没有观察到文件字段");
    const result = await session.execute(approvedUpload(policy, snapshot, upload.id, "resume-file-1"));
    expect(result.status).toBe("applied");
    expect(String(result.actualValue)).toContain("resume.pdf");
  }, 30_000);

  it("accepts a resume upload when the site replaces the file input with parsed fields", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
        <title>附件上传</title>
        <div id="upload"><label for="resume">简历附件</label><input id="resume" name="resume" type="file"></div>
        <div id="parsed"></div>
        <script>
          document.querySelector('#resume').addEventListener('change', () => {
            document.querySelector('#upload').remove();
            document.querySelector('#parsed').innerHTML = '<label for="email">邮箱</label><input id="email" name="email" value="parsed@example.com">';
          });
        </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-upload-parsed-"));
    temporaryDirectories.push(profileDir);
    const resumePath = join(profileDir, "resume.pdf");
    await writeFile(resumePath, "%PDF-1.4 test", "utf8");
    const key = Buffer.alloc(32, 18);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({
      profileDir,
      headless: true,
      fileResolver: async () => resumePath
    });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-upload-parsed", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-upload-parsed");
    const upload = snapshot.fields.find((field) => field.label === "简历附件")!;
    const result = await session.execute(approvedUpload(policy, snapshot, upload.id, "resume-file-1"));

    expect(result.status).toBe("applied");
    expect(result.snapshot.fields).toEqual([
      expect.objectContaining({ label: "邮箱", currentValue: "parsed@example.com" })
    ]);
  }, 30_000);

  it("waits for delayed and multi-stage resume parsing before reporting success", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
        <title>附件上传</title>
        <div id="upload"><label for="resume">简历附件</label><input id="resume" name="resume" type="file"></div>
        <div id="parsed"></div>
        <script>
          document.querySelector('#resume').addEventListener('change', () => {
            setTimeout(() => {
              document.querySelector('#upload').remove();
              document.querySelector('#parsed').innerHTML = '<label for="email">邮箱</label><input id="email" name="email" value="">';
              setTimeout(() => {
                const email = document.querySelector('#email');
                email.value = 'parsed@example.com';
                email.dispatchEvent(new Event('input', { bubbles: true }));
              }, 140);
            }, 140);
          });
        </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-upload-delayed-parsed-"));
    temporaryDirectories.push(profileDir);
    const resumePath = join(profileDir, "resume.pdf");
    await writeFile(resumePath, "%PDF-1.4 test", "utf8");
    const key = Buffer.alloc(32, 20);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({
      profileDir,
      headless: true,
      fileResolver: async () => resumePath
    });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-upload-delayed-parsed", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-upload-delayed-parsed");
    const upload = snapshot.fields.find((field) => field.label === "简历附件");
    if (!upload) throw new Error("没有观察到文件字段");
    const result = await session.execute(approvedUpload(policy, snapshot, upload.id, "resume-file-1"));

    expect(result.status).toBe("applied");
    expect(result.snapshot.fields).toEqual([
      expect.objectContaining({ label: "邮箱", currentValue: "parsed@example.com" })
    ]);
  }, 30_000);

  it("times out when a resume upload disappears without producing parsed values", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
        <title>Resume upload</title>
        <div id="upload"><label for="resume">Resume</label><input id="resume" name="resume" type="file"></div>
        <label for="email">Email</label><input id="email" name="email" value="">
        <script>
          document.querySelector('#resume').addEventListener('change', () => {
            document.querySelector('#upload').remove();
          });
        </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-upload-no-values-"));
    temporaryDirectories.push(profileDir);
    const resumePath = join(profileDir, "resume.pdf");
    await writeFile(resumePath, "%PDF-1.4 test", "utf8");
    const key = Buffer.alloc(32, 21);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({
      profileDir,
      headless: true,
      fileResolver: async () => resumePath
    });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-upload-no-values", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-upload-no-values");
    const upload = snapshot.fields.find((field) => field.label === "Resume");
    if (!upload) throw new Error("upload field was not observed");
    const result = await session.execute(approvedUpload(policy, snapshot, upload.id, "resume-file-1"));

    expect(result.status).toBe("failed");
    expect(result.errors).toEqual(["upload_parse_timeout"]);
  }, 30_000);

  it("rejects an upload when the site only clears the file and shows an error", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>附件上传</title>
        <label for="resume">简历附件</label><input id="resume" name="resume" type="file">
        <div id="result"></div>
        <script>
          document.querySelector('#resume').addEventListener('change', (event) => {
            event.target.value = '';
            document.querySelector('#result').innerHTML = '<div class="field-error">简历解析失败</div>';
          });
        </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-upload-error-"));
    temporaryDirectories.push(profileDir);
    const resumePath = join(profileDir, "resume.pdf");
    await writeFile(resumePath, "%PDF-1.4 test", "utf8");
    const key = Buffer.alloc(32, 19);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true, fileResolver: async () => resumePath });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-upload-error", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-upload-error");
    const upload = snapshot.fields.find((field) => field.label === "简历附件")!;
    const result = await session.execute(approvedUpload(policy, snapshot, upload.id, "resume-file-1"));

    expect(result.status).toBe("failed");
    expect(result.errors).toContain("readback_mismatch");
  }, 30_000);

  it("fails a select command when the requested option is not read back", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Select readback</title>
        <label for="role">岗位方向</label>
        <select id="role" name="role">
          <option value="">请选择</option>
          <option value="backend">后端开发</option>
        </select>
        <script>document.querySelector('#role').addEventListener('change', (event) => { event.target.value = ''; });</script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");
    const profileDir = await mkdtemp(join(tmpdir(), "resume-select-readback-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 16);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-select-readback", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-select-readback");
    const field = snapshot.fields.find((candidate) => candidate.label === "岗位方向")!;
    const result = await session.execute(approvedSelect(policy, snapshot, field.id, "后端开发"));

    expect(result.status).toBe("failed");
    expect(result.errors).toContain("readback_mismatch");
  }, 30_000);

  it("does not mutate a file field when its execution epoch is invalidated during file lookup", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Upload</title>
        <label for="resume">Resume</label><input id="resume" name="resume" type="file">`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-cancel-upload-"));
    temporaryDirectories.push(profileDir);
    const resumePath = join(profileDir, "resume.pdf");
    await writeFile(resumePath, "%PDF-1.4 test", "utf8");
    let lookupStarted!: () => void;
    const started = new Promise<void>((resolve) => { lookupStarted = resolve; });
    let finishLookup!: (path: string) => void;
    const lookup = new Promise<string>((resolve) => { finishLookup = resolve; });
    const key = Buffer.alloc(32, 14);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({
      profileDir,
      headless: true,
      fileResolver: async () => {
        lookupStarted();
        return lookup;
      }
    });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-cancel-upload", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-cancel-upload");
    const upload = snapshot.fields.find((field) => field.label === "Resume");
    if (!upload) throw new Error("upload field was not observed");
    const pending = session.execute(approvedUpload(policy, snapshot, upload.id, "resume-file-1"), 1);
    await started;

    session.invalidateExecution("task-cancel-upload", 2);
    finishLookup(resumePath);

    await expect(pending).resolves.toMatchObject({
      status: "blocked",
      errors: ["execution_invalidated"]
    });
    const observed = await session.observe("task-cancel-upload");
    expect(observed.fields.find((field) => field.id === upload.id)?.currentValue).toBe("");
  }, 30_000);

  it("blocks intermediate navigation while the page has visible validation errors", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
        <title>信息校验</title>
        <div class="field-error">邮箱格式错误</div>
        <button type="button" onclick="document.title='不应到达'">下一步</button>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-validation-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 2);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-4", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-4");
    const next = snapshot.actions.find((action) => action.text === "下一步");
    if (!next) throw new Error("没有观察到下一步操作");
    const result = await session.execute(approvedClick(policy, snapshot, next.id));
    expect(result.status).toBe("blocked");
    expect(result.errors).toContain("page_not_valid");
    expect(result.snapshot.title).toBe("信息校验");
  }, 30_000);
});
