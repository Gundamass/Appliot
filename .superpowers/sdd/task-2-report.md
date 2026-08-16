# Task 2 报告：Worker 活动监视器与页面指纹

## 状态

已完成。直接在当前工作区修改，未创建 worktree，未执行 Git 提交，且未增加 IPC activity response 分支。

## 变更文件

- `apps/browser-worker/src/activity-monitor.ts`
  - 新增只读 `ActivityMonitor`：监听主框架导航和本地 DOM 活动信号，提供 `start(taskId)`、`stop()` 与 `subscribe(listener)`。
  - 页面变化使用固定 750ms 防抖、两次相隔 500ms 的一致指纹采样及 5 秒硬上限；超时发出脱敏 `page_unstable`。
  - 用户活动仅从本地安全事件转换为既有 opaque `fieldId` 和有限活动类型，绝不传输输入值。
  - 指纹只哈希 URL、标题、页面阶段、opaque ID 和结构元数据；不包含标签、值、选择器、坐标或脚本。
- `apps/browser-worker/src/observer.ts`
  - 新增无值、无标签的 `observeStructure()`，为监视器提供可见字段/操作结构及现有 opaque ID。
  - 普通观察和结构观察均排除隐藏、禁用、不可交互和 `data-resume-internal` / `data-internal` 控件。
- `apps/browser-worker/src/dom-registry.ts`
  - Registry 选择范围与观察结果对齐，避免隐藏或内部直接控件改变 opaque ID 到 Locator 的序号映射。
- `apps/browser-worker/src/session-manager.ts`
  - `start()` 创建监视器；`open()` 在导航前安装只读观察器并按 task 启动；`stop()` 清理监视器、页面监听器和计时器。
  - 增加内部 `subscribeActivity()`，未连接 IPC。
- `apps/browser-worker/src/activity-monitor.test.ts`
  - 覆盖防抖、双样本稳定、输入脱敏、5 秒上限的可配置测试时钟以及 stop 清理。
- `apps/browser-worker/src/observer.test.ts`
  - 覆盖确定性结构指纹及真实 Chromium 会话中隐藏、禁用、不可交互、内部字段/操作的排除。
- `packages/contracts/src/browser.ts`
  - 为任务要求的有界稳定等待增加严格、脱敏的 `page_unstable` Worker activity 变体，仅含 `taskId` 与 `fingerprint`。
- `packages/contracts/src/browser.test.ts`
  - 覆盖 `page_unstable` 的正向解析、缺少 taskId 与额外敏感值拒绝。

## RED

```powershell
corepack pnpm --filter @resume/browser-worker exec vitest run src/activity-monitor.test.ts src/observer.test.ts
```

预期失败：2 个测试文件无法导入缺失的 `./activity-monitor.js`，说明监视器和指纹帮助器尚不存在。

```powershell
corepack pnpm --filter @resume/contracts exec vitest run src/browser.test.ts
```

预期失败：1/14 测试失败，`WorkerActivitySchema` 拒绝 `page_unstable`，并明确列出现有有限活动类型中尚无该变体。

## GREEN 与验证

```powershell
corepack pnpm --filter @resume/browser-worker exec vitest run src/activity-monitor.test.ts src/observer.test.ts
```

通过：2 个文件、7/7 测试通过。

```powershell
corepack pnpm --filter @resume/browser-worker typecheck
```

通过：根 TypeScript 配置无错误。

```powershell
corepack pnpm --filter @resume/browser-worker test
```

通过：4 个文件、12/12 Worker 测试通过，包括既有 executor、文件解析器和新增观察器测试。

```powershell
corepack pnpm --filter @resume/contracts exec vitest run src/browser.test.ts
```

通过：1 个文件、14/14 合同测试通过。

```powershell
git diff --check
```

通过：无空白错误。

## 自检

- 本地监视路径不调用 DeepSeek 或任何模型。
- `observeStructure()` 不读取字段值、标签、错误文本、验证码、密码、MFA/CAPTCHA 内容、坐标或选择器；事件只公开 task ID、opaque field ID、有限活动类型和哈希指纹。
- 现有可执行命令联合未扩展，未增加脚本、任意选择器、坐标、CDP 或提交能力。
- 初始化脚本在导航前注册，并在当前文档安装；`stop()` 移除页面监听器、取消防抖/采样/上限计时器并清空订阅者。
- `page_unstable` 只使用有限的严格活动形状。Task 3 所需的 IPC 封装与转发没有实现。

## Review Fixes (2026-07-29)

- Shared opaque field/action ID derivation now lives in `apps/browser-worker/src/opaque-id.ts`; activity and `observeStructure()` use the same derivation, with an exact correlation regression test.
- `ActivityMonitor` installs its persistent init script once per monitor/page, so repeated `start()` calls do not accumulate `addInitScript` registrations.
- The document-start observer now watches `document` rather than a possibly-not-yet-created `document.documentElement`. A real Chromium test verifies hidden, disabled, readonly, aria-disabled, inert, and internal inputs never emit activity.
- Privacy boundary unchanged: emitted events contain only task ID, opaque IDs, bounded activity kinds, and fingerprints; no values, labels, selectors, coordinates, credentials, CAPTCHA data, or model calls.

Commands and results:

```powershell
corepack pnpm --filter @resume/browser-worker exec vitest run src/activity-monitor.test.ts
# RED: repeated start installed addInitScript twice (expected 1, received 2)

corepack pnpm --filter @resume/browser-worker exec vitest run src/observer.test.ts
# RED before root fix: no browser activity received; after root fix: 4/4 passed

corepack pnpm --filter @resume/browser-worker exec vitest run src/activity-monitor.test.ts src/observer.test.ts
# 2 files, 15/15 passed

corepack pnpm --filter @resume/browser-worker test
# 4 files, 20/20 passed

corepack pnpm --filter @resume/browser-worker typecheck
# passed
```

## 关注点

- `page_unstable` 是 Task 2 的 5 秒硬上限所必需的本地、严格活动变体；Task 3 仍需将其映射到 API 的既有 `PAGE_UNSTABLE` 有限错误码。
- 浏览器内监听脚本仅向 Worker 输出固定前缀的有限事件，不包含页面文本或输入值；不可信页面伪造的控制台消息会在严格的本地形状校验后被丢弃，除非其恰好符合有限事件格式。
