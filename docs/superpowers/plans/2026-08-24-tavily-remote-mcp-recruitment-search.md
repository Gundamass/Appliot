# Tavily Remote MCP Recruitment Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Tavily 官方 Remote MCP 的 `tavily-search` 替换浏览器模拟搜索，在对话中安全展示候选招聘入口并经用户确认后复用现有岗位推荐与受控投递链路。

**Architecture:** API 内新增独立的招聘入口搜索端口、Tavily Streamable HTTP MCP 适配器和公网 HTTPS URL 校验器。ConversationGraph 只接收标准化候选列表，以一个带候选项的确认记录完成入口选择；用户确认前不写入 `verifiedRecruitmentSite`、不启动 Browser Worker。生产依赖直接注入 Tavily 搜索端口，并彻底移除招聘入口的浏览器搜索 IPC。

**Tech Stack:** TypeScript 5.8、Node.js 24、Zod 3.25、`@modelcontextprotocol/sdk` 1.30.0、LangGraph、Fastify、React 19、Vitest、pnpm workspace

## Global Constraints

- 只连接 Tavily 官方 Remote MCP：`https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILY_API_KEY}`。
- 首期 MCP 工具白名单只有 `tavily-search`；不得调用 `extract`、`map`、`crawl` 或 `research`。
- 固定搜索参数：`search_depth=basic`、`topic=general`、`max_results=5`、`include_images=false`、`include_raw_content=false`。
- Tavily 请求只包含公司名、招聘类型和固定搜索词，不包含简历或任何候选人个人信息。
- 最多向对话层返回 3 个去重后的安全候选；搜索排序不得被描述为官网认证。
- 候选和用户粘贴的 URL 只允许 HTTPS、无 URL 凭据、非裸 IP，并且 DNS 解析结果必须全部为公网地址。
- API Key 只来自 `TAVILY_API_KEY`，不得进入源码、前端、数据库、审计事件、错误消息或日志。
- MCP 调用超时为 10,000 ms；仅对连接失败、HTTP 429 和 5xx 做一次短退避重试。
- 搜索失败后允许重试或粘贴官方招聘链接；不得降级为百度、必应或其他浏览器搜索。
- 用户确认招聘入口前不得启动 Browser Worker、创建岗位匹配会话或创建投递任务。
- 保留现有岗位匹配、岗位选择、受控填写、登录/验证码人工接管和最终提交硬锁。
- 本期不实现企业招聘状态跟踪。
- 按当前会话串行执行，不创建子智能体；每完成一个 Task 运行该 Task 的测试并用中文汇报。

## File Structure

### 新建

- `packages/contracts/src/recruitment-search.ts`：搜索输入、候选、搜索结果、已确认入口和对话选择目标的共享 Zod 契约。
- `packages/contracts/src/recruitment-search.test.ts`：共享契约的边界测试。
- `apps/api/src/recruitment-search/public-https-url.ts`：URL 规范化、DNS 公网检查和重定向目标复验。
- `apps/api/src/recruitment-search/public-https-url.test.ts`：SSRF、规范化和去重测试。
- `apps/api/src/recruitment-search/tavily-remote-mcp.ts`：查询构造、MCP 连接、工具白名单、响应解析、重试和错误归一化。
- `apps/api/src/recruitment-search/tavily-remote-mcp.test.ts`：注入式 MCP 调用单元测试。
- `apps/api/src/recruitment-search/tavily-remote-mcp.integration.test.ts`：本地假 Streamable HTTP MCP Server 集成测试。
- `apps/api/src/recruitment-search/tavily-remote-mcp.smoke.test.ts`：显式提供真实 API Key 时才运行的烟雾测试。

### 修改

- `apps/api/package.json`、`pnpm-lock.yaml`：固定 MCP SDK 版本。
- `apps/api/src/config.ts`、`apps/api/src/config.test.ts`：增加可选 Tavily 配置组。
- `packages/contracts/src/index.ts`：导出招聘搜索契约。
- `packages/contracts/src/browser.ts`、`packages/contracts/src/browser.test.ts`：移除招聘搜索 Browser IPC。
- `packages/contracts/src/conversation.ts`、`packages/contracts/src/conversation.test.ts`：增加候选选择确认和 `selectedUrl`。
- `apps/api/src/conversations/conversation-tools.ts`、`apps/api/src/conversations/conversation-tools.test.ts`：搜索工具改为返回候选集合，不再申请浏览器 owner。
- `apps/api/src/conversations/conversation-graph.ts`、`apps/api/src/conversations/conversation-graph.test.ts`：实现候选选择、确认后写入已验证入口和手工链接恢复。
- `apps/api/src/conversations/conversation-service.ts`、`apps/api/src/conversations/conversation-routes.ts` 及对应测试：透传并校验 `selectedUrl`。
- `apps/api/src/conversations/conversation-e2e.test.ts`：验证搜索、确认、岗位推荐和失败恢复边界。
- `apps/api/src/production-dependencies.ts`、`apps/api/src/production-dependencies.test.ts`：生产环境改接 Tavily 搜索端口，并断言搜索阶段不创建浏览器客户端。
- `apps/web/src/conversation/api.ts`：确认请求支持所选 URL。
- `apps/web/src/conversation/ConversationCards.tsx`、`apps/web/src/conversation/ConversationCards.test.tsx`：在一个确认卡中展示并选择 1～3 个候选。
- `apps/web/src/conversation/ChatHome.tsx`：提交候选 URL。
- `apps/browser-worker/src/public-navigation-guard.ts`：对已确认招聘入口及其重定向逐跳执行公网 HTTPS 校验。
- `apps/browser-worker/src/public-navigation-guard.test.ts`：验证私网重定向在发出请求前被阻断。
- `apps/api/src/browser/worker-client.ts`、`apps/api/src/browser/worker-client.test.ts`、`apps/api/src/browser/fixtures/activity-worker.ts`：删除招聘搜索 IPC 客户端分支。
- `apps/browser-worker/src/ipc-server.ts`、`apps/browser-worker/src/ipc-server.test.ts`、`apps/browser-worker/src/session-manager.ts`、`apps/browser-worker/src/session-manager.test.ts`：删除招聘搜索处理分支。
- `docs/testing/2026-08-22-chat-first-workspace-regression.md`：用中文补充 Tavily 回归结果。

### 删除

- `apps/browser-worker/src/recruitment-site-discovery.ts`：删除百度搜索页面自动化。
- `apps/browser-worker/src/recruitment-site-discovery.test.ts`：删除对应浏览器搜索测试；公网 URL 用例迁移到 API 测试。

---

### Task 1: Tavily 配置组与 MCP SDK 依赖

**Files:**
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/config.test.ts`

**Interfaces:**
- Produces: `TavilyRemoteMcpConfig { apiKey: string; endpoint: string; timeoutMs: number; maxRetries: 1 }`
- Produces: `ApiConfig.tavily?: TavilyRemoteMcpConfig`
- Consumes: `NodeJS.ProcessEnv`

- [ ] **Step 1: 写配置失败测试**

在 `apps/api/src/config.test.ts` 增加：

```ts
it("loads Tavily Remote MCP from an API key without exposing the key in errors", () => {
  expect(loadConfig({ TAVILY_API_KEY: "tvly-test-secret" })).toMatchObject({
    tavily: {
      apiKey: "tvly-test-secret",
      endpoint: "https://mcp.tavily.com/mcp/",
      timeoutMs: 10_000,
      maxRetries: 1
    }
  });

  const secret = "tvly-should-never-leak";
  const message = captureError(() => loadConfig({
    TAVILY_API_KEY: secret,
    TAVILY_MCP_TIMEOUT_MS: "invalid"
  }));
  expect(message).toContain("TAVILY_MCP_TIMEOUT_MS");
  expect(message).not.toContain(secret);
});

it("keeps Tavily disabled when no TAVILY variables are present and rejects unsafe endpoints", () => {
  expect(loadConfig({}).tavily).toBeUndefined();
  expect(() => loadConfig({ TAVILY_API_KEY: "key", TAVILY_MCP_ENDPOINT: "http://localhost:3000/mcp" }))
    .toThrow("TAVILY_MCP_ENDPOINT");
  expect(() => loadConfig({ TAVILY_MCP_TIMEOUT_MS: "10000" }))
    .toThrow("TAVILY_API_KEY");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack pnpm --filter @resume/api exec vitest run src/config.test.ts`

Expected: FAIL，`ApiConfig` 尚无 `tavily`，`loadConfig` 不解析 `TAVILY_*`。

- [ ] **Step 3: 增加固定版本依赖**

Run: `corepack pnpm --filter @resume/api add @modelcontextprotocol/sdk@1.30.0`

Expected: `apps/api/package.json` 出现 `"@modelcontextprotocol/sdk": "1.30.0"`，`pnpm-lock.yaml` 同步更新；不得改动其他依赖版本。

- [ ] **Step 4: 实现 Tavily 配置解析**

在 `apps/api/src/config.ts` 增加并导出：

```ts
export interface TavilyRemoteMcpConfig {
  apiKey: string;
  endpoint: string;
  timeoutMs: number;
  maxRetries: 1;
}

const tavilySchema = z.object({
  apiKey: nonEmptyString,
  endpoint: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      && url.search === "";
  }, "https_endpoint_required"),
  timeoutMs: positiveInteger
}).strict();
```

将 `tavily?: TavilyRemoteMcpConfig` 加到 `ApiConfig`。在 `loadConfig` 中把任何 `TAVILY_` 变量视为启用配置组，使用以下值解析，并通过 `invalidVariables` 只报告变量名：

```ts
const hasTavily = Object.keys(env).some((name) => name.startsWith("TAVILY_"));
let tavily: TavilyRemoteMcpConfig | undefined;
if (hasTavily) {
  const result = tavilySchema.safeParse({
    apiKey: env.TAVILY_API_KEY,
    endpoint: env.TAVILY_MCP_ENDPOINT ?? "https://mcp.tavily.com/mcp/",
    timeoutMs: env.TAVILY_MCP_TIMEOUT_MS ?? "10000"
  });
  if (!result.success) {
    coreErrors.push(...invalidVariables(result, {
      apiKey: "TAVILY_API_KEY",
      endpoint: "TAVILY_MCP_ENDPOINT",
      timeoutMs: "TAVILY_MCP_TIMEOUT_MS"
    }));
  } else {
    tavily = { ...result.data, maxRetries: 1 };
  }
}
```

返回 `ApiConfig` 时仅在配置成功后展开 `{ tavily }`；不要把 Tavily Key 加入启动日志或 `scripts/local-launch.psm1` 的必填列表。

- [ ] **Step 5: 运行配置测试和类型检查**

Run: `corepack pnpm --filter @resume/api exec vitest run src/config.test.ts`

Expected: PASS。

Run: `corepack pnpm --filter @resume/api typecheck`

Expected: PASS。

- [ ] **Step 6: 提交 Task 1**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/config.ts apps/api/src/config.test.ts
git commit -m "feat: configure Tavily remote MCP"
```

---

### Task 2: 招聘搜索契约与公网 HTTPS 校验

**Files:**
- Create: `packages/contracts/src/recruitment-search.ts`
- Create: `packages/contracts/src/recruitment-search.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/recruitment-search/public-https-url.ts`
- Create: `apps/api/src/recruitment-search/public-https-url.test.ts`

**Interfaces:**
- Produces: `RecruitmentSiteSearchPort.search(input): Promise<RecruitmentSiteSearchResult>`
- Produces: `RecruitmentSiteCandidate`, `RecruitmentSiteSearchResult`, `VerifiedRecruitmentSite`
- Produces: `validatePublicHttpsUrl(rawUrl, resolveHostname?): Promise<{ url: string; domain: string }>`
- Consumes: DNS resolver returning every resolved address for one hostname

- [ ] **Step 1: 写共享契约失败测试**

创建 `packages/contracts/src/recruitment-search.test.ts`，覆盖以下断言：

```ts
import { describe, expect, it } from "vitest";
import {
  RecruitmentSearchRequestSchema,
  RecruitmentSiteSearchResultSchema,
  VerifiedRecruitmentSiteSchema
} from "./recruitment-search.js";

describe("recruitment search contracts", () => {
  it("accepts only bounded non-personal search input and at most three candidates", () => {
    expect(RecruitmentSearchRequestSchema.parse({
      companyName: "百度",
      recruitmentType: "campus"
    })).toEqual({ companyName: "百度", recruitmentType: "campus" });
    expect(() => RecruitmentSearchRequestSchema.parse({
      companyName: "百度",
      recruitmentType: "campus",
      resumeText: "secret"
    })).toThrow();
    expect(() => RecruitmentSiteSearchResultSchema.parse({
      query: "百度 校园招聘 招聘 官网",
      candidates: Array.from({ length: 4 }, (_, index) => ({
        title: `候选 ${index}`,
        url: `https://jobs${index}.example.com/`,
        domain: `jobs${index}.example.com`,
        snippet: "招聘入口",
        source: "tavily"
      }))
    })).toThrow();
  });

  it("keeps a selected site separate from search results", () => {
    expect(VerifiedRecruitmentSiteSchema.parse({
      company: "百度",
      recruitmentType: "campus",
      query: "百度 校园招聘 招聘 官网",
      title: "百度校园招聘",
      url: "https://talent.baidu.com/",
      domain: "talent.baidu.com",
      snippet: "校园招聘岗位",
      source: "tavily",
      sourceScore: 0.92
    })).toMatchObject({ company: "百度", source: "tavily" });
  });
});
```

- [ ] **Step 2: 写 URL 校验失败测试**

创建 `apps/api/src/recruitment-search/public-https-url.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { validatePublicHttpsUrl } from "./public-https-url.js";

describe("validatePublicHttpsUrl", () => {
  const publicDns = vi.fn(async () => ["220.181.7.203"]);

  it.each([
    "http://talent.baidu.com/jobs",
    "https://user:pass@talent.baidu.com/jobs",
    "https://localhost/jobs",
    "https://127.0.0.1/jobs",
    "https://[::1]/jobs",
    "https://jobs.local/path"
  ])("rejects unsafe URL %s", async (url) => {
    await expect(validatePublicHttpsUrl(url, publicDns)).rejects.toThrow("unsafe_recruitment_url");
  });

  it("rejects a hostname when any DNS answer is private", async () => {
    await expect(validatePublicHttpsUrl("https://jobs.example.com/", async () => [
      "203.0.113.8",
      "10.0.0.2"
    ])).rejects.toThrow("unsafe_recruitment_url");
  });

  it("normalizes a public HTTPS URL and removes its fragment", async () => {
    await expect(validatePublicHttpsUrl(
      "https://Talent.Baidu.com/jobs#apply",
      publicDns
    )).resolves.toEqual({
      url: "https://talent.baidu.com/jobs",
      domain: "talent.baidu.com"
    });
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `corepack pnpm --filter @resume/contracts exec vitest run src/recruitment-search.test.ts`

Expected: FAIL，契约文件不存在。

Run: `corepack pnpm --filter @resume/api exec vitest run src/recruitment-search/public-https-url.test.ts`

Expected: FAIL，URL 校验器不存在。

- [ ] **Step 4: 实现共享契约**

创建 `packages/contracts/src/recruitment-search.ts`，定义以下严格 schema 和导出类型：

```ts
import { z } from "zod";

export const RecruitmentSearchTypeSchema = z.enum(["campus", "social", "internship", "unknown"]);
export const RecruitmentCompanySchema = z.string().trim().min(1).max(80)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "recruitment_company_control_character");

export const RecruitmentSearchRequestSchema = z.object({
  companyName: RecruitmentCompanySchema,
  recruitmentType: RecruitmentSearchTypeSchema
}).strict();

export const RecruitmentSiteCandidateSchema = z.object({
  title: z.string().trim().min(1).max(160),
  url: z.string().url().max(2_048),
  domain: z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9.-]+$/u),
  snippet: z.string().trim().max(500),
  source: z.literal("tavily"),
  sourceScore: z.number().min(0).max(1).optional()
}).strict();

export const RecruitmentSiteSearchResultSchema = z.object({
  query: z.string().trim().min(1).max(200),
  candidates: z.array(RecruitmentSiteCandidateSchema).max(3)
}).strict();

export const VerifiedRecruitmentSiteSchema = z.object({
  company: RecruitmentCompanySchema,
  recruitmentType: RecruitmentSearchTypeSchema,
  query: z.string().trim().min(1).max(200),
  ...RecruitmentSiteCandidateSchema.shape
}).strict();

export type RecruitmentSearchRequest = z.infer<typeof RecruitmentSearchRequestSchema>;
export type RecruitmentSearchType = z.infer<typeof RecruitmentSearchTypeSchema>;
export type RecruitmentSiteCandidate = z.infer<typeof RecruitmentSiteCandidateSchema>;
export type RecruitmentSiteSearchResult = z.infer<typeof RecruitmentSiteSearchResultSchema>;
export type VerifiedRecruitmentSite = z.infer<typeof VerifiedRecruitmentSiteSchema>;

export interface RecruitmentSiteSearchPort {
  search(input: RecruitmentSearchRequest): Promise<RecruitmentSiteSearchResult>;
}
```

从 `packages/contracts/src/index.ts` 导出该文件。

- [ ] **Step 5: 实现公网 URL 校验器**

把现有 `apps/browser-worker/src/recruitment-site-discovery.ts` 中已验证过的 IP 分类逻辑迁移到 `apps/api/src/recruitment-search/public-https-url.ts`。公开接口必须固定为：

```ts
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type HostnameResolver = (hostname: string) => Promise<readonly string[]>;

export async function validatePublicHttpsUrl(
  rawUrl: string,
  resolveHostname: HostnameResolver = resolveAll
): Promise<{ url: string; domain: string }> {
  if (rawUrl.length > 2_048) throw new Error("unsafe_recruitment_url");
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("unsafe_recruitment_url"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error("unsafe_recruitment_url");
  }
  const hostname = url.hostname.toLowerCase();
  if (isIP(hostname) !== 0 || hostname === "localhost" || hostname.endsWith(".local")) {
    throw new Error("unsafe_recruitment_url");
  }
  const addresses = await resolveHostname(hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new Error("unsafe_recruitment_url");
  }
  url.hash = "";
  url.hostname = hostname;
  return { url: url.toString(), domain: hostname };
}

async function resolveAll(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}
```

`isPublicAddress` 必须完整迁移已有测试覆盖的 IPv4/IPv6 环回、私网、链路本地、文档网段、保留网段和 IPv4-mapped IPv6 判断，不得只检查 `10.*`。

- [ ] **Step 6: 运行 Task 2 测试**

Run: `corepack pnpm --filter @resume/contracts exec vitest run src/recruitment-search.test.ts`

Expected: PASS。

Run: `corepack pnpm --filter @resume/api exec vitest run src/recruitment-search/public-https-url.test.ts`

Expected: PASS。

Run: `corepack pnpm --filter @resume/contracts typecheck && corepack pnpm --filter @resume/api typecheck`

Expected: PASS。

- [ ] **Step 7: 提交 Task 2**

```bash
git add packages/contracts/src/recruitment-search.ts packages/contracts/src/recruitment-search.test.ts packages/contracts/src/index.ts apps/api/src/recruitment-search/public-https-url.ts apps/api/src/recruitment-search/public-https-url.test.ts
git commit -m "feat: define safe recruitment search boundary"
```

---

### Task 3: 受限 Tavily Streamable HTTP MCP 客户端

**Files:**
- Create: `apps/api/src/recruitment-search/tavily-remote-mcp.ts`
- Create: `apps/api/src/recruitment-search/tavily-remote-mcp.test.ts`

**Interfaces:**
- Consumes: `TavilyRemoteMcpConfig`
- Consumes: `validatePublicHttpsUrl`
- Produces: `createTavilyRecruitmentSiteSearch(config, adapters?): RecruitmentSiteSearchPort`
- Produces: stable error codes `TAVILY_TIMEOUT`, `TAVILY_UNAVAILABLE`, `TAVILY_PROTOCOL_ERROR`, `NO_SAFE_CANDIDATE`

- [ ] **Step 1: 写查询和工具白名单失败测试**

创建 `apps/api/src/recruitment-search/tavily-remote-mcp.test.ts`，使用注入的 `callTool` spy：

```ts
it("calls only tavily-search with fixed privacy-preserving parameters", async () => {
  const callTool = vi.fn(async () => ({ content: [{ type: "text", text: JSON.stringify({
    results: [{
      title: "百度校园招聘",
      url: "https://talent.baidu.com/#jobs",
      content: "招聘岗位",
      score: 0.91
    }]
  }) }] }));
  const search = createTavilyRecruitmentSiteSearch(config, {
    callTool,
    resolveHostname: async () => ["220.181.7.203"]
  });

  await expect(search.search({ companyName: "百度", recruitmentType: "campus" }))
    .resolves.toMatchObject({
      query: "百度 校园招聘 招聘 官网",
      candidates: [{ source: "tavily", domain: "talent.baidu.com" }]
    });
  expect(callTool).toHaveBeenCalledWith("tavily-search", {
    query: "百度 校园招聘 招聘 官网",
    search_depth: "basic",
    topic: "general",
    max_results: 5,
    include_images: false,
    include_raw_content: false
  }, 10_000);
});
```

再增加：控制字符公司名被 schema 拒绝；重复 URL 去重；4 个安全结果只返回 3 个；所有候选不安全时抛 `NO_SAFE_CANDIDATE`；响应中出现 `extract`/`crawl` 指令文本只作为摘要；调用接口没有任意工具名参数。

增加响应大小用例：单个 MCP text content 超过 256 KiB 时抛 `TAVILY_PROTOCOL_ERROR`，且不得把超大内容复制到错误或日志。

- [ ] **Step 2: 写超时、重试和脱敏失败测试**

增加：

```ts
it.each([
  [new TavilyTransportError("timeout", 408), "TAVILY_TIMEOUT"],
  [new TavilyTransportError("rate_limited", 429), "TAVILY_UNAVAILABLE"],
  [new TavilyTransportError("server_error", 503), "TAVILY_UNAVAILABLE"],
  [new Error("malformed"), "TAVILY_PROTOCOL_ERROR"]
])("maps failures without leaking endpoint secrets", async (cause, code) => {
  const secret = "tvly-secret-value";
  const callTool = vi.fn().mockRejectedValue(cause);
  const search = createTavilyRecruitmentSiteSearch({ ...config, apiKey: secret }, { callTool });
  const error = await search.search({ companyName: "百度", recruitmentType: "campus" })
    .then(() => undefined, (value) => value as Error);
  expect(error?.message).toBe(code);
  expect(String(error)).not.toContain(secret);
});
```

分别断言 429、5xx 和连接中断调用两次；400、协议错误和 URL 安全失败只调用一次。

- [ ] **Step 3: 运行测试确认失败**

Run: `corepack pnpm --filter @resume/api exec vitest run src/recruitment-search/tavily-remote-mcp.test.ts`

Expected: FAIL，Tavily 客户端模块不存在。

- [ ] **Step 4: 实现固定查询、MCP 调用和响应解析**

`apps/api/src/recruitment-search/tavily-remote-mcp.ts` 必须使用固定工具名常量，调用方不能传工具名：

```ts
const TAVILY_SEARCH_TOOL = "tavily-search" as const;
const MAX_REMOTE_RESULTS = 5;
const MAX_SAFE_CANDIDATES = 3;

const RECRUITMENT_LABELS = {
  campus: "校园招聘",
  social: "社会招聘",
  internship: "实习招聘",
  unknown: "招聘"
} as const;

function buildQuery(input: RecruitmentSearchRequest): string {
  return `${input.companyName} ${RECRUITMENT_LABELS[input.recruitmentType]} 招聘 官网`;
}

function fixedArguments(query: string): Record<string, unknown> {
  return {
    query,
    search_depth: "basic",
    topic: "general",
    max_results: MAX_REMOTE_RESULTS,
    include_images: false,
    include_raw_content: false
  };
}
```

定义内部适配接口，便于单元测试但不向 ConversationGraph 暴露 MCP：

```ts
export interface TavilyMcpCallAdapter {
  callTool(name: "tavily-search", args: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
}

export interface TavilySearchAdapters {
  callTool?: TavilyMcpCallAdapter["callTool"];
  resolveHostname?: HostnameResolver;
  delay?: (milliseconds: number) => Promise<void>;
}
```

默认 `callTool` 使用：

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = new URL(config.endpoint);
endpoint.searchParams.set("tavilyApiKey", config.apiKey);
const client = new Client({ name: "resume-application-assistant", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(endpoint);
await client.connect(transport);
try {
  return await client.callTool(
    { name: TAVILY_SEARCH_TOOL, arguments: args },
    undefined,
    { timeout: timeoutMs }
  );
} finally {
  await client.close();
}
```

用 Zod 严格解析 Tavily 文本 JSON：MCP text content 在 `JSON.parse` 前按 UTF-8 字节数限制为 256 KiB，只读取 `results[].title/url/content/score`，标题截断 160 字、摘要转纯文本并截断 500 字、最多处理 5 条。逐条调用 `validatePublicHttpsUrl`，按规范化 URL 去重，保留 Tavily 原顺序，最多 3 条。外部文本绝不进入工具名或后续系统提示。

- [ ] **Step 5: 实现错误归一化和一次重试**

对每次调用使用 10 秒 SDK timeout。只对网络连接错误、429、5xx 调用 `delay(200)` 后重试一次；其他错误不重试。最终只抛以下无敏感字段错误：

```ts
export type TavilySearchErrorCode =
  | "TAVILY_TIMEOUT"
  | "TAVILY_UNAVAILABLE"
  | "TAVILY_PROTOCOL_ERROR"
  | "NO_SAFE_CANDIDATE";

export class TavilySearchError extends Error {
  constructor(readonly code: TavilySearchErrorCode) {
    super(code);
    this.name = "TavilySearchError";
  }
}
```

不得把原始异常 message、完整 Endpoint、请求头或 Tavily 原始响应拼接到 Error。

- [ ] **Step 6: 运行 Task 3 测试**

Run: `corepack pnpm --filter @resume/api exec vitest run src/recruitment-search/tavily-remote-mcp.test.ts`

Expected: PASS。

Run: `corepack pnpm --filter @resume/api typecheck`

Expected: PASS。

- [ ] **Step 7: 提交 Task 3**

```bash
git add apps/api/src/recruitment-search/tavily-remote-mcp.ts apps/api/src/recruitment-search/tavily-remote-mcp.test.ts
git commit -m "feat: add restricted Tavily MCP search client"
```

---

### Task 4: 删除浏览器招聘搜索链路

**Files:**
- Modify: `apps/api/src/production-dependencies.ts`
- Modify: `apps/api/src/production-dependencies.test.ts`
- Modify: `packages/contracts/src/browser.ts`
- Modify: `packages/contracts/src/browser.test.ts`
- Modify: `apps/api/src/browser/worker-client.ts`
- Modify: `apps/api/src/browser/worker-client.test.ts`
- Modify: `apps/browser-worker/src/ipc-server.ts`
- Modify: `apps/browser-worker/src/ipc-server.test.ts`
- Modify: `packages/contracts/src/browser.ts`
- Modify: `packages/contracts/src/browser.test.ts`
- Modify: `apps/api/src/browser/worker-client.ts`
- Modify: `apps/api/src/browser/worker-client.test.ts`
- Modify: `apps/api/src/browser/fixtures/activity-worker.ts`
- Modify: `apps/browser-worker/src/ipc-server.ts`
- Modify: `apps/browser-worker/src/ipc-server.test.ts`
- Modify: `apps/browser-worker/src/session-manager.ts`
- Modify: `apps/browser-worker/src/session-manager.test.ts`
- Delete: `apps/browser-worker/src/recruitment-site-discovery.ts`
- Delete: `apps/browser-worker/src/recruitment-site-discovery.test.ts`

**Interfaces:**
- Removes: `BrowserWorkerClient.searchRecruitmentSite` and Browser IPC request/response variants
- Preserves: ConversationGraph 的可选搜索依赖暂时保持未注入；Task 5 会在同一个可测试提交中升级接口并接入 Tavily

- [ ] **Step 1: 改写生产接线测试并确认失败**

把 `apps/api/src/production-dependencies.test.ts` 中“routes recruitment discovery through the shared production browser client”改成：

```ts
it("does not start a browser to search for a recruitment site", async () => {
  const browserClientFactory = vi.fn(async () => productionBrowserClient());
  const dependencies = createProductionDependencies(config(), { browserClientFactory });
  const app = await createApp(dependencies);
  try {
    const created = await app.inject({ method: "POST", url: "/api/conversations" });
    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${created.json().id}/messages`,
      payload: { text: "帮我投递一下百度校园招聘" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().pendingConfirmation).toBeUndefined();
    expect(response.json().message.text).toContain("暂时无法");
    expect(browserClientFactory).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
```

Run: `corepack pnpm --filter @resume/api exec vitest run src/production-dependencies.test.ts`

Expected: FAIL，生产依赖仍调用 Browser Worker 搜索。

- [ ] **Step 2: 从生产依赖删除浏览器搜索接线**

删除 `searchRecruitmentSite` 和 `releaseRecruitmentTask` 生产接线。`ProductionBrowserClient` 的可选方法列表删除 `searchRecruitmentSite`。本 Task 不注入替代搜索实现；缺少搜索依赖时 ConversationGraph 必须返回现有 `recruitment_discovery_unavailable` 用户提示，且不启动 Browser Worker。Task 5 在升级 ConversationTool 接口后接入 Tavily。

- [ ] **Step 3: 删除 Browser IPC 招聘搜索能力**

从 `packages/contracts/src/browser.ts` 删除：

- `RecruitmentSiteSearchInputSchema`；
- `WorkerRequestSchema` 的 `search_recruitment_site` 分支；
- `WorkerResponseSchema` 的 `recruitment_site_found` 分支；
- 对应 browser 类型导出。

从 Worker Client、fixture、IPC Server 和 Session Manager 删除所有 `searchRecruitmentSite` / `search_recruitment_site` / `recruitment_site_found` 分支与测试。删除两个 `recruitment-site-discovery.*` 文件。不要删除 Browser Worker 的岗位页面读取、登录接管、Challenge 或受控投递能力。

- [ ] **Step 4: 运行 Task 4 定向测试**

Run: `corepack pnpm --filter @resume/api exec vitest run src/production-dependencies.test.ts src/browser/worker-client.test.ts`

Expected: PASS。

Run: `corepack pnpm --filter @resume/contracts exec vitest run src/browser.test.ts`

Expected: PASS，并且不存在招聘搜索 IPC 正向用例。

Run: `corepack pnpm --filter @resume/browser-worker exec vitest run src/ipc-server.test.ts src/session-manager.test.ts`

Expected: PASS。

Run: `rtk rg -n "search_recruitment_site|recruitment_site_found|buildRecruitmentSearchUrl|www\.baidu\.com/s" apps packages`

Expected: 无匹配。

- [ ] **Step 5: 提交 Task 4**

```bash
git add apps/api/src/production-dependencies.ts apps/api/src/production-dependencies.test.ts packages/contracts/src/browser.ts packages/contracts/src/browser.test.ts apps/api/src/browser/worker-client.ts apps/api/src/browser/worker-client.test.ts apps/api/src/browser/fixtures/activity-worker.ts apps/browser-worker/src/ipc-server.ts apps/browser-worker/src/ipc-server.test.ts apps/browser-worker/src/session-manager.ts apps/browser-worker/src/session-manager.test.ts apps/browser-worker/src/recruitment-site-discovery.ts apps/browser-worker/src/recruitment-site-discovery.test.ts
git commit -m "refactor: remove browser recruitment search"
```

---

### Task 5: 对话候选选择、Tavily 生产接线、确认门和手工链接恢复

**Files:**
- Modify: `packages/contracts/src/conversation.ts`
- Modify: `packages/contracts/src/conversation.test.ts`
- Modify: `apps/api/src/conversations/conversation-tools.ts`
- Modify: `apps/api/src/conversations/conversation-tools.test.ts`
- Modify: `apps/api/src/conversations/conversation-graph.ts`
- Modify: `apps/api/src/conversations/conversation-graph.test.ts`
- Modify: `apps/api/src/conversations/conversation-service.ts`
- Modify: `apps/api/src/conversations/conversation-service.test.ts`
- Modify: `apps/api/src/conversations/conversation-routes.ts`
- Modify: `apps/api/src/conversations/conversation-routes.test.ts`
- Modify: `apps/api/src/production-dependencies.ts`
- Modify: `apps/api/src/production-dependencies.test.ts`
- Modify: `apps/web/src/conversation/api.ts`
- Modify: `apps/web/src/conversation/ConversationCards.tsx`
- Modify: `apps/web/src/conversation/ConversationCards.test.tsx`
- Modify: `apps/web/src/conversation/ChatHome.tsx`
- Create: `apps/browser-worker/src/public-navigation-guard.ts`
- Create: `apps/browser-worker/src/public-navigation-guard.test.ts`
- Modify: `apps/browser-worker/src/session-manager.ts`
- Modify: `apps/browser-worker/src/session-manager.test.ts`

**Interfaces:**
- Consumes: `searchRecruitmentSites({ companyName, recruitmentType })`
- Produces: one `confirm_recruitment_site` confirmation whose target contains 1～3 candidates
- Produces: `confirm(conversationId, confirmationId, approved, selectedUrl?)`
- Produces: production `searchRecruitmentSites` backed by Tavily, with an injectable fake for tests
- Guarantees: `verifiedRecruitmentSite` is written only after approved selection

- [ ] **Step 1: 写候选组契约失败测试**

在 `packages/contracts/src/conversation.test.ts` 增加一个 `confirm_recruitment_site` confirmation，目标结构固定为：

```ts
const choices = {
  kind: "recruitment_site_choices" as const,
  company: "百度",
  recruitmentType: "campus" as const,
  query: "百度 校园招聘 招聘 官网",
  candidates: [
    { title: "百度人才", url: "https://talent.baidu.com/", domain: "talent.baidu.com", snippet: "校园招聘", source: "tavily" as const },
    { title: "百度招聘", url: "https://jobs.baidu.com/", domain: "jobs.baidu.com", snippet: "招聘", source: "tavily" as const }
  ]
};
expect(ConversationConfirmationSchema.parse({
  confirmationId: "confirmation-choices",
  action: "confirm_recruitment_site",
  target: choices
})).toMatchObject({ target: { candidates: expect.any(Array) } });
expect(ConversationConfirmInputSchema.parse({
  confirmationId: "confirmation-choices",
  approved: true,
  selectedUrl: "https://talent.baidu.com/"
})).toMatchObject({ selectedUrl: "https://talent.baidu.com/" });
```

同时断言：候选数组为空或超过 3 条失败；`selectedUrl` 使用 HTTP 失败；`request_job_recommendations` 仍只接受单个 `recruitment_site` target。

- [ ] **Step 2: 写 Graph 两阶段确认失败测试**

改写 `apps/api/src/conversations/conversation-graph.test.ts` 的招聘入口主测试：

```ts
expect(discovered.pendingConfirmation?.target.kind).toBe("recruitment_site_choices");
expect(discovered.pendingConfirmation?.target.candidates).toHaveLength(2);
expect(discovered.context.verifiedRecruitmentSite).toBeUndefined();
expect(create).not.toHaveBeenCalled();

const selectedUrl = "https://talent.baidu.com/";
const siteApproved = (await graph.invoke({
  conversationId: "conversation-recruitment",
  confirmationId: discovered.confirmationId,
  approved: true,
  selectedUrl,
  context: discovered.context
})).response;
expect(siteApproved.context.verifiedRecruitmentSite?.url).toBe(selectedUrl);
expect(siteApproved.pendingConfirmation?.action).toBe("request_job_recommendations");
expect(create).not.toHaveBeenCalled();
```

增加拒绝用例：`selectedUrl` 不在 pending candidate list 时返回 `recruitment_site_selection_invalid`；取消时不写 `verifiedRecruitmentSite`；第一次确认前 Browser Worker 和 `jobMatchService.create` 都未调用。

再增加意图用例，断言“帮我投递百度社会招聘”映射为 `social`，“帮我看看腾讯实习招聘”映射为 `internship`，没有明确类型的“查找大疆招聘官网”映射为 `unknown`；查询标签必须与 Task 3 的 `RECRUITMENT_LABELS` 一致。

- [ ] **Step 3: 写前端选择失败测试**

在 `apps/web/src/conversation/ConversationCards.test.tsx` 渲染一个 choices confirmation，选择第二个 radio 后点击“确认使用此入口”：

```ts
fireEvent.click(screen.getByRole("radio", { name: /jobs\.baidu\.com/u }));
fireEvent.click(screen.getByRole("button", { name: "确认使用此入口" }));
expect(onConfirm).toHaveBeenCalledWith(
  "confirmation-choices",
  true,
  "https://jobs.baidu.com/"
);
```

断言页面显示标题、域名、摘要和“搜索候选，需你确认”文案，不显示“官方入口”认证标签。

- [ ] **Step 4: 运行测试确认失败**

Run: `corepack pnpm --filter @resume/contracts exec vitest run src/conversation.test.ts`

Expected: FAIL，choices target 和 confirm input 尚不存在。

Run: `corepack pnpm --filter @resume/api exec vitest run src/conversations/conversation-graph.test.ts src/conversations/conversation-tools.test.ts`

Expected: FAIL，工具仍返回单入口且提前写入已验证上下文。

Run: `corepack pnpm --filter @resume/web exec vitest run src/conversation/ConversationCards.test.tsx`

Expected: FAIL，确认卡不能选择候选 URL。

- [ ] **Step 5: 修改对话契约与确认输入**

在 `packages/contracts/src/conversation.ts`：

```ts
export const RecruitmentSiteChoicesTargetSchema = z.object({
  kind: z.literal("recruitment_site_choices"),
  company: RecruitmentCompanySchema,
  recruitmentType: RecruitmentSearchTypeSchema,
  query: z.string().trim().min(1).max(200),
  candidates: z.array(RecruitmentSiteCandidateSchema).min(1).max(3)
}).strict();

export const ConversationConfirmInputSchema = z.object({
  confirmationId: IdentifierSchema,
  approved: z.boolean(),
  selectedUrl: z.string().url().max(2_048).refine((value) => new URL(value).protocol === "https:").optional()
}).strict();
```

`confirm_recruitment_site` 的 confirmation target 改为 `RecruitmentSiteChoicesTargetSchema`；`request_job_recommendations` 保持 `RecruitmentSiteTargetSchema`。`ConversationContextSchema.verifiedRecruitmentSite` 使用 `VerifiedRecruitmentSiteSchema`。

同时把 `ConversationTargetSchema` 的招聘类型从旧 Browser 专用 `RecruitmentTypeSchema` 迁移到 `RecruitmentSearchTypeSchema`，使 `campus`、`social`、`internship`、`unknown` 四种搜索意图都能通过对话契约。Browser IPC 已在 Task 4 删除，不能再从 `browser.ts` 导入招聘搜索类型。

完成迁移后从 `packages/contracts/src/browser.ts` 删除已无消费者的 `RecruitmentTypeSchema`、`RecruitmentSiteResultSchema` 及对应类型导出，并把仍需保留的招聘搜索契约全部从 `recruitment-search.ts` 导出。更新 `browser.test.ts`，确认 Browser contract 中不再存在招聘发现输入、结果或类型。

- [ ] **Step 6: 改造对话工具和 Graph**

`ConversationToolDependencies` 改为：

```ts
searchRecruitmentSites?: (
  input: RecruitmentSearchRequest
) => Promise<RecruitmentSiteSearchResult>;
```

`discoverRecruitmentSite` 不再生成 owner ID、浏览器 lease 或单入口卡，固定返回：

```ts
const search = RecruitmentSiteSearchResultSchema.parse(
  await dependencies.searchRecruitmentSites({
    companyName: input.company,
    recruitmentType: input.recruitmentType
  })
);
return { cards: [], recruitmentSearch: search };
```

当 `searchRecruitmentSites` 未注入时固定抛出 `TAVILY_NOT_CONFIGURED`，不再使用会误导为浏览器故障的 `recruitment_discovery_unavailable`。

`prepareRecruitmentDiscovery` 用搜索结果创建一个 choices confirmation。搜索后只能设置用于恢复的 `lastRecruitmentRequest: { company, recruitmentType }`，不得设置 `verifiedRecruitmentSite`。确认分支必须：

1. 当 `approved=false` 时清空已验证入口并结束；
2. 当 `approved=true` 时要求 `selectedUrl`；
3. 只接受与 pending candidates 中规范化 URL 完全相等的项；
4. 将所选 candidate 与 pending 的 company/recruitmentType/query 合成为 `VerifiedRecruitmentSite`；
5. 这时才写 `verifiedRecruitmentSite`，并创建现有 `request_job_recommendations` confirmation；
6. 第二次确认后才调用现有 `create_job_match_session`。

同时扩展确定性公司级意图提取：优先识别“校园招聘”“社会招聘/社招”“实习招聘/实习”，其余明确招聘官网请求使用 `unknown`。保持公司名的 80 字符和控制字符约束，不把整句或 URL 当成公司名。

错误文案固定为：

```ts
if (code === "TAVILY_NOT_CONFIGURED") return "联网搜索尚未配置。你可以配置 Tavily，或粘贴该公司的官方招聘链接。";
if (code === "TAVILY_TIMEOUT" || code === "TAVILY_UNAVAILABLE") return "招聘入口搜索暂时不可用。你可以稍后重试，或粘贴该公司的官方招聘链接。";
if (code === "TAVILY_PROTOCOL_ERROR" || code === "NO_SAFE_CANDIDATE") return "暂时没有找到可确认的招聘入口。请换一种公司名称，或粘贴官方招聘链接。";
if (code === "recruitment_site_selection_invalid") return "所选招聘入口已失效，请重新搜索并确认。";
```

- [ ] **Step 7: 接入 Tavily 生产搜索端口**

在 `ProductionAdapterDependencies` 增加：

```ts
recruitmentSiteSearch?: RecruitmentSiteSearchPort;
```

在 `createProductionDependencies` 中创建 `recruitmentSiteSearch`：

```ts
const recruitmentSiteSearch = adapters.recruitmentSiteSearch
  ?? (config.tavily === undefined ? undefined : createTavilyRecruitmentSiteSearch(config.tavily));
```

然后在现有 `createConversationGraph({ ... })` 参数对象末尾增加以下精确属性展开，不改动其他依赖：

```ts
...(recruitmentSiteSearch === undefined ? {} : {
  searchRecruitmentSites: (input: RecruitmentSearchRequest) => recruitmentSiteSearch.search(input)
})
```

在 `production-dependencies.test.ts` 增加 Tavily fake，断言公司级请求调用 `search({ companyName: "百度", recruitmentType: "campus" })`，返回 choices confirmation，且 `browserClientFactory` 仍为 0 次。另一个用例在 `config.tavily` 和 adapter 都缺失时断言用户收到 `TAVILY_NOT_CONFIGURED` 对应提示。

- [ ] **Step 8: 实现手工 HTTPS 链接恢复**

在 deterministic intent 前检测消息中的单个 HTTPS URL。只有 `context.lastRecruitmentRequest` 存在时才处理；否则询问公司名。调用同一个 `validatePublicHttpsUrl`，将安全链接转换为单候选 choices confirmation：

```ts
{
  title: `${lastRecruitmentRequest.company}招聘入口`,
  url: validated.url,
  domain: validated.domain,
  snippet: "用户提供的招聘链接，仍需确认后使用。",
  source: "user"
}
```

为此把候选 `source` schema 调整为 `z.enum(["tavily", "user"])`，但 Tavily 适配器仍只能产出 `source: "tavily"`。用户链接也必须经过 DNS 公网检查，不能因手工输入绕过 URL 安全规则。

- [ ] **Step 9: 透传 `selectedUrl` 并更新前端**

`conversation-routes.ts` 使用共享 `ConversationConfirmInputSchema`；Service 和 Graph input 增加可选 `selectedUrl`，幂等键加入规范化后的 selected URL 哈希或原值，避免同一 confirmation ID 选择不同 URL 被错误复用。

前端接口改为：

```ts
confirm(
  id: string,
  confirmationId: string,
  approved: boolean,
  selectedUrl?: string
): Promise<ConversationTurnResponse>;
```

`ConfirmationCard` 遇到 `recruitment_site_choices` 时用 radio list 展示候选，默认选中第一项，批准按钮调用 `onConfirm(confirmationId, true, selectedUrl)`；取消调用不带 URL。普通投递确认和岗位推荐确认保持原样。

- [ ] **Step 10: 对已确认入口启用逐跳公网导航保护**

给 Browser `open` request 增加可选 `navigationPolicy: z.enum(["default", "public_https"]).default("default")`。`BrowserWorkerClient` 增加：

```ts
async openPublic(taskId: string, url: string): Promise<OpenedPage> {
  const response = await this.request({ type: "open", taskId, url, navigationPolicy: "public_https" });
  if (response.type !== "opened") throw new Error(`浏览器 Worker 返回了意外响应：${response.type}`);
  return response;
}
```

生产 `jobBrowser.open` 使用 `openPublic`；现有 `applicationBrowser.open` 保持普通 `open`，避免改变已创建投递任务的恢复语义。IPC Server 把 policy 传给 Session Manager。

创建 `public-navigation-guard.ts`，在 `page.goto` 前安装 Playwright route。只检查 `request.isNavigationRequest()` 且 `request.resourceType()==="document"` 的请求；对初始 URL和每次 3xx 后的新 document request 调用与 API 等价的 HTTPS、凭据、裸 IP、DNS 公网地址规则，通过才 `route.continue()`，失败先 `route.abort("blockedbyclient")` 再抛 `unsafe_recruitment_redirect`。测试依赖可注入 DNS resolver；生产默认不得提供私网放行开关。

在 `public-navigation-guard.test.ts` 覆盖：公开初始 URL 放行；公开站 302 到 `https://10.0.0.2/` 在目标请求发出前被 abort；HTTP、localhost、凭据 URL 和混合公网/私网 DNS 答案被阻断。`session-manager.test.ts` 断言 `navigationPolicy="default"` 不安装 guard，`public_https` 在 `goto` 前安装并在任务释放时移除。

- [ ] **Step 11: 运行 Task 5 测试**

Run: `corepack pnpm --filter @resume/contracts exec vitest run src/conversation.test.ts`

Expected: PASS。

Run: `corepack pnpm --filter @resume/api exec vitest run src/conversations/conversation-tools.test.ts src/conversations/conversation-graph.test.ts src/conversations/conversation-service.test.ts src/conversations/conversation-routes.test.ts`

Expected: PASS。

Run: `corepack pnpm --filter @resume/api exec vitest run src/production-dependencies.test.ts`

Expected: PASS，Tavily fake 被调用且 Browser Worker factory 未调用。

Run: `corepack pnpm --filter @resume/api exec vitest run src/browser/worker-client.test.ts`

Expected: PASS，`openPublic` 只产生 `public_https` open request。

Run: `corepack pnpm --filter @resume/browser-worker exec vitest run src/public-navigation-guard.test.ts src/ipc-server.test.ts src/session-manager.test.ts`

Expected: PASS，私网重定向在网络请求发出前被阻断。

Run: `corepack pnpm --filter @resume/web exec vitest run src/conversation/ConversationCards.test.tsx`

Expected: PASS。

Run: `corepack pnpm --filter @resume/contracts typecheck && corepack pnpm --filter @resume/api typecheck && corepack pnpm --filter @resume/web typecheck`

Expected: PASS。

- [ ] **Step 12: 提交 Task 5**

```bash
git add packages/contracts/src/conversation.ts packages/contracts/src/conversation.test.ts packages/contracts/src/recruitment-search.ts packages/contracts/src/recruitment-search.test.ts packages/contracts/src/browser.ts packages/contracts/src/browser.test.ts apps/api/src/conversations/conversation-tools.ts apps/api/src/conversations/conversation-tools.test.ts apps/api/src/conversations/conversation-graph.ts apps/api/src/conversations/conversation-graph.test.ts apps/api/src/conversations/conversation-service.ts apps/api/src/conversations/conversation-service.test.ts apps/api/src/conversations/conversation-routes.ts apps/api/src/conversations/conversation-routes.test.ts apps/api/src/production-dependencies.ts apps/api/src/production-dependencies.test.ts apps/api/src/browser/worker-client.ts apps/api/src/browser/worker-client.test.ts apps/browser-worker/src/public-navigation-guard.ts apps/browser-worker/src/public-navigation-guard.test.ts apps/browser-worker/src/ipc-server.ts apps/browser-worker/src/ipc-server.test.ts apps/browser-worker/src/session-manager.ts apps/browser-worker/src/session-manager.test.ts apps/web/src/conversation/api.ts apps/web/src/conversation/ConversationCards.tsx apps/web/src/conversation/ConversationCards.test.tsx apps/web/src/conversation/ChatHome.tsx
git commit -m "feat: confirm Tavily recruitment candidates in chat"
```

---

### Task 6: MCP 集成测试、真实烟雾测试与中文回归报告

**Files:**
- Create: `apps/api/src/recruitment-search/tavily-remote-mcp.integration.test.ts`
- Create: `apps/api/src/recruitment-search/tavily-remote-mcp.smoke.test.ts`
- Modify: `apps/api/src/conversations/conversation-e2e.test.ts`
- Modify: `docs/testing/2026-08-22-chat-first-workspace-regression.md`

**Interfaces:**
- Verifies: actual MCP SDK `Client` + `StreamableHTTPClientTransport`
- Verifies: optional production endpoint `https://mcp.tavily.com/mcp/`
- Verifies: end-to-end user confirmation gates and no browser search fallback

- [ ] **Step 1: 写本地 Streamable HTTP MCP 集成测试**

用 `@modelcontextprotocol/sdk/server/mcp.js`、`StreamableHTTPServerTransport` 和 Node `http.createServer` 启动仅监听 `127.0.0.1` 的临时服务。注册唯一工具 `tavily-search`，记录收到的 arguments，并返回：

```ts
{
  content: [{
    type: "text",
    text: JSON.stringify({
      results: [{
        title: "百度校园招聘",
        url: "https://talent.baidu.com/",
        content: "校园招聘职位",
        score: 0.95
      }]
    })
  }]
}
```

测试调用真实 `createTavilyRecruitmentSiteSearch` 默认 MCP transport，只允许测试覆盖 Endpoint 和 DNS resolver。断言 initialize + `tools/call` 成功，参数完全等于固定参数，结果标准化正确，测试结束关闭 client/transport/server。另一个用例让服务超过 10 秒或注入 20 ms 测试 timeout，断言 `TAVILY_TIMEOUT` 且无 dangling handle。

- [ ] **Step 2: 运行本地集成测试并修复传输细节**

Run: `corepack pnpm --filter @resume/api exec vitest run src/recruitment-search/tavily-remote-mcp.integration.test.ts --testTimeout=15000`

Expected: PASS；不访问公网 Tavily。

- [ ] **Step 3: 增加显式启用的真实烟雾测试**

创建 `tavily-remote-mcp.smoke.test.ts`：

```ts
const apiKey = process.env.TAVILY_API_KEY;
const smoke = apiKey === undefined ? it.skip : it;

smoke("finds at least one safe Baidu campus recruitment candidate", async () => {
  const search = createTavilyRecruitmentSiteSearch({
    apiKey: apiKey!,
    endpoint: "https://mcp.tavily.com/mcp/",
    timeoutMs: 10_000,
    maxRetries: 1
  });
  const result = await search.search({ companyName: "百度", recruitmentType: "campus" });
  expect(result.candidates.length).toBeGreaterThan(0);
  expect(result.candidates.every((candidate) => candidate.url.startsWith("https://"))).toBe(true);
});
```

默认 CI 必须显示 SKIP；只有开发者显式提供 `TAVILY_API_KEY` 时才消耗额度。测试名称、异常和 console 输出不得包含 Key 或完整 MCP URL。

- [ ] **Step 4: 完成对话 E2E 回归**

在 `conversation-e2e.test.ts` 增加完整链路：

1. “帮我投递百度校园招聘”只调用 Tavily fake；
2. 返回两个候选且 `verifiedRecruitmentSite` 为空；
3. 选择候选并确认后才写已验证入口；
4. 第二次确认后才创建岗位匹配会话；
5. Tavily 失败时返回粘贴链接提示，Browser Worker spy 为 0 次；
6. 粘贴安全官方链接进入相同确认门；
7. 私网链接被拒绝；
8. 不产生企业招聘状态字段或查询。

Run: `corepack pnpm --filter @resume/api exec vitest run src/conversations/conversation-e2e.test.ts`

Expected: PASS。

- [ ] **Step 5: 运行完整回归**

Run: `corepack pnpm test`

Expected: 所有 workspace 测试 PASS；真实 Tavily smoke 默认 SKIP。

Run: `corepack pnpm typecheck`

Expected: PASS。

Run: `corepack pnpm build`

Expected: PASS。

Run: `rtk rg -n "tavilyApiKey=[^$]|TAVILY_API_KEY=.+|tvly-[A-Za-z0-9]" apps packages docs scripts -g "!**/node_modules/**" -g "!**/dist/**"`

Expected: 除测试中的明确假值和文档变量模板外无匹配；任何真实密钥匹配都必须先移除，再继续。

- [ ] **Step 6: 更新中文回归报告**

在 `docs/testing/2026-08-22-chat-first-workspace-regression.md` 增加“2026-08-24 Tavily Remote MCP 回归”章节，逐项记录：命令、通过/失败/跳过数量、真实烟雾测试是否执行、浏览器搜索残留扫描结果、密钥扫描结果。报告必须为中文；若存在失败，记录根因和是否阻断，不得把未运行写成通过。

- [ ] **Step 7: 提交 Task 6**

```bash
git add apps/api/src/recruitment-search/tavily-remote-mcp.integration.test.ts apps/api/src/recruitment-search/tavily-remote-mcp.smoke.test.ts apps/api/src/conversations/conversation-e2e.test.ts docs/testing/2026-08-22-chat-first-workspace-regression.md
git commit -m "test: verify Tavily recruitment search flow"
```

## Final Acceptance Check

- [ ] `git status --short` 中没有遗漏的 Tavily 实现文件。
- [ ] `git diff --check` 和 `git diff --cached --check` 无错误。
- [ ] `rtk rg -n "search_recruitment_site|recruitment_site_found|www\.baidu\.com/s" apps packages` 无匹配。
- [ ] 对话搜索响应中 `verifiedRecruitmentSite` 在用户确认前为空。
- [ ] Tavily 失败时 Browser Worker 未启动，界面提供重试或粘贴链接。
- [ ] 岗位匹配和受控投递全量测试通过，最终提交仍需人工确认。
- [ ] 没有实现企业招聘状态跟踪。
- [ ] 中文回归报告记录所有实际测试结果。
