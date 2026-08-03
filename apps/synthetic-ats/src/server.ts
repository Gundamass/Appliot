import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export interface SyntheticDraft {
  email?: string;
  city?: string;
  phone?: string;
  selfEvaluation?: string;
  school?: string;
  company?: string;
  position?: string;
  projectName?: string;
  projectDescription?: string;
}

export interface SyntheticTaskState {
  draft: SyntheticDraft;
  submissionCount: number;
  modelCallCount: number;
  selectedJob?: string;
  loginCount: number;
  uploadCount: number;
}

export interface SyntheticAtsServer {
  baseUrl: string;
  state(taskId: string): SyntheticTaskState;
  close(): Promise<void>;
}

const applicationTemplatePath = fileURLToPath(new URL("../public/application.html", import.meta.url));
const reviewTemplatePath = fileURLToPath(new URL("../public/review.html", import.meta.url));

export async function startSyntheticAts(): Promise<SyntheticAtsServer> {
  const [applicationTemplate, reviewTemplate] = await Promise.all([
    readFile(applicationTemplatePath, "utf8"),
    readFile(reviewTemplatePath, "utf8")
  ]);
  const tasks = new Map<string, SyntheticTaskState>();
  const taskState = (taskId: string): SyntheticTaskState => {
    const existing = tasks.get(taskId);
    if (existing) return existing;
    const created: SyntheticTaskState = { draft: {}, submissionCount: 0, modelCallCount: 0, loginCount: 0, uploadCount: 0 };
    tasks.set(taskId, created);
    return created;
  };

  const server = createServer(async (request, response) => {
    try {
      const origin = `http://${request.headers.host ?? "127.0.0.1"}`;
      const url = new URL(request.url ?? "/", origin);
      const taskId = url.searchParams.get("taskId") ?? "default-task";
      const scenario = url.searchParams.get("scenario") ?? "default";
      if (request.method === "GET" && url.pathname === "/jobs") {
        sendHtml(response, jobsPage(taskId, scenario));
        return;
      }
      if (request.method === "GET" && url.pathname === "/login") {
        taskState(taskId).selectedJob = url.searchParams.get("job") ?? "java-backend";
        sendHtml(response, loginPage(taskId, scenario));
        return;
      }
      if (request.method === "GET" && url.pathname === "/application") {
        if (url.searchParams.get("loggedIn") === "1") taskState(taskId).loginCount += 1;
        sendHtml(response, scenario === "profile-retry"
          ? profileRetryPage(taskId)
          : render(applicationTemplate, taskId, scenario));
        return;
      }
      if (request.method === "GET" && url.pathname === "/mokahr") {
        sendHtml(response, mokahrPage(taskId));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/mokahr-state") {
        const body = JSON.parse(await readText(request)) as { draft?: SyntheticDraft; uploaded?: boolean };
        if (body.uploaded) taskState(taskId).uploadCount += 1;
        Object.assign(taskState(taskId).draft, body.draft ?? {});
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(JSON.stringify(taskState(taskId)));
        return;
      }
      if (request.method === "POST" && url.pathname === "/step2") {
        const form = await readForm(request);
        Object.assign(taskState(taskId).draft, {
          email: form.get("email") ?? "",
          city: form.get("city") ?? "",
          phone: form.get("phone") ?? ""
        });
        sendHtml(response, stepTwo(taskId, scenario));
        return;
      }
      if (request.method === "GET" && url.pathname === "/step2") {
        const email = url.searchParams.get("email");
        const city = url.searchParams.get("city");
        const phone = url.searchParams.get("phone");
        if (email !== null) taskState(taskId).draft.email = email;
        if (city !== null) taskState(taskId).draft.city = city;
        if (phone !== null) taskState(taskId).draft.phone = phone;
        sendHtml(response, stepTwo(taskId, scenario));
        return;
      }
      if (request.method === "POST" && url.pathname === "/review") {
        const form = await readForm(request);
        taskState(taskId).draft.selfEvaluation = form.get("selfEvaluation") ?? "";
        sendHtml(response, render(reviewTemplate, taskId, scenario));
        return;
      }
      if (request.method === "GET" && url.pathname === "/review") {
        taskState(taskId).draft.selfEvaluation = url.searchParams.get("selfEvaluation") ?? "";
        sendHtml(response, render(reviewTemplate, taskId, scenario));
        return;
      }
      if (request.method === "POST" && url.pathname === "/submit") {
        taskState(taskId).submissionCount += 1;
        sendHtml(response, "<!doctype html><meta charset='utf-8'><title>投递成功</title><h1>已提交</h1>");
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(JSON.stringify(taskState(taskId)));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/model-call") {
        taskState(taskId).modelCallCount += 1;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ count: taskState(taskId).modelCallCount }));
        return;
      }
      response.statusCode = 404;
      response.end("Not Found");
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("合成招聘站没有分配端口");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state: (taskId) => structuredClone(taskState(taskId)),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

function render(template: string, taskId: string, scenario: string): string {
  return template
    .replaceAll("{{TASK_ID}}", encodeURIComponent(taskId))
    .replaceAll("{{SCENARIO}}", encodeURIComponent(scenario))
    .replaceAll("{{SCENARIO_JSON}}", JSON.stringify(scenario))
    .replaceAll("{{PHONE_FIELD}}", scenario === "stuck-control"
      ? `<div id="phone-field">
        <label for="phone">手机号码</label>
        <input id="phone" name="phone" inputmode="numeric" required>
      </div>`
      : "")
    .replaceAll("{{INTERMEDIATE_ACTION}}", scenario === "ambiguous-submit"
      ? `<button type="submit" formaction="/submit?taskId=${encodeURIComponent(taskId)}">继续</button>`
      : `<a id="next-step" href="/step2?taskId=${encodeURIComponent(taskId)}&scenario=${encodeURIComponent(scenario)}">下一步</a>`);
}

function jobsPage(taskId: string, scenario: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>选择岗位</title></head>
    <body><main><h1>选择岗位</h1><form method="get" action="/login">
      <input type="hidden" name="taskId" value="${escapeHtml(taskId)}">
      <input type="hidden" name="scenario" value="${escapeHtml(scenario)}">
      <button type="submit" name="job" value="java-backend">Java 后端开发工程师</button>
    </form></main></body></html>`;
}

function loginPage(taskId: string, scenario: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>登录</title></head>
    <body><main><h1>登录招聘系统</h1><form method="get" action="/application">
      <input type="hidden" name="taskId" value="${escapeHtml(taskId)}">
      <input type="hidden" name="scenario" value="${escapeHtml(scenario)}">
      <input type="hidden" name="loggedIn" value="1">
      <label for="password">密码</label><input id="password" name="password" type="password" required>
      <button type="submit">登录并继续</button>
    </form></main></body></html>`;
}

function stepTwo(taskId: string, scenario: string): string {
  return `<!doctype html>
    <html lang="zh-CN">
    <head><meta charset="utf-8"><title>第二步：补充信息</title></head>
    <body>
      <main>
        <h1>补充信息</h1>
        <form>
          <label for="selfEvaluation">自我评价</label>
          <textarea id="selfEvaluation" name="selfEvaluation" required></textarea>
          <button type="button" onclick="location.href='/review?taskId=${encodeURIComponent(taskId)}&scenario=${encodeURIComponent(scenario)}&selfEvaluation='+encodeURIComponent(document.querySelector('#selfEvaluation').value)">下一步</button>
          <button type="submit" formaction="/submit?taskId=${encodeURIComponent(taskId)}">提交申请</button>
        </form>
      </main>
    </body>
    </html>`;
}

function profileRetryPage(taskId: string): string {
  return `<!doctype html>
    <html lang="zh-CN">
    <head><meta charset="utf-8"><title>档案补全重试</title></head>
    <body>
      <main>
        <h1>候选人信息</h1>
        <form method="post" action="/submit?taskId=${encodeURIComponent(taskId)}">
          <label for="name">姓名</label>
          <input id="name" name="name" value="已有姓名" required>
          <label for="city">城市</label>
          <select id="city" name="city" required>
            <option value="">请选择</option>
            <option value="hangzhou">杭州</option>
            <option value="shenzhen">深圳</option>
          </select>
          <button type="submit">提交申请</button>
        </form>
      </main>
    </body>
    </html>`;
}

function mokahrPage(taskId: string): string {
  const encodedTaskId = encodeURIComponent(taskId);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>DJI 校园招聘申请</title></head>
  <body><main><h1>申请信息</h1>
    <div id="upload" class="ant-upload-wrapper"><span class="ant-upload"><button type="button">上传简历</button><input id="resume" type="file" accept="application/pdf" style="display:none"></span></div>
    <div id="form"></div>
    <script>
      const taskId = ${JSON.stringify(encodedTaskId)};
      const draft = {};
      const sync = (extra = {}) => fetch('/api/mokahr-state?taskId=' + taskId, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draft, ...extra }) });
      const item = (label, control) => '<div class="ant-form-item"><div class="ant-form-item-label"><label class="ant-form-item-required">' + label + '</label></div><div class="ant-form-item-control">' + control + '<div class="ant-form-item-explain-error" hidden>必填项未填写</div></div></div>';
      const bind = () => document.querySelectorAll('#form input, #form textarea').forEach((field) => field.addEventListener('change', () => { draft[field.dataset.key] = field.value; sync(); }));
      const renderBase = () => { document.querySelector('#form').innerHTML =
        item('邮箱', '<input name="basics.email" data-key="email" value="parsed@example.com">') +
        item('手机号码', '<input name="basics.phone" data-key="phone" placeholder="请输入手机号">') +
        '<section><h2>教育经历</h2>' + item('学校', '<input name="education[0].school" data-key="school" value="测试大学">') + '</section>' +
        '<section id="work"><h2>实习经历</h2><button id="add-work" type="button">添加</button></section>' +
        '<section id="projects"><h2>项目经历</h2></section>';
        bind();
      };
      document.querySelector('#resume').addEventListener('change', async () => {
        Object.assign(draft, { email: 'parsed@example.com', school: '测试大学' });
        await sync({ uploaded: true });
        document.querySelector('#upload').remove();
        renderBase();
      });
      document.addEventListener('click', (event) => {
        if (event.target.id === 'add-work') { event.target.remove(); document.querySelector('#work').insertAdjacentHTML('beforeend',
          item('公司', '<input data-key="company">') + item('职位', '<input data-key="position">') + '<button id="add-project" type="button">下一步</button>'); bind(); }
        if (event.target.id === 'add-project') { event.target.remove(); document.querySelector('#projects').insertAdjacentHTML('beforeend',
          item('项目名称', '<input data-key="projectName">') + item('项目描述', '<textarea data-key="projectDescription"></textarea>') +
          '<form method="post" action="/submit?taskId=' + taskId + '"><button type="submit" aria-label="预览并提交">预览并提交</button></form>'); bind(); }
      });
    </script></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]!);
}

function sendHtml(response: ServerResponse, html: string): void {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(html);
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

async function readText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
