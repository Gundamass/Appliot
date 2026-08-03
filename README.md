# 简历投递助手

一个面向个人使用的本地简历资料管理与投递辅助工具。

用户可以导入 PDF 简历，审核系统提取的结构化资料，并通过带有规划、检索、验证、追问和修正步骤的 RAG 工作流为招聘表单准备答案。项目后续将接入受控浏览器自动化，用于填写招聘网站的中间页面。

> 安全边界：自动化永远不能执行最终投递、确认申请或发送申请等终局操作。最终提交必须由用户在真实浏览器中亲自完成。

## 当前状态

目前已经完成基础阶段，包含本地 Web 界面、API 边界、PDF 处理流程、资料审核、RAG 决策和自我评价审核。

| 模块 | 状态 |
| --- | --- |
| React 本地 Web 界面 | 已实现，可单独启动 |
| PDF 原件本地留存 | 已实现 |
| PDF 文本解析与 OCR 接口 | 已实现，生产 OCR 适配器尚未配置 |
| 模型结构化提取接口 | 已实现，生产模型适配器尚未配置 |
| 资料确认、修正和版本记录 | 已实现 |
| RAG 规划、检索、验证、追问和修正 | 已实现 |
| 岗位相关自我评价审核 | 已实现 |
| 受控浏览器自动填写 | 尚未实现 |
| 最终投递 | 明确禁止自动执行 |

由于真实 OCR 和模型适配器尚未接入，当前 API 会在监听端口前主动停止，并显示清晰的配置提示。这是预期的安全保护，不是模块加载故障。因此目前可以查看和操作前端界面，但上传解析、自我评价生成等依赖 API 的完整流程暂时不可用。

## 环境要求

- Windows 10/11
- Node.js `24.14.1` 或更高版本
- Corepack
- pnpm `10.13.1`（由 `packageManager` 字段指定）

首次使用时，在项目根目录安装依赖：

```powershell
corepack pnpm install --frozen-lockfile
```

## 启动前端

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

## API 状态

构建 API：

```powershell
corepack pnpm --filter @resume/api build
```

尝试启动 API：

```powershell
corepack pnpm --filter @resume/api start
```

在生产 OCR 和模型提取适配器配置完成前，启动命令会按设计退出，并显示：

```text
Local PDF and fact extraction dependencies must be configured before starting the API
```

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

当前基础阶段共有 337 项自动化测试，覆盖资料作用域隔离、PDF 导入与重试、RAG 决策、自我评价审核以及 API 构建产物启动等行为。

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

## 后续计划

下一阶段将实现独立的受控浏览器服务，主要包括：

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
