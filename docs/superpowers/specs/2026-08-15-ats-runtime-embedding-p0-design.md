# ATS Runtime 与 Embedding P0 稳定化设计

日期：2026-08-15

## 背景

2026-08-14 的 ATS 自动填写稳定化设计已经覆盖工作/实习分流、栏目受限语义映射、稳定重试键、复杂控件回读和后端真实进度。当前实现仍有五类更底层的风险：

1. 浏览器观察把字段 ID 绑定到 `locator(...).nth(index)`。动态插入、删除或重排后，旧 locator 可能指向同序号的另一个控件。
2. 普通控件写入后只立即观察一次。React、Vue 或 ATS 自身状态同步稍后回滚时，执行器可能报告假成功。
3. 状态机没有 Challenge 状态。CAPTCHA、HTTP 403/429、设备验证和风控页面不能一致地停止执行与废止授权。
4. 观察器只扫描主文档，既不声明 iframe 和 Shadow DOM 边界，也无法区分“没有字段”和“字段位于未扫描区域”。
5. 字段本体当前有 83 项，但远程 Embedding Provider 单批最多接受 32 项；本体索引一次性提交 83 项，并在基础设施失败后错误地回退到 DeepSeek。

这些问题必须先于岗位匹配与推荐处理。岗位抓取、排序和解释不会进入本设计，也不会被塞入现有 `ApplicationService`。

## 目标

1. 动态 DOM 变化后，旧节点引用只会失效，绝不会自动绑定到同序号的新节点。
2. 受控组件只有在两个稳定窗口的局部回读均匹配时才报告成功。
3. Challenge 或未支持的 DOM 边界出现时，系统立即暂停并废止在途执行与旧授权。
4. 83 项字段本体按 `32/32/19` 顺序构建向量索引，所有远程 Embedding 调用默认 GPU 并发为 1。
5. 基础设施失败与语义歧义分流；基础设施失败不得触发 DeepSeek，健康召回的 Top-3 才能进入歧义仲裁。
6. 首个正式支持范围保持为 Moka/Mokahr 中文主文档流程与 DJI 路径，并继续保证最终提交次数为 0。

## 非目标

- 不遍历或自动操作 iframe、开放或封闭 Shadow DOM。
- 不破解 CAPTCHA，不代替用户完成设备验证、扫码、隐私同意或风控验证。
- 不新增 BM25、BGE-Reranker、Langfuse、Browser-Use 或 LangGraph。
- 不自动选岗，不实现岗位匹配，不扩大到其他 ATS 的正式支持声明。
- 不改变 ActionPolicy 与 Browser Worker 对终局提交的双重禁止。
- 不在本轮大规模拆分 `ApplicationService`；只提取 P0 所需的明确协调器。

## 总体流程

```text
observe
  -> detect challenge and unsupported boundaries
  -> create FrameRef + MutationEpoch + NodeRefs
  -> resolve and authorize against the current snapshot
  -> prepare: verify epoch, frame and node identity
  -> apply once
  -> wait for local stability
  -> local readback #1
  -> wait for a second stability window
  -> local readback #2
  -> applied or failed
  -> periodic full-page audit
```

任一步检测到 Challenge、未支持边界、epoch 变化、节点失联或用户活动时，都必须停止当前事务。恢复时重新观察、规划和授权，不复用旧命令。

## Runtime 身份模型

### `FrameRef`

`FrameRef` 标识观察所属文档，而不是一个可重新查询的选择器：

```ts
interface FrameRef {
  documentId: string;
  kind: "main";
}
```

- `documentId` 在主文档导航或重载时更换。
- MVP 只为主文档生成可执行的 `FrameRef`。
- 子 iframe 只生成不可执行的边界诊断，不分配可写 `FrameRef`。

### `MutationEpoch`

```ts
type MutationEpoch = number;
```

- 每个主文档从 0 开始单调增加。
- 相关 `childList` 变化、控件身份属性变化和主文档导航都会推进 epoch。
- 观察快照记录 epoch；执行前必须与页面当前 epoch 完全一致。
- apply 开始后的框架内部 mutation 不回绑节点；事务继续持有原节点句柄完成局部回读，但新规划必须使用新快照。

### `NodeRef`

```ts
interface NodeRef {
  documentId: string;
  nodeId: string;
  observedAt: MutationEpoch;
}
```

- 页面初始化脚本使用文档内 `WeakMap<Element, string>` 为实际 DOM 节点分配不可预测的 `nodeId`。
- `nodeId` 不由 DOM 序号、CSS 路径、字段名称或可变属性计算。
- 字段、操作和执行命令携带 `NodeRef`；审批摘要必须覆盖 `NodeRef` 与 mutation epoch。
- 节点被移除后，原 `NodeRef` 永久失效，即使同位置出现外观相同的新节点也不复用。

### `NodeRegistry`

`NodeRegistry` 取代当前基于 `nth(index)` 的 `DomRegistry`。每次观察时，它把 `NodeRef` 绑定到当时的 Playwright `ElementHandle`，并提供：

```ts
interface NodeRegistry {
  prepare(ref: NodeRef, expectedEpoch: MutationEpoch): Promise<PreparedNode>;
  release(): Promise<void>;
}
```

`prepare()` 依次验证：

1. `documentId` 仍是当前主文档。
2. 页面 epoch 与命令 epoch 一致。
3. `nodeId` 存在于当前 Registry。
4. 对应句柄仍连接在文档中。
5. 节点角色仍与命令一致，例如 `fill` 不能落到 select 或 action。

任何检查失败都返回稳定错误码 `stale_node_ref` 或 `node_role_changed`，并要求 API 重新观察。不得用字段 ID、CSS selector 或同序号 locator 自动寻找替代节点。

## 控件执行事务

### 事务阶段

每个字段操作改为以下阶段：

```text
prepare -> apply -> settle-1 -> local-readback-1 -> settle-2 -> local-readback-2 -> commit
```

- `prepare`：校验 execution epoch、`NodeRef`、ActionPolicy 授权和用户活动代次。
- `apply`：对已准备的节点只执行一次写入、选择或上传动作。
- `settle-1`：等待目标节点及其最近表单容器连续 300 ms 无相关 mutation，上限 2 秒。
- `local-readback-1`：直接从原节点句柄读取规范化值和选中状态，不做全页扫描。
- `settle-2`：再次等待连续 300 ms 稳定，上限 2 秒。
- `local-readback-2`：再次读取同一节点；两次结果都与目标值一致才提交成功。

稳定窗口超时返回 `control_unstable`；第一次匹配而第二次回滚返回 `controlled_value_reverted`；节点断开返回 `stale_node_ref`。一次事务内不自动重复 apply，外层仍使用已存在的稳定业务键控制最多两次自动尝试。

### 局部回读与全页审计

- 普通字段、单选组和自定义选择器优先局部回读。
- 上传继续使用解析完成条件，但同样受 NodeRef 和 execution epoch 约束。
- 每完成 8 个成功字段、每个 deterministic/semantic phase 结束以及进入最终审核前，执行一次全页审计。
- 全页审计重新观察页面，对已提交操作按稳定业务键核对值；发现回滚时把字段标为失败，不静默重填。
- 任何终局提交控件仍不进入可执行 NodeRegistry。

## Challenge 与人工接管

### 检测来源

Browser Worker 统一产生脱敏诊断：

```ts
type ChallengeKind =
  | "captcha"
  | "access_denied"
  | "rate_limited"
  | "device_verification"
  | "risk_control"
  | "unsupported_iframe"
  | "unsupported_shadow_dom";
```

- 主文档导航响应为 403 时产生 `access_denied`，429 时产生 `rate_limited`。
- CAPTCHA、设备验证和风控只使用 Moka/Mokahr、DJI 已验证的 URL、标题、可访问名称和有限文本信号；不记录原始 DOM 或用户输入。
- 可见 iframe 或包含交互控件的 Shadow Root 产生对应 unsupported 诊断。
- 仅有无关的不可见 iframe、统计 iframe 或没有交互控件的开放 Shadow Root 不阻断，但仍可计入非敏感边界数量。

### `ChallengeCoordinator`

检测到阻断诊断后：

1. 状态机从 `observing`、`filling`、`validating` 或 `navigating` 进入 `awaiting_challenge`。
2. API 推进 task execution epoch，并调用 Browser Worker `invalidate_execution`。
3. Browser Worker 清除该任务尚未消费的审批 token、NodeRegistry 和准备中的事务。
4. 页面停止所有自动操作，前端展示 Challenge 类型与“继续填写”操作。
5. 用户自行完成验证或人工处理未支持边界。
6. 只有用户显式点击“继续填写”才允许离开 `awaiting_challenge`。
7. 恢复从全新 observe 开始，随后重新解析、规划和授权；旧命令永不恢复。

普通字段失败、健康页面的短暂 mutation 和保守的第二次搜索尝试不进入 `awaiting_challenge`。

## iframe 与 Shadow DOM 边界

MVP 不扫描这些区域，也不把它们当成“没有字段”：

- 快照增加有限 `boundaries` 列表，只包含种类、可见性、是否疑似包含交互控件和脱敏原因码。
- 主文档存在可填写字段，但另有疑似交互边界时，系统暂停并展示未覆盖区域。
- 主文档没有字段而存在疑似交互边界时，必须进入人工接管，不能进入最终审核或成功。
- 用户处理边界并显式继续后，系统只重新扫描主文档；不会自动进入 iframe 或 Shadow Root。
- 封闭 Shadow Root 无法检查内部控件时，只要宿主可见且具有交互语义，就保守地视为未支持边界。

## Embedding 调度与索引

### 统一调度器

在远程 Provider 外增加 `ScheduledEmbeddingProvider`：

```ts
interface EmbeddingSchedule {
  maxBatchSize: 32;
  maxConcurrency: 1;
}
```

- `embedDocuments()` 按输入顺序切为最多 32 项的批次并顺序执行。
- 83 项本体固定形成 `32/32/19` 三批，结果按原索引合并。
- `embedQuery()` 与文档批次使用同一个 FIFO 队列，因此同一 GPU Worker 同时最多有一个请求。
- 单批最多沿用 Remote Provider 的 2 次重试；调度器不额外叠加重试。
- 任一批失败则整个索引构建失败，不返回部分向量。

### 字段本体索引

- 本体索引 key 由 embedding model、model revision、instruction version 和字段本体内容哈希组成。
- 同一 key 的并发构建共享一个 Promise；成功后复用只读向量，失败后清除 singleflight，下一次显式操作可重试。
- 本体内容哈希覆盖 semantic、label、aliases、types、sections、risk 和 description。
- 查询必须等健康本体索引完成后进入同一调度队列，不再用 `Promise.all` 同时冲击 GPU Worker。

### Fact Embedding Index

- 现有 32 分批保留，并改为通过同一个调度器执行。
- 同一 profile revision 与索引配置的并发 `synchronize()` 共享一个构建 Promise。
- singleflight key 覆盖 profile revision、model revision、instruction version 与索引配置。
- 构建失败时删除 building index，保留旧 active index；没有健康 active index 时返回 `EmbeddingSearchUnavailableError`。

### DeepSeek 仲裁边界

Embedding 结果分为：

1. `infrastructure_failure`：配置、网络、超时、限流、响应格式、向量数量或维度错误。
2. `healthy_no_candidate`：健康召回后没有兼容候选。
3. `healthy_ambiguous`：健康候选存在，但 Top-1 低于阈值或与 Top-2 间距不足。
4. `healthy_resolved`：Top-1 达到阈值和间距要求。

只有 `healthy_ambiguous` 可以调用 DeepSeek。输入只包含当前栏目和控件类型兼容的 Top-3 候选及其分数，不再传入全部字段定义。基础设施失败直接返回 `embedding_unavailable`，不得逐字段触发 DeepSeek。

## 状态与重试预算

### 状态迁移

```text
observing/filling/validating/navigating
  -> CHALLENGE_DETECTED
  -> awaiting_challenge
  -> USER_RESUME
  -> observing
```

- `awaiting_challenge` 持久化 Challenge 类型、发生时间和脱敏原因码。
- 进程重启后仍保持暂停，不因页面当前看似正常而自动恢复。
- 用户恢复会清除旧 Challenge，但不会清除字段的两次自动尝试计数。

### 预算

- 每个稳定字段业务键最多 2 次自动 apply，DOM 重渲染不重置。
- 每次 settle 窗口为 300 ms，单窗口上限 2 秒。
- 每个普通控件最多执行两个 settle 窗口，不在事务内循环重写。
- Remote Embedding 每批最多 32 项、Provider 最多 2 次重试、GPU 并发为 1。
- Challenge 没有自动恢复次数；每次恢复都必须由用户显式触发。
- iframe/Shadow DOM 边界没有自动穿透次数，始终人工接管。

## Moka/DJI 限域

- 节点身份、稳定回读和提交阻断是通用底层机制。
- Challenge 文本规则、复杂控件适配和验收页面仅声明 Moka/Mokahr 中文主文档与 DJI 路径支持。
- 未识别站点只使用 HTTP 状态、主文档结构和通用边界检测，不声称能安全处理其挑战或嵌套控件。
- 真实页面验证必须由用户完成登录、验证码和岗位选择，并停在最终审核页。

## 失败处理与可观测性

- 对外只暴露有限中文状态和稳定原因码，不保存原始 DOM、selector、坐标、验证码文本或候选人输入。
- Runtime trace 记录 task ID 的脱敏哈希、snapshot ID、document ID、mutation epoch、NodeRef 哈希、阶段、耗时与结果码。
- Embedding trace 记录 cache key 哈希、批次大小、队列等待、Provider 错误类别和是否进入 DeepSeek；不记录字段原文或档案内容。
- `stale_node_ref`、`controlled_value_reverted`、`challenge_detected`、`unsupported_dom_boundary` 和 `embedding_unavailable` 必须在字段明细或任务状态中可见。

## 测试设计

### Runtime 单元与浏览器测试

1. 在目标字段前插入新 input 后，旧 `NodeRef` 返回 `stale_node_ref`，新 input 不接收旧值。
2. 删除目标并在相同序号插入相同标签控件后，旧 `nodeId` 不复用。
3. 仅重排但节点仍连接时，epoch 变化仍要求重新观察和授权。
4. React/Vue 风格控件先接受值、500 ms 后回滚时返回 `controlled_value_reverted`。
5. 两次稳定回读保持目标值时才返回 `applied`。
6. 每 8 个成功字段与 phase 结束时执行全页审计。

### Challenge 与边界测试

1. CAPTCHA、403、429、设备验证和风控分别进入 `awaiting_challenge`。
2. 进入状态时 execution epoch 推进、旧审批不可消费、在途操作返回 `execution_invalidated`。
3. 页面恢复正常但用户未点击继续时，系统不执行任何字段操作。
4. 用户点击继续后从 observe 开始，旧 NodeRef 和旧审批仍不可复用。
5. 可见交互 iframe、开放 Shadow Root 和疑似交互的封闭 Shadow Host 都产生边界诊断并暂停。

### Embedding 测试

1. 83 项输入产生严格的 `[32, 32, 19]` 调用序列，输出顺序不变。
2. 多个字段并发解析时 Provider 的最大活动调用数为 1。
3. 并发首次解析只构建一次本体索引。
4. 并发 Fact 搜索只构建一次相同配置与 revision 的索引。
5. 第二批网络失败时不调用 DeepSeek，不激活部分索引。
6. 健康但歧义的召回只把 Top-3 传给 DeepSeek。
7. DeepSeek 返回 Top-3 之外的 semantic 时结果保持 unresolved。

### 集成与真实回归

- 合成 ATS 增加 DOM 插入/重排、延迟回滚、Challenge、iframe 和 Shadow DOM 场景。
- Moka/DJI 回归验证工作/实习分流、复杂选择器、日期、语言能力和 Runtime P0。
- 所有合成与真实测试都断言 `submissionCount === 0`。
- 真实页面只执行到最终审核，不点击、不批准最终提交控件。

## 验收标准

- 动态 DOM 后旧 `NodeRef` 失效，绝不写入同序号新控件。
- 受控组件在两个稳定窗口后仍保持目标值才报告成功。
- CAPTCHA、403、429、设备验证和风控进入持久化的 `awaiting_challenge`。
- Challenge 结束后只有用户显式继续才能重新观察、规划和授权。
- iframe 和 Shadow DOM 边界被展示并暂停，不会被解释为无字段。
- 83 项本体按 `32/32/19` 分批，Provider 最大并发为 1。
- 本体索引与 Fact Index 的并发首次构建均为 singleflight。
- Embedding 基础设施失败不触发 DeepSeek；歧义仲裁只接收健康 Top-3。
- Moka/DJI 自动填写停在最终审核，最终提交次数始终为 0。
