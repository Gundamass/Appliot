# 前后端联调回归缺陷修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复已在真实前后端联调中复现的意图误分类、服务状态过期和 Windows 浏览器版本不匹配问题，然后用单元测试、生产构建、隔离 HTTP 联调和完整 Playwright 功能回归证明修复有效。

**Architecture:** 对话图仍以 `deterministicIntent` 和结构化模型共同分类，但只把模型用于确定性规则无法识别的文本；服务状态以守护器进程存活为子服务缓存状态的有效性边界；Playwright 测试不再硬编码系统 Edge，浏览器 Worker 按“显式路径→Playwright 匹配 Chromium→系统浏览器”解析。

**Tech Stack:** TypeScript 5.8、LangGraph、Vitest 3、PowerShell 5.1+、Playwright 1.53.1、Fastify、React/Vite、SQLite。

## Global Constraints

- 实现前重读 `docs/superpowers/specs/2026-09-04-integration-regression-fixes-design.md`，不扩展到意图体系重构、新健康探测协议或安全/审批边界变更。
- 仓库存在 `.codegraph/`；定位或理解代码时先用 `rtk codegraph explore`，再用 `rtk rg`。所有 shell 命令以 `rtk` 开头。
- 当前工作树有用户未提交改动；修改前和每次提交前均对当前 Task 列出的完整文件清单执行 `rtk git -c safe.directory='E:/projects/简历投递助手' diff --`，仅暂存本计划新增的 hunk。若目标文件原本已脏，按各 Task 给出的精确 `add -p` 命令逐块选择，不得把无关改动带入提交。
- 每个缺陷均严格执行 RED→GREEN→受影响回归；看到新测试因预期原因失败后才修改生产代码。
- 测试不依赖已停止的本地守护服务；隔离联调使用 `44120`/`45173` 端口和 `.tmp/integration-regression-20260904`，完成后停止子进程并删除临时数据。
- 浏览器回归的默认用例必须在未设置 `RESUME_BROWSER_EXECUTABLE` 时运行；另外用单元测试保留显式路径的最高优先级。

---

### Task 1: 防止结构化模型覆盖明确的投递进度意图

**Files:**

- Modify: `apps/api/src/conversations/conversation-graph.test.ts`
- Modify: `apps/api/src/conversations/conversation-graph.ts:300-336`

- [x] **Step 1: 写入模型返回“合法但错误”意图的失败测试**

在现有 `"executes a read-only status query without confirmation"` 附近增加：

```ts
it("keeps an unambiguous application-status intent ahead of a conflicting model result", async () => {
  const dependencies = fakeDependencies();
  const generateStructured = vi.fn(async () => ({
    kind: "list_recommendations",
    requiresConfirmation: false
  }));
  dependencies.modelProvider = { generateStructured };

  const response = await runConversationTurn(
    dependencies,
    "我投了哪些岗位？对应的网站有哪些？",
    { version: 0, recentPostingIds: [] }
  );

  expect(response.message.intent?.kind).toBe("list_application_tasks");
  expect(response.cards).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "application_task" })
  ]));
  expect(generateStructured).not.toHaveBeenCalled();
});
```

- [x] **Step 2: 增加“只有未知文本才交给模型”的保护测试**

```ts
it("uses the structured model when deterministic rules do not understand the message", async () => {
  const dependencies = fakeDependencies();
  const generateStructured = vi.fn(async () => ({
    kind: "list_recommendations",
    requiresConfirmation: false
  }));
  dependencies.modelProvider = { generateStructured };

  const response = await runConversationTurn(
    dependencies,
    "帮我做点别的事情",
    { version: 0, recentPostingIds: [] }
  );

  expect(response.message.intent?.kind).toBe("list_recommendations");
  expect(generateStructured).toHaveBeenCalledTimes(1);
});
```

- [x] **Step 3: 运行定向测试并确认 RED**

Run:

```powershell
rtk proxy corepack pnpm --filter @resume/api exec vitest run src/conversations/conversation-graph.test.ts
```

Expected: 新的冲突测试失败，实际意图为 `list_recommendations`，且 `generateStructured` 被调用；“未知文本交给模型”测试通过。

- [x] **Step 4: 对所有非 `unknown` 确定性意图短路返回**

保留手动招聘 URL 分支在前，把仅针对 `discover_recruitment_site` 的分支替换为通用分支：

```ts
if (fallback.kind !== "unknown") {
  return finish({
    intent: fallback,
    traceIds: trace(
      dependencies,
      nodeEvent(state, "classify_intent", fallback.kind, "deterministic_intent"),
      state.traceIds
    )
  });
}
if (dependencies.modelProvider === undefined) {
  return finish({
    intent: fallback,
    traceIds: trace(
      dependencies,
      nodeEvent(state, "classify_intent", fallback.kind, "deterministic_fallback"),
      state.traceIds
    )
  });
}
```

不改动确认消息分支、手动 URL 恢复分支、模型 schema 校验、`normalizeIntent` 和模型异常回退。

- [x] **Step 5: 运行对话图回归并确认 GREEN**

Run:

```powershell
rtk proxy corepack pnpm --filter @resume/api exec vitest run src/conversations/conversation-graph.test.ts src/conversations/conversation-e2e.test.ts src/conversations/conversation-tools.test.ts
```

Expected: 全部通过；明确意图不调用模型，未知文本仍调用模型。

- [x] **Step 6: 审查并提交 Task 1 独立变更**

```powershell
rtk git -c safe.directory='E:/projects/简历投递助手' diff -- apps/api/src/conversations/conversation-graph.ts apps/api/src/conversations/conversation-graph.test.ts
rtk git -c safe.directory='E:/projects/简历投递助手' add -p -- apps/api/src/conversations/conversation-graph.ts apps/api/src/conversations/conversation-graph.test.ts
rtk git -c safe.directory='E:/projects/简历投递助手' diff --cached --check
rtk git -c safe.directory='E:/projects/简历投递助手' commit -m "fix: prioritize deterministic conversation intents"
```

Expected: 提交仅包含本 Task 的两个测试和 `classifyIntent` 短路改动。

---

### Task 2: 守护器停止时将子服务缓存状态视为过期

**Files:**

- Modify: `scripts/service-control.test.ps1:94-117`
- Modify: `scripts/service-supervisor.psm1:914-942`

- [x] **Step 1: 写入过期 `ready` 状态的失败测试**

在现有状态格式测试后增加独立 case：

```powershell
Invoke-Case "treats cached ready services as stopped when the supervisor is absent" {
  $runtime = Join-Path $testRoot "stale-ready-runtime"
  New-Item -ItemType Directory -Path $runtime | Out-Null
  $state = New-ServiceRuntimeState -DesiredState "running"
  $state.supervisorPid = 0
  foreach ($name in @("remoteOcr", "remoteEmbedding", "tunnel", "api", "web")) {
    $state.services.$name.state = "ready"
  }
  Write-RuntimeState -Path (Join-Path $runtime "runtime-state.json") -State $state

  $notRunningLabel = '"\u672a\u8fd0\u884c"' | ConvertFrom-Json
  $readyLabel = '"\u5c31\u7eea"' | ConvertFrom-Json
  $lines = @(Get-ServiceStatusLines -RuntimeRoot $runtime)

  Assert-Equal 6 $lines.Count "Status did not produce exactly six service lines."
  Assert-Equal 6 (@($lines | Where-Object { $_.Contains($notRunningLabel) }).Count) "Stopped supervisor did not invalidate every cached child status."
  Assert-True (-not (($lines -join "`n").Contains($readyLabel))) "Stopped supervisor exposed a stale ready status."
}
```

- [x] **Step 2: 运行 PowerShell 测试并确认 RED**

Run:

```powershell
rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/service-control.test.ps1
```

Expected: 新 case 失败，因为五个子服务仍包含“就绪”。

- [x] **Step 3: 只在守护器存活时信任子服务缓存**

在 `Get-ServiceStatusLines` 的子服务循环中引入有效状态，守护器停止时不带出过期错误后缀：

```powershell
foreach ($name in @("remoteOcr", "remoteEmbedding", "tunnel", "api", "web")) {
  $record = $state.services.$name
  $effectiveState = if ($supervisorState -eq "stopped") { "stopped" } else { $record.state }
  $suffix = if (
    $supervisorState -ne "stopped" -and
    -not [string]::IsNullOrEmpty([string]$record.lastError) -and
    $effectiveState -ne "ready"
  ) { " - $($record.lastError)" } else { "" }
  $lines.Add(("{0,-24} {1}{2}" -f $labels[$name], (Get-ServiceStatusText -State $effectiveState), $suffix))
}
```

不增加端口、SSH 或 HTTP 探测，不写回 `runtime-state.json`。

- [x] **Step 4: 运行脚本回归和真实状态命令**

```powershell
rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/service-control.test.ps1
rtk proxy corepack pnpm services:status
```

Expected: 测试全部通过；当本机守护器未运行时，状态命令的 6 行均显示“未运行”，不再显示过期“就绪”。

- [x] **Step 5: 审查并提交 Task 2 独立变更**

```powershell
rtk git -c safe.directory='E:/projects/简历投递助手' diff -- scripts/service-control.test.ps1 scripts/service-supervisor.psm1
rtk git -c safe.directory='E:/projects/简历投递助手' add -p -- scripts/service-control.test.ps1 scripts/service-supervisor.psm1
rtk git -c safe.directory='E:/projects/简历投递助手' diff --cached --check
rtk git -c safe.directory='E:/projects/简历投递助手' commit -m "fix: invalidate stale service readiness"
```

---

### Task 3: 统一 Playwright 与浏览器 Worker 的可执行文件优先级

**Files:**

- Modify: `tests/browser/playwright-config.spec.ts`
- Modify: `playwright.config.ts:1-20`
- Modify: `apps/browser-worker/src/session-manager.test.ts:1-183`
- Modify: `apps/browser-worker/src/session-manager.ts:27-50`

- [x] **Step 1: 为 Playwright 配置写入无显式路径时不强制 Edge 的失败测试**

将配置测试导入改为同时导入纯函数，并增加：

```ts
import config, { browserLaunchOptions } from "../../playwright.config.js";

test("prefers an explicit executable and otherwise uses an installed Playwright Chromium", () => {
  const playwrightExecutable = "C:\\playwright\\chromium.exe";
  const pathExists = (candidate: string) => candidate === playwrightExecutable;

  expect(browserLaunchOptions(undefined, playwrightExecutable, pathExists)).toEqual({
    launchOptions: { executablePath: playwrightExecutable }
  });
  expect(browserLaunchOptions("C:\\browsers\\approved.exe", playwrightExecutable, pathExists)).toEqual({
    launchOptions: { executablePath: "C:\\browsers\\approved.exe" }
  });
  expect(browserLaunchOptions(undefined, playwrightExecutable, () => false)).toEqual({});
});
```

- [x] **Step 2: 为 Worker 写入 Playwright Chromium 默认优先级测试**

扩展 `playwright-core` mock，使其也暴露可观察的默认路径：

```ts
vi.mock("playwright-core", () => ({
  chromium: {
    executablePath: vi.fn(() => process.execPath),
    launchPersistentContext: vi.fn(async () => runtime.context)
  }
}));
```

将导入扩展为：

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { chromium } from "playwright-core";
import { BrowserSessionManager, resolveExecutablePath } from "./session-manager.js";
```

在页面生命周期测试前增加：

```ts
const originalBrowserExecutable = process.env.RESUME_BROWSER_EXECUTABLE;

afterEach(() => {
  if (originalBrowserExecutable === undefined) delete process.env.RESUME_BROWSER_EXECUTABLE;
  else process.env.RESUME_BROWSER_EXECUTABLE = originalBrowserExecutable;
  vi.mocked(chromium.executablePath).mockClear();
});

describe("browser executable resolution", () => {
  it("prefers Playwright's matching Chromium when no explicit path is configured", () => {
    delete process.env.RESUME_BROWSER_EXECUTABLE;

    expect(resolveExecutablePath()).toBe(process.execPath);
    expect(chromium.executablePath).toHaveBeenCalledTimes(1);
  });

  it("keeps an explicit executable ahead of Playwright's Chromium", () => {
    process.env.RESUME_BROWSER_EXECUTABLE = process.execPath;

    expect(resolveExecutablePath(import.meta.filename)).toBe(import.meta.filename);
    expect(chromium.executablePath).not.toHaveBeenCalled();
  });
});
```

`import.meta.filename` 在项目要求的 Node 24 中可用，且指向存在的文件，可用来验证显式参数的优先级。

- [x] **Step 3: 运行两组定向测试并确认 RED**

```powershell
rtk proxy corepack pnpm exec playwright test tests/browser/playwright-config.spec.ts --reporter=line
rtk proxy corepack pnpm --filter @resume/browser-worker exec vitest run src/session-manager.test.ts
```

Expected: 配置测试因未导出 `browserLaunchOptions` 或无法选中存在的 Playwright Chromium 而失败；Worker 测试因未导出 `resolveExecutablePath`/尚未调用 `chromium.executablePath()` 失败。

- [x] **Step 4: 移除 Playwright 配置中的 Windows Edge 硬编码**

将 `playwright.config.ts` 顶部和 `use` 构造改为：

```ts
import { existsSync } from "node:fs";
import { chromium, defineConfig } from "@playwright/test";

export function browserLaunchOptions(
  explicitExecutablePath: string | undefined,
  playwrightExecutablePath = chromium.executablePath(),
  pathExists: (candidate: string) => boolean = existsSync
) {
  const executablePath = explicitExecutablePath
    || (pathExists(playwrightExecutablePath) ? playwrightExecutablePath : undefined);
  return executablePath
    ? { launchOptions: { executablePath } }
    : {};
}

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  outputDir: "playwright-artifacts",
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    ...browserLaunchOptions(process.env.RESUME_BROWSER_EXECUTABLE)
  }
});
```

这样未显式配置时直接使用 Playwright 1.53.1 已安装的完整 Chromium，避免默认 headless 流程误找未安装的 `chromium_headless_shell-1179`；设置环境变量时仍由显式路径覆盖。

- [x] **Step 5: 在 Worker 中优先选择已安装的 Playwright Chromium**

导出解析函数以便直接测试，并保留显式无效路径立即报错的现有语义：

```ts
export function resolveExecutablePath(configuredPath?: string): string {
  const explicitCandidate = configuredPath ?? process.env.RESUME_BROWSER_EXECUTABLE;
  if (explicitCandidate !== undefined) {
    if (!existsSync(explicitCandidate)) {
      throw new Error("未找到可用的 Edge、Chrome 或 Chromium 浏览器");
    }
    return explicitCandidate;
  }

  const playwrightCandidate = chromium.executablePath();
  const candidate = existsSync(playwrightCandidate)
    ? playwrightCandidate
    : executableCandidates.find((path) => existsSync(path));
  if (!candidate) {
    throw new Error("未找到可用的 Edge、Chrome 或 Chromium 浏览器");
  }
  return candidate;
}
```

函数参数仍高于环境变量，两者都属于运行时显式配置；仅在两者均缺失时检查 Playwright 路径和系统候选。

- [x] **Step 6: 运行配置、Worker 和类型回归并确认 GREEN**

```powershell
rtk proxy corepack pnpm exec playwright test tests/browser/playwright-config.spec.ts --reporter=line
rtk proxy corepack pnpm --filter @resume/browser-worker exec vitest run src/session-manager.test.ts
rtk proxy corepack pnpm typecheck
```

Expected: 全部通过；无显式路径且匹配 Chromium 存在时，Playwright 配置和 Worker 都返回该路径；显式参数仍优先。

- [x] **Step 7: 审查并提交 Task 3 独立变更**

```powershell
rtk git -c safe.directory='E:/projects/简历投递助手' diff -- playwright.config.ts tests/browser/playwright-config.spec.ts apps/browser-worker/src/session-manager.ts apps/browser-worker/src/session-manager.test.ts
rtk git -c safe.directory='E:/projects/简历投递助手' add -p -- playwright.config.ts tests/browser/playwright-config.spec.ts apps/browser-worker/src/session-manager.ts apps/browser-worker/src/session-manager.test.ts
rtk git -c safe.directory='E:/projects/简历投递助手' diff --cached --check
rtk git -c safe.directory='E:/projects/简历投递助手' commit -m "fix: prefer Playwright-compatible Chromium"
```

---

### Task 4: 执行全量验证和真实前后端隔离联调

**Files:**

- Verify only: `apps/api/dist/server.js`
- Verify only: `apps/web/dist/`
- Verify only: `.tmp/integration-regression-20260904/` (temporary, remove after verification)

- [x] **Step 1: 运行所有受影响的自动化测试**

```powershell
rtk proxy corepack pnpm --filter @resume/api exec vitest run src/conversations/conversation-graph.test.ts src/conversations/conversation-e2e.test.ts src/conversations/conversation-tools.test.ts
rtk proxy corepack pnpm --filter @resume/browser-worker exec vitest run src/session-manager.test.ts
rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/service-control.test.ps1
rtk proxy corepack pnpm exec playwright test tests/browser/playwright-config.spec.ts --reporter=line
```

Expected: 全部通过，不得仅依赖单个新测试的结果。

- [x] **Step 2: 运行工作区级测试、类型检查和生产构建**

```powershell
rtk proxy corepack pnpm test
rtk proxy corepack pnpm typecheck
rtk proxy corepack pnpm build
```

Expected: 三条命令均以退出码 0 完成；`apps/api/dist/server.js`、`apps/api/dist/browser-worker.js` 和 `apps/web/dist/` 由本次源码重建。

- [x] **Step 3: 确认隔离端口未被占用并创建临时目录**

```powershell
rtk powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -State Listen -LocalPort 44120,45173 -ErrorAction SilentlyContinue) { throw 'integration ports are already in use' }; New-Item -ItemType Directory -Force -Path '.tmp/integration-regression-20260904' | Out-Null"
```

Expected: 命令无错误退出，两个端口可用。

- [x] **Step 4: 在两个独立执行会话中启动构建后的 API 和 Web**

API 会话：

```powershell
rtk powershell.exe -NoProfile -Command '$env:DATABASE_FILE="E:/projects/简历投递助手/.tmp/integration-regression-20260904/resume.sqlite"; $env:API_PORT="44120"; $env:LANGSMITH_TRACING_ENABLED="false"; Remove-Item Env:RESUME_BROWSER_EXECUTABLE -ErrorAction SilentlyContinue; node apps/api/dist/server.js'
```

Web 会话：

```powershell
rtk powershell.exe -NoProfile -Command '$env:WEB_PORT="45173"; $env:WEB_API_ORIGIN="http://127.0.0.1:44120"; node scripts/serve-web.mjs'
```

Expected: API 监听 `127.0.0.1:44120`，Web 输出 `Appliot web listening on http://127.0.0.1:45173`。不使用守护器的旧运行状态或默认数据库。

- [x] **Step 5: 通过 Web 反向代理执行真实 HTTP 前后端联调**

在第三个执行会话中运行：

```powershell
rtk powershell.exe -NoProfile -Command '& { $ErrorActionPreference="Stop"; $origin="http://127.0.0.1:45173"; $page=Invoke-WebRequest -UseBasicParsing -Uri $origin; if ($page.StatusCode -ne 200) { throw "web root failed" }; $session=Invoke-RestMethod -Method Post -ContentType "application/json" -Body "{}" -Uri ($origin + "/api/conversations"); $body=@{ text="我投了哪些岗位？对应的网站有哪些？" } | ConvertTo-Json -Compress; $result=Invoke-RestMethod -Method Post -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body)) -Uri ($origin + "/api/conversations/" + $session.id + "/messages"); if ($result.message.intent.kind -ne "list_application_tasks") { throw ("unexpected intent: " + $result.message.intent.kind) }; $view=Invoke-RestMethod -Method Get -Uri ($origin + "/api/conversations/" + $session.id); if ($view.messages.Count -lt 2) { throw "conversation was not persisted" }; $cleared=Invoke-RestMethod -Method Delete -Uri ($origin + "/api/conversations"); Write-Output ("PASS integration conversation " + $session.id + " intent=" + $result.message.intent.kind + " messages=" + $view.messages.Count + " cleared=" + $cleared.deletedCount) }'
```

Expected: 输出以 `PASS integration conversation` 开头并以实际会话 ID 结尾的单行结果；请求路径是 Web `45173` 而不是直连 API，证明静态前端服务、反向代理、Fastify 路由、对话图和 SQLite 持久化串联正常。

- [x] **Step 6: 停止两个隔离服务并安全清理临时数据**

先给 API/Web 执行会话发送 Ctrl+C，然后执行：

```powershell
rtk powershell.exe -NoProfile -Command '$target=[IO.Path]::GetFullPath("E:/projects/简历投递助手/.tmp/integration-regression-20260904"); $allowed=[IO.Path]::GetFullPath("E:/projects/简历投递助手/.tmp") + [IO.Path]::DirectorySeparatorChar; if (-not $target.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw "unsafe cleanup target" }; if (Get-NetTCPConnection -State Listen -LocalPort 44120,45173 -ErrorAction SilentlyContinue) { throw "integration services are still listening" }; Remove-Item -LiteralPath $target -Recurse -Force'
```

Expected: 临时目录被删除，两个端口无监听器。

- [x] **Step 7: 在不设置浏览器路径时运行完整 Playwright 功能回归**

```powershell
rtk powershell.exe -NoProfile -Command 'Remove-Item Env:RESUME_BROWSER_EXECUTABLE -ErrorAction SilentlyContinue; node scripts/run-playwright.mjs test --reporter=line'
```

Expected: 完整套件全部通过（加入本计划的配置测试后当前预期为 48 passed），无 `Target page, context or browser has been closed`，失败时必须保留 `playwright-artifacts` 而不得改用显式 Edge 来掩盖问题。

- [x] **Step 8: 检查最终差异、空白错误和工作树边界**

```powershell
rtk git -c safe.directory='E:/projects/简历投递助手' diff --check
rtk git -c safe.directory='E:/projects/简历投递助手' status --short
rtk git -c safe.directory='E:/projects/简历投递助手' log -4 --oneline
```

Expected: `diff --check` 无输出；最近历史包含设计提交 `3185d28` 和四个实现提交；`status --short` 可以仍显示用户原有改动，但不应有 `.tmp/integration-regression-20260904` 或本计划遗留的未提交代码。

## Execution Notes

- 原始全仓测试首轮有 3 个旧 Browser Worker DOM 用例因并行资源争用超过 5 秒；三个文件串行复验均通过，再次运行原始全仓命令也全部通过，因此未改动无关超时或 DOM 逻辑。
- 首次无显式路径的完整 Playwright 回归发现默认 headless 流程要求未安装的 `chromium_headless_shell-1179`；根据新增 RED 测试补充 `5795e67`，显式选择存在的 `chromium.executablePath()`，最终 48/48 通过。
- 隔离 HTTP 联调使用 Web `45173` 代理到 API `44120`，目标语句返回 `list_application_tasks`、持久化 2 条消息，清理 4 个隔离测试会话后停止进程并删除临时目录。

---

## Completion Criteria

- 真实快捷语句“我投了哪些岗位？对应的网站有哪些？”在模型返回合法冲突值时仍解析为 `list_application_tasks`，且模型未被调用。
- 守护器不存在时，`services:status` 的守护器和五个子服务均显示“未运行”，不暴露缓存 `ready` 或过期错误后缀。
- 未设置 `RESUME_BROWSER_EXECUTABLE` 时，Playwright 使用自身匹配浏览器，Worker 优先使用存在的 `chromium.executablePath()`；显式路径仍优先且无效时明确失败。
- 受影响测试、全量测试、类型检查、生产构建、Web 代理到 API 的隔离 HTTP 联调和无显式浏览器的完整 Playwright 回归全部通过。
- 临时进程、端口、SQLite 和会话数据已清理；不改动、删除或提交用户原有的无关工作树变更。
