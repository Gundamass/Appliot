# Agent Runtime Task 5 交付报告

## Status

- status: complete（Task5 本批代码与回归验证完成）。
- branch: `fix/mokahr-campus-apply`。
- implementation commit SHA: `517b3d8`（Supervisor/Planner/Replanner/Validator 与契约实现）。
- 本批不提交 `apps/api/src/production-dependencies.ts` 或其他工作区已有用户改动。

## 本批实现

- 强化 Supervisor 决策绑定：绑定 `intentId`、`planRevision`、`inputRefs`、step owner 和 capability，拒绝跨意图、跨版本、跨 owner 的模型决策。
- 高风险 specialist direct dispatch fail-closed；不可逆操作必须经过人工 `confirm`、`final_submit` capability 和完整 approval binding。
- 人工 `correct` 不得绕过 prompt injection、captcha、ambiguous fact、authentication 等安全 gate；修正必须生成并验证新 plan。
- 强化重规划边界：校验 intent、planId、revision、previousRevision 和连续的 revision history；允许 revision history 达到 100 条后丢弃最旧条目的合法截断。
- 加强运行预算与执行证明：校验 steps/tool calls/replans/retries/tokens/elapsed time，重试受 `maxAttempts` 约束，完成必须携带真实 evidence refs 和满足全部 acceptance criteria。
- attempt token 由 trusted runtime 按 run/plan/revision/step/attempt 生成并绑定，拒绝计划输入伪造 token；Supervisor trace、completion metadata、startedAt 等运行字段同步补齐。
- Planner 不再生成 synthetic output refs；不可逆计划只生成 provisional approval binding，后续应由 trusted runtime 依据真实浏览器 snapshot 替换/签发。
- `PlanState`/`PlanStep` 契约增加完成证据和 satisfied criteria 字段，PlanValidator 增加 approval binding 缺失检查。

## 验证结果

聚焦测试命令：

```text
rtk run "node ..\\..\\node_modules\\vitest\\vitest.mjs run --root . src/agent/supervisor --reporter=dot"
```

完整结果：

```text
Test Files  5 passed (5)
     Tests  33 passed (33)
```

新增回归覆盖：当 `revisionHistory` 已达到 100 条时，合法重规划保留连续后缀并继续执行，不再误报 `replan_revision_history_invalid`。

差异检查：

```text
rtk git diff --check
```

结果：通过（无输出、退出码 0）。

类型检查：

```text
rtk run "corepack pnpm --filter @resume/api typecheck"
```

结果：环境阻塞，`tsc` 未被识别：

```text
'tsc' is not recognized as an internal or external command,
operable program or batch file.
```

这是当前依赖/PATH 环境问题，不是本批已确认的 TypeScript 诊断；需在完整依赖环境重新执行。

## 已知 concern / 后续批次

- production composition 尚未在本批闭合：`apps/api/src/agent/graph-service.ts` 仍使用 `createLegacyMainGraph`，`production-dependencies.ts` 尚未完整组合 Catalog、Policy、Runtime、Supervisor。后续批次需完成切换并补生产启动/重启验证。
- caller token 不能在启动时固定签发一个长期复用的 15 分钟 token；应改为动态签发或接入受信 runtime issuer。
- Planner 当前 approval binding 是 provisional 结构绑定（`planning:${intentId}` 等），不是实时浏览器 snapshot；真实执行前必须由 trusted runtime 重新绑定 snapshot、target fingerprint 和 payload hash。
- 本批保持人工最终确认，不允许通过 `correct` 或 specialist 直派绕过高风险/不可逆 gate；自动能力优先仍受 policy、证据、预算和 checkpoint 约束。

## Task5 安全批次增量（2026-09-03）

- `SupervisorGraphDependencies` 新增受信任 `approvalBindingProvider`。高风险/不可逆 `ask_human` 必须经 provider 签发严格 `PlanApprovalBinding`，并将 run、step、revision、epoch 及 snapshot/target/payload 绑定写入 interrupt；provider 缺失或返回无效结构时 fail-closed。
- 默认启用有限 `BudgetLimits`，步骤/工具/replan/retry/token/时长均在运行前后做预算比较；attempt token 超长时使用 SHA-256 压缩保持小于 256 字符。
- graph 初始入口执行 `SupervisorGraphStateSchema.safeParse`，拒绝预标记 completed/running 计划、非零预算或 evidence 注入。

验证：聚焦新增测试使用 `node ../../node_modules/vitest/vitest.mjs run src/agent/supervisor/supervisor-graph.test.ts -t 'blocks irreversible approval|rebinds an invalidated|rejects precompleted|bounds generated'`，4 项新增行为通过；完整 supervisor 回归受现有测试仍注入初始 evidence、且未提供 approval provider 的旧断言影响。类型检查环境可执行 TypeScript，但仓库当前存在大量既有依赖缺失诊断；`git diff --check` 应在提交前运行。
