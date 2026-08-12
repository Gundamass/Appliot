# 简历投递助手

一个面向个人使用的本地简历资料管理与投递辅助工具。

用户可以导入 PDF 简历，审核系统提取的结构化资料，并通过带有规划、检索、验证、追问和修正步骤的 RAG 工作流为招聘表单准备答案。受控浏览器负责填写招聘网站的中间页面，并在最终提交前锁定任务。

> 安全边界：自动化永远不能执行最终投递、确认申请或发送申请等终局操作。最终提交必须由用户在真实浏览器中亲自完成。

## 当前状态

目前已经完成基础阶段，包含本地 Web 界面、API 边界、PDF 处理流程、资料审核、RAG 决策和自我评价审核。

| 模块 | 状态 |
| --- | --- |
| React 本地 Web 界面 | 已实现，可单独启动 |
| PDF 原件本地留存 | 已实现 |
| PDF 文本解析与 OCR 接口 | 已实现，支持通过 SSH 隧道连接远程 GPU OCR Worker |
| 模型结构化提取接口 | 已实现，DeepSeek 与远程 Embedding 可由本地配置接入 |
| 资料确认、修正和版本记录 | 已实现 |
| RAG 规划、检索、验证、追问和修正 | 已实现 |
| 岗位相关自我评价审核 | 已实现 |
| 受控浏览器自动填写 | 已实现，包含页面观察、字段填写、回读验证和中间操作 |
| 最终投递 | 明确禁止自动执行 |

生产适配器由根目录 `.env.local` 配置。远程 OCR 与 Embedding 只监听服务器回环地址，本地通过受管 SSH 隧道访问，不直接暴露到局域网或公网。

## 环境要求

- Windows 10/11
- Node.js `24.14.1` 或更高版本
- Corepack
- pnpm `10.13.1`（由 `packageManager` 字段指定）

首次使用时，在项目根目录安装依赖：

```powershell
corepack pnpm install --frozen-lockfile
```

## 长期运行与登录自启

推荐使用统一服务控制脚本。它会管理远程 OCR/Embedding、本地 SSH 隧道、API、受控浏览器 Worker和生产前端。

首次安装前需要满足：

- `.env.local` 已配置 DeepSeek、OCR 与 Embedding 参数。
- 当前用户可以无交互 SSH 登录远程 GPU 服务器。
- 远程服务器已经部署 `resume-ai` 控制器和 Worker。
- 已执行 `corepack pnpm install --frozen-lockfile`。

首次安装：

```powershell
.\scripts\service-control.ps1 install `
  -SshHost "远程服务器地址" `
  -SshUser "远程用户名" `
  -SshPort 22 `
  -RemoteRoot "/home/远程用户名/resume-ai"
```

该命令会构建生产产物、把非秘密远程连接信息写入被 Git 忽略的 `.runtime/services/service-config.json`，并注册当前用户的 `Appliot Services` 登录任务。受控浏览器依赖桌面会话，因此是在 Windows 用户登录后自启，而不是在尚未登录时启动。

日常命令：

```powershell
.\scripts\service-control.ps1 status
.\scripts\service-control.ps1 start
.\scripts\service-control.ps1 stop
.\scripts\service-control.ps1 restart
.\scripts\service-control.ps1 logs
.\scripts\service-control.ps1 uninstall
```

`stop` 会停止前端、API、浏览器 Worker、SSH 隧道和远程 OCR/Embedding。`uninstall` 还会删除登录任务，但不会删除数据库、候选人档案、模型、配置或日志。

守护器会检查进程存活和功能健康。API、前端或隧道退出后按退避策略恢复；远程 Worker 连续异常时先检查远程控制器，再执行受控重启。模型冷启动期间显示为启动中，不会反复重启。

状态和日志位于：

```text
.runtime/services/runtime-state.json
.runtime/services/logs/
```

日志会轮转且不记录 `.env.local` 内容、Authorization Token、SSH 私钥或请求正文。

## 开发模式

### 启动前端

在项目根目录运行：

```powershell
corepack pnpm --filter @resume/web dev --host 127.0.0.1
```

然后访问：

```text
http://127.0.0.1:5173
```

前端开发服务器会把 `/api` 请求转发到本机 API：

```text
http://127.0.0.1:43120
```

如果只启动前端，可以浏览界面，但涉及服务端的操作会提示请求失败。

### 启动 API

构建 API：

```powershell
corepack pnpm --filter @resume/api build
```

尝试启动 API：

```powershell
corepack pnpm --filter @resume/api start
```

如果必需适配器配置不完整，启动命令会按设计退出，并显示：

```text
Local PDF and fact extraction dependencies must be configured before starting the API
```

## 长期运行故障排查

- `status` 显示 SSH 隧道异常：检查网络、SSH Agent 和无交互登录；守护器会自动重连。
- OCR 或 Embedding 长时间启动中：首次加载 GPU 模型可能需要较长时间，可通过 `logs` 查看远程控制日志。
- API 启动失败：确认本机 Node.js 至少为 `24.14.1`，并检查 `.env.local` 和 `api.stderr.log`。
- 前端端口不可用：检查 `5173` 是否被非 Appliot 进程占用；守护器不会盲目终止未知进程。
- 执行 `stop` 后仍有异常：再次运行 `status`。控制脚本会在守护器已退出但仍有受管资源时启动一次清理流程。

API 完成配置后只监听回环地址 `127.0.0.1:43120`，不会默认暴露到局域网或公网。

## 已实现流程

### PDF 简历导入

1. 计算上传文件的 SHA-256 指纹。
2. 在解析前检查是否已经成功导入过相同文件。
3. 将 PDF 原件持久保存在本机。
4. 按页提取 PDF 文本，对图片页使用 OCR 回退。
5. 通过模型边界提取带页码和原文证据的结构化事实。
6. 将事实标记为“待确认”，不会直接用于自动填写。

即使解析、OCR 或模型提取失败，原始 PDF 仍会保留，并允许之后重试。

### 资料审核

- 查看按类别整理的简历资料。
- 查看每项资料对应的 PDF 页码和原文证据。
- 明确确认提取结果。
- 修正错误内容并保留版本记录。
- 未经确认的提取结果不能进入自动填写状态。

### RAG 工作流

每个招聘字段的处理包含以下可见步骤：

1. 规划需要查询的资料来源和验证规则。
2. 优先检索当前投递任务的回答，再检索长期个人资料。
3. 检查证据覆盖、字段类型、选项和日期等约束。
4. 资料不足或存在冲突时向用户追问。
5. 将用户答案保存为当前任务的专属回答。
6. 只有用户明确操作时，才将任务回答推广到长期个人资料。

任务专属回答默认不会泄漏到其他投递任务。

### 字段匹配与人工审核

- 已知招聘字段优先使用字段目录和精确语义路径匹配。
- 确定性规则未覆盖的空字段才进入语义检索，低置信度结果不会自动填写。
- 任务工作台显示已填写、待审核、缺少资料和暂不支持的字段统计，并可展开查看匹配原因与支持证据。
- 用户补充的答案默认只用于当前投递；只有用户明确勾选时，才会保存到长期候选人档案。
- 系统只执行填写、校验和合理的中间操作，不会点击“提交申请”“发送申请”等终局操作。

### 自我评价微调

- 保存岗位描述作为当前任务的来源信息。
- 基于原始自我评价和已有证据生成岗位微调稿。
- 同时显示原文、微调稿、调整原因和支持证据。
- 用户可以采用微调稿、编辑后采用，或继续使用原文。
- 批准结果默认只属于当前任务。
- 推广到长期资料是批准之后的独立操作。

系统不会静默采用或推广生成内容。

## 测试与构建

运行全部测试：

```powershell
corepack pnpm test
```

运行类型检查：

```powershell
corepack pnpm typecheck
```

构建全部包：

```powershell
corepack pnpm build
```

自动化测试覆盖资料作用域隔离、PDF 导入与重试、RAG 决策、字段匹配、自我评价审核、受控浏览器填写和 API 构建产物启动等行为。

## 项目结构

```text
apps/
  api/                  Fastify 本地 API、SQLite 持久化和业务路由
  web/                  React + Vite 本地 Web 界面

packages/
  contracts/            共享 TypeScript 类型和 Zod 运行时契约
  model-provider/       可替换的模型提供商接口
  profile-domain/       PDF、OCR 和结构化资料提取领域逻辑
  rag/                  规划、检索、验证、追问、修正和自我评价逻辑

docs/superpowers/
  specs/                已确认的整体设计规格
  plans/                分阶段实施计划

tests/fixtures/         测试用 PDF 生成工具
```

## 数据与隐私

- 项目按单用户、本地优先方式设计。
- 简历原件、结构化资料和任务回答保存在本机。
- API 仅监听回环地址。
- Web 不读取招聘网站 Cookie，也不保存招聘网站密码。
- 登录、验证码、扫码和多因素认证必须由用户手动完成。
- 系统不能生成没有证据支持的经历、技能、证书或资格。

## 受控浏览器流程

当前独立受控浏览器服务包括：

- 启动或连接持久化 Chromium 会话。
- 由用户手动完成招聘网站登录和验证。
- 识别标准招聘表单及常见 ATS 组件。
- 自动填写普通字段并回读验证。
- 自动执行合理的中间保存和下一步操作。
- 到达最终投递页面后进入锁定状态。
- 从工具权限层彻底禁止自动点击最终提交。

详细设计和实施计划见：

- [`docs/superpowers/specs/2026-07-22-resume-application-assistant-design.md`](docs/superpowers/specs/2026-07-22-resume-application-assistant-design.md)
- [`docs/superpowers/plans/2026-07-22-controlled-browser-automation.md`](docs/superpowers/plans/2026-07-22-controlled-browser-automation.md)
- [`docs/superpowers/plans/2026-07-22-resume-assistant-integration.md`](docs/superpowers/plans/2026-07-22-resume-assistant-integration.md)
