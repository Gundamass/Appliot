# Appliot 全服务守护与登录自启实施计划

> **执行方式：** 在当前本地会话中按任务顺序执行，使用 TDD，小步提交；不创建工作树，不派发子任务。

**目标：** 实现用户登录后自动启动远程 OCR/Embedding、本地 SSH 隧道、API/浏览器 Worker和前端，并提供可靠的启动、停止、重启、状态、日志和卸载命令。

**架构：** 使用用户级 Windows 任务计划程序唤醒一个 PowerShell 守护器。守护器维护单实例锁、期望状态、受管 PID、健康状态和退避计数；通过 SSH 控制远程 Worker，通过本地功能探针判断隧道、API 和前端是否真正可用。前端长期运行使用仓库内 Node 静态服务器，不使用 Vite 开发服务器。

**技术栈：** PowerShell 5.1+、Windows Task Scheduler、OpenSSH、Node.js HTTP、现有 Fastify API、远程 Python deployment controller、Supervisor/systemd user services。

**设计依据：** `docs/superpowers/specs/2026-08-12-service-supervisor-autostart-design.md`

**保护约束：**

- 不修改或提交 `.superpowers/sdd/*` 用户改动和 `.runtime/`。
- 不提交 `.env.local`、真实远程地址、SSH 私钥、Token、候选人数据或浏览器会话。
- 所有手写代码修改使用 `apply_patch`。
- 所有 shell 命令使用 `rtk` 前缀。
- 真实安装前先完成假进程与假 SSH 集成测试。

---

### Task 1: 建立守护器状态模型、配置校验和日志基础设施

**Files:**
- Create: `scripts/service-supervisor.psm1`
- Create: `scripts/service-supervisor.test.ps1`

**Interfaces:**
- `Read-ServiceConfig -Path [string]`：严格读取 `sshHost`、`sshUser`、`sshPort`、`remoteRoot`。
- `Get-RetryDelaySeconds -FailureCount [int]`：返回 `2, 5, 10, 30, 60` 秒退避。
- `Protect-LogText -Text [string] -SecretValues [string[]]`：过滤 Authorization、Token 和显式秘密值。
- `Rotate-ServiceLog -Path [string] -MaxBytes [long] -Backups [int]`：按大小轮转。
- `Read-RuntimeState` / `Write-RuntimeState`：原子读写 JSON 状态。
- `Test-OwnedProcess -ProcessId [int] -ExpectedCommandFragment [string]`：验证 PID 与命令身份。

- [ ] **Step 1: 写失败测试**

测试以下行为：

- 缺字段、额外字段、危险 SSH 主机/用户名、越界端口、非绝对远程根目录均被拒绝。
- 退避序列严格为 `2、5、10、30、60、60`。
- 日志过滤 Bearer Token、环境变量式 Token 和传入的秘密值。
- 轮转保留 `.1` 到 `.5`，不越界增长。
- 连续写入超过 100 MiB 的测试日志后，当前文件和五份备份总量仍受上限约束。
- 状态文件使用临时文件替换，不留下半写入 JSON。
- PID 不存在或命令不匹配时不得视为受管进程。

- [ ] **Step 2: 运行测试并确认失败**

Run: `rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/service-supervisor.test.ps1`

Expected: 因模块或导出函数不存在而失败。

- [ ] **Step 3: 实现最小状态与日志模块**

状态文件至少包含：

```json
{
  "schemaVersion": 1,
  "desiredState": "running",
  "supervisorPid": 0,
  "updatedAt": "2026-08-12T00:00:00.000Z",
  "services": {
    "remoteOcr": { "state": "stopped", "restartCount": 0 },
    "remoteEmbedding": { "state": "stopped", "restartCount": 0 },
    "tunnel": { "state": "stopped", "restartCount": 0 },
    "api": { "state": "stopped", "restartCount": 0 },
    "web": { "state": "stopped", "restartCount": 0 }
  }
}
```

所有 JSON 读取使用 `ConvertFrom-Json` 后逐字段校验，不接受任意对象透传；日志轮转与状态写入限制在已解析的 `.runtime/services` 根目录内。

- [ ] **Step 4: 运行测试并确认通过**

Run: `rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/service-supervisor.test.ps1`

Expected: `All service supervisor PowerShell tests passed.`

- [ ] **Step 5: 提交**

```powershell
rtk git add scripts/service-supervisor.psm1 scripts/service-supervisor.test.ps1
rtk git commit -m "feat: add service supervisor state primitives"
```

---

### Task 2: 增强 SSH 隧道和远程 Worker 控制

**Files:**
- Modify: `scripts/local-launch.psm1`
- Modify: `scripts/open-model-tunnel.test.ps1`
- Modify: `scripts/open-model-tunnel.ps1`
- Modify: `scripts/service-supervisor.psm1`
- Modify: `scripts/service-supervisor.test.ps1`

**Interfaces:**
- `Get-ModelTunnelSshArguments` 增加批处理、连接超时、转发失败退出和 SSH 保活参数。
- `Get-RemoteControlSshArguments -Config <config> -Command start|status|stop` 返回分离参数数组。
- `Invoke-RemoteWorkerCommand` 只执行固定白名单脚本 `start-all.sh`、`status.sh`、`stop-all.sh`。

- [ ] **Step 1: 写 SSH 参数失败测试**

断言隧道参数包含：

```text
-N
-o BatchMode=yes
-o ConnectTimeout=8
-o ExitOnForwardFailure=yes
-o ServerAliveInterval=15
-o ServerAliveCountMax=3
-L 18080:127.0.0.1:18080
-L 43121:127.0.0.1:43121
```

远程控制参数必须使用固定命令路径和单独参数，不允许 `Invoke-Expression`、用户拼接 shell 片段或非白名单命令。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/open-model-tunnel.test.ps1
rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/service-supervisor.test.ps1
```

Expected: 新增保活参数和远程命令函数断言失败。

- [ ] **Step 3: 实现安全 SSH 参数与远程控制**

保留现有主机/用户/IP 校验。远程命令路径由已验证的 `remoteRoot` 组合为 `<remoteRoot>/services/bin/<command>.sh`，并作为 SSH 的单个远程命令参数传入。错误输出先脱敏，再写入 `remote.log`。

- [ ] **Step 4: 运行测试并确认通过**

Run:

```powershell
rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/open-model-tunnel.test.ps1
rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/service-supervisor.test.ps1
```

Expected: 两套 PowerShell 测试全部通过。

- [ ] **Step 5: 提交**

```powershell
rtk git add scripts/local-launch.psm1 scripts/open-model-tunnel.ps1 scripts/open-model-tunnel.test.ps1 scripts/service-supervisor.psm1 scripts/service-supervisor.test.ps1
rtk git commit -m "feat: harden managed SSH worker controls"
```

---

### Task 3: 实现生产前端静态服务器与 API 代理

**Files:**
- Create: `scripts/serve-web.mjs`
- Create: `scripts/serve-web.test.mjs`
- Modify: `package.json`

**Interfaces:**
- `createWebServer({ distRoot, apiOrigin, host, port })`。
- 静态文件只从 `apps/web/dist` 提供。
- `/api/*` 反向代理至 `http://127.0.0.1:43120`，保留方法、请求体、状态码、响应头和 SSE 流。
- 未匹配的前端路由回退到 `index.html`。

- [ ] **Step 1: 写 Node 失败测试**

使用 `node:test` 与临时目录测试：

- `/` 返回 `index.html`。
- 深路由回退到 `index.html`。
- 静态资源 MIME 类型正确。
- 路径穿越请求返回 400/404，不能读取 dist 外文件。
- `/api/health/adapters` 被代理到假 API。
- POST 请求体和非 200 响应不被改写。
- 服务器只接受 loopback host 配置。

- [ ] **Step 2: 运行测试并确认失败**

Run: `rtk node --test scripts/serve-web.test.mjs`

Expected: 模块不存在或接口未实现导致失败。

- [ ] **Step 3: 实现静态服务和代理**

仅使用 Node 标准库 `node:http`、`node:fs`、`node:path`、`node:stream`；不新增第三方依赖。添加根脚本：

```json
"start:web": "node scripts/serve-web.mjs"
```

- [ ] **Step 4: 运行测试和构建**

Run:

```powershell
rtk node --test scripts/serve-web.test.mjs
rtk pnpm --filter @resume/web build
```

Expected: Node 测试通过，前端生产构建成功。

- [ ] **Step 5: 提交**

```powershell
rtk git add scripts/serve-web.mjs scripts/serve-web.test.mjs package.json
rtk git commit -m "feat: add production web host and API proxy"
```

---

### Task 4: 实现本地进程生命周期与功能健康探针

**Files:**
- Modify: `scripts/service-supervisor.psm1`
- Modify: `scripts/service-supervisor.test.ps1`
- Create: `scripts/fixtures/fake-managed-service.ps1`

**Interfaces:**
- `Start-ManagedProcess`：隐藏启动并重定向 stdout/stderr。
- `Stop-ManagedProcess`：先验证身份，再优雅停止进程树。
- `Test-TcpPort`、`Invoke-JsonHealthProbe`、`Invoke-WebHealthProbe`。
- `Wait-ServiceReady`：带超时和停止标记。
- `Get-ServiceRecoveryAction`：根据状态、失败次数和预热窗口决定 `none|restart-local|reconnect-tunnel|inspect-remote|restart-remote`。

- [ ] **Step 1: 写进程和恢复策略失败测试**

通过假服务验证：

- 启动后记录 PID 与命令身份。
- 重复启动不会创建第二实例。
- 假服务退出后恢复动作遵循退避序列。
- 停止标记存在时不重启。
- 命令身份不匹配的 PID 不会被终止。
- OCR/Embedding 处于预热窗口时不触发远程重启。
- 三次功能检查失败后才查询远程状态。

- [ ] **Step 2: 运行测试并确认失败**

Run: `rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/service-supervisor.test.ps1`

Expected: 生命周期函数尚未实现导致失败。

- [ ] **Step 3: 实现进程管理和探针**

API 启动定义：

```text
WorkingDirectory: apps/api
Executable: node
Arguments: --env-file-if-exists=../../.env.local dist/server.js
Health: http://127.0.0.1:43120/api/health/adapters
```

Web 启动定义：

```text
WorkingDirectory: repository root
Executable: node
Arguments: scripts/serve-web.mjs
Health: http://127.0.0.1:5173/
```

隧道使用 `ssh.exe` 直接启动，并通过本地端口和进程身份双重检查。

- [ ] **Step 4: 运行测试并确认通过**

Run: `rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/service-supervisor.test.ps1`

Expected: 全部进程与恢复策略测试通过，无残留假服务进程。

- [ ] **Step 5: 提交**

```powershell
rtk git add scripts/service-supervisor.psm1 scripts/service-supervisor.test.ps1 scripts/fixtures/fake-managed-service.ps1
rtk git commit -m "feat: manage local service lifecycle and health"
```

---

### Task 5: 实现守护循环和完整启动/停止顺序

**Files:**
- Create: `scripts/service-supervisor.ps1`
- Modify: `scripts/service-supervisor.psm1`
- Modify: `scripts/service-supervisor.test.ps1`
- Create: `scripts/service-supervisor.integration.test.ps1`
- Create: `scripts/fixtures/fake-ssh.ps1`

**Interfaces:**
- `service-supervisor.ps1 -RuntimeRoot [string] -ConfigPath [string]`。
- 单实例锁：`supervisor.lock`。
- 期望状态：`desired-state.json`。
- 运行状态：`runtime-state.json`。
- 健康循环默认 10 秒，可在测试中注入更短间隔。

- [ ] **Step 1: 写端到端假链路失败测试**

假 SSH 与假 HTTP 服务记录事件顺序，断言：

```text
remote-start
tunnel-start
api-start
web-start
```

并验证：

- 守护器第二实例立即退出。
- 杀死 API 后只重启 API，不重启远程 Worker。
- 杀死隧道后重连并重新探测适配器。
- 连续远程健康失败时执行一次受控远程重启。
- 写入 `stopped` 后按 `web → api → tunnel → remote-stop` 关闭。
- 守护器异常退出后，任务计划程序再次启动可以识别和清理旧状态。

- [ ] **Step 2: 运行集成测试并确认失败**

Run: `rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/service-supervisor.integration.test.ps1`

Expected: 守护器入口不存在或启动顺序断言失败。

- [ ] **Step 3: 实现守护主循环**

每次循环：

1. 检查期望状态。
2. 更新 supervisor heartbeat。
3. 检查受管 PID 身份。
4. 执行功能探针。
5. 更新连续失败数和最后成功时间。
6. 计算且执行最多一个恢复动作。
7. 原子写入脱敏状态。
8. 可中断等待下个周期。

异常捕获只记录脱敏摘要；不可恢复的配置错误使守护器退出并保留明确状态，不无限快速重启。

- [ ] **Step 4: 运行单元和集成测试**

Run:

```powershell
rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/service-supervisor.test.ps1
rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/service-supervisor.integration.test.ps1
```

Expected: 两套测试通过，测试临时目录无受管进程残留。

- [ ] **Step 5: 提交**

```powershell
rtk git add scripts/service-supervisor.ps1 scripts/service-supervisor.psm1 scripts/service-supervisor.test.ps1 scripts/service-supervisor.integration.test.ps1 scripts/fixtures/fake-ssh.ps1
rtk git commit -m "feat: supervise the complete application stack"
```

---

### Task 6: 实现统一控制命令和用户登录计划任务

**Files:**
- Create: `scripts/service-control.ps1`
- Create: `scripts/service-control.test.ps1`
- Modify: `scripts/service-supervisor.psm1`
- Modify: `package.json`

**Interfaces:**
- 参数：`install|start|stop|restart|status|logs|uninstall`。
- `install` 参数：`-SshHost`、`-SshUser`、`-SshPort`、`-RemoteRoot`、`-NoStart`。
- 计划任务名称固定为 `Appliot Services`。
- 计划任务动作只包含守护器脚本路径与运行根路径，不包含 SSH 地址或秘密。

- [ ] **Step 1: 写控制命令失败测试**

通过可注入的任务计划程序适配器测试：

- install 先校验依赖和 SSH，再构建，再写配置，再注册任务。
- 注册动作使用当前用户登录触发器、隐藏 PowerShell、多实例 IgnoreNew、无限执行时长。
- start 幂等，stop 等待守护器和子进程退出。
- status 在守护器未运行、部分降级、全部就绪时输出六项中文状态。
- logs 只返回 `.runtime/services/logs` 内文件。
- uninstall 删除任务并保留数据库、模型、配置和日志。
- 任一错误消息不包含配置秘密或 `.env.local` 值。

- [ ] **Step 2: 运行测试并确认失败**

Run: `rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/service-control.test.ps1`

Expected: 控制脚本和任务计划适配器尚未实现导致失败。

- [ ] **Step 3: 实现控制命令**

`install` 使用 `Register-ScheduledTask` 创建当前用户任务；若系统策略阻止该 cmdlet，则回退到 `schtasks.exe /Create /SC ONLOGON /RL LIMITED`，随后查询任务定义确认动作与当前用户一致。

根 `package.json` 增加便捷命令：

```json
"services:status": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/service-control.ps1 status",
"services:start": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/service-control.ps1 start",
"services:stop": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/service-control.ps1 stop"
```

- [ ] **Step 4: 运行控制测试并检查帮助输出**

Run:

```powershell
rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/service-control.test.ps1
rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/service-control.ps1 status
```

Expected: 测试通过；未安装时 status 返回清晰中文状态而不是堆栈。

- [ ] **Step 5: 提交**

```powershell
rtk git add scripts/service-control.ps1 scripts/service-control.test.ps1 scripts/service-supervisor.psm1 package.json
rtk git commit -m "feat: add service lifecycle control commands"
```

---

### Task 7: 更新文档并执行全仓回归

**Files:**
- Modify: `README.md`
- Modify: `.gitignore` only if `.runtime/services` is not already ignored

- [ ] **Step 1: 更新 README**

写明：

- 登录后自启的前提和受控浏览器限制。
- 首次安装命令、日常 start/stop/restart/status/logs 命令。
- 配置存放位置和隐私边界。
- 服务恢复策略和日志位置。
- 卸载不会删除数据库或模型。
- 常见故障：SSH 无密码连接、远程模型预热、端口占用、Node 版本不满足。

- [ ] **Step 2: 运行所有新增测试**

Run:

```powershell
rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/local-launch.test.ps1
rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/open-model-tunnel.test.ps1
rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/service-supervisor.test.ps1
rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/service-supervisor.integration.test.ps1
rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/service-control.test.ps1
rtk node --test scripts/serve-web.test.mjs
```

Expected: 所有 PowerShell 与 Node 测试通过。

- [ ] **Step 3: 运行全仓验证**

Run:

```powershell
rtk pnpm --filter @resume/api test
rtk pnpm --filter @resume/web test
rtk pnpm build
rtk pnpm typecheck
rtk git diff --check
```

Expected: API、Web、构建、类型检查与差异检查全部通过；仅允许已知 Node 补丁版本警告。

- [ ] **Step 4: 提交文档**

```powershell
rtk git add README.md .gitignore
rtk git commit -m "docs: document persistent service operations"
```

---

### Task 8: 安装自启并执行真实远程链路验收

**Files:**
- Runtime only: `.runtime/services/*`，不得提交
- Windows user task: `Appliot Services`

- [ ] **Step 1: 停止当前临时开发进程**

只停止已确认属于本仓库的当前 API、Vite 和旧 SSH 隧道进程；不得按端口盲目终止其他程序。

- [ ] **Step 2: 安装用户登录自启**

先从当前已验证的 SSH 配置读取实际值，再执行：

```powershell
$actualSshHost = "从本机 SSH 配置读取"
$actualSshUser = "从本机 SSH 配置读取"
$actualRemoteRoot = "从远程控制器探测得到"
rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/service-control.ps1 install `
  -SshHost $actualSshHost `
  -SshUser $actualSshUser `
  -SshPort 22 `
  -RemoteRoot $actualRemoteRoot
```

实际值只进入被忽略的运行配置，不记录在 Git 差异、提交消息或测试快照中。

- [ ] **Step 3: 验证完整就绪状态**

Run:

```powershell
rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/service-control.ps1 status
rtk curl.exe -fsS http://127.0.0.1:43120/api/health/adapters
rtk curl.exe -fsS http://127.0.0.1:5173/
```

Expected: 守护器、远程 OCR、远程 Embedding、隧道、API/浏览器 Worker和前端全部就绪。

- [ ] **Step 4: 执行恢复测试**

- 终止受管隧道 PID，验证守护器自动重连且适配器恢复。
- 终止受管 API PID，验证 API 与浏览器 Worker恢复，前端保持可访问。
- 执行 `stop`，等待两个健康周期，验证本地端口关闭且远程 Worker停止。
- 执行 `start`，验证完整链路再次恢复。
- 查询计划任务，确认登录触发器、当前用户和 IgnoreNew 多实例策略。

- [ ] **Step 5: 隐私与提交审计**

Run:

```powershell
rtk git status --short --ignored
rtk git diff --check
rtk git log -8 --oneline
```

确认 `.runtime/services/service-config.json`、日志、PID、`.env.local` 和浏览器数据均未被暂存。最终代码如有验收修正，单独提交：

验收修正只暂存实际修改过的源码、测试和文档文件，再提交为 `fix: harden persistent service recovery`；不得使用包含 `.runtime` 的目录级暂存命令。

## 完成定义

- 当前用户登录后计划任务能拉起唯一守护器。
- 六项服务状态可区分，并且真实 OCR/Embedding 为就绪。
- 本地进程或隧道异常退出后能自动恢复。
- `stop` 后本地和远程服务均保持停止，`start` 可再次恢复。
- 所有新增测试、API/Web 测试、构建和类型检查通过。
- Git 中不存在运行配置、Token、SSH 私钥、真实远程地址、候选人数据或浏览器会话。
