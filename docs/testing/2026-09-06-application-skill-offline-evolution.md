# Application Skill 离线进化资格测试

## 验收目标

声明式 Application Skill 候选只能在离线门禁全部通过后从 `candidate` 进入
`replay_qualified`。资格评估不会分配线上流量，也不会触发最终投递。

## 固定门禁顺序

1. `schema`：按 `ApplicationSkillVersionSchema` 校验候选，并重新计算内容哈希。
2. `semantics`：检查能力未扩张、工作流可达、字段和 readback 完整、域名受限。
3. `safety-simulation`：要求零安全违规、零错误写入、零读回不一致。
4. `hidden-holdout-replay`：评估器才可打开隐藏留出集；Champion 与候选使用完全相同的样本。
5. `synthetic-ats`：覆盖控件重排、重复标签、延迟选项、隐藏蜜罐、意外导航、陈旧
   NodeRef 和填写后变异。

任一门禁失败都会短路后续步骤。候选必须在目标失败分层上按固定评估向量严格优于
Champion，同时在全局不劣于 Champion；候选留出集结果还必须保持零安全违规和零错误写入。

## 数据隔离与审计

- 生成器只接收冻结清单中的训练样本；隐藏留出样本由独立评估能力打开。
- 每个机会使用确定性的 `evolution-lease-*` 记录争抢一次性执行租约，重复执行不会再次调用模型。
- 每次运行写入确定性的 `evolution-report-*` 不可变报告，包括每个门禁的输入 SHA-256、
  evaluator `1.0.0`、结果及拒绝原因。
- 通过后仅创建并绑定候选，再以 compare-and-set 执行
  `candidate -> replay_qualified`；资格评估前后的流量分配摘要必须一致。

## 自动化证据

运行：

```powershell
rtk corepack pnpm --filter @resume/api exec vitest run src/application-skills/replay-corpus.test.ts src/application-skills/evaluation-engine.test.ts src/application-skills/evolution-collector.test.ts src/application-skills/evolution-agent.test.ts src/application-skills/evolution-coordinator.test.ts
rtk corepack pnpm --filter @resume/synthetic-ats test -- --run
rtk corepack pnpm test:e2e -- tests/browser/application-skill-offline-evolution.spec.ts
rtk corepack pnpm build
```

端到端固定报告 ID 为
`evolution-report-evolution-opportunity-offline-e2e`。测试断言候选状态为
`replay_qualified`、流量仍为 100% Champion / 0% candidate、七类 Synthetic ATS 页面
的 `submissionCount` 均为 0，且模型载荷中不存在 `holdout-offline-*`。
