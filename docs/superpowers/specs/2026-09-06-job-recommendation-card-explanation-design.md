# 岗位推荐体验与声明式投递 Skill 自动进化设计

本设计包含两个连续阶段：第一部分优化岗位推荐卡片和匹配度解释；第二部分建设按招聘网站划分、可自动演化和自动选择最优版本的声明式投递 Skill 系统。两个阶段共享“结果可审计、最终提交必须由用户确认”的安全原则，但可以独立实施和验收。

## 第一部分：岗位推荐卡片与匹配度解释

### 背景

当前岗位推荐卡片同时展示公司、地点、用工类型、来源、满足/未知/冲突数量和一条内部证据摘要，信息密度过高。展开详情后还会直接出现 `Profile fact education[0].degree` 等内部字段路径，普通用户无法理解。

此外，卡片展示的是 `fitScore`，列表排序主要依据 `rankingScore`，因此页面不能严格保证显示的是“匹配度最高的六个岗位”。现有评分还会给“资料不足、无法判断”的要求计入 50% 得分，容易在简历证据较少时抬高匹配度。

### 目标

1. 岗位推荐区域严格展示匹配度最高的六个岗位。
2. 收起状态的岗位卡片只展示岗位名称、匹配度和三个操作入口。
3. 展开状态使用自然中文解释匹配优势、待确认条件、差距与风险以及分项得分。
4. 显示的百分比与排序使用同一个可审计评分结果。
5. 保留岗位选择、冲突确认、陈旧结果保护和禁止自动投递等既有安全行为。

### 非目标

- 不调整岗位抓取、筛选和翻页逻辑。
- 不使用大模型临时生成每张卡片的评分说明。
- 不自动补全用户资料，也不把“资料不足”推断为“满足”。
- 不改变“选择岗位后仍需用户明确确认才能开始投递”的流程。

### 用户体验

#### 收起状态

每张卡片只展示：

- 岗位名称；
- `匹配度 NN%`；
- `查看详情`；
- `选择此岗位`；
- `岗位页面`。

公司、地点、用工类型、来源、匹配统计和证据摘要不再出现在收起状态。已选择、结果陈旧、冲突确认和操作错误属于必要状态反馈，可以在对应状态发生时临时显示，不视为常驻卡片信息。

#### 展开状态

详情在当前卡片内部展开，包含四个区块：

1. **匹配优势**：只展示被已确认简历资料或求职偏好明确支持的岗位条件。
2. **待确认条件**：展示岗位提出、但当前资料不足以判断的条件。
3. **差距与风险**：展示与必选求职偏好或已确认资料明确冲突的条件。
4. **匹配度如何得出**：展示每个参与评分维度的实际得分、满分以及最终总分。

所有文案必须是面向用户的自然中文，不允许显示内部 requirement ID、evidence ID、JSON 路径或 `Profile fact ...` 等实现细节。

### 评分规则

评分维度的基础权重保持不变：

| 维度 | 基础权重 |
| --- | ---: |
| 技能 | 35 |
| 工作职责 | 25 |
| 项目经验 | 20 |
| 基本条件（学历、专业、工作年限） | 10 |
| 求职偏好（地点、岗位类型、行业、工作方式、薪资） | 10 |

只对岗位实际包含的维度计分。缺失维度从分母中移除，其余维度按基础权重比例归一化到 100 分。同一维度包含多条要求时，维度权重平均分配给这些要求。

每条要求的得分改为：

- 明确满足：获得该要求的全部权重；
- 资料不足：0 分，并归入“待确认条件”；
- 明确冲突：0 分，并归入“差距与风险”。

`fitScore` 等于所有要求实际得分之和乘以 100，并保留两位小数；卡片使用四舍五入后的整数百分比。详情展示各维度实际得分与归一化后的维度满分，分项和总分必须来自同一次后端评分，前端不得重复实现评分公式。

### 排序与数量限制

后端推荐结果和前端防御性排序均使用以下稳定顺序：

1. `fitScore` 降序；
2. `confidence` 降序；
3. `canonicalUrl` 字典序升序。

前端排序后截取前六个结果。冲突岗位不再被人工移动到普通岗位之后；其位置由匹配度决定，但选择时继续要求用户确认冲突。

### 数据模型

后端评分结果增加结构化、可持久化的评分解释。每个维度至少包含：

- 稳定维度代码；
- 中文维度名称；
- 实际得分；
- 该维度归一化后的满分；
- 满足、待确认和冲突的要求数量。

要求说明继续关联原岗位要求，但显示文案由后端生成。匹配证据摘要应使用用户可理解的资料标签和已确认值，例如“你的专业‘软件工程’符合岗位专业要求”，而不是暴露 `education[0].major`。

评分解释字段在读取历史数据时允许缺失。前端遇到旧结果时显示“此结果使用旧版评分，重新匹配后可查看分项说明”，而不是在客户端推测旧版分项得分。

### 组件边界

- `@resume/job-matching` 负责评分、分项汇总和稳定排序。
- API 岗位匹配子图负责把岗位要求与已确认资料转换为自然中文证据摘要。
- `@resume/contracts` 定义评分分项的持久化契约，并兼容旧结果。
- Web 岗位卡片只负责前六筛选、状态交互和结构化详情渲染，不复制后端评分公式。

### 错误与安全处理

- 岗位没有可评分要求时，保持可预测的 0% 结果并在详情说明资料不足，不生成虚假优势。
- 评分分项缺失或格式不合法时按旧结果处理，不能阻塞页面渲染。
- 陈旧结果仍不可选择；冲突结果仍需二次确认。
- `岗位页面`继续使用新标签页打开原始招聘地址。
- 本功能不会触发创建投递任务或最终提交。

### 测试策略

采用测试驱动开发：

1. 在岗位匹配包中先写失败测试，证明 unknown 从 50% 改为 0%、分项得分正确、缺失维度会归一化，以及排序严格按 `fitScore`、`confidence`、URL 执行。
2. 在契约层增加新旧评分结果解析测试，确保历史结果兼容。
3. 在 API 子图测试中证明用户可见摘要不包含内部字段路径，并能输出中文资料标签和值。
4. 在 Web 组件测试中证明收起卡片只保留指定信息，展开详情包含四个中文区块，旧结果显示重匹配说明，结果按匹配度排序且最多六个。
5. 运行会话岗位推荐端到端测试，验证查看详情、岗位选择和岗位页面链接，并确认没有自动创建或提交投递。

### 验收标准

- 页面最多显示六个岗位，且顺序与显示的匹配度一致。
- 卡片收起状态没有公司、地点、用工类型、来源、匹配统计或证据摘要。
- 详情中不存在 `Profile fact`、数组路径、内部 ID 或 reason code。
- 资料不足不再贡献匹配分，并明确展示为待确认条件。
- 每个参与维度的分项得分相加后与后端 `fitScore` 一致。
- 旧结果可正常显示，并明确提示重新匹配后查看新版说明。
- 选择岗位和冲突确认行为保持不变，测试期间不发生真实投递。

## 第二部分：声明式投递 Skill 自动进化

### 背景与依据

当前系统已经具备浏览器观察和执行工具、Application Agent、TraceSink、LangSmith 脱敏投影、全页审计、读回验证、ApprovalGate 和 execution epoch，但尚未具备一等的投递 Skill 定义、注册、版本谱系、运行时选择、评测、自动晋升与回滚机制。现有站点适配代码属于固定实现，不是可独立演化的 Skill。

本部分参考 MindSpore AKG Skill Evolution 的“实践→总结→复用”闭环、演化链压缩、失败→成功经验提取、经验去重合并和 A/B 测试机制，并将单一性能指标替换为投递场景中的安全、正确性、完整率和效率字典序。[参考文档](https://github.com/mindspore-ai/akg/blob/master/akg_agents/docs/v2/SkillEvolution.md)

### 目标

1. 每个招聘网站拥有独立、声明式、不可变版本的投递 Skill。
2. 每次投递执行都绑定明确的 Skill ID、版本和页面指纹，并可从 TraceSink 完整追溯。
3. Evolution Agent 能从优胜演化链和失败→成功记录中生成受 Schema 约束的候选 Skill。
4. 候选 Skill 经过自动校验、历史回放、合成站测试和在线 Champion–Challenger 评测后自动晋升或回滚，不要求人工批准。
5. 自动进化不能改变最终提交确认、授权、隐私、域名和审计等固定安全规则。

### 非目标

- 第一版不允许 Skill 携带任意 JavaScript、TypeScript、XPath、系统命令或网络请求。
- 不让 LLM 直接覆盖生产 Skill，也不根据单次成功自动晋升版本。
- 不把招聘结果、面试邀请或 Offer 作为填写 Skill 的即时奖励；这些结果受到岗位质量和候选人背景等大量外部因素影响。
- 不允许 Skill 决定是否最终提交申请。
- 不在第一版建设跨网站通用 Skill；百度、Moka、大疆等网站分别维护谱系。

### 总体架构

在线执行路径为：

```text
站点与页面指纹
→ Skill Selector
→ Skill Interpreter
→ 固定安全内核
→ 浏览器执行
→ 写入后读回与全页审计
→ SkillExecutionRecord
```

离线进化路径为：

```text
TraceSink 本地事实 + LangSmith 聚合结果
→ Evolution Collector
→ 演化链/失败成功对压缩
→ LLM 生成受约束补丁
→ 候选 Skill
→ 历史回放和合成站测试
→ Challenger
→ 小流量真实填写
→ Champion 或 Quarantined
```

主要组件职责如下：

- **Skill Registry**：保存不可变 Skill 版本、父子谱系、状态、适用页面指纹和评测摘要。
- **Skill Selector**：根据网站、页面指纹和稳定任务分流选择 Champion 或 Challenger。
- **Skill Interpreter**：把声明式流程转换为现有 `ApplicationTools` 能理解的计划，不直接操作浏览器。
- **固定安全内核**：继续负责 NodeRef、snapshot、execution epoch、approval、域名、文件和终态提交限制。
- **Evaluation Engine**：把执行事实转换为可比较的硬约束和软指标，并决定候选状态转换。
- **Evolution Agent**：聚类审计问题、压缩演化记录并让 LLM 生成结构化 Skill 补丁。
- **Replay Corpus**：保存脱敏页面结构和预期结果，支持训练集与留出集回放。
- **LangSmith**：负责跨任务聚合、失败聚类和版本分析；本地 TraceSink 仍是可重放事实源。

### 声明式 Skill Schema

Skill 分为不可进化元数据和可进化流程内容。

不可进化元数据由 Registry 维护：

```yaml
id: moka-application
site: moka
allowedDomains:
  - "*.mokahr.com"
schemaVersion: 1
version: 1.2.1
parentVersion: 1.2.0
contentHash: "sha256:..."
```

LLM 不能修改站点身份、允许域名、Schema 主版本、父版本或内容哈希。新站点和域名只能通过系统配置注册，不能由演化流程自行扩展。

可进化内容示例：

```yaml
pageVariants:
  - id: work-experience-v3
    match:
      urlPatterns: ["/candidate/apply/**"]
      requiredTexts: ["工作经历"]
      requiredFields:
        - semantic: work.company
        - semantic: work.startDate

fields:
  work.endDate:
    labels: ["结束时间", "离职时间"]
    controlTypes: [month, date]
    locators:
      - by: label
        value: "结束时间"
      - by: label
        value: "离职时间"

workflow:
  - id: fill-work-experience
    when:
      pageVariant: work-experience-v3
    actions:
      - capability: fill_empty_fields
        fieldGroup: work
      - capability: readback
      - capability: full_page_audit
    success: [required_fields_confirmed]
    next: continue_or_wait

recovery:
  field_missing:
    strategies: [reobserve, try_next_locator]
    maxAttempts: 2
```

Skill 允许描述页面指纹、字段标签、控件类型、受限定位提示、页面阶段、固定能力调用顺序、成功条件和有上限的恢复策略。定位优先使用 label、role、placeholder 和稳定属性；CSS 仅作为受限的最后一级提示。

Skill 不允许包含任意脚本、实际简历值、任意 URL 跳转、自定义网络请求、approval、最终提交能力、关闭审计的选项或评价权重。条件表达式使用有限布尔 DSL，不执行代码。

候选内容依次接受：

1. JSON Schema 校验；
2. 状态可达性、终点和重试上限等语义校验；
3. 能力、域名和权限不能超出父版本及固定安全策略的安全校验；
4. 规范化序列化并计算内容哈希，确保相同内容只有一个身份。

### 数据模型与状态

核心持久化实体包括：

- `SkillVersion`：ID、网站、版本、父版本、Schema 版本、内容、哈希、状态和创建来源。
- `SkillPageBinding`：Skill 版本与页面指纹的适用关系。
- `SkillExecutionRecord`：任务、Skill 版本、页面指纹、步骤结果和脱敏评测输入。
- `SkillEvaluation`：回放或在线样本的硬约束、软指标和比较结果。
- `SkillEvolutionRun`：触发原因、输入记录、LLM 输出、候选版本和最终状态。
- `SkillTrafficAllocation`：页面指纹下 Champion、Challenger 和稳定分流比例。

Skill 状态机为：

```text
candidate
→ replay_qualified
→ challenger
→ champion
→ retired

任意验证或运行阶段发生硬失败
→ quarantined
```

版本不可原地修改。回滚通过重新指向上一 Champion 完成，失败版本保留用于审计和防止重复生成同类缺陷。

### 执行记录与隐私

每次运行记录：网站、页面指纹、Skill ID/版本、能力步骤、字段识别数量、计划填写数量、成功读回数量、全页审计差异、重试与恢复次数、用户手动修改次数、完成状态、标准化失败原因和耗时。

TraceSink 不记录姓名、电话、邮箱、实际简历文本和原始控件值。Replay Corpus 只保留控件结构、语义标签、值类型、脱敏占位符、页面状态转换和预期动作。LangSmith 只接收现有安全投影及 Skill 版本、页面指纹哈希和汇总指标，不接收本地回放快照。

### Evolution Agent

Evolution Collector 按网站、页面指纹和标准化失败原因聚类。满足以下任一条件时创建进化运行：

- 最近 20 个同页面指纹的有效样本中，同类失败达到 3 次；
- 页面指纹发生漂移，当前没有可用 Champion；
- 某个 Challenger 明确优于父版本，但仍存在可归纳的重复恢复步骤。

Collector 生成三类输入：

1. **优胜演化链**：沿 Skill 父子树只保留评价结果严格改善的相邻版本差异。
2. **失败→成功对**：提取同类任务中最后失败版本与首次成功版本之间的完整声明式差异。
3. **经验合并**：按页面、字段和错误主题聚类，去重重复标签、指纹和恢复策略。

LLM 只输出满足 Evolution Patch Schema 的补丁，例如：

```yaml
baseVersion: 1.2.0
pageVariant: work-experience-v3
changes:
  - operation: add_field_label
    field: work.endDate
    value: "离职时间"
reason: repeated_field_missing
expectedEffect: improve_readback_coverage
```

补丁应用失败、超出父版本能力或产生相同内容哈希时跳过，不创建新版本。

### 离线回放与在线选择

候选版本先在触发样本和历史训练集上回放，再在按时间和页面指纹隔离的留出集上比较，避免只记住已知失败。随后运行合成招聘站测试。只有所有硬约束通过、相对 Champion 没有指标回退且至少一个软指标改善时，候选才成为 Challenger。

在线选择采用按任务 ID 哈希的稳定分流。同一任务从开始到释放始终使用同一 Skill 版本。Challenger 初始获得 10% 的同页面指纹任务，其余由 Champion 处理。

自动晋升规则为：

- Challenger 至少积累 10 个有效在线样本；
- 安全违规、错误字段写入和新增审计差异必须为 0；
- 对同页面指纹的任务级指标做分层 bootstrap，按字典序比较 Challenger 与 Champion；
- 第一个存在差异的软指标，其 95% 置信区间必须完全优于 Champion；
- 达到 50 个有效样本仍无法证明改善时，将候选退役而不是强行晋升；
- 任何硬失败都会立即停止 Challenger 分流、标记 `quarantined` 并恢复上一 Champion。

系统为每个页面指纹选择 Champion，而不是为整个网站维护唯一全局最优版本。旧页面和新版页面可以同时使用不同 Skill 版本。

### 评价规则

Evaluation Engine 使用固定、不可由 Skill 修改的字典序：

1. 安全违规数量，必须为 0；
2. 错误字段写入和全页审计差异，必须为 0；
3. 字段填写正确率，越高越好；
4. 必填字段完成率，越高越好；
5. 用户手动修改次数，越少越好；
6. 重试与恢复次数，越少越好；
7. 执行时间，越短越好。

只有前一项无差异或满足硬约束时才比较后一项。招聘结果、面试邀请和 Offer 不进入这一即时评分。

### 固定安全边界

以下规则位于 Skill Interpreter 之外，不能被 Skill、Evolution Agent 或晋升策略修改：

- 最终提交必须由用户对当前任务明确确认；
- Skill 不能创建、复制或伪造 approval；
- NodeRef、snapshot、execution epoch 和当前浏览器所有权必须有效；
- Skill 不能扩大站点域名、网络、文件或个人资料权限；
- 写入后读回和全页审计不能关闭；
- TraceSink 与 LangSmith 继续拒绝个人敏感信息；
- 恢复和重试受系统级上限约束；
- 终态提交按钮不属于声明式 Skill 的能力集合。

Skill 自动发布不等于岗位投递授权。Champion 的自动晋升只改变最终提交之前的页面填写策略。

### 失败处理

- 找不到匹配页面指纹时使用只观察、不写入的安全模式，并创建页面漂移进化任务。
- Skill 解释、Schema 或语义校验失败时不执行候选版本。
- LLM 不可用时继续使用现有 Champion，不阻塞正常投递。
- LangSmith 不可用时记录留在本地 outbox，Skill 执行和本地评测继续工作。
- Replay Corpus 样本不足时候选保持 `candidate`，不能直接进入在线流量。
- Champion 自身发生硬失败时停止自动填写并要求用户接管，不自动切换到未经验证的候选。

### 测试策略

采用测试驱动开发并按边界分层：

1. Contracts：Skill Schema、Evolution Patch、状态和执行记录的新旧兼容测试。
2. Registry：不可变版本、父子谱系、内容去重、原子状态转换、回滚和并发更新测试。
3. Interpreter：页面匹配、有限条件 DSL、能力白名单、重试上限和禁止最终提交测试。
4. Selector：按页面指纹选择、稳定任务分流、Champion/Challenger 隔离和无匹配时只观察测试。
5. Evaluation：字典序、硬失败隔离、bootstrap 晋升、样本不足和 50 样本退役测试。
6. Evolution：失败成功对、单调优胜链、结构化补丁校验、重复内容跳过和 LLM 不可用测试。
7. Replay：训练/留出隔离、脱敏快照、候选与 Champion 同输入比较测试。
8. 集成：TraceSink、LangSmith outbox、Skill 版本绑定、全页审计和自动回滚联调。
9. 浏览器端到端：合成 Moka/大疆页面上的 Challenger 分流、字段读回、页面漂移和禁止自动提交测试。

### 分阶段实施

1. **阶段 A：岗位推荐体验**——完成第一部分的卡片精简、评分修正和可读详情。
2. **阶段 B：Skill 基础设施**——完成 Schema、Registry、Interpreter、Selector 和 TraceSink 版本绑定；只运行人工编写的 Champion。
3. **阶段 C：离线进化**——完成 Replay Corpus、Evaluation Engine、Evolution Agent 和候选回放，不分配真实 Challenger 流量。
4. **阶段 D：在线自动晋升**——启用稳定 A/B 分流、统计晋升、隔离和自动回滚。

阶段必须顺序交付。阶段 B 的固定安全内核测试未通过前不能启用阶段 C；阶段 C 无法稳定复现 Champion/候选差异前不能启用阶段 D。

### 验收标准

- 每次填写运行都能追溯到唯一 Skill 版本和页面指纹。
- 声明式 Skill 无法表达任意代码、最终提交、权限扩大或关闭审计。
- 相同任务不会在执行过程中切换 Skill 版本。
- 候选版本只有通过 Schema、安全、历史留出回放和合成站测试后才能获得真实流量。
- 自动晋升遵循固定评价字典序和统计门槛，单次成功不会触发晋升。
- 任意安全违规、错误字段写入或新增审计差异会立即隔离候选并回滚。
- 页面没有可用 Skill 时系统只观察并请求用户接管，不尝试未验证填写。
- LangSmith 或 LLM 故障不会影响现有 Champion 的安全执行。
- 自动演化和自动晋升不会绕过每次投递的最终用户确认。
