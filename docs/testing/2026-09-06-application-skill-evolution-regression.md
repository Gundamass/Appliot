# Application Skill 自动演化回归记录

日期：2026-09-07
范围：审计失败收集、候选生成、离线门禁、10% Champion/Challenger 分流、统计晋升、硬失败回滚与最终提交保护。

## 场景与结果

浏览器回归使用百度投递页面变体 `evolution-label-change`。种子 Champion `baidu-application@1.0.0` 无法识别只暴露 `Preferred identity` placeholder 的新姓名控件；三条 `field_missing` 失败和一条后续成功形成演化机会。自动演化协调器从 append-only 评估窗口收集机会，调用受约束生成和关闭的离线门禁，仅为 `basics.name` 增加 placeholder locator hint。候选 `1.0.1` 依次通过 Schema、语义、安全模拟、隐藏留出回放和 Synthetic ATS 门禁，再由协调器自动获得固定 allocation 的 10% 流量。生产依赖只有在结构化模型和全部 qualification ports 同时存在时才启用此协调器；缺失或异常时保留当前 Champion，不开放流量。

晋升试验的确定性参数如下：

- allocation ID：`allocation-baidu-evolution-e2e`
- evaluator：`1.0.0`
- bootstrap seed material：`allocation-baidu-evolution-e2e1.0.0retriesAndRecoveries`
- Champion 样本：10
- Challenger 样本：10（全部满足相同 site、fingerprint、scenario 和 required-field-count 分层）
- 首个差异维度：`retriesAndRecoveries`
- observed delta：`1`
- 95% 置信区间：`[1, 1]`
- 决策：`promote`

生命周期先从 `1.0.0 champion / 1.0.1 replay_qualified` 原子进入 90/10 试验，再原子提交为 `1.0.0 retired / 1.0.1 champion / 100% Champion`。激活前已绑定任务继续保持 `1.0.0`，新任务按稳定哈希进入固定 cohort。

随后创建 `1.0.2` Challenger，并在 `post-fill-mutation` 页面注入写后值变化。第一条新增 full-page audit mismatch 在同一次 `recordAndDecide` 调用内触发 `1.0.2 quarantined`，Challenger 流量归零，`1.0.1` 恢复 100%；回滚延迟断言上限为 1000 ms。稳定任务仍绑定 `1.0.1`，回滚后的新任务同样选择 `1.0.1`。已绑定 `1.0.2` 的任务在恢复时保留原绑定但进入 `observe_only_handoff`，不会编译下一次写操作。

## 审计与安全证据

- 本场景保留 25 条 append-only execution records；尝试更新记录由 SQLite trigger 拒绝。
- 代表性 evaluation IDs：
  - 首条演化失败：`skill-evaluation-144325278fe817e1fd949f0fa8d62dd4`
  - 第十条晋升 Challenger：`skill-evaluation-3f19a627f216b486f9a36c17d7a9e97d`
  - 触发回滚的审计差异：`skill-evaluation-fa55b2bf854dac94cee84122f6dbb8cb`
- 测试运行附加两张页面截图和一份 `skill-evolution-audit.json`，其中包含完整 evaluation ID 列表、统计结果、实际回滚耗时和提交计数。
- `evolution-label-change` 与 `post-fill-mutation` 的 `submissionCount` 均为 `0`。
- 页面中的真实 submit 控件始终存在，但测试和 Skill 控制面均未点击或授权最终提交。

## 验证命令

```powershell
rtk corepack pnpm --filter @resume/synthetic-ats test -- --run
rtk corepack pnpm --filter @resume/api test -- --run
rtk corepack pnpm test:e2e -- tests/browser/application-skill-runtime.spec.ts tests/browser/application-skill-offline-evolution.spec.ts tests/browser/application-skill-evolution.spec.ts
rtk corepack pnpm typecheck
rtk corepack pnpm build
```

结果：API 127 个文件、1115/1115；Synthetic ATS 7/7；Skill Runtime、离线演化与自动演化 Playwright 合计 13/13；根 TypeScript typecheck 与生产构建通过。构建只输出既有 Web chunk 大小提示，无失败。
