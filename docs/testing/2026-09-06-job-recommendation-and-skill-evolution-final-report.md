# 岗位推荐与声明式 Skill 自动演化最终验收报告

日期：2026-09-07

## 验收结论

分阶段计划的 22 个任务已完成。岗位推荐现在按展示百分比稳定排序并只保留前六个；折叠卡片只包含岗位名称、匹配度、查看详情、选择此岗位和岗位页面，展开后使用中文解释匹配优势、待确认条件、差距与风险以及分项计分。声明式 Application Skill 已覆盖不可变版本、任务固定绑定、离线资格、稳定 10% Challenger、确定性统计晋升、硬失败原子回滚和 append-only 审计闭环。

最终提交能力没有扩张：最终审核仍是 acknowledgement-only，所有 Synthetic ATS 与联调场景的提交计数均为 0。

## 完整自动化矩阵

| 验证项 | 结果 |
| --- | --- |
| contracts | 17 个文件，193/193 |
| job-matching | 7 个文件，87/87 |
| API | 127 个文件，1115/1115 |
| Web | 45 个文件，261/261 |
| Synthetic ATS | 1 个文件，7/7 |
| 四规格 Playwright | 16/16 |
| 根 TypeScript typecheck | 通过 |
| 生产构建 | 通过；仅有既存 518.41 kB Web chunk 提示 |
| `git diff --check` | 通过；仅输出 Windows 工作区的 LF/CRLF 提示 |
| 敏感边界静态扫描 | `Profile fact`、profile path、approval token、raw DOM、querySelector 和 submit command 模式均无命中 |

Playwright 四规格为 `conversation-job-match-flow`、`application-skill-runtime`、`application-skill-offline-evolution` 和 `application-skill-evolution`。它们共同覆盖 Moka、DJI、百度、六卡排序与解释、旧会话兼容、歧义与未匹配页面、stale NodeRef、刷新恢复、离线资格、固定分流、晋升、回滚和最终审核边界。

## 安全边界复核

- Skill 能力由 schema、父版本非扩张检查和解释器白名单共同限制；声明中不存在 submit 能力。
- 任务在首次写入前持久化 Skill 绑定；重载继续使用原版本。版本被隔离后，已绑定任务保留审计身份但进入 observe-only handoff。
- 训练集与隐藏留出集按确定性规则分离；生成模型看不到 holdout 内容、评估结果或发布判定内部数据。
- 候选必须依次通过 schema、语义、安全模拟、隐藏回放和 Synthetic ATS；门禁缺失或异常时不创建 Challenger 流量。
- Challenger 固定为 10%，至少 10 个合格样本且 95% 区间有利才晋升；50 个样本仍无结论时停止试验。
- 任一安全违规、错误写入或新增 full-page audit mismatch 都会隔离 Challenger，并在同一事务中恢复稳定 Champion 的 100% 流量。
- action policy、浏览器所有权、NodeRef/snapshot/epoch、双重读回、全页审计、意外导航检测和最终审核确认均在完整回归中保持绿色。
- 执行与评估证据使用不可变 ID 和哈希化/枚举化内容；不保留简历值、审批密钥、原始 DOM、查询 token 或完整岗位 URL。

## 可复现的演化证据

百度自动演化使用 allocation `allocation-baidu-evolution-e2e`。Champion 与 Challenger 各 10 个同分层样本，首个差异维度为 `retriesAndRecoveries`，observed delta 为 1，95% 区间为 `[1, 1]`，因此 `1.0.1` 晋升。随后 `1.0.2` 在填写后变异场景产生新增审计差异，在小于 1000 ms 的断言窗口内被 quarantine，`1.0.1` 恢复 100%。完整 evaluation ID、截图和提交计数记录在自动演化回归报告及 Playwright 附件中。

## 实际 UI 检查

本地 5173 页面可访问。首次检查看到的是构建前仍驻留在标签页内的旧 JavaScript bundle，其中历史卡片仍显示开发者字段；刷新后当前构建已加载，源码与自动化 DOM 均验证新的五元素折叠结构。刷新同时暴露该临时验收 API 已重建数据库，旧 conversation ID 无法恢复。新建百度入口搜索真实执行后，Tavily 在 10 秒超时，界面正确停在可重试错误，没有误创建岗位匹配或投递任务。该外部搜索可用性不作为本地功能通过的替代证据；百度完整推荐链路由确定性浏览器夹具验证。

## 已知非阻断项

- Web 生产 bundle 仍有超过 500 kB 的既有提示，需要后续按路由或重型组件拆包。
- 实际招聘入口搜索依赖 Tavily 网络和服务可用性；本次手工检查遇到一次 10 秒超时，错误处理符合预期。
- 工作区在本计划开始前已有大量并行未提交改动；各阶段提交只收录可安全隔离的计划文件，生产组合层的相关接线保留在现有 dirty 文件中并已由完整 API 回归覆盖。
