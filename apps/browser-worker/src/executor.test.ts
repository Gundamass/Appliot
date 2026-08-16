import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionPolicy } from "@resume/action-policy";
import type { ExecutableCommand, FormSnapshot, WorkerActivity } from "@resume/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlledExecutor } from "./executor.js";
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
  const nodeRef = snapshot.fields.find((field) => field.id === fieldId)?.nodeRef;
  if (nodeRef === undefined) throw new Error("field_node_ref_not_found");
  const executionEpoch = 11;
  const approval = policy.approve({
    taskId: snapshot.taskId,
    snapshotId: snapshot.id,
    targetId: fieldId,
    operation: "fill",
    nodeRef,
    executionEpoch
  }, snapshot);
  return {
    type: "fill",
    taskId: snapshot.taskId,
    snapshotId: snapshot.id,
    fieldId,
    nodeRef,
    executionEpoch,
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
  const nodeRef = snapshot.fields.find((field) => field.id === fieldId)?.nodeRef;
  if (nodeRef === undefined) throw new Error("field_node_ref_not_found");
  const executionEpoch = 11;
  const approval = policy.approve({
    taskId: snapshot.taskId,
    snapshotId: snapshot.id,
    targetId: fieldId,
    operation: "select",
    nodeRef,
    executionEpoch
  }, snapshot);
  return {
    type: "select",
    taskId: snapshot.taskId,
    snapshotId: snapshot.id,
    fieldId,
    nodeRef,
    executionEpoch,
    value,
    approval: approval.token
  };
}

function approvedClick(policy: ActionPolicy, snapshot: FormSnapshot, actionId: string): ExecutableCommand {
  const nodeRef = snapshot.actions.find((action) => action.id === actionId)?.nodeRef;
  if (nodeRef === undefined) throw new Error("action_node_ref_not_found");
  const executionEpoch = 11;
  const approval = policy.approve({
    taskId: snapshot.taskId,
    snapshotId: snapshot.id,
    targetId: actionId,
    operation: "click_intermediate",
    nodeRef,
    executionEpoch
  }, snapshot);
  return {
    type: "click_intermediate",
    taskId: snapshot.taskId,
    snapshotId: snapshot.id,
    actionId,
    nodeRef,
    executionEpoch,
    approval: approval.token
  };
}

function approvedUpload(
  policy: ActionPolicy,
  snapshot: FormSnapshot,
  fieldId: string,
  fileId: string
): ExecutableCommand {
  const nodeRef = snapshot.fields.find((field) => field.id === fieldId)?.nodeRef;
  if (nodeRef === undefined) throw new Error("field_node_ref_not_found");
  const executionEpoch = 11;
  const approval = policy.approve({
    taskId: snapshot.taskId,
    snapshotId: snapshot.id,
    targetId: fieldId,
    operation: "upload",
    nodeRef,
    executionEpoch
  }, snapshot);
  return {
    type: "upload",
    taskId: snapshot.taskId,
    snapshotId: snapshot.id,
    fieldId,
    nodeRef,
    executionEpoch,
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

  it("keeps delayed ATS input events suppressed through the automatic readback", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Application</title>
        <label for="email">Email</label><input id="email" name="email">
        <script>
          const email = document.querySelector('#email');
          email.addEventListener('input', () => {
            if (email.value !== 'agent@example.com' || email.dataset.replayed) return;
            email.dataset.replayed = 'true';
            setTimeout(() => email.dispatchEvent(new Event('input', { bubbles: true })), 90);
          });
        </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-delayed-activity-guard-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 23);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    const activities: WorkerActivity[] = [];
    session.subscribeActivity((activity) => activities.push(activity));
    await session.open("task-delayed-guard", `http://127.0.0.1:${address.port}/apply`);
    const snapshot = await session.observe("task-delayed-guard");
    const email = snapshot.fields.find((field) => field.label === "Email");
    if (!email) throw new Error("email field was not observed");

    await session.execute(approvedFill(policy, snapshot, email.id, "agent@example.com"));
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(activities.filter((activity) => activity.type === "user_activity")).toEqual([]);
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

  it("selects and reads back native and ARIA choice groups", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Apply</title>
        <fieldset required>
          <legend>Are you willing to relocate?</legend>
          <label><input type="radio" name="relocate" value="Yes" checked>Yes</label>
          <label><input type="radio" name="relocate" value="No">No</label>
        </fieldset>
        <div role="radiogroup" aria-label="Will you require sponsorship?" aria-required="true">
          <button type="button" role="radio" aria-checked="true">Yes</button>
          <button type="button" role="radio" aria-checked="false">No</button>
        </div>
        <script>
          document.querySelector('[role=radiogroup]').addEventListener('click', (event) => {
            const selected = event.target.closest('[role=radio]');
            if (!selected) return;
            for (const choice of document.querySelectorAll('[role=radiogroup] [role=radio]')) {
              choice.setAttribute('aria-checked', String(choice === selected));
            }
          });
        </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-choice-groups-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 5);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-choice-groups", `http://127.0.0.1:${address.port}/apply`);

    let snapshot = await session.observe("task-choice-groups");
    const relocate = snapshot.fields.find((field) => field.label === "Are you willing to relocate?");
    if (!relocate) throw new Error("native radio group was not observed");
    let result = await session.execute(approvedSelect(policy, snapshot, relocate.id, "false"));
    expect(result).toMatchObject({ status: "applied", actualValue: "No" });

    snapshot = result.snapshot;
    const sponsorship = snapshot.fields.find((field) => field.label === "Will you require sponsorship?");
    if (!sponsorship) throw new Error("ARIA radio group was not observed");
    result = await session.execute(approvedSelect(policy, snapshot, sponsorship.id, "No"));
    expect(result).toMatchObject({ status: "applied", actualValue: "No" });
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

  it("selects a DJI text-backed year control from its visible menu items", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>DJI Apply</title>
        <div class="apply-field-date">
          <div class="title-date">Start date</div>
          <div class="ctrl-date">
            <div class="sd-Dropdown-container-282zZ">
              <label class="sd-Input-container-3OoVt sd-Select-container-D6nZH">
                <span id="stale-display" class="sd-Input-display-value-1RTHN"></span>
                <input id="stale" type="text" placeholder="Stale" value="">
              </label>
            </div>
            <div class="sd-Dropdown-container-282zZ">
              <label class="sd-Input-container-3OoVt sd-Select-container-D6nZH">
                <span id="year-display" class="sd-Input-display-value-1RTHN"></span>
                <input id="year" type="text" placeholder="年" value="">
              </label>
            </div>
            <div class="sd-Dropdown-container-282zZ">
              <label class="sd-Input-container-3OoVt sd-Select-container-D6nZH">
                <span id="month-display" class="sd-Input-display-value-1RTHN"></span>
                <input id="month" type="text" placeholder="月" value="">
              </label>
            </div>
            <div id="stale-options" class="sd-Select-menu-UbIS2" hidden>
              <div class="sd-Menu-content-item-37fPj">2026</div>
            </div>
            <div id="year-options" class="sd-Select-menu-UbIS2" hidden>
              <div class="sd-Menu-content-item-37fPj">2025</div>
              <div class="sd-Menu-content-item-37fPj">2026</div>
            </div>
            <div id="month-options" class="sd-Select-menu-UbIS2" hidden>
              <div class="sd-Menu-content-item-37fPj">1</div>
              <div class="sd-Menu-content-item-37fPj">04</div>
            </div>
          </div>
        </div>
        <script>
          const stale = document.querySelector('#stale');
          const staleDisplay = document.querySelector('#stale-display');
          const staleList = document.querySelector('#stale-options');
          const year = document.querySelector('#year');
          const display = document.querySelector('#year-display');
          const list = document.querySelector('#year-options');
          const month = document.querySelector('#month');
          const monthDisplay = document.querySelector('#month-display');
          const monthList = document.querySelector('#month-options');
          stale.addEventListener('click', () => { staleList.hidden = false; });
          stale.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') staleList.hidden = true;
          });
          staleList.addEventListener('click', (event) => {
            const option = event.target.closest('[class*="Menu-content-item"]');
            if (!option) return;
            staleDisplay.textContent = option.textContent;
            staleList.hidden = true;
          });
          year.addEventListener('click', () => { list.hidden = false; });
          list.addEventListener('click', (event) => {
            const option = event.target.closest('[class*="Menu-content-item"]');
            if (!option) return;
            display.textContent = option.textContent;
            year.removeAttribute('placeholder');
            list.hidden = true;
          });
          month.addEventListener('click', () => { monthList.hidden = false; });
          monthList.addEventListener('click', (event) => {
            const option = event.target.closest('[class*="Menu-content-item"]');
            if (!option) return;
            monthDisplay.textContent = option.textContent;
            month.removeAttribute('placeholder');
            monthList.hidden = true;
          });
        </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-dji-text-select-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 16);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-dji-text-select", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-dji-text-select");
    const stale = snapshot.fields.find((field) => field.type === "select"
      && field.controlKind === "custom"
      && !/[年月]/u.test(field.label));
    if (!stale) throw new Error("stale custom control was not observed");
    const failed = await session.execute(approvedSelect(policy, snapshot, stale.id, "2099"));
    expect(failed).toMatchObject({ status: "failed", errors: ["custom_option_not_found"] });

    const year = failed.snapshot.fields.find((field) => field.label === "Start date 年");
    if (!year) throw new Error("DJI text-backed year control was not observed");
    const result = await session.execute(approvedSelect(policy, failed.snapshot, year.id, "2026"));

    expect(result).toMatchObject({
      status: "applied",
      actualValue: "2026",
      errors: []
    });
    expect(result.snapshot.fields.find((field) => field.id === year.id)).toMatchObject({
      label: "Start date 年",
      currentValue: "2026"
    });
    const month = result.snapshot.fields.find((field) => field.label === "Start date 月");
    if (!month) throw new Error("DJI text-backed month control was not observed");
    const monthResult = await session.execute(approvedSelect(policy, result.snapshot, month.id, "04"));

    expect(monthResult).toMatchObject({
      status: "applied",
      actualValue: "04",
      errors: []
    });
    expect(monthResult.snapshot.fields.find((field) => field.id === month.id)).toMatchObject({
      label: "Start date 月",
      currentValue: "04"
    });
  }, 30_000);

  it("types into a searchable school control before selecting the exact result", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Apply</title>
        <label for="school">School</label>
        <input id="school" role="combobox" aria-label="School" aria-controls="school-options">
        <div id="school-options" role="listbox"></div>
        <script>
          const input = document.querySelector('#school');
          const list = document.querySelector('#school-options');
          input.addEventListener('input', () => {
            list.innerHTML = input.value === 'Tongji University'
              ? '<div role="option">Tongji University</div>'
              : '';
          });
          list.addEventListener('click', (event) => {
            const option = event.target.closest('[role=option]');
            if (!option) return;
            input.value = option.textContent;
            list.innerHTML = '';
          });
        </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-searchable-school-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 17);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-searchable-school", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-searchable-school");
    const school = snapshot.fields.find((field) => field.label === "School");
    if (!school) throw new Error("searchable school control was not observed");
    const result = await session.execute(approvedSelect(policy, snapshot, school.id, "Tongji University"));

    expect(result).toMatchObject({ status: "applied", actualValue: "Tongji University", errors: [] });
  }, 30_000);

  it("scopes duplicate custom-select options to the target control popup", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Apply</title>
        <label for="laboratory-one">是否有实验室经历</label>
        <input id="laboratory-one" role="combobox" aria-label="是否有实验室经历" aria-controls="laboratory-one-options" aria-expanded="true">
        <div id="laboratory-one-options" role="listbox">
          <div role="option">是</div><div role="option">否</div>
        </div>
        <label for="laboratory-two">是否有实验室经历</label>
        <input id="laboratory-two" role="combobox" aria-label="是否有实验室经历" aria-controls="laboratory-two-options" aria-expanded="true">
        <div id="laboratory-two-options" role="listbox">
          <div role="option">是</div><div role="option">否</div>
        </div>
        <script>
          for (const input of document.querySelectorAll('[role=combobox]')) {
            const list = document.getElementById(input.getAttribute('aria-controls'));
            list.addEventListener('click', (event) => {
              const option = event.target.closest('[role=option]');
              if (!option) return;
              input.value = option.textContent;
              input.setAttribute('aria-expanded', 'false');
              list.hidden = true;
            });
          }
        </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-scoped-custom-select-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 24);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-scoped-custom-select", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-scoped-custom-select");
    const laboratory = snapshot.fields.find((field) => field.label === "是否有实验室经历");
    if (!laboratory) throw new Error("laboratory control was not observed");
    const result = await session.execute(approvedSelect(policy, snapshot, laboratory.id, "是"));

    expect(result).toMatchObject({ status: "applied", actualValue: "是", errors: [] });
  }, 30_000);

  it("scopes duplicate Mokahr options to the nearest field container without ARIA ownership", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>DJI Apply</title>
        <section class="form-item-one">
          <label class="sd-Input-container sd-Select-container">
            <span class="sd-Input-display-value"></span>
            <input id="laboratory-one" type="text" placeholder="是否有实验室经历">
          </label>
          <div class="sd-Select-menu"><div class="sd-Menu-content-item">是</div><div class="sd-Menu-content-item">否</div></div>
        </section>
        <section class="form-item-two">
          <label class="sd-Input-container sd-Select-container">
            <span class="sd-Input-display-value"></span>
            <input id="laboratory-two" type="text" placeholder="是否有实验室经历">
          </label>
          <div class="sd-Select-menu"><div class="sd-Menu-content-item">是</div><div class="sd-Menu-content-item">否</div></div>
        </section>
        <script>
          for (const section of document.querySelectorAll('section')) {
            const input = section.querySelector('input');
            const display = section.querySelector('[class*=Input-display-value]');
            section.querySelector('[class*=Select-menu]').addEventListener('click', (event) => {
              const option = event.target.closest('[class*=Menu-content-item]');
              if (!option) return;
              input.value = option.textContent;
              display.textContent = option.textContent;
            });
          }
        </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-nearest-custom-select-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 25);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-nearest-custom-select", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-nearest-custom-select");
    const laboratory = snapshot.fields[0];
    if (!laboratory) throw new Error("laboratory control was not observed");
    const result = await session.execute(approvedSelect(policy, snapshot, laboratory.id, "是"));

    expect(result).toMatchObject({ status: "applied", actualValue: "是", errors: [] });
  }, 30_000);

  it("collapses nested Mokahr option labels that represent the same logical choice", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>DJI Apply</title>
        <section class="apply-field">
          <label class="sd-Input-container sd-Select-container">
            <input id="laboratory" type="text" placeholder="是否有实验室经历">
          </label>
        </section>
        <div class="sd-Select-menu">
          <div class="sd-Menu-content-item"><span class="option-label">是</span></div>
          <div class="sd-Menu-content-item"><span class="option-label">否</span></div>
        </div>
        <script>
          const input = document.querySelector('#laboratory');
          document.querySelector('.sd-Select-menu').addEventListener('click', (event) => {
            const option = event.target.closest('.sd-Menu-content-item');
            if (!option) return;
            input.value = option.textContent;
          });
        </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-nested-custom-option-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 28);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-nested-custom-option", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-nested-custom-option");
    const laboratory = snapshot.fields.find((field) => field.label === "是否有实验室经历");
    if (!laboratory) throw new Error("laboratory control was not observed");
    const result = await session.execute(approvedSelect(policy, snapshot, laboratory.id, "是"));

    expect(result).toMatchObject({ status: "applied", actualValue: "是", errors: [] });
  }, 30_000);

  it("projects an exact percentile rank into the smallest containing ATS bucket", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>DJI Apply</title>
        <label class="sd-Input-container sd-Select-container">
          <input id="rank" type="text" placeholder="成绩排名">
        </label>
        <div class="sd-Select-menu">
          <div class="sd-Menu-content-item"><span class="option-label">前10%</span></div>
          <div class="sd-Menu-content-item"><span class="option-label">前30%</span></div>
          <div class="sd-Menu-content-item"><span class="option-label">前50%</span></div>
          <div class="sd-Menu-content-item"><span class="option-label">其他</span></div>
        </div>
        <script>
          const input = document.querySelector('#rank');
          document.querySelector('.sd-Select-menu').addEventListener('click', (event) => {
            const option = event.target.closest('.sd-Menu-content-item');
            if (!option) return;
            input.value = option.textContent;
          });
        </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-percentile-bucket-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 29);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-percentile-bucket", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-percentile-bucket");
    const rank = snapshot.fields.find((field) => field.label === "成绩排名");
    if (!rank) throw new Error("rank control was not observed");
    const result = await session.execute(approvedSelect(policy, snapshot, rank.id, "前5%"));

    expect(result).toMatchObject({
      status: "applied",
      actualValue: "前10%",
      errors: [],
      warnings: ["control_recovered_after_readback_mismatch"]
    });
  }, 30_000);

  it("reads a DJI custom selection from its display node instead of decorative label text", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>DJI Apply</title>
        <div class="apply-field-rank">
          <div class="title-rank">成绩排名</div>
          <div class="ctrl-rank">
            <label class="sd-Input-container sd-Select-container">
              <span class="sd-Input-display-value"></span>
              <input id="rank" type="text" placeholder="请选择" value="">
              <span class="sd-Input-addon">下拉</span>
            </label>
          </div>
        </div>
        <div class="sd-Select-menu" hidden>
          <div class="sd-Menu-content-item">前10%</div>
          <div class="sd-Menu-content-item">前30%</div>
        </div>
        <script>
          const input = document.querySelector('#rank');
          const display = document.querySelector('[class*=Input-display-value]');
          const menu = document.querySelector('[class*=Select-menu]');
          input.addEventListener('click', () => { menu.hidden = false; });
          menu.addEventListener('click', (event) => {
            const option = event.target.closest('[class*=Menu-content-item]');
            if (!option) return;
            display.textContent = option.textContent;
            menu.hidden = true;
          });
        </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-dji-display-readback-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 33);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-dji-display-readback", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-dji-display-readback");
    const rank = snapshot.fields.find((field) => field.label === "成绩排名");
    if (!rank) throw new Error("rank control was not observed");
    const result = await session.execute(approvedSelect(policy, snapshot, rank.id, "前10%"));

    expect(result).toMatchObject({ status: "applied", actualValue: "前10%", errors: [] });
  }, 30_000);

  it("waits for a delayed searchable ATS option and selects one uniquely annotated result", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Apply</title>
        <label for="award">赛事名称</label>
        <input id="award" role="combobox" aria-label="赛事名称" aria-controls="award-options" aria-expanded="false">
        <div id="award-options" role="listbox" hidden></div>
        <script>
          const input = document.querySelector('#award');
          const list = document.querySelector('#award-options');
          let timer;
          input.addEventListener('input', () => {
            clearTimeout(timer);
            list.hidden = false;
            list.innerHTML = '';
            timer = setTimeout(() => {
              list.innerHTML = input.value === '全国大学生软件创新大赛'
                ? '<div role="option">全国大学生软件创新大赛 <span>国家级 · 2025</span></div>'
                : '';
            }, 1700);
          });
          input.addEventListener('click', () => {
            input.setAttribute('aria-expanded', 'true');
            list.hidden = false;
          });
          list.addEventListener('click', (event) => {
            const option = event.target.closest('[role=option]');
            if (!option) return;
            input.value = option.textContent.trim().replace(/\\s+/g, ' ');
            input.setAttribute('aria-expanded', 'false');
            list.hidden = true;
          });
        </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-delayed-award-select-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 19);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-delayed-award-select", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-delayed-award-select");
    const award = snapshot.fields.find((field) => field.label === "赛事名称");
    if (!award) throw new Error("searchable award control was not observed");
    const result = await session.execute(approvedSelect(
      policy,
      snapshot,
      award.id,
      "全国大学生软件创新大赛"
    ));

    expect(result).toMatchObject({
      status: "applied",
      actualValue: "全国大学生软件创新大赛 国家级 · 2025",
      errors: []
    });
  }, 30_000);

  it("rejects ambiguous annotated results from a searchable ATS control", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Apply</title>
        <label for="award">赛事名称</label>
        <input id="award" role="combobox" aria-label="赛事名称" aria-controls="award-options">
        <div id="award-options" role="listbox"></div>
        <script>
          const input = document.querySelector('#award');
          const list = document.querySelector('#award-options');
          input.addEventListener('input', () => {
            list.innerHTML = [
              '<div role="option">全国大学生软件创新大赛 国家级 · 2025</div>',
              '<div role="option">全国大学生软件创新大赛 省级 · 2025</div>'
            ].join('');
          });
        </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-ambiguous-award-select-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 20);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-ambiguous-award-select", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-ambiguous-award-select");
    const award = snapshot.fields.find((field) => field.label === "赛事名称");
    if (!award) throw new Error("searchable award control was not observed");
    const result = await session.execute(approvedSelect(
      policy,
      snapshot,
      award.id,
      "全国大学生软件创新大赛"
    ));

    expect(result).toMatchObject({ status: "failed", errors: ["custom_option_ambiguous"] });
  }, 30_000);

  it("does not accept a custom option when the control readback stays on the search text", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Apply</title>
        <label for="school">School</label>
        <input id="school" role="combobox" aria-label="School" aria-controls="school-options">
        <div id="school-options" role="listbox"></div>
        <script>
          const input = document.querySelector('#school');
          const list = document.querySelector('#school-options');
          input.addEventListener('input', () => {
            list.innerHTML = '<div role="option">Tongji University</div>';
          });
          list.addEventListener('click', () => { input.value = 'Other University'; list.innerHTML = ''; });
        </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-searchable-readback-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 18);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-searchable-readback", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-searchable-readback");
    const school = snapshot.fields.find((field) => field.label === "School");
    if (!school) throw new Error("searchable school control was not observed");
    const result = await session.execute(approvedSelect(policy, snapshot, school.id, "Tongji University"));

    expect(result).toMatchObject({ status: "failed", errors: ["custom_readback_mismatch"] });
  }, 30_000);

  it("does not accept a searchable custom option when its click leaves the popup open", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Apply</title>
        <label for="school">School</label>
        <input id="school" role="combobox" aria-label="School" aria-controls="school-options" aria-expanded="true">
        <div id="school-options" role="listbox"></div>
        <script>
          const input = document.querySelector('#school');
          const list = document.querySelector('#school-options');
          input.addEventListener('input', () => {
            list.innerHTML = '<div role="option">Tongji University</div>';
          });
        </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-searchable-no-selection-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 30);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-searchable-no-selection", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-searchable-no-selection");
    const school = snapshot.fields.find((field) => field.label === "School");
    if (!school) throw new Error("searchable school control was not observed");
    const result = await session.execute(approvedSelect(policy, snapshot, school.id, "Tongji University"));

    expect(result).toMatchObject({ status: "failed", errors: ["custom_selection_not_committed"] });
  }, 30_000);

  it("waits for a searchable custom option to commit asynchronously", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Apply</title>
        <label for="major">Major</label>
        <input id="major" role="combobox" aria-label="Major" aria-controls="major-options" aria-expanded="true">
        <div id="major-options" role="listbox"></div>
        <script>
          const input = document.querySelector('#major');
          const list = document.querySelector('#major-options');
          input.addEventListener('input', () => {
            list.hidden = false;
            list.innerHTML = '<div role="option">Software Engineering</div>';
          });
          list.addEventListener('click', () => {
            setTimeout(() => {
              input.value = 'Software Engineering';
              input.setAttribute('aria-expanded', 'false');
              list.hidden = true;
            }, 150);
          });
        </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-async-select-commit-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 31);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-async-select-commit", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-async-select-commit");
    const major = snapshot.fields.find((field) => field.label === "Major");
    if (!major) throw new Error("major control was not observed");
    const result = await session.execute(approvedSelect(policy, snapshot, major.id, "Software Engineering"));

    expect(result).toMatchObject({
      status: "applied",
      actualValue: "Software Engineering",
      errors: []
    });
  }, 30_000);

  it("searches a Mokahr custom select identified by its Select container", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>DJI Apply</title>
        <label class="sd-Input-container sd-Select-container">
          <span class="sd-Input-display-value"></span>
          <input id="school" type="text" placeholder="School">
        </label>
        <div class="sd-Select-menu"></div>
        <script>
          const input = document.querySelector('#school');
          const display = document.querySelector('.sd-Input-display-value');
          const menu = document.querySelector('.sd-Select-menu');
          input.addEventListener('input', () => {
            menu.innerHTML = input.value === 'Tongji University'
              ? '<div class="sd-Menu-content-item">Tongji University</div>'
              : '';
          });
          menu.addEventListener('click', (event) => {
            const option = event.target.closest('.sd-Menu-content-item');
            if (!option) return;
            input.value = option.textContent;
            display.textContent = option.textContent;
            menu.hidden = true;
          });
        </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-mokahr-searchable-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 31);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-mokahr-searchable", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-mokahr-searchable");
    const school = snapshot.fields.find((field) => field.label === "School");
    if (!school) throw new Error("Mokahr school control was not observed");
    const result = await session.execute(approvedSelect(policy, snapshot, school.id, "Tongji University"));

    expect(result).toMatchObject({ status: "applied", actualValue: "Tongji University", errors: [] });
  }, 30_000);

  it("associates a portal-mounted Mokahr menu with the nearest custom select", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>DJI Apply</title>
        <style>
          #first { position: absolute; top: 20px; left: 20px; }
          #second { position: absolute; top: 220px; left: 20px; }
          #first-menu { position: absolute; top: 55px; left: 20px; }
          #second-menu { position: absolute; top: 255px; left: 20px; }
        </style>
        <label id="first" class="sd-Input-container sd-Select-container"><input id="laboratory-one" placeholder="First laboratory"></label>
        <label id="second" class="sd-Input-container sd-Select-container"><input id="laboratory-two" placeholder="Second laboratory"></label>
        <div id="first-menu" class="sd-Select-menu"><div class="sd-Menu-content-item">Yes</div><div class="sd-Menu-content-item">No</div></div>
        <div id="second-menu" class="sd-Select-menu"><div class="sd-Menu-content-item">Yes</div><div class="sd-Menu-content-item">No</div></div>
        <script>
          document.querySelector('#first-menu').addEventListener('click', (event) => {
            document.querySelector('#laboratory-one').value = event.target.textContent;
          });
          document.querySelector('#second-menu').addEventListener('click', (event) => {
            document.querySelector('#laboratory-two').value = event.target.textContent;
          });
        </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-mokahr-portal-scope-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 32);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-mokahr-portal-scope", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-mokahr-portal-scope");
    const second = snapshot.fields.find((field) => field.label === "Second laboratory");
    if (!second) throw new Error("second Mokahr control was not observed");
    const result = await session.execute(approvedSelect(policy, snapshot, second.id, "Yes"));

    expect(result).toMatchObject({ status: "applied", actualValue: "Yes", errors: [] });
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

  it("returns a stable date-component error when a selected year is not committed", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Date readback</title>
        <label for="start-year">Start date year</label>
        <select id="start-year" name="startYear">
          <option value="">Select</option>
          <option value="2022">2022</option>
        </select>
        <script>
          document.querySelector('#start-year').addEventListener('change', (event) => {
            event.target.value = '';
          });
        </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const profileDir = await mkdtemp(join(tmpdir(), "resume-date-component-readback-"));
    temporaryDirectories.push(profileDir);
    const key = Buffer.alloc(32, 32);
    const policy = new ActionPolicy(key);
    const session = new BrowserSessionManager({ profileDir, headless: true });
    sessions.push(session);
    await session.start(key.toString("base64url"));
    await session.open("task-date-component-readback", `http://127.0.0.1:${address.port}/apply`);

    const snapshot = await session.observe("task-date-component-readback");
    const year = snapshot.fields.find((field) => field.label === "Start date year");
    if (!year) throw new Error("start year control was not observed");
    const result = await session.execute(approvedSelect(policy, snapshot, year.id, "2022"));

    expect(result).toMatchObject({
      status: "failed",
      errors: ["date_component_readback_mismatch"]
    });
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

describe("controlled field transaction", () => {
  it("releases the current registry and rejects approvals rebound across invalidation", async () => {
    const harness = await createTransactionHarness({ stableSnapshotId: true });
    const original = harness.command;
    const releasesBeforeInvalidation = harness.registry.release.mock.calls.length;

    await harness.executor.invalidate(original.taskId);
    expect(harness.registry.release).toHaveBeenCalledTimes(releasesBeforeInvalidation + 1);
    await harness.executor.observe(original.taskId);

    await expect(harness.executor.execute({
      ...original,
      executionEpoch: original.executionEpoch + 1
    })).resolves.toMatchObject({
      status: "blocked",
      errors: ["approval_execution_epoch_mismatch"]
    });
    await expect(harness.executor.execute(original, () => false)).resolves.toMatchObject({
      status: "blocked",
      errors: ["execution_invalidated"]
    });
  });

  it("does not clear consumed approval ids when execution state is invalidated", async () => {
    vi.useFakeTimers();
    try {
      const harness = await createTransactionHarness({ stableSnapshotId: true });
      const first = harness.executor.execute(harness.command);
      await vi.advanceTimersByTimeAsync(650);
      await expect(first).resolves.toMatchObject({ status: "applied" });

      await harness.executor.invalidate(harness.command.taskId);
      await harness.executor.observe(harness.command.taskId);

      await expect(harness.executor.execute(harness.command)).resolves.toMatchObject({
        status: "blocked",
        errors: ["approval_replayed"]
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies once and commits only after two stable local readbacks", async () => {
    vi.useFakeTimers();
    try {
      const harness = await createTransactionHarness();
      const pending = harness.execute();
      await vi.advanceTimersByTimeAsync(650);

      await expect(pending).resolves.toMatchObject({ status: "applied", actualValue: "candidate-secret" });
      expect(harness.apply).toHaveBeenCalledTimes(1);
      expect(harness.observe).toHaveBeenCalledTimes(2);
      expect(harness.trace.record.mock.calls.map(([event]) => event.phase)).toEqual([
        "prepare",
        "apply",
        "settle-1",
        "readback-1",
        "settle-2",
        "readback-2"
      ]);
      const serialized = JSON.stringify(harness.trace.record.mock.calls);
      expect(serialized).not.toContain("candidate-secret");
      expect(serialized).not.toContain("Candidate email");
      expect(serialized).not.toContain("#candidate-email");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a delayed controlled rollback without applying twice", async () => {
    vi.useFakeTimers();
    try {
      const harness = await createTransactionHarness({ rollbackAtMs: 500 });
      const pending = harness.execute();
      await vi.advanceTimersByTimeAsync(650);

      await expect(pending).resolves.toMatchObject({
        status: "failed",
        actualValue: "original",
        errors: ["controlled_value_reverted"]
      });
      expect(harness.apply).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports continuous local mutation as control_unstable", async () => {
    vi.useFakeTimers();
    try {
      const harness = await createTransactionHarness({ unstable: true });
      const pending = harness.execute();
      await vi.advanceTimersByTimeAsync(2_100);

      await expect(pending).resolves.toMatchObject({ status: "failed", errors: ["control_unstable"] });
      expect(harness.apply).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a handle disconnected between readbacks as stale_node_ref", async () => {
    vi.useFakeTimers();
    try {
      const harness = await createTransactionHarness({ disconnectAfterFirstRead: true });
      const pending = harness.execute();
      await vi.advanceTimersByTimeAsync(650);

      await expect(pending).resolves.toMatchObject({ status: "failed", errors: ["stale_node_ref"] });
      expect(harness.apply).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["settle-1", "settle-2"] as const)(
    "honors execution invalidation during %s",
    async (invalidationPhase) => {
      vi.useFakeTimers();
      try {
        const harness = await createTransactionHarness({ invalidationPhase });
        const pending = harness.execute();
        await vi.advanceTimersByTimeAsync(650);

        await expect(pending).resolves.toMatchObject({
          status: "failed",
          errors: ["execution_invalidated"]
        });
        expect(harness.apply).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    }
  );
});

interface TransactionHarnessOptions {
  rollbackAtMs?: number;
  unstable?: boolean;
  disconnectAfterFirstRead?: boolean;
  invalidationPhase?: "settle-1" | "settle-2";
  stableSnapshotId?: boolean;
}

async function createTransactionHarness(options: TransactionHarnessOptions = {}) {
  const key = Buffer.alloc(32, 41);
  const policy = new ActionPolicy(key);
  const nodeRef = {
    documentId: "document-transaction",
    nodeId: "node-transaction-01",
    observedAt: 3
  };
  const initial: FormSnapshot = {
    id: "snapshot-transaction-1",
    taskId: "task-transaction",
    url: "https://example.test/apply",
    title: "Application",
    stage: "application_form",
    frameRef: { documentId: nodeRef.documentId, kind: "main" },
    mutationEpoch: nodeRef.observedAt,
    fields: [{
      id: "field-candidate-email",
      label: "Candidate email",
      type: "text",
      required: true,
      options: [],
      currentValue: "original",
      nodeRef
    }],
    actions: [],
    errors: []
  };
  let value = "original";
  let connected = true;
  let current = true;
  let waitCount = 0;
  let readCount = 0;
  const apply = vi.fn(async (next: string) => {
    value = next;
    if (options.rollbackAtMs !== undefined) {
      setTimeout(() => { value = "original"; }, options.rollbackAtMs);
    }
  });
  const prepared = {
    fill: apply,
    blur: vi.fn(async () => undefined),
    waitForStableWindow: vi.fn(async (_stableMs: number, capMs: number, isCurrent: () => boolean) => {
      waitCount += 1;
      const phase = waitCount === 1 ? "settle-1" : "settle-2";
      await new Promise<void>((resolve) => setTimeout(resolve, options.unstable ? capMs : 300));
      if (!isCurrent() || options.invalidationPhase === phase) {
        current = false;
        throw transactionError("execution_invalidated");
      }
      if (options.unstable) throw transactionError("control_unstable");
      if (!connected) throw transactionError("stale_node_ref");
    }),
    readValue: vi.fn(async () => {
      if (!connected) throw transactionError("stale_node_ref");
      readCount += 1;
      const result = value;
      if (readCount === 1 && options.disconnectAfterFirstRead) connected = false;
      return result;
    })
  };
  const registry = {
    prepare: vi.fn(async () => prepared),
    field: vi.fn(() => prepared),
    release: vi.fn(async () => undefined)
  };
  let observations = 0;
  const observe = vi.fn(async () => {
    observations += 1;
    const snapshot = observations === 1 || options.stableSnapshotId
      ? initial
      : {
          ...initial,
          id: `snapshot-transaction-${observations}`,
          fields: [{ ...initial.fields[0]!, currentValue: value }]
        };
    return { snapshot, registry };
  });
  const trace = { record: vi.fn() };
  const Executor = ControlledExecutor as unknown as new (...args: unknown[]) => ControlledExecutor;
  const executor = new Executor({ observe }, key, undefined, undefined, trace);
  await executor.observe(initial.taskId);
  const command = approvedFill(policy, initial, initial.fields[0]!.id, "candidate-secret");

  return {
    apply,
    command,
    executor,
    observe,
    registry,
    trace,
    execute: () => executor.execute(command, () => current)
  };
}

function transactionError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
