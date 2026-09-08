# 岗位投递助手

一个面向个人使用的本地优先求职工作台。用户从对话开始说明目标公司或岗位，系统在用户确认的前提下发现校招官网、推荐匹配岗位，并通过受控浏览器协助完成招聘表单的中间填写和回读验证。

> 安全边界：系统不会点击“提交申请”“确认投递”“发送申请”等最终操作。登录、验证码、扫码、多因素认证和最终投递始终由用户在真实浏览器中完成。

> 当前的“投递进度”展示本地受控投递任务及对应招聘网站，不实现企业招聘结果、面试进度或 Offer 状态跟踪。

## 实际界面

以下截图来自本地运行的真实界面，使用中性示例数据采集，未展示个人简历内容。

### 对话优先工作台

![对话首页与快速开始入口](docs/images/chat-home-quick-start.png)

首页将岗位推荐和投递进度融入对话。刷新页面后会从 URL 和本地最近会话记录恢复对话上下文。

### 公司名到校招官网候选

![百度招聘入口候选与用户确认](docs/images/recruitment-entry-confirmation.png)

输入“百度”后，后端通过 Tavily Remote MCP 搜索招聘入口候选；用户先选择可信的官网入口，系统才会继续询问是否进行岗位推荐。

## 核心流程

1. 在对话中输入“帮我投递百度”或从“岗位推荐”快速入口填写目标公司。
2. 系统搜索该公司的招聘入口候选，明确展示域名、标题和摘要。
3. 用户确认要使用的官网入口后，系统询问是否开始岗位推荐。
4. 用户确认后，系统根据已确认的简历资料和求职偏好进行岗位提取、匹配和证据展示。
5. 用户选择岗位后才创建受控投递任务；受控浏览器可填写普通字段、回读校验并在需要登录、补充资料或内容审核时暂停。
6. 到达最终提交前，任务锁定为人工审核，用户自行完成真实网站上的最终投递。

## 已实现能力

| 能力 | 说明 |
| --- | --- |
| 对话式工作台 | 蓝白风格的对话首页，包含岗位推荐、投递进度和简历资料三个入口。 |
| 会话恢复 | URL `conversation` 参数和本地最近会话记录共同恢复刷新后的上下文；服务端错误不会误建新会话。 |
| 官网发现 | 通过 Tavily Remote MCP 搜索公司校招/招聘官网候选，用户确认后才进入下一步。 |
| 岗位匹配 | 提取岗位信息，结合候选人资料与求职偏好生成可核查的匹配结果、证据和缺口。 |
| 受控投递 | 受控浏览器支持页面观察、字段填写、回读验证和合理的中间操作；不允许最终提交。 |
| 人工审核 | 登录、验证码、资料缺失、内容微调和最终提交均可暂停到用户处理。 |
| 简历资料库 | PDF 原件本地留存、文本/OCR 提取、结构化资料审核、修正和版本记录。 |
| RAG 辅助 | 针对招聘字段进行规划、检索、验证、追问和修正；任务回答默认不泄漏到其他投递。 |
| 本地运行 | API 仅监听回环地址；可通过 SSH 隧道使用远程 OCR 与 Embedding 服务。 |

## 快速启动

### 首次安装

环境要求：Windows 10/11、Node.js `>=24.14.1`、Corepack。项目固定使用 pnpm `10.13.1`。

```powershell
corepack pnpm install --frozen-lockfile
```

在根目录创建并维护被 Git 忽略的 `.env.local`。要启用公司招聘官网搜索，至少配置：

```text
TAVILY_API_KEY=<你的 Tavily API Key>
```

可选配置项：

```text
TAVILY_MCP_ENDPOINT=https://mcp.tavily.com/mcp/
TAVILY_MCP_TIMEOUT_MS=10000
```

`TAVILY_API_KEY` 只在 API 进程内使用，不进入前端构建产物、数据库、审计事件或日志。

### 一键启动全部服务

首次使用远程 OCR/Embedding 时，先按实际服务器信息安装服务控制器：

```powershell
.\scripts\service-control.ps1 install `
  -SshHost "远程服务器地址" `
  -SshUser "远程用户名" `
  -SshPort 22 `
  -RemoteRoot "/home/远程用户名/resume-ai"
```

日常启动、查看状态和停止：

```powershell
corepack pnpm services:start
corepack pnpm services:status
corepack pnpm services:stop
```

已完成上述安装后，`services:start` 会受管启动前端、API、浏览器 Worker、本地 SSH 隧道及远程 OCR/Embedding 服务。受控浏览器依赖 Windows 桌面会话，因此在用户登录后运行。

更多运维操作可直接使用服务控制脚本：

```powershell
.\scripts\service-control.ps1 restart
.\scripts\service-control.ps1 logs
.\scripts\service-control.ps1 uninstall
```

`uninstall` 只移除登录任务，不会删除本地数据库、候选人资料、模型、配置或日志。

前端默认地址为 [http://127.0.0.1:5173](http://127.0.0.1:5173)，API 默认监听 `http://127.0.0.1:43120`。

### 开发模式

也可以分别启动开发服务：

```powershell
corepack pnpm --filter @resume/web dev --host 127.0.0.1
corepack pnpm --filter @resume/api start
```

仅启动前端时可以查看界面；简历解析、官网搜索、岗位匹配和投递操作需要 API 与相应适配器可用。

## 测试与构建

```powershell
# 全部单元与集成测试
corepack pnpm test

# TypeScript 类型检查
corepack pnpm typecheck

# 构建全部工作区包
corepack pnpm build

# Playwright 端到端测试
corepack pnpm test:e2e
```

测试覆盖会话恢复、官网候选确认、Tavily Remote MCP 协议边界、岗位匹配、资料作用域隔离、PDF/OCR、RAG 决策、受控浏览器填写和最终提交限制。

## 项目结构

```text
apps/
  api/                  Fastify 本地 API、SQLite 持久化、对话与投递编排
  web/                  React + Vite 对话优先工作台

packages/
  contracts/            共享 TypeScript 类型与 Zod 契约
  model-provider/       模型与远程 Embedding 提供商接口
  profile-domain/       PDF、OCR、结构化资料提取与审核领域逻辑
  rag/                  规划、检索、验证、追问、修正与自我评价逻辑

docs/images/            README 使用的真实本地功能截图
docs/superpowers/       已确认的设计与实施计划
```

## 数据与安全

- 项目按单用户、本地优先方式设计；简历原件、结构化资料和任务回答保存于本机。
- API 默认只监听 `127.0.0.1`，远程 OCR 与 Embedding 通过受管 SSH 隧道访问。
- 系统不读取招聘网站 Cookie，不保存招聘网站密码。
- 所有生成内容都必须有资料证据支持；资料不足或存在冲突时会追问或暂停。
- 用户补充的任务回答默认只作用于当前投递，推广到长期资料需要独立确认。
- 联网招聘搜索只返回候选；打开官网、开始岗位推荐、创建投递任务和最终提交均由用户显式确认。

## 相关文档

- [Agent Runtime 架构说明](docs/architecture/agent-runtime.md)
- [Agent Runtime、Supervisor 与意图理解实施计划](docs/superpowers/plans/2026-09-02-agent-runtime-supervisor-intent-plan.md)
- [Agent Runtime、Supervisor 与意图理解设计](docs/superpowers/specs/2026-09-02-agent-runtime-supervisor-intent-design.md)
- [Chat-first 工作台实施计划](docs/superpowers/plans/2026-08-22-chat-first-workspace.md)
- [Tavily Remote MCP 招聘入口搜索实施计划](docs/superpowers/plans/2026-08-24-tavily-remote-mcp-recruitment-search.md)
- [Tavily Remote MCP 设计](docs/superpowers/specs/2026-08-24-tavily-remote-mcp-recruitment-search-design.md)
- [受控浏览器自动化计划](docs/superpowers/plans/2026-07-22-controlled-browser-automation.md)
