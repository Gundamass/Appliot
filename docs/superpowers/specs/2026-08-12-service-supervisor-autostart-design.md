# Appliot 全服务守护与登录自启设计

## 目标

为 Appliot 提供一套不依赖管理员权限的长期运行方案。Windows 用户登录后，系统自动恢复远程 OCR/Embedding、本地 SSH 隧道、API、受控浏览器 Worker 与前端；任一受管进程异常退出后能够自动恢复，同时保留明确的手动停止、重启、状态查询、日志查看和卸载入口。

## 约束与边界

- Windows 侧不要求管理员权限，使用当前用户的任务计划程序登录触发器。
- 受控浏览器依赖交互式桌面会话，因此自启时点是“用户登录后”，不是“系统尚未登录时”。
- OCR 与 Embedding 运行在远程 Ubuntu GPU 服务器，由本地守护器通过无密码 SSH 检查和控制。
- `stop` 会停止本地全部服务，并同步停止远程 OCR 与 Embedding Worker。
- `.env.local`、API Token、SSH 私钥和候选人数据不得写入日志、状态文件、计划任务参数或 Git。
- 远程主机、用户、端口与安装根目录属于本机运维配置，不硬编码进版本库。
- 守护器不负责提交招聘申请，也不改变现有投递审核边界。

## 方案选择

采用“单一 PowerShell 守护器 + 用户级任务计划程序”。

任务计划程序只负责在用户登录后隐藏启动守护器。守护器负责依赖排序、进程所有权、健康检查、自动恢复、状态持久化和优雅关闭。

未采用以下方案：

- 每个服务单独注册计划任务：依赖顺序和统一关闭难以保证。
- NSSM、WinSW 或 PM2：引入额外安装依赖，部分方式需要管理员权限，且不适合管理交互式受控浏览器。

## 管理接口

提供统一入口 `scripts/service-control.ps1`：

```powershell
.\scripts\service-control.ps1 install
.\scripts\service-control.ps1 start
.\scripts\service-control.ps1 stop
.\scripts\service-control.ps1 restart
.\scripts\service-control.ps1 status
.\scripts\service-control.ps1 logs
.\scripts\service-control.ps1 uninstall
```

- `install`：校验配置和依赖、构建生产产物、注册当前用户的登录任务，并可立即启动。
- `start`：启动唯一守护器；已经运行时保持幂等。
- `stop`：写入期望停止状态，阻止自动拉起，然后按依赖逆序关闭本地与远程服务。
- `restart`：完成一次完整停止后重新启动。
- `status`：展示各服务当前状态、最后成功时间、重启次数、重试倒计时和简短错误。
- `logs`：列出日志位置，可按服务查看最新日志。
- `uninstall`：停止全部服务并删除登录任务，不删除数据库、档案、模型、配置或日志。

## 配置

新增不入库的本地配置文件，例如 `.runtime/services/service-config.json`。首次 `install` 可从命令行参数生成，后续由控制脚本读取。配置仅保存非秘密信息：

```json
{
  "sshHost": "gpu-host.example.invalid",
  "sshUser": "resume-user",
  "sshPort": 22,
  "remoteRoot": "/home/resume-user/resume-ai"
}
```

以上值只说明文件结构，`install` 时必须写入本机实际配置。

秘密仍由现有机制管理：

- DeepSeek 与本地适配器 Token 保留在 `.env.local`。
- SSH 认证使用用户现有 SSH Agent 或私钥配置，脚本不读取或复制私钥。
- 远程 Worker Token 保留在远程权限为 `0600` 的 token 文件中。

`install` 必须验证：Node/Corepack/pnpm、PowerShell、OpenSSH、无交互 SSH、项目依赖、`.env.local`、远程控制脚本和本地端口可用性。

## 启动流程

守护器按以下顺序执行：

1. 获取单实例锁并写入守护器 PID。
2. 清除旧的停止标记，载入本地配置但不输出秘密。
3. 通过 SSH 执行远程 `start-all.sh`。
4. 等待远程 OCR 与 Embedding 进入预热或就绪状态。
5. 启动带 SSH 保活参数的本地端口转发。
6. 等待本地 `18080` 与 `43121` 可访问。
7. 启动生产 API；API 内部继续负责创建受控浏览器 Worker。
8. 等待 `/api/health/adapters` 可访问。
9. 启动生产前端静态服务并等待根页面可访问。
10. 进入健康检查循环。

远程模型允许较长冷启动时间。预热期间状态为 `starting`，不重复执行远程重启。

## 前端运行方式

长期运行不使用 Vite 开发服务器。`install` 或显式构建先生成 `apps/web/dist`，守护器使用仓库内受控的静态服务器脚本监听 `127.0.0.1:5173`，并保持现有 API 代理行为。生产 API 使用已构建的 `apps/api/dist/server.js`。

这样避免文件监听器、热更新连接和开发服务器重载成为长期运行故障源。

## 健康检查

守护器同时检查进程存活与功能健康，不能仅凭 PID 判断：

| 服务 | 存活检查 | 功能检查 |
| --- | --- | --- |
| 守护器 | 单实例锁与 PID 身份 | 健康循环时间戳持续更新 |
| 远程 OCR | 远程控制器状态 | 隧道后的 OCR `/readyz` |
| 远程 Embedding | 远程控制器状态 | 隧道后的 Embedding `/readyz` |
| SSH 隧道 | 受管 SSH PID | 本地转发端口可连接 |
| API/浏览器 Worker | 受管 Node PID | `/api/health/adapters` 返回合法响应 |
| 前端 | 受管静态服务器 PID | `http://127.0.0.1:5173/` 返回成功 |

API 健康响应用于展示 OCR 与 Embedding 的最终适配器状态。DeepSeek 的 `configured` 状态不触发付费探测。

## 自动恢复

- API 或前端意外退出：等待 2 秒后重启；连续失败使用 `2、5、10、30、60` 秒退避，之后保持 60 秒上限。
- SSH 隧道断开：立即进入重连；使用 `ServerAliveInterval`、`ServerAliveCountMax`、`ExitOnForwardFailure` 和批处理模式避免假连接或交互式挂起。
- 隧道恢复后：重新检查远程 Worker 和 API 适配器状态。
- OCR 或 Embedding 连续三次健康检查失败：先查询远程控制器；确认进程异常后才执行远程重启。
- 模型处于预热窗口时不计入连续失败，不反复加载模型。
- API 连续失败时只重启 API，由 API 重新创建浏览器 Worker。
- Windows 休眠、网络切换或远程服务器短暂不可达时，守护器保留运行并按退避策略恢复依赖链。
- 用户执行 `stop` 后，停止标记优先于任何恢复逻辑。

## 停止流程

1. 写入期望停止标记。
2. 通知守护器退出健康循环。
3. 优雅停止前端静态服务器。
4. 向 API 发送终止信号，等待 API 关闭受控浏览器 Worker和数据库连接。
5. 停止 SSH 隧道。
6. 通过 SSH 执行远程 `stop-all.sh`。
7. 清理仅属于本次守护实例的 PID 和锁文件，保留日志与状态摘要。

停止操作只终止状态文件记录且命令行身份匹配的进程，不按端口或进程名批量杀进程。

## 状态与日志

`status` 默认输出六项摘要：

```text
Appliot 守护器       运行中
远程 OCR             就绪
远程 Embedding       就绪
SSH 隧道             已连接
API / 浏览器 Worker  就绪
前端                  就绪
```

异常项追加最后成功时间、重启次数、重试倒计时、简短失败原因和日志位置。

运行文件位于 `.runtime/services/`：

```text
service-config.json
desired-state.json
runtime-state.json
supervisor.lock
logs/supervisor.log
logs/tunnel.log
logs/api.log
logs/web.log
logs/remote.log
```

日志单文件上限 10 MiB，保留 5 份。日志写入前过滤 Token、Authorization 头、环境变量值、请求正文和私钥路径。状态文件只保存 PID、时间戳、计数器、状态码和脱敏错误摘要。

## 计划任务

计划任务名称为 `Appliot Services`，作用域为当前用户：

- 触发器：当前用户登录。
- 动作：隐藏运行 PowerShell 守护入口。
- 多实例策略：已有实例运行时不创建新实例。
- 不设置运行时长上限。
- 不因使用电池而强制停止。
- 任务参数不包含远程地址、Token 或 SSH 私钥路径。

守护器内部单实例锁是第二层防重复保护。

## 测试策略

- PowerShell 单元测试：配置解析、参数校验、状态转换、退避计算、PID 身份校验、日志脱敏与轮转。
- 进程集成测试：使用轻量假服务验证启动顺序、异常重启、停止标记和无重复实例。
- SSH 命令测试：验证参数数组、安全主机校验、批处理与保活参数，不使用表达式执行。
- 远程控制测试：使用假 SSH 可执行文件验证 start/status/stop 调用顺序，不访问真实服务器。
- 本机冒烟测试：安装计划任务、立即启动、验证六项状态、停止、再次启动、卸载。
- 真实链路测试：连接现有远程服务器，确认 OCR/Embedding 就绪、API 适配器就绪、前端可访问，并模拟一次隧道重连。

## 验收标准

- 用户登录后，无需手动命令即可访问 `http://127.0.0.1:5173/`。
- OCR、Embedding、SSH 隧道、API、浏览器 Worker和前端均有可区分状态。
- 杀死任一本地受管进程后，服务能在退避窗口内恢复。
- 网络短暂中断恢复后，隧道和适配器自动恢复。
- `stop` 后至少经过两个健康检查周期，任何服务都不会被自动拉起，远程 Worker处于停止状态。
- `start`、`stop`、`restart`、`install` 与 `uninstall` 均幂等。
- 计划任务、日志、状态文件和 Git 中不出现 Token、私钥、候选人数据或 `.env.local` 内容。
- 服务连续运行 24 小时后日志体积受限，状态仍可查询，数据库与候选人档案保持完整。
