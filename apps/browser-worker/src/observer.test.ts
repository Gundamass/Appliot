import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkerActivity } from "@resume/contracts";
import { fingerprintPageStructure, type PageStructure } from "./activity-monitor.js";
import { BrowserSessionManager } from "./session-manager.js";

const structure: PageStructure = {
  url: "https://jobs.example/apply",
  title: "Application",
  stage: "application_form",
  fields: [{ id: "field_opaque", type: "text", required: true, accessibleName: "Email address" }],
  actions: [{ id: "action_opaque", kind: "button", accessibleName: "Continue" }]
};

describe("page structural fingerprint", () => {
  it("is stable for equivalent visible field and action metadata", () => {
    expect(fingerprintPageStructure(structure)).toBe(fingerprintPageStructure({ ...structure }));
  });

  it("changes when visible structure changes without including raw labels or values", () => {
    const changed = {
      ...structure,
      fields: [...structure.fields, {
        id: "field_other",
        type: "select",
        required: false,
        accessibleName: "Country"
      }]
    };

    expect(fingerprintPageStructure(changed)).not.toBe(fingerprintPageStructure(structure));
    expect(fingerprintPageStructure(changed)).not.toContain("Application");
  });

  it("excludes hidden, disabled, non-interactable, and internal controls from observations", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Apply</title>
        <label for="visible">Visible</label><input id="visible" required>
        <input type="hidden" id="hidden-type">
        <input id="disabled" disabled>
        <fieldset disabled><input id="fieldset-disabled"></fieldset>
        <input id="readonly" readonly>
        <input id="hidden-style" style="display:none">
        <input id="transparent" style="opacity:0">
        <input id="pointer-events" style="pointer-events:none">
        <input id="hidden-aria" aria-hidden="true">
        <input id="disabled-aria" aria-disabled="true">
        <section data-resume-internal><input id="internal"></section>
        <button type="button">Continue</button>
        <button type="button" disabled>Disabled</button>
        <fieldset disabled><button type="button">Fieldset disabled</button></fieldset>
        <button type="button" style="display:none">Hidden</button>
        <button type="button" style="opacity:0">Transparent</button>
        <button type="button" style="pointer-events:none">No pointer events</button>
        <button type="button" aria-disabled="true">ARIA disabled</button>
        <section data-internal><button type="button">Internal</button></section>`);
    });
    const profileDir = await mkdtemp(join(tmpdir(), "resume-observer-"));
    const session = new BrowserSessionManager({ profileDir, headless: true });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");
      const key = Buffer.alloc(32, 1).toString("base64url");
      await session.start(key);
      await session.open("task-1", `http://127.0.0.1:${address.port}/apply`);

      const snapshot = await session.observe("task-1");
      expect(snapshot.fields).toHaveLength(1);
      expect(snapshot.actions.map((action) => action.text)).toEqual(["Continue"]);
    } finally {
      await session.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("waits for an asynchronously mounted form after the initial document shell", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Apply</title>
        <main id="app"></main>
        <a href="#">Home</a>
        <script>
          setTimeout(() => {
            document.querySelector('#app').innerHTML = '<label for="email">Email address</label><input id="email" name="email">';
          }, 160);
        </script>`);
    });
    const profileDir = await mkdtemp(join(tmpdir(), "resume-observer-delayed-form-"));
    const session = new BrowserSessionManager({ profileDir, headless: true });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");
      await session.start(Buffer.alloc(32, 1).toString("base64url"));
      await session.open("task-delayed-form", `http://127.0.0.1:${address.port}/apply`);

      const snapshot = await session.observe("task-delayed-form");

      expect(snapshot.fields).toEqual([
        expect.objectContaining({ label: "Email address", type: "text" })
      ]);
    } finally {
      await session.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("excludes visible editable controls without a usable label", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Apply</title>
        <input id="unlabelled">
        <input id="placeholder" placeholder="Phone number">
        <label for="labelled">Name</label><input id="labelled">
        <input id="aria" aria-label="Email address">`);
    });
    const profileDir = await mkdtemp(join(tmpdir(), "resume-observer-labels-"));
    const session = new BrowserSessionManager({ profileDir, headless: true });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");
      await session.start(Buffer.alloc(32, 1).toString("base64url"));
      await session.open("task-1", `http://127.0.0.1:${address.port}/apply`);

      const snapshot = await session.observe("task-1");

      expect(snapshot.fields.map((field) => field.label)).toEqual(["Phone number", "Name", "Email address"]);
    } finally {
      await session.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("recognizes custom required form controls without a native required attribute", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Apply</title>
        <div class="ant-form-item ant-form-item-required"><label>姓名 <span>*</span></label><input aria-label='姓名'></div>
        <div class="form-item"><label>手机号</label><input aria-label='手机号' aria-required='true'></div>
        <div class="form-item"><label>自我评价</label><textarea aria-label='自我评价' data-required='true'></textarea></div>`);
    });
    const profileDir = await mkdtemp(join(tmpdir(), "resume-observer-required-"));
    const session = new BrowserSessionManager({ profileDir, headless: true });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");
      await session.start(Buffer.alloc(32, 1).toString("base64url"));
      await session.open("task-1", `http://127.0.0.1:${address.port}/apply`);

      const snapshot = await session.observe("task-1");

      expect(snapshot.fields.map((field) => ({ label: field.label, required: field.required }))).toEqual([
        { label: "姓名", required: true },
        { label: "手机号", required: true },
        { label: "自我评价", required: true }
      ]);
    } finally {
      await session.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("reads Mokahr form-item labels and required state without treating validation copy as the field name", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>DJI Apply</title>
        <section class="resume-section"><h2>基本信息</h2>
          <div class="ant-form-item ant-form-item-has-error">
            <div class="ant-form-item-label"><label class="ant-form-item-required">手机号码</label></div>
            <div class="ant-form-item-control">
              <div class="phone-prefix">+86</div>
              <input placeholder="请输入手机号">
              <div class="ant-form-item-explain-error">必填项未填写</div>
            </div>
          </div>
          <div class="ant-form-item">
            <div class="ant-form-item-label"><label class="ant-form-item-required">项目名称</label></div>
            <div class="ant-form-item-control"><input placeholder="必填项未填写"></div>
          </div>
        </section>`);
    });
    const profileDir = await mkdtemp(join(tmpdir(), "resume-observer-mokahr-label-"));
    const session = new BrowserSessionManager({ profileDir, headless: true });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");
      await session.start(Buffer.alloc(32, 1).toString("base64url"));
      await session.open("task-mokahr", `http://127.0.0.1:${address.port}/apply`);

      const snapshot = await session.observe("task-mokahr");

      expect(snapshot.fields.map(({ label, required }) => ({ label, required }))).toEqual([
        { label: "手机号码", required: true },
        { label: "项目名称", required: true }
      ]);
      expect(snapshot.fields.map((field) => field.label)).not.toContain("必填项未填写");
    } finally {
      await session.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("reads labels and required state from the current Mokahr custom field layout", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>DJI Apply</title>
        <section>
          <h2>个人信息</h2>
          <div class="apply-field-Q2iJ7AtQGX">
            <div class="title-IWWQ0Xa4L7"><span>姓名</span><span class="required-asterisk-av7daEKsLS"></span></div>
            <div class="ctrl-CICMG4Fr4_"><label><input placeholder="请输入"></label></div>
          </div>
          <div class="apply-field-Q2iJ7AtQGX">
            <div class="title-IWWQ0Xa4L7"><span>补充说明</span></div>
            <div class="ctrl-CICMG4Fr4_"><textarea></textarea></div>
          </div>
        </section>`);
    });
    const profileDir = await mkdtemp(join(tmpdir(), "resume-observer-current-mokahr-"));
    const session = new BrowserSessionManager({ profileDir, headless: true });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");
      await session.start(Buffer.alloc(32, 1).toString("base64url"));
      await session.open("task-current-mokahr", `http://127.0.0.1:${address.port}/apply`);

      const snapshot = await session.observe("task-current-mokahr");

      expect(snapshot.fields.map(({ label, required }) => ({ label, required }))).toEqual([
        { label: "姓名", required: true },
        { label: "补充说明", required: false }
      ]);
    } finally {
      await session.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("prefers the Mokahr field title over a custom select display value", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>DJI Apply</title>
        <div class="apply-field-custom">
          <div class="title-custom">Gender</div>
          <div class="ctrl-custom"><label class="select-custom"><span>Male</span><input type="text" value=""></label></div>
        </div>`);
    });
    const profileDir = await mkdtemp(join(tmpdir(), "resume-observer-select-label-"));
    const session = new BrowserSessionManager({ profileDir, headless: true });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server has no port");
      await session.start(Buffer.alloc(32, 1).toString("base64url"));
      await session.open("task-select-label", `http://127.0.0.1:${address.port}/apply`);

      const snapshot = await session.observe("task-select-label");

      expect(snapshot.fields.map((field) => field.label)).toEqual(["Gender"]);
    } finally {
      await session.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("associates a Mokahr add button with its nearest experience section", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>DJI Apply</title>
        <section class="resume-section"><h2>项目经历</h2><button type="button">添加</button></section>
        <section class="resume-section"><h2>教育经历</h2><button type="button">添加</button></section>`);
    });
    const profileDir = await mkdtemp(join(tmpdir(), "resume-observer-mokahr-action-"));
    const session = new BrowserSessionManager({ profileDir, headless: true });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");
      await session.start(Buffer.alloc(32, 1).toString("base64url"));
      await session.open("task-mokahr", `http://127.0.0.1:${address.port}/apply`);

      const snapshot = await session.observe("task-mokahr");

      expect(snapshot.actions.map(({ text, class: actionClass, context }) => ({ text, actionClass, context }))).toEqual([
        { text: "添加", actionClass: "intermediate_navigation", context: "项目经历添加" },
        { text: "添加", actionClass: "intermediate_navigation", context: "教育经历添加" }
      ]);
    } finally {
      await session.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("associates current Mokahr block-title add buttons with their section", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>DJI Apply</title>
        <div class="apply-block">
          <div class="blockTitle"><span>项目经验</span><button type="button">添加</button></div>
          <div class="ctrl"><input placeholder="项目名称"></div>
        </div>`);
    });
    const profileDir = await mkdtemp(join(tmpdir(), "resume-observer-current-action-"));
    const session = new BrowserSessionManager({ profileDir, headless: true });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");
      await session.start(Buffer.alloc(32, 1).toString("base64url"));
      await session.open("task-current-action", `http://127.0.0.1:${address.port}/apply`);

      const snapshot = await session.observe("task-current-action");

      expect(snapshot.actions).toEqual([
        expect.objectContaining({ text: "添加", class: "intermediate_navigation", context: "项目经验添加" })
      ]);
    } finally {
      await session.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps Mokahr action context concise when an experience section contains long content", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>DJI Apply</title>
        <section class="resume-section">
          <h2>项目经历</h2>
          <p>${"项目描述".repeat(600)}</p>
          <button type="button">添加</button>
        </section>`);
    });
    const profileDir = await mkdtemp(join(tmpdir(), "resume-observer-mokahr-long-action-"));
    const session = new BrowserSessionManager({ profileDir, headless: true });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");
      await session.start(Buffer.alloc(32, 1).toString("base64url"));
      await session.open("task-mokahr-long", `http://127.0.0.1:${address.port}/apply`);

      const snapshot = await session.observe("task-mokahr-long");

      expect(snapshot.actions).toEqual([
        expect.objectContaining({ text: "添加", class: "intermediate_navigation", context: "项目经历添加" })
      ]);
    } finally {
      await session.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("does not assign a shared add button to one of several experience sections", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>DJI Apply</title>
        <main>
          <section><h2>教育经历</h2></section>
          <section><h2>项目经历</h2></section>
          <button type="button">添加</button>
        </main>`);
    });
    const profileDir = await mkdtemp(join(tmpdir(), "resume-observer-shared-action-"));
    const session = new BrowserSessionManager({ profileDir, headless: true });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");
      await session.start(Buffer.alloc(32, 1).toString("base64url"));
      await session.open("task-shared-action", `http://127.0.0.1:${address.port}/apply`);

      const snapshot = await session.observe("task-shared-action");

      expect(snapshot.actions).toEqual([
        expect.objectContaining({ text: "添加", class: "unknown_side_effect" })
      ]);
      expect(snapshot.actions[0]).not.toHaveProperty("context");
    } finally {
      await session.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("observes an identifiable hidden Mokahr resume input through its visible upload wrapper", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>DJI Apply</title>
        <div class="ant-upload-wrapper">
          <span class="ant-upload"><button type="button">上传简历</button>
            <input type="file" accept="application/pdf" style="display:none">
          </span>
        </div>`);
    });
    const profileDir = await mkdtemp(join(tmpdir(), "resume-observer-hidden-upload-"));
    const session = new BrowserSessionManager({ profileDir, headless: true });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");
      await session.start(Buffer.alloc(32, 1).toString("base64url"));
      await session.open("task-mokahr", `http://127.0.0.1:${address.port}/apply`);

      const snapshot = await session.observe("task-mokahr");

      expect(snapshot.fields).toEqual([
        expect.objectContaining({ label: "上传简历", type: "file" })
      ]);
    } finally {
      await session.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("observes the current Mokahr resume upload wrapper", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>DJI Apply</title>
        <div class="file_upload">
          <button type="button">上传简历</button>
          <input id="resumeKey" type="file" name="resumeKey" accept="application/pdf" style="display:none">
        </div>`);
    });
    const profileDir = await mkdtemp(join(tmpdir(), "resume-observer-current-upload-"));
    const session = new BrowserSessionManager({ profileDir, headless: true });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");
      await session.start(Buffer.alloc(32, 1).toString("base64url"));
      await session.open("task-current-upload", `http://127.0.0.1:${address.port}/apply`);

      const snapshot = await session.observe("task-current-upload");

      expect(snapshot.fields).toEqual([
        expect.objectContaining({ label: "上传简历", type: "file", required: false })
      ]);
    } finally {
      await session.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports activity only for visible, editable, non-internal controls", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Apply</title>
        <input id="visible" aria-label="Visible field">
        <input id="hidden" style="display:none">
        <input id="disabled" disabled>
        <input id="readonly" readonly>
        <input id="aria-disabled" aria-disabled="true">
        <section inert><input id="inert"></section>
        <section data-resume-internal><input id="internal"></section>
        <script>
          setTimeout(() => {
            for (const id of ["visible", "hidden", "disabled", "readonly", "aria-disabled", "inert", "internal"]) {
              document.getElementById(id).dispatchEvent(new Event("input", { bubbles: true }));
            }
          }, 750);
        </script>`);
    });
    const profileDir = await mkdtemp(join(tmpdir(), "resume-activity-filter-"));
    const session = new BrowserSessionManager({ profileDir, headless: true });
    const activities: WorkerActivity[] = [];
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");
      await session.start(Buffer.alloc(32, 1).toString("base64url"));
      session.subscribeActivity((activity) => activities.push(activity));
      await session.open("task-1", `http://127.0.0.1:${address.port}/apply`);
      const snapshot = await session.observe("task-1");

      await new Promise((resolve) => setTimeout(resolve, 1_000));

      expect(snapshot.fields).toHaveLength(1);
      expect(activities.filter((activity) => activity.type === "user_activity")).toEqual([{
        type: "user_activity",
        taskId: "task-1",
        fieldId: snapshot.fields[0]!.id,
        activity: "input"
      }]);
    } finally {
      await session.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports genuine ordinary button and link clicks while filtering unavailable controls", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Apply</title>
        <input id="email">
        <button id="visible" type="button">Choose job</button>
        <a id="link" href="#details">Job details</a>
        <button id="disabled" type="button" disabled>Disabled</button>
        <button id="hidden" type="button" style="display:none">Hidden</button>
        <section data-resume-internal><button id="internal" type="button">Internal</button></section>
        <script>
          setTimeout(() => {
            for (const id of ["visible", "link", "disabled", "hidden", "internal"]) {
              document.getElementById(id).dispatchEvent(new MouseEvent("click", { bubbles: true }));
            }
          }, 250);
        </script>`);
    });
    const profileDir = await mkdtemp(join(tmpdir(), "resume-click-activity-"));
    const session = new BrowserSessionManager({ profileDir, headless: true });
    const activities: WorkerActivity[] = [];
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试服务器没有分配端口");
      await session.start(Buffer.alloc(32, 1).toString("base64url"));
      session.subscribeActivity((activity) => activities.push(activity));
      await session.open("task-1", `http://127.0.0.1:${address.port}/apply`);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const clicks = activities.filter((activity): activity is Extract<WorkerActivity, { type: "user_activity" }> =>
        activity.type === "user_activity" && activity.activity === "click");
      expect(clicks).toHaveLength(2);
      expect(new Set(clicks.map((activity) => activity.fieldId)).size).toBe(2);
      expect(JSON.stringify(clicks)).not.toMatch(/Choose job|Job details|#visible|#link|coordinates/);
    } finally {
      await session.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 30_000);
});
