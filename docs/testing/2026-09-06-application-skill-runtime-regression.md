# 声明式投递 Skill Runtime 回归记录

## 验证范围

本轮回归覆盖 Moka、DJI、百度三个 Champion Skill，并使用 Playwright 保留真实招聘域名和路由，只把响应拦截到本地合成 ATS。测试不会访问线上招聘接口，也不会执行最终提交。

覆盖的页面变化包括：字段标签改名、重复标签/重复语义、延迟渲染、节点失效、歧义指纹、意外导航、受支持域名上的未匹配路由，以及页面刷新后的绑定恢复。

## 固定绑定

| Site | Skill | Version | Page fingerprint | Allocation |
| --- | --- | --- | --- | --- |
| Moka | `moka-application` | `1.0.0` | `b70b76ca0d8242abc1422088ae102f05e7157c6bc45e93724bfdbe1eebbe543d` | `allocation-moka-b70b76ca0d8242abc1422088` |
| DJI | `dji-application` | `1.0.0` | `6f00113954dd164379bdb9bcc230c461e0d16da2b4995901fdf9a6b27404b4d5` | `allocation-dji-6f00113954dd164379bdb9bc` |
| 百度 | `baidu-application` | `1.0.0` | `004c4bb7116a509a332df5f17b4553b04129d05383a02a693447622a4f5f6fc3` | `allocation-baidu-004c4bb7116a509a332df5f1` |

刷新前后的绑定对象要求完全相等。执行记录 ID 使用 `skill-record-<32 hex>`，尝试 ID 使用 `attempt-<32 hex>`；它们按任务动态生成，测试校验格式、关联绑定和幂等落库，不把动态 ID 固化到文档。

## TDD 证据

- 合成 ATS RED：新增 `/skill-runtime` 和 `/api/skill-runtime-state` 契约后，原实现返回 404；实现 3 个站点、7 个场景和只读状态后转 GREEN。
- 页面识别 RED：合成页最初只在正文放置“申请职位/个人信息”，但 Skill 观测 landmark 只包含标题、字段标签和动作文本，三个 Champion 均未命中；把稳定标志纳入标题后转 GREEN。
- DJI RED：声明中的 `education[].institution` 无法匹配浏览器中的 `education[0].institution`，解释器、计划构建器和浏览器 E2E 同时失败；将首层重复条目归一为模板语义后转 GREEN。
- 重复语义 RED：两个 `basics.name` 控件会自动写入第一个；运行时改为在绑定和写入前拒绝非唯一可写语义并请求接管后转 GREEN。
- 意外导航 RED：浏览器执行异常沿用旧快照，审计只能看到 `write_failed`；执行器改为异常后尽力获取新快照，审计稳定记录 `unexpected_navigation`，同时不改变失败关闭行为。

## 功能断言

- Moka：姓名、邮箱、手机号各写入一次；刷新后不重复写入；进入最终审核前停止。
- DJI：姓名、手机号、毕业院校各写入一次；`education[]` 模板正确绑定 `education[0]` 实例；延迟渲染同样可识别。
- 百度：Champion 当前是 observe/readback/audit-only，不产生字段写入，直接停在最终审核边界。
- 标签改名：依靠声明语义而非可见标签继续正确填写。
- 重复语义、歧义指纹、未匹配路由：不绑定不安全候选，不写字段，转人工接管。
- stale-node：返回失败，字段值和写入计数保持为空，并写入脱敏失败记录。
- unexpected-navigation：只允许导航发生前的首次字段事件，随后失败关闭，记录 `unexpected_navigation`，不会继续填写。
- final-submit：最终步骤仅确认审核锁，`toolCallsUsed === 0`。
- 所有场景均断言 `submissionCount === 0`。

Playwright 成功用例附带 `matched-moka`、`matched-dji`、`matched-baidu` 和 `unmatched-observe-only` 截图；失败时仍按项目配置保留 screenshot、video 和 trace。

## 自动化结果

- Skill 解释器、选择器与安全计划构建聚焦测试：39/39 通过。
- contracts 全量：17 个文件，193/193 通过。
- API 最终全量：127 个文件，1115/1115 通过。
- 合成 ATS：7/7 通过。
- browser-worker 全量：13 个文件，134/134 通过。
- Skill Runtime 浏览器回归：11/11 通过。
- API、browser-worker、synthetic ATS TypeScript 检查全部通过。
- 根工作区构建通过；仅保留既有的 Web 单 chunk 超过 500 kB 警告（518.41 kB），不影响本次功能与安全门禁。
- 最终四规格浏览器矩阵（岗位推荐、Skill Runtime、离线演化、自动演化）16/16 通过；其中 Runtime 场景仍为 11/11，全部提交计数为 0。
