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
  awardLevel?: string;
  unknownField?: string;
  majorDirection?: string;
  major?: string;
  preservedValue?: string;
  formalWorkCompanies?: string[];
  internshipCompanies?: string[];
  internshipPositions?: string[];
  projectNames?: string[];
  projectDescriptions?: string[];
  awardName?: string;
  awardDate?: string;
  startYear?: string;
  startMonth?: string;
  languageName?: string;
  languageProficiency?: string;
  languageSpeakingListening?: string;
  languageReadingWriting?: string;
}

export interface SyntheticTaskState {
  draft: SyntheticDraft;
  submissionCount: number;
  modelCallCount: number;
  selectedJob?: string;
  loginCount: number;
  uploadCount: number;
  searches: { major: string[] };
  workAddCount: number;
  internshipAddCount: number;
  projectAddCount: number;
  runtime: SyntheticRuntimeState;
  skillRuntime: SyntheticSkillRuntimeState;
  challenge?: SyntheticChallengeState;
}

export interface SyntheticRuntimeState {
  scenario: string;
  values: Record<string, string>;
  writeCounts: Record<string, number>;
  mutationCount: number;
  auditCount: number;
}

export interface SyntheticChallengeState {
  scenario: string;
  kind: "captcha" | "access_denied" | "rate_limited" | "device_verification" | "risk_control" | "unsupported_iframe" | "unsupported_shadow_dom";
  fillCount: number;
}

export type SyntheticSkillRuntimeSite = "moka" | "dji" | "baidu";
export type SyntheticSkillRuntimeScenario =
  | "stable"
  | "renamed-label"
  | "duplicate-label"
  | "delayed-render"
  | "stale-node"
  | "ambiguous-fingerprint"
  | "unexpected-navigation";

export interface SyntheticSkillRuntimeState {
  site: SyntheticSkillRuntimeSite | "";
  scenario: SyntheticSkillRuntimeScenario | "";
  values: Record<string, string>;
  writeCounts: Record<string, number>;
  navigationCount: number;
}

export interface SyntheticAtsServer {
  baseUrl: string;
  state(taskId: string): SyntheticTaskState;
  close(): Promise<void>;
}

const applicationTemplatePath = fileURLToPath(new URL("../public/application.html", import.meta.url));
const reviewTemplatePath = fileURLToPath(new URL("../public/review.html", import.meta.url));
const stabilityTemplatePath = fileURLToPath(new URL("../public/stability.html", import.meta.url));
const runtimeP0TemplatePath = fileURLToPath(new URL("../public/runtime-p0.html", import.meta.url));
const challengeP0TemplatePath = fileURLToPath(new URL("../public/challenge-p0.html", import.meta.url));
const jobListTemplatePath = fileURLToPath(new URL("../public/job-list.html", import.meta.url));

export async function startSyntheticAts(): Promise<SyntheticAtsServer> {
  const [applicationTemplate, reviewTemplate, stabilityTemplate, runtimeP0Template, challengeP0Template, jobListTemplate] = await Promise.all([
    readFile(applicationTemplatePath, "utf8"),
    readFile(reviewTemplatePath, "utf8"),
    readFile(stabilityTemplatePath, "utf8"),
    readFile(runtimeP0TemplatePath, "utf8"),
    readFile(challengeP0TemplatePath, "utf8"),
    readFile(jobListTemplatePath, "utf8")
  ]);
  const tasks = new Map<string, SyntheticTaskState>();
  const taskState = (taskId: string): SyntheticTaskState => {
    const existing = tasks.get(taskId);
    if (existing) return existing;
    const created: SyntheticTaskState = {
      draft: {},
      submissionCount: 0,
      modelCallCount: 0,
      loginCount: 0,
      uploadCount: 0,
      searches: { major: [] },
      workAddCount: 0,
      internshipAddCount: 0,
      projectAddCount: 0,
      runtime: {
        scenario: "",
        values: {},
        writeCounts: {},
        mutationCount: 0,
        auditCount: 0
      },
      skillRuntime: {
        site: "",
        scenario: "",
        values: {},
        writeCounts: {},
        navigationCount: 0
      }
    };
    tasks.set(taskId, created);
    return created;
  };

  const server = createServer(async (request, response) => {
    try {
      const origin = `http://${request.headers.host ?? "127.0.0.1"}`;
      const url = new URL(request.url ?? "/", origin);
      const taskId = url.searchParams.get("taskId") ?? "default-task";
      const scenario = url.searchParams.get("scenario") ?? "default";
      if (request.method === "GET" && url.pathname === "/job-list.html") {
        taskState(taskId);
        sendHtml(response, jobListTemplate);
        return;
      }
      if (request.method === "GET" && url.pathname === "/job-detail.html") {
        taskState(taskId);
        sendHtml(response, jobDetailPage(taskId, url.searchParams.get("job") ?? "java-lead"));
        return;
      }
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
        const applicationPage = scenario === "profile-retry"
          ? profileRetryPage(taskId)
          : render(applicationTemplate, taskId, scenario);
        sendHtml(response, applicationPage.replace("<body", '<body data-resume-entry="application_form"'));
        return;
      }
      if (request.method === "GET" && url.pathname === "/mokahr") {
        sendHtml(response, mokahrPage(taskId));
        return;
      }
      if (request.method === "GET" && url.pathname === "/dji") {
        sendHtml(response, djiPage(taskId));
        return;
      }
      if (request.method === "GET" && url.pathname === "/stability") {
        sendHtml(response, render(stabilityTemplate, taskId, "stability"));
        return;
      }
      if (request.method === "GET" && url.pathname === "/runtime-p0") {
        taskState(taskId).runtime.scenario = scenario;
        sendHtml(response, render(runtimeP0Template, taskId, scenario));
        return;
      }
      if (request.method === "GET" && url.pathname === "/challenge-p0") {
        const state = taskState(taskId);
        state.challenge = {
          scenario,
          kind: challengeKindForScenario(scenario),
          fillCount: 0
        };
        if (scenario === "access-denied") response.statusCode = 403;
        if (scenario === "rate-limited") response.statusCode = 429;
        sendHtml(response, render(challengeP0Template, taskId, scenario));
        return;
      }
      if (request.method === "GET" && url.pathname === "/skill-runtime") {
        const site = parseSkillRuntimeSite(url.searchParams.get("site"));
        const skillScenario = parseSkillRuntimeScenario(scenario);
        const state = taskState(taskId);
        if (state.skillRuntime.site !== site || state.skillRuntime.scenario !== skillScenario) {
          state.skillRuntime = {
            site,
            scenario: skillScenario,
            values: {},
            writeCounts: {},
            navigationCount: 0
          };
        }
        sendHtml(response, skillRuntimePage(
          taskId,
          site,
          skillScenario,
          state.skillRuntime.values,
          state.skillRuntime.writeCounts
        ));
        return;
      }
      if (request.method === "GET" && url.pathname === "/skill-runtime-unexpected") {
        const state = taskState(taskId);
        state.skillRuntime.navigationCount += 1;
        sendHtml(response, `<!doctype html><html><head><meta charset="utf-8"><title>Unexpected navigation</title></head><body data-fixture="application-skill-runtime-unexpected"><h1>Session changed</h1><label>Search<input name="search"></label></body></html>`);
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
      if (request.method === "POST" && url.pathname === "/api/stability-state") {
        const body = JSON.parse(await readText(request)) as Partial<Pick<
          SyntheticTaskState,
          "draft" | "searches" | "workAddCount" | "internshipAddCount" | "projectAddCount"
        >>;
        const state = taskState(taskId);
        Object.assign(state.draft, body.draft ?? {});
        if (body.searches?.major) state.searches.major = [...body.searches.major];
        if (body.workAddCount !== undefined) state.workAddCount = body.workAddCount;
        if (body.internshipAddCount !== undefined) state.internshipAddCount = body.internshipAddCount;
        if (body.projectAddCount !== undefined) state.projectAddCount = body.projectAddCount;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(JSON.stringify(state));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/runtime-p0-state") {
        const body = JSON.parse(await readText(request)) as Partial<SyntheticRuntimeState>;
        const state = taskState(taskId);
        if (body.scenario !== undefined) state.runtime.scenario = body.scenario;
        if (body.values !== undefined) state.runtime.values = { ...body.values };
        if (body.writeCounts !== undefined) state.runtime.writeCounts = { ...body.writeCounts };
        if (body.mutationCount !== undefined) state.runtime.mutationCount = body.mutationCount;
        if (body.auditCount !== undefined) state.runtime.auditCount = body.auditCount;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(JSON.stringify(state));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/challenge-p0-state") {
        const body = JSON.parse(await readText(request)) as { fillCount?: number };
        const state = taskState(taskId);
        if (state.challenge && body.fillCount !== undefined) state.challenge.fillCount = body.fillCount;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(JSON.stringify(state));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/skill-runtime-state") {
        const body = JSON.parse(await readText(request)) as Partial<SyntheticSkillRuntimeState>;
        const state = taskState(taskId);
        if (body.site !== undefined) state.skillRuntime.site = parseSkillRuntimeSite(body.site);
        if (body.scenario !== undefined) state.skillRuntime.scenario = parseSkillRuntimeScenario(body.scenario);
        if (body.values !== undefined) state.skillRuntime.values = { ...body.values };
        if (body.writeCounts !== undefined) state.skillRuntime.writeCounts = { ...body.writeCounts };
        if (body.navigationCount !== undefined) state.skillRuntime.navigationCount = body.navigationCount;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(JSON.stringify(state));
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

function parseSkillRuntimeSite(value: unknown): SyntheticSkillRuntimeSite {
  if (value === "moka" || value === "dji" || value === "baidu") return value;
  throw new Error("unknown_skill_runtime_site");
}

function parseSkillRuntimeScenario(value: unknown): SyntheticSkillRuntimeScenario {
  if (
    value === "stable"
    || value === "renamed-label"
    || value === "duplicate-label"
    || value === "delayed-render"
    || value === "stale-node"
    || value === "ambiguous-fingerprint"
    || value === "unexpected-navigation"
  ) return value;
  throw new Error("unknown_skill_runtime_scenario");
}

function skillRuntimePage(
  taskId: string,
  site: SyntheticSkillRuntimeSite,
  scenario: SyntheticSkillRuntimeScenario,
  values: Readonly<Record<string, string>>,
  writeCounts: Readonly<Record<string, number>>
): string {
  const fields = skillRuntimeFields(site, scenario, values);
  const encodedTaskId = encodeURIComponent(taskId);
  const encodedSite = encodeURIComponent(site);
  const encodedScenario = encodeURIComponent(scenario);
  const formMarkup = `<form id="skill-form" method="post" action="/submit?taskId=${encodedTaskId}">${fields}<button type="submit">提交申请</button></form>`;
  const initialMarkup = scenario === "delayed-render" ? "" : formMarkup;
  const delayedRender = scenario === "delayed-render"
    ? `setTimeout(() => { root.innerHTML = ${JSON.stringify(formMarkup)}; bind(); }, 250);`
    : "";
  return `<!doctype html>
  <html lang="zh-CN"><head><meta charset="utf-8"><title>申请职位 - 个人信息</title></head>
  <body data-fixture="application-skill-runtime" data-site="${site}" data-scenario="${scenario}">
    <main><h1>申请职位</h1><h2>个人信息</h2><div id="skill-root">${initialMarkup}</div></main>
    <script>
      const root = document.querySelector('#skill-root');
      const taskId = ${JSON.stringify(encodedTaskId)};
      const site = ${JSON.stringify(encodedSite)};
      const scenario = ${JSON.stringify(encodedScenario)};
      const values = ${JSON.stringify(values)};
      const writeCounts = ${JSON.stringify(writeCounts)};
      let syncPromise = Promise.resolve();
      const sync = () => syncPromise = fetch('/api/skill-runtime-state?taskId=' + taskId, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ site, scenario, values, writeCounts }),
        keepalive: true
      });
      const onValue = (event) => {
        const field = event.target;
        const semantic = field.dataset.semantic;
        if (!semantic) return;
        values[semantic] = field.value;
        writeCounts[semantic] = (writeCounts[semantic] || 0) + 1;
        if (scenario === 'unexpected-navigation') {
          void sync().finally(() => { location.href = '/skill-runtime-unexpected?taskId=' + taskId; });
        } else {
          void sync();
        }
      };
      const bind = () => root.querySelectorAll('[data-semantic]').forEach((field) => {
        field.addEventListener('input', onValue);
      });
      bind();
      window.skillRuntimeFixture = {
        flush() { return syncPromise; },
        triggerStaleNode() {
          const field = root.querySelector('[data-semantic]');
          if (!field) throw new Error('skill_runtime_field_missing');
          field.replaceWith(field.cloneNode(true));
          bind();
        }
      };
      ${delayedRender}
    </script>
  </body></html>`;
}

function skillRuntimeFields(
  site: SyntheticSkillRuntimeSite,
  scenario: SyntheticSkillRuntimeScenario,
  values: Readonly<Record<string, string>>
): string {
  const renamed = scenario === "renamed-label";
  const fields: Array<[string, string]> = site === "moka"
    ? [
        ["basics.name", renamed ? "Full legal name" : "姓名"],
        ["basics.email", renamed ? "Primary email" : "邮箱"],
        ["basics.phone", renamed ? "Mobile contact" : "手机号码"]
      ]
    : site === "dji"
      ? [
          ["basics.name", renamed ? "Full legal name" : "姓名"],
          ["basics.phone", renamed ? "Mobile contact" : "手机号码"],
          ["education[0].institution", renamed ? "University" : "毕业院校"]
        ]
      : [["basics.name", renamed ? "Full legal name" : "姓名"]];
  if (scenario === "duplicate-label") fields.push(["basics.name", renamed ? "Full legal name" : "姓名"]);
  return fields.map(([semantic, label], index) => `
    <label for="skill-field-${index}">${label}</label>
    <input id="skill-field-${index}" name="${semantic}" data-semantic="${semantic}" value="${escapeHtml(values[semantic] ?? "")}" required>`).join("");
}

function challengeKindForScenario(scenario: string): SyntheticChallengeState["kind"] {
  switch (scenario) {
    case "captcha": return "captcha";
    case "access-denied": return "access_denied";
    case "rate-limited": return "rate_limited";
    case "device-verification": return "device_verification";
    case "risk-control": return "risk_control";
    case "interactive-iframe": return "unsupported_iframe";
    case "open-shadow-input":
    case "closed-shadow-host": return "unsupported_shadow_dom";
    default: throw new Error(`unknown_challenge_scenario:${scenario}`);
  }
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

function jobDetailPage(taskId: string, jobId: string): string {
  const title = jobId === "backend-architect" ? "后端架构师" : "Java 技术负责人";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head>
    <body data-resume-entry="job_detail"><main><article class="position-detail">
      <h1>${title}</h1><p>示例公司 · 深圳</p>
      <section data-job-description><h2>岗位职责</h2><p>负责平台服务设计、交付与技术治理。</p>
        <h2>岗位要求</h2><ul><li>本科及以上学历</li><li>五年以上 Java 开发经验</li></ul></section>
      <a href="/application?taskId=${encodeURIComponent(taskId)}">进入申请表</a>
    </article></main></body></html>`;
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

function djiPage(taskId: string): string {
  const encodedTaskId = encodeURIComponent(taskId);
  return `<!doctype html>
  <html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <title>大疆校园招聘申请</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; background: #f4f6f8; color: #1f2933; }
      main { width: min(760px, calc(100% - 32px)); margin: 32px auto; background: white; padding: 28px; }
      form { display: grid; gap: 18px; }
      section { display: grid; gap: 14px; border-top: 1px solid #dde3e8; padding-top: 18px; }
      label { display: grid; gap: 7px; font-weight: 650; }
      input { border: 1px solid #aeb8c2; min-height: 38px; padding: 0 10px; }
      button { justify-self: end; min-height: 40px; padding: 0 18px; }
    </style>
  </head>
  <body><main><h1>申请信息</h1>
    <form method="post" action="/submit?taskId=${encodedTaskId}">
      <section aria-labelledby="education-title"><h2 id="education-title">教育经历</h2>
        <label for="school">毕业院校<input id="school" name="education[0].institution" data-key="school" required></label>
        <label for="major-direction">研究方向<input id="major-direction" name="application.majorDirection" data-key="majorDirection" required></label>
      </section>
      <section aria-labelledby="project-title"><h2 id="project-title">项目经历</h2>
        <label for="project-name">项目名称<input id="project-name" name="projects[0].name" data-key="projectName" required></label>
      </section>
      <section aria-labelledby="award-title"><h2 id="award-title">获奖经历</h2>
        <label for="award-level">获奖级别<select id="award-level" name="awards[0].level" data-key="awardLevel" required><option value="">请选择</option><option value="国家级">国家级</option><option value="省级">省级</option><option value="校级">校级</option></select></label>
      </section>
      <section aria-labelledby="extra-title"><h2 id="extra-title">补充信息</h2>
        <label for="unknown-field">未命名字段<input id="unknown-field" name="application.jobSpecific" data-key="unknownField" required></label>
      </section>
      <button type="submit">提交申请</button>
    </form>
    <script>
      const taskId = ${JSON.stringify(encodedTaskId)};
      const draft = {};
      const sync = () => fetch('/api/mokahr-state?taskId=' + taskId, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draft })
      });
      document.querySelectorAll('input, select').forEach((field) => field.addEventListener('change', () => {
        draft[field.dataset.key] = field.value;
        sync();
      }));
    </script>
  </main></body></html>`;
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
