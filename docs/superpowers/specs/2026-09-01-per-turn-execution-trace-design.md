# 每轮对话执行轨迹设计

## 1. 背景

当前对话页已经通过 SSE 展示招聘入口搜索、确认和岗位推荐等处理阶段，但 `ConversationProcessChain` 位于整个消息列表上方，事件只按 `conversationId` 聚合。多轮对话发生后，用户无法判断某个步骤属于哪条消息，同名阶段还会被全局合并。

本期将执行过程改为每轮对话独立的执行轨迹。轨迹紧跟在对应的用户消息下方，使用纵向流程点和连接线，不使用卡片容器，从视觉上与用户及助手的对话气泡区分。

## 2. 目标

1. 每条触发服务端处理的用户消息都有独立执行轨迹。
2. 轨迹展示真实的处理阶段和工具调用，而不是静态模拟进度。
3. 展示意图理解摘要、工具名称、脱敏调用参数、结果摘要、耗时、等待确认和失败原因。
4. 运行中或等待用户确认的轨迹自动展开；结束后的轨迹默认折叠，用户可以手动展开。
5. 页面刷新或 SSE 重连后，历史轨迹仍能按原消息恢复。
6. 保留现有岗位匹配、岗位筛选确认、受控投递、人工接管和最终提交锁定逻辑。

## 3. 非目标

- 不展示模型的逐字隐性思维链、内部提示词、模型原始输出或未经整理的推理内容。
- 不展示 API Key、Authorization、Cookie、完整简历内容、个人敏感字段或原始工具报文。
- 不实现企业招聘状态跟踪、轮询、Webhook 或通知。
- 不改变岗位匹配评分、推荐排序、用户确认边界和最终投递授权规则。
- 不把执行轨迹作为业务成功依据；轨迹写入失败不得改变对话和投递结果。

## 4. 核心决策

### 4.1 以用户消息序号归属执行轨迹

每个过程事件新增 `turnSequence`，值为该轮用户消息在会话中的 `sequence`。服务端在调用 ConversationGraph 前已经计算出 `nextSequence`，因此搜索、工具调用和响应生成开始前就能确定归属。

前端按 `conversationId + turnSequence` 分组事件，并把轨迹插入对应用户消息之后、助手响应之前。这样不依赖事件到达顺序，也不需要用文本或时间戳猜测归属。

确认按钮触发的操作同样视为一轮用户消息。前端立即插入与服务端确认文案一致的乐观用户消息，服务端使用该消息的 `turnSequence` 发布事件。刷新后，以数据库中的正式消息替换乐观消息。

### 4.2 以步骤标识更新同一个流程点

每个事件新增 `stepId`。同一步骤从 `running` 变为 `completed`、`waiting` 或 `failed` 时复用同一个 `stepId`。前端按 `stepId` 保留最新状态，并按该步骤第一次出现的事件顺序排列。

这比现有的“按 stage 取最后一个事件”更准确：同一轮可以多次调用同一种工具，每次调用也能保留独立流程点。

### 4.3 只展示可审计执行摘要

过程事件由业务节点和工具适配器显式生成。意图理解只输出结构化结论，例如“识别到公司：百度；招聘类型：校园招聘”，不输出模型的内部推理文本。

工具参数和结果通过每个工具自己的摘要器生成，只允许输出白名单字段。事件总线不接收原始请求、响应或密钥，因此前端不存在误展示原始敏感报文的路径。

## 5. 事件契约

在现有 `ConversationProcessEvent` 基础上扩展：

```ts
type ConversationProcessStatus =
  | "running"
  | "completed"
  | "waiting"
  | "failed";

type ConversationProcessToolSummary = {
  name: string;
  input: Array<{ label: string; value: string }>;
  result?: string;
};

type ConversationProcessEvent = {
  id: string;
  conversationId: string;
  turnSequence: number;
  stepId: string;
  type: "process_changed";
  stage: ConversationProcessStage;
  status: ConversationProcessStatus;
  summary: string;
  tool?: ConversationProcessToolSummary;
  durationMs?: number;
  failure?: {
    code: string;
    summary: string;
    retryable: boolean;
  };
  createdAt: string;
};
```

约束如下：

- `turnSequence` 必须为正整数，并指向用户角色消息。
- `stepId` 在单轮内稳定，长度受限，不包含密钥或用户内容。
- `summary`、工具输入值、结果摘要和失败摘要均限制长度并去除控制字符。
- `durationMs` 仅在步骤结束时写入，必须为非负整数。
- `failure` 只允许稳定错误码和面向用户的原因摘要，不包含堆栈或内部地址。
- `tool.name` 来自工具名称白名单，不能直接使用外部页面或模型生成的名称。
- `tool.input` 是已脱敏的展示字段，不是原始调用参数。

首期沿用现有招聘流程 stage，并补充链接校验、浏览器读取、岗位匹配和响应生成所需 stage。stage 只表达用户可理解的业务阶段，具体工具名称由 `tool.name` 表达。

## 6. 服务端设计

### 6.1 事件持久化

`conversation_process_events` 增加以下字段：

- `turn_sequence INTEGER NOT NULL`
- `step_id TEXT NOT NULL`
- `summary TEXT NOT NULL`
- `details_json TEXT NOT NULL DEFAULT '{}'`

`details_json` 只保存通过合约校验的 `tool`、`durationMs` 和 `failure`。增加 `(conversation_id, turn_sequence, id)` 索引以支持会话重放后按轮归组。现有历史裁剪和 `history_reset` 机制继续保留。

旧事件没有可靠的消息归属，不能安全回填。迁移时只清空升级前的 `conversation_process_events` 和游标，再建立新结构；会话消息、上下文、确认记录、岗位匹配和投递任务不受影响。升级后的新事件全部要求正数序号，避免展示猜测出来的错误历史。

### 6.2 事件总线

`ConversationProcessEventBus.emit` 改为接收结构化输入，而不是分散的 `conversationId/stage/status` 参数。事件总线负责：

- 合约校验；
- 持久化和历史裁剪；
- SSE 发布；
- 对单字段长度和 JSON 总大小设置上限。

事件写入和 SSE 发布仍是 best effort。异常被捕获并记录稳定错误码，不中断 ConversationGraph。

### 6.3 ConversationGraph 与工具边界

`ConversationGraphInput` 增加必填 `turnSequence`。服务层在文本消息和确认操作两条路径中，都在调用 graph 前确定该值。待确认记录同时保存 `sourceTurnSequence`，使下一轮确认开始时能够准确结束上一轮的等待步骤，而不是通过时间戳猜测来源。

Graph 使用轻量过程记录器：

```ts
const step = processTrace.start({
  turnSequence,
  stepId: "recruitment-search-1",
  stage: "searching_recruitment_site",
  summary: "正在搜索百度校园招聘入口",
  tool: summarizeTavilyInput(searchInput)
});

step.complete({
  summary: "找到 3 个候选入口",
  tool: summarizeTavilyResult(result)
});
```

记录器计算耗时并保证 start/complete/fail 使用相同 `stepId`。等待用户确认使用 `waiting` 状态；下一轮确认开始时，先结束上一轮的等待步骤，再为当前确认轮创建新步骤。

每个真实工具适配器提供独立摘要器：

- Tavily：公司名、招聘类型、搜索结果数量、选中的公开域名；不包含 API Key 和完整 Remote MCP URL。
- URL Guard：协议、公开网络校验结论和规范化域名；不包含 DNS 或内部网络诊断细节。
- Browser Worker：正在打开的公开招聘域名、页面读取结果数量和人工接管状态；不包含 Cookie、表单原始值或截图正文。
- 岗位匹配：候选岗位数量、过滤数量和匹配完成状态；不复制完整简历。
- 投递进度：本系统任务数量和查询结果摘要；不声称同步企业招聘状态。

## 7. 前端设计

### 7.1 消息与轨迹编排

移除消息区顶部的全局 `ConversationProcessChain`。消息列表根据用户消息序号组装每轮内容：

```text
用户消息气泡
  纵向流程点轨迹
助手消息气泡或确认卡片
```

每轮轨迹使用新的 `ConversationTurnTrace` 组件。组件只接收该轮事件，不读取整个会话状态。SSE 连接状态保留在对话页标题区域或轨迹的轻量错误状态中，不再占用独立过程卡片。

### 7.2 视觉规则

- 轨迹无外框、无填充背景、无阴影和圆角卡片。
- 左侧使用 18px 流程点和 1px 连接线；完成、运行、等待和失败同时使用图标、文字与颜色区分。
- 标题行展示步骤名称，右侧展示耗时或“进行中”。
- 摘要放在步骤名称下方。
- 工具名称使用图标加文字，不使用胶囊标签。
- 工具输入和结果以流程点下方缩进明细显示，使用细虚线作为层级提示，不再包裹成卡片。
- 删除“可审计执行摘要 · 隐私内容和密钥已隐藏”提示文案。
- 对话气泡保留现有蓝白风格，确保对话内容与执行轨迹一眼可区分。

### 7.3 展开和折叠

- 存在 `running` 或 `waiting` 步骤时自动展开。
- 该轮首次到达终态后保持展开，避免结果瞬间消失；用户继续下一轮或重新进入页面时，已结束轨迹默认折叠。
- 折叠行展示“执行完成 · N 步 · X 秒”或“执行失败 · 原因摘要”。
- 用户手动展开或折叠后，在该轮状态不变时保留用户选择。
- 展开按钮使用原生 `button`，提供 `aria-expanded` 和明确可访问名称。

### 7.4 SSE 重连与历史恢复

前端继续使用一个会话级 SSE 连接接收事件，但存储结构改为按 `turnSequence` 分组。事件使用 `id` 去重，使用 `stepId` 合并状态。

发生 `history_reset` 时，清空本地过程事件并接受服务端重放；消息记录不受影响。如果某轮事件因历史裁剪不完整，该轮不展示残缺轨迹，也不把事件错误归到其他消息。

## 8. 失败与边界状态

- 工具失败：当前流程点标记失败，展示稳定失败摘要和是否可重试；助手消息仍给出可恢复操作。
- SSE 断开：正在运行的轨迹保留最后状态，并在对话标题显示连接已中断；不得把运行步骤误标为失败。
- 对话请求失败且没有服务端终态事件：前端将该轮显示为“请求未完成”，同时保留已有真实步骤。
- 未识别意图或普通问答：仍展示“理解请求”和“生成回复”两个流程点，满足每轮可见，但不虚构工具调用。
- 用户快速重复提交：沿用会话锁和幂等键；每个有效请求拥有独立 `turnSequence`，重复请求不产生第二条轨迹。

## 9. 兼容边界

- 招聘入口仍由 Tavily Remote MCP 发现，并经过 URL 安全校验和用户确认。
- 未确认招聘入口前不启动 Browser Worker、岗位匹配或投递任务。
- 岗位推荐后仍由用户选择岗位，受控投递仍保留字段回读、风险控制、登录/验证码人工接管和最终提交硬锁。
- 执行轨迹只描述本系统内部操作，不查询、推断或展示企业招聘系统中的后续状态。

## 10. 测试策略

### 10.1 合约与数据库

- 合约接受合法的 `turnSequence`、`stepId`、摘要、工具详情、耗时和失败信息。
- 合约拒绝负耗时、超长摘要、未知状态和未脱敏的非白名单结构。
- 数据库迁移创建新增字段和索引，并兼容已有数据库。
- 事件总线持久化、裁剪、重放和订阅后保留完整轮次字段。

### 10.2 服务端

- 普通问答、招聘入口搜索、用户确认、岗位推荐、投递进度和失败路径都发布对应轮次事件。
- 同一工具多次调用拥有不同 `stepId`，同一步骤的状态更新复用 `stepId`。
- Tavily、URL Guard、Browser Worker 和岗位匹配摘要不含密钥、Cookie、简历正文或原始报文。
- 事件发布失败不改变 ConversationGraph 的业务响应。
- 幂等重试不创建重复执行轨迹。

### 10.3 前端

- 每轮轨迹显示在对应用户消息后，且不会跨轮合并。
- 运行中和等待确认自动展开，历史终态默认折叠，手动展开状态可保持。
- 重复 stage 和重复工具调用按 `stepId` 分别展示。
- 工具名称、脱敏参数、结果摘要、耗时和失败原因正确渲染。
- 无工具普通问答仍显示最小两步轨迹。
- SSE 断开、重连、重放和 `history_reset` 不造成重复或错位。
- 320px、常规桌面宽度下无文字溢出、遮挡或横向滚动。

### 10.4 回归

- 现有 ChatHome、会话持久化、招聘入口搜索和确认测试继续通过。
- 岗位匹配、岗位选择、Browser Worker、受控填写、人工接管和最终提交锁定测试继续通过。
- 不新增企业招聘状态跟踪相关 API、数据库表或界面。

## 11. 验收标准

1. 用户发送任意有效消息后，其消息下方立即出现独立执行轨迹。
2. 两轮连续对话的流程点不会合并或互相覆盖。
3. 招聘入口搜索能显示 Tavily 调用摘要、候选结果摘要、URL 校验和等待确认。
4. 开始岗位推荐能显示 Browser Worker 和岗位匹配的真实执行阶段。
5. 运行中轨迹展开，历史完成轨迹折叠，用户可以查看每一步详情。
6. 界面使用流程点而非执行过程卡片，并且不显示已删除的隐私提示文案。
7. 页面刷新和 SSE 重连后，轨迹仍附着于正确消息。
8. 任何执行轨迹都不包含隐性思维链、密钥、Cookie、完整简历或原始工具报文。
9. 现有岗位匹配和受控投递安全边界保持不变。
10. 本期未实现企业招聘状态跟踪。
