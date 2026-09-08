# Agent Runtime Task 4 复审修复报告

## 范围

本修复针对 `dfcbbaa..4b6c50b` 的 Task 4 attestation 复审意见，并以
`36fce8a` 已修复 Supervisor 向 specialist 传递 attestation 的状态为基线。
只修改 attestation/approval 的可信组合边界及其测试；没有重写 legacy
application graph 或修改其他工作区改动。

## 结果

- `production-dependencies.ts` 不再创建并公开一组进程启动时的固定 caller
  token。它现在公开 `agentCallerAttestationProvider`，该 provider 仅由可信
  composition root 持有 issuer，并为 graph、runtime、supervisor 和
  specialist-agent 身份按需签发新的短期 token；配套 verifier 保持在同一
  受信任依赖边界。
- `createCallerAttestationProvider` 的纯单元测试验证每次 runtime 请求得到不
  同 token，且各 scoped helper 的 caller claim 正确。production composition
  测试也断言不再存在旧的 `agentCallerAttestations` 固定 token 属性。
- `ApprovalIssuer.issue` 现在限制调用方传入的 `expiresAt`：晚于 issuer 配置
  TTL 的值以 `human_approval_expiry_exceeds_ttl` 拒绝，不能借由调用方扩大人类
  审批有效期。新增回归测试覆盖 60 秒 issuer TTL 与 2 分钟请求 expiry。

## TDD 记录

先在 `production-dependencies.test.ts` 增加动态 provider 的 composition 测试，
并执行其定向命令。测试收集在断言前被环境阻塞：当前 workspace 缺少
`better-sqlite3` 包，Vitest 无法导入该测试文件。随后实现最小 provider 边界，
并补充/运行不依赖 SQLite 的 provider 与 approval RED/GREEN 回归。代码改动前
approval TTL 断言不存在；实现后定向测试通过。

## 验证

通过：

```text
rtk node ../../node_modules/vitest/vitest.mjs run src/agent/policy/caller-attestation.test.ts src/agent/policy/approval-gate.test.ts
Test Files  2 passed (2)
Tests       6 passed (6)

rtk node ../../node_modules/vitest/vitest.mjs run src/agent/capabilities/catalog.test.ts src/agent/policy/policy-engine.test.ts src/agent/policy/approval-gate.test.ts src/agent/policy/injection-detector.test.ts src/agent/policy/caller-attestation.test.ts src/agent/runtime/runtime-attestation.test.ts src/agent/supervisor/specialist-attestation.test.ts
Test Files  7 passed (7)
Tests       28 passed (28)

rtk pnpm --filter @resume/api typecheck
TypeScript: No errors found
```

`git diff --cached --check` 通过。

环境阻塞：

```text
rtk node ../../node_modules/vitest/vitest.mjs run src/production-dependencies.test.ts -t "trusted attestation provider"
Error: Cannot find package 'better-sqlite3'
```

这是依赖缺失造成的测试收集失败，并非新增断言失败；待恢复 API 的
`better-sqlite3` workspace 安装后应重新运行该 composition 测试。

## 未完成的生产接线

本次不宣称完整 production graph 已接入 Task 4/5 的 Catalog、Policy、Runtime
和 Supervisor。当前 `createProductionDependencies` 仍组合 legacy
`createGraphService` / `createLegacyMainGraph` 路径；它没有创建或注入
CapabilityCatalog、PolicyEngine、AgentRuntime 或 Supervisor graph。Task 9 的
明确切换任务应在同一生产依赖图中构建这些组件，并在实际 graph/runtime/
supervisor/specialist 创建点调用 provider 取得其 token。新的 provider/verifier
边界已准备好，且不会再让 production composition 伪装为已完成该接线。
