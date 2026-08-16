# 岗位匹配与推荐设计

日期：2026-08-16  
状态：已批准  
首期范围：Moka/Mokahr 中文岗位页面与 DJI 招聘路径

## 背景

当前系统已经具备候选人档案、知识库检索、受控 Browser Worker 和 `ApplicationTask` 投递流程。现有流程从明确岗位进入申请表单，负责字段解析、内容审阅和受控填写；它不负责从岗位列表中发现、比较和选择岗位。

本设计增加独立的岗位匹配能力：系统根据知识库中用户确认的岗位期望操作招聘网站筛选器，读取筛选后的全部岗位，对岗位要求与候选人档案进行可解释匹配，并等待用户显式选择。用户选定岗位后，系统才创建现有投递流程能够接管的 `ApplicationTask`。

岗位发现、提取、匹配和选岗不得塞入 `ApplicationService`。两条流程只在“用户已确认岗位并创建待审阅投递任务”这一边界相接。

## 目标

1. 从岗位列表页、岗位详情页和申请表单页自动识别正确入口。
2. 使用知识库中用户确认的结构化岗位期望生成可审阅的 ATS 筛选条件。
3. 在明确预算和恢复语义下读取筛选后的全部岗位，而不是只读取首屏或固定 Top-N。
4. 使用确定性、可版本化的规则和混合召回产生可解释排序。
5. 仅在双方信息均明确且互斥时判定硬冲突；未知条件继续参与排序，但降低置信度。
6. 保存岗位、证据、差距、评分版本和会话游标，使整个会话在应用重启后恢复。
7. 由用户显式选岗；明确冲突岗位必须额外确认。
8. 保持现有最终提交双重禁止，所有验收路径中 `submissionCount === 0`。

## 非目标

- 不自动替用户选择岗位。
- 不自动申请，不点击或批准最终提交控件。
- 不扩展 Moka/Mokahr 和 DJI 之外的正式 ATS 支持声明。
- 不破解 CAPTCHA，不绕过 403、429、设备验证、扫码、隐私同意或风险控制。
- 不读取或存储原始 DOM、CSS selector、浏览器配置、验证码文本或完整简历。
- 不引入 BM25、BGE-Reranker、Langfuse、Browser-Use 或 LangGraph。
- 不让 DeepSeek 生成候选人经历、修改明确事实、决定淘汰或改变排名。
- 不在本功能中重构现有 `ApplicationService`；只复用稳定的基础设施边界。

## 核心边界

### `JobMatchSession`

`JobMatchSession` 是独立、持久化、可恢复的聚合根，只负责：

- 入口识别；
- 岗位期望快照；
- ATS 筛选确认与执行；
- 岗位分页提取和去重；
- 岗位要求归一化；
- 匹配、解释和排序；
- 暂停、恢复和选岗；
- 将已确认岗位转换为待审阅 `ApplicationTask`。

它不解析或填写申请表单，也不持有最终提交权限。

### 与 `ApplicationTask` 的衔接

只有处于 `selected` 的会话可以执行转换。转换事务：

1. 校验会话版本、结果版本、岗位内容哈希和冲突确认版本。
2. 创建或返回同一幂等键对应的 `ApplicationTask`。
3. 将任务置于现有流程的待打开/待审阅起点。
4. 将会话推进到 `converted_to_application` 并保存 `applicationTaskId`。

转换不调用 Browser Worker 写入能力，不打开最终提交权限，也不增加提交计数。

## 入口识别

版本化 `JobAdapter` 根据受限页面快照返回一种入口：

```ts
type JobEntryKind = "job_list" | "job_detail" | "application_form";
```

- `job_list`：创建多岗位匹配会话，先进入筛选确认。
- `job_detail`：创建单岗位匹配会话，跳过网站列表筛选，只提取当前岗位。
- `application_form`：不创建岗位匹配会话，直接进入现有投递流程。

入口无法可靠识别时明确失败为 `unsupported_job_entry`，不得猜测后继续操作。

## 状态机

正常状态流：

```text
created
  -> awaiting_filter_confirmation
  -> opening_job_page
  -> awaiting_login
  -> applying_filters
  -> extracting_jobs
  -> matching_jobs
  -> awaiting_job_selection
  -> selected
  -> converted_to_application
```

辅助和终止状态：

- `awaiting_challenge`：遇到 CAPTCHA、403、429、设备验证、风险控制或不支持 DOM 边界。
- `paused`：用户暂停或读取预算用尽后保存进度。
- `failed`：Adapter 契约、数据完整性或不可恢复依赖错误。
- `cancelled`：用户取消。
- `expired`：来源岗位或会话超过保留策略，不能继续执行。

状态约束：

- 岗位列表页按完整正常状态流执行；岗位详情页从 `created` 直接进入 `opening_job_page`，不进入筛选确认和筛选执行状态。
- 页面已登录时从 `opening_job_page` 直接进入 `applying_filters` 或 `extracting_jobs`；只有检测到登录要求时才进入 `awaiting_login`。
- `awaiting_filter_confirmation` 必须由用户显式确认后才能操作网站筛选器。
- `awaiting_login` 和 `awaiting_challenge` 不自动恢复；用户处理后必须显式继续。
- 恢复总是从新的页面观察和 Adapter 识别开始，旧执行权限不恢复。
- `paused` 保留游标和已提取结果，继续时从持久化游标开始新预算。
- 档案、岗位期望或评分版本变化不删除旧结果，而是标记 `stale`；重新匹配必须由用户显式触发。
- P0 不按时间自动过期会话；只有在用户恢复时确认来源岗位已删除或规范 URL 永久失效，才进入 `expired`。
- 终止状态不持有浏览器所有权租约。

## 岗位期望

知识库保存用户确认的结构化期望：

```ts
interface JobExpectationCriterion {
  kind:
    | "target_role"
    | "location"
    | "employment_type"
    | "industry"
    | "work_mode"
    | "salary";
  values: string[];
  strength: "required" | "preferred";
}

interface JobExpectationSnapshot {
  revision: number;
  criteria: JobExpectationCriterion[];
  confirmedAt: string;
}
```

创建会话时复制不可变快照。UI 在执行网站筛选前展示快照和 Adapter 可映射结果，允许用户修改；确认会产生新的会话内快照版本，不直接静默改写知识库。

Adapter 只操作能够稳定映射的网站筛选条件。无法映射的 `required` 和 `preferred` 条件仍在本地匹配阶段生效，并在 UI 中标记为“网站未筛选，本地判断”。

## 岗位数据契约

```ts
interface JobPosting {
  id: string;
  source: "moka" | "dji";
  sourceJobId?: string;
  canonicalUrl: string;
  title: string;
  organization: string;
  location?: string;
  employmentType?: string;
  description: string;
  requirements: JobRequirement[];
  adapterVersion: string;
  contentHash: string;
  extractedAt: string;
}

interface JobRequirement {
  id: string;
  category:
    | "skill"
    | "responsibility"
    | "project"
    | "education"
    | "major"
    | "experience_years"
    | "location"
    | "employment_type"
    | "industry"
    | "work_mode"
    | "salary"
    | "other";
  normalizedValue: string;
  required: boolean;
  sourceEvidence: string;
}
```

`sourceEvidence` 是受长度限制的岗位文本片段，不包含 DOM、selector 或坐标。`contentHash` 覆盖所有影响匹配的归一化字段；岗位内容变化必须产生新哈希和新结果版本。

## 持久化模型

新增表：

- `job_match_sessions`：状态、版本、入口、当前阶段、依赖版本、选中结果和投递任务引用。
- `job_match_expectation_snapshots`：会话内不可变岗位期望快照。
- `job_postings`：按来源、规范 URL、来源岗位 ID 和内容哈希保存归一化岗位。
- `job_match_results`：分数、置信度、三态结果、证据、差距、版本和过期标记。
- `job_extraction_cursors`：页码/游标、连续无新增次数、预算消耗和继续令牌。
- `job_match_events`：只追加的结构化会话事件。

所有表使用现有数据库迁移机制。仓储写入会话版本时采用乐观并发控制；版本不一致返回 `job_match_version_conflict`，不覆盖较新状态。

## ATS Job Adapter

首期提供版本化 Adapter：

```ts
interface JobAdapter {
  source: "moka" | "dji";
  version: string;
  identify(snapshot: JobPageSnapshot): JobEntryKind | "unsupported";
  mapFilters(expectation: JobExpectationSnapshot): FilterPlan;
  extractList(snapshot: JobPageSnapshot): ExtractedJobPage;
  extractDetail(snapshot: JobPageSnapshot): JobPostingDraft;
}
```

Browser Worker 只返回结构化 `JobPageSnapshot`：页面种类、脱敏可见字段、分页信息、筛选回读和有限挑战诊断。它不得返回原始 DOM、selector、浏览器配置或用户输入。

### 筛选执行

1. API 生成 `FilterPlan` 并等待用户确认。
2. 获取全局浏览器所有权租约并打开岗位页。
3. Browser Worker 依据 Adapter 操作已确认筛选。
4. 每次筛选写操作后回读当前筛选状态。
5. 回读不一致时明确失败；写操作不得盲目重试。
6. 网站未支持的条件进入本地硬冲突和偏好判断。

匹配会话和投递任务共享同一个浏览器所有权租约。租约标识 `ownerKind: "job_match" | "application"` 和 `ownerId`，任何时刻只允许一个所有者执行浏览器动作。

### 分页与读取预算

每次提取运行使用以下默认保护值，部署配置可以收紧但不能取消：

- 最多 100 个分页推进；
- 最多 15 分钟；
- 最多新增 2,000 个唯一岗位；
- 连续 2 页无新增岗位时正常停止。

岗位按来源岗位 ID 优先、规范 URL 次之进行去重；相同身份但内容哈希变化时更新岗位版本。每完成一页就事务性保存岗位、事件和下一游标。

达到页数、时间或数量阈值时进入 `paused`，保留部分结果并显示停止原因。用户选择“继续读取”后，从保存游标开始新的同等预算；已读取岗位不重复计数。该机制限制单次运行，不设置不可继续的总量上限。

只读导航或提取失败最多执行“初始请求 + 1 次重试”。筛选写操作、选岗和转换操作不做盲重试，只依赖幂等键安全重放。

### Challenge 和 Adapter 失败

- 发现 Challenge 时推进 execution epoch、废止旧权限并进入 `awaiting_challenge`。
- 用户显式继续后重新观察、重新识别页面和重新授权。
- Adapter 预期字段或分页契约不匹配时返回 `job_adapter_contract_mismatch` 并进入 `failed`。
- 不支持 iframe 或 Shadow DOM 时进入 `awaiting_challenge`，交给用户处理，不把未扫描区域解释为无岗位。

## 匹配语义

```ts
type RequirementOutcome = "satisfied" | "conflict" | "unknown";
```

判定原则：

- `satisfied`：岗位要求与已确认档案证据或岗位期望明确相容。
- `conflict`：岗位与用户 `required` 期望明确互斥，或岗位明确必需条件与已确认档案事实明确互斥。
- `unknown`：任一方缺失、文本含糊、证据不足或无法可靠归一化。

只有明确冲突可以从正常推荐中淘汰。未确认的学历、专业、年限、技能、地点或工作模式一律为 `unknown`，不得按缺失事实推断冲突。

明确冲突岗位不进入“推荐岗位”排序列表，但仍按同一确定性 `rankingScore` 进入独立的“最接近但有冲突”列表，展示具体冲突和其余匹配证据。

## 评分模型

首个评分版本为 `job-match-v1`：

| 维度 | 权重 |
| --- | ---: |
| 技能 | 35 |
| 工作/实习职责 | 25 |
| 项目经验 | 20 |
| 专业、学历、经验年限 | 10 |
| 用户偏好 | 10 |

确定性匹配引擎保存：

```ts
interface JobMatchResult {
  id: string;
  sessionId: string;
  postingId: string;
  fitScore: number;
  confidence: number;
  rankingScore: number;
  outcomes: RequirementAssessment[];
  evidence: MatchEvidence[];
  gaps: MatchGap[];
  scoringVersion: "job-match-v1";
  profileRevision: number;
  expectationRevision: number;
  postingContentHash: string;
  stale: boolean;
}
```

- `fitScore` 是已知、可评分维度的 0-100 加权匹配分。
- `confidence` 根据已知权重覆盖率和证据质量计算；未知权重越高，置信度越低。
- `rankingScore` 由 `fitScore` 和确定性 `confidence` 计算，用于正常推荐和冲突列表各自排序。
- 同一岗位、档案、期望、评分版本和索引身份必须产生完全相同的三个分数。
- 评分公式、归一化规则和阈值作为 `job-match-v1` 的代码常量和测试夹具固定，后续变更必须产生新版本。

`job-match-v1` 固定计算规则如下：

1. 只对岗位中实际出现的维度分配权重；缺失维度的权重按比例重新分配给其余出现维度。
2. 同一维度有多个要求时平均分配该维度权重。
3. 三态得分为 `satisfied = 1`、`conflict = 0`、`unknown = 0.5`。
4. `fitScore = round(100 * Σ(要求权重 * 三态得分), 2)`。
5. `knownCoverage = Σ(satisfied 或 conflict 的要求权重)`。
6. 每个要求只取最佳合法证据质量：用户确认的结构化事实为 `1.0`，确定性归一化事实为 `0.8`，健康 Trigram/Dense 召回为 `0.6`，无合法证据为 `0`；`evidenceQuality = Σ(要求权重 * 最佳证据质量)`。
7. `confidence = round(100 * (0.7 * knownCoverage + 0.3 * evidenceQuality), 2)`。
8. `rankingScore = round(fitScore * (0.75 + 0.25 * confidence / 100), 2)`。

这里的 `round(value, 2)` 表示四舍五入到两位小数。DeepSeek 咨询结果不参与上述任一输入。若两个岗位 `rankingScore` 相同，依次按 `fitScore` 降序、`confidence` 降序、规范 URL 升序稳定排序。

Trigram 和 Dense Embedding 只用于要求与档案证据的受限混合召回。它们不绕过三态判断，也不直接把“未召回”变成冲突。

## DeepSeek 边界

DeepSeek 只处理健康混合召回后的歧义项。每次输入仅包含：

- 一个结构化岗位要求；
- 最多 Top-3 条候选人档案证据；
- 不透明证据 ID 和必要的归一化类别。

它不接收完整简历、完整知识库或其他岗位内容。允许输出：

```ts
interface JobRequirementAdvisory {
  outcome: RequirementOutcome;
  confidence: number;
  evidenceIds: string[];
}
```

边界规则：

- `confidence < 0.9`、引用 Top-3 之外证据、格式越界或调用失败时，结果统一为 `unknown`。
- DeepSeek 不能修改岗位明确条件或候选人已确认事实。
- DeepSeek 输出作为歧义说明附加到结果，不回写 `fitScore`、确定性 `confidence` 或 `rankingScore`。
- DeepSeek 不能产生硬冲突，不能决定岗位属于正常推荐还是冲突列表。
- Embedding 基础设施失败时只降级到规则和 Trigram，不调用 DeepSeek。

## API 设计

API 路由独立于现有 applications 路由，使用 `/job-match-sessions` 资源：

- `POST /job-match-sessions`：创建会话并识别入口。
- `GET /job-match-sessions/:id`：读取完整会话快照和当前版本。
- `PUT /job-match-sessions/:id/filter-confirmation`：保存并确认会话内筛选快照。
- `POST /job-match-sessions/:id/pause`：暂停当前运行。
- `POST /job-match-sessions/:id/resume`：从登录、Challenge 或普通暂停恢复。
- `POST /job-match-sessions/:id/continue-extraction`：从保存游标启动新读取预算。
- `POST /job-match-sessions/:id/rematch`：基于当前档案、期望和评分版本显式重跑。
- `POST /job-match-sessions/:id/selection`：选择无明确冲突岗位。
- `POST /job-match-sessions/:id/conflict-selection`：携带冲突摘要版本确认冲突岗位。
- `POST /job-match-sessions/:id/application`：幂等创建待审阅 `ApplicationTask`。
- `POST /job-match-sessions/:id/cancel`：取消会话并释放租约。

所有修改请求携带：

```ts
interface JobMatchMutationGuard {
  sessionVersion: number;
  idempotencyKey: string;
}
```

选岗请求额外携带 `resultId`、`resultVersion` 和 `postingContentHash`。冲突选岗还携带 `conflictSummaryHash`。任何版本或哈希不一致都返回稳定冲突错误，并要求前端刷新，不静默接受旧确认。

前端使用有限频率轮询读取会话快照和进度；P0 不新增 SSE/WebSocket 协议。轮询只读且不推进状态。

## UI 设计

工作台采用已确认的三段布局：

1. 顶部展示已确认筛选条件和读取进度，可在执行前修改条件。
2. 主列表展示正常推荐；下方独立展示“最接近但有冲突”。
3. 详情区展示匹配分、置信度、满足项、未知项、证据和差距。

交互规则：

- 筛选条件确认前不显示“开始读取”以外的执行动作。
- 网站未映射条件明确标记为本地判断。
- 未知项使用独立状态，不与满足或冲突混淆。
- 读取进行中持续展示已读取数量、去重新增数量和保护阈值说明。
- 达到保护阈值时保留已读取结果，并提供“继续读取”。
- 依赖版本变化时旧结果保留但标记过期，只提供“重新匹配”，不自动重跑。
- 冲突岗位选择时就地展示冲突内容和额外确认；岗位内容变化使旧确认失效。
- 确认选岗后只显示“已选择，尚未创建投递任务”。
- 工作台不出现“自动申请”或“最终提交”操作。
- 创建 `ApplicationTask` 后导航到现有人工审阅投递流程。

## 安全、隐私与可观测性

- 服务端验证每次状态迁移、会话版本、结果版本、岗位哈希、冲突摘要和浏览器租约。
- UI 隐藏按钮不是安全边界；非法请求必须由服务端拒绝。
- Browser Worker 权限按 execution epoch 发放；Challenge、暂停、取消和租约转移都会废止旧权限。
- Job Adapter 只产生有限结构化快照，不向 API 传递原始 DOM 或 selector。
- 事件和 trace 只记录会话 ID 哈希、来源、Adapter 版本、阶段、数量、耗时、稳定错误码和内容哈希。
- 不记录完整岗位正文、候选人档案正文、DeepSeek 提示正文、浏览器配置或认证信息。
- `ApplicationTask` 转换沿用 ActionPolicy 和 Browser Worker 对最终提交的双重禁止。

## 失败处理

| 场景 | 行为 |
| --- | --- |
| 登录未完成 | 进入 `awaiting_login`，用户显式继续后重新观察 |
| CAPTCHA/403/429/设备验证/风险控制 | 进入 `awaiting_challenge`，废止旧执行权限 |
| 不支持 iframe/Shadow DOM | 进入 `awaiting_challenge`，人工接管 |
| Adapter DOM 契约不匹配 | 进入 `failed`，显示 `job_adapter_contract_mismatch` |
| 筛选回读不一致 | 停止写操作并失败，不盲目重试 |
| 单页只读提取失败 | 最多重试一次；仍失败则保存游标并暂停/失败 |
| 单次读取预算用尽 | 保存部分结果并进入 `paused`，允许继续 |
| Embedding 基础设施失败 | 降级规则和 Trigram，不调用 DeepSeek |
| DeepSeek 失败或越界 | 歧义项保持 `unknown` |
| 会话/结果/岗位版本冲突 | 返回稳定冲突错误，要求刷新 |
| 转换请求重复 | 相同幂等键返回同一个 `ApplicationTask` |

## 测试设计

所有测试使用脱敏、固定夹具，不读取 `.env.local`、真实数据库、简历、浏览器配置或隐私日志。

### 领域与仓储测试

- 覆盖全部合法状态迁移，并拒绝越级、重复和过期版本操作。
- 覆盖会话、期望快照、岗位、结果、游标和事件的事务写入。
- 在筛选、分页、匹配和待选岗阶段模拟进程重启，恢复后不重复岗位、事件或浏览器动作。
- 验证档案、期望、评分或岗位哈希变化时旧结果只标记过期。
- 验证相同幂等键只创建一个 `ApplicationTask`。

### Adapter 与提取测试

- Moka/Mokahr 与 DJI 分别提供列表、详情、登录、挑战和契约漂移夹具。
- 验证网站筛选映射、筛选后回读和本地补充判断。
- 验证岗位 ID/URL 去重、内容更新、逐页持久化和恢复游标。
- 验证连续 2 页无新增停止，以及 100 页、15 分钟、2,000 岗位三类保护阈值。
- 验证只读失败最多重试一次，写操作不盲目重试。

### 匹配测试

- 明确互斥条件产生 `conflict`；任一方不明确时产生 `unknown`。
- 未知岗位保留在正常推荐中并降低置信度。
- 冲突岗位只出现在“最接近但有冲突”列表。
- `job-match-v1` 在相同输入下产生确定的 `fitScore`、`confidence` 和 `rankingScore`。
- 每个结果包含证据、差距、版本和内容哈希。
- Embedding 不可用时只使用规则和 Trigram，并断言 DeepSeek 调用次数为 0。
- DeepSeek 只接收一个要求和 Top-3 证据；低置信度、越界证据和失败都保持 `unknown`。
- 任意 DeepSeek 返回值都不能改变三个确定性分数或列表归属。

### API、并发与浏览器测试

- 验证 `sessionVersion`、幂等键、结果版本和哈希校验。
- 验证岗位匹配和投递任务不能同时持有浏览器租约。
- 验证 Challenge 推进 execution epoch，旧权限和在途命令失效。
- Browser E2E 覆盖列表页多岗位、详情页单岗位和申请表单页直达流程。
- Browser E2E 覆盖登录、挑战、暂停、继续读取、过期结果和冲突确认。
- UI 测试覆盖桌面和 320px 窄屏，无文本、控件或对话区溢出。

### 安全回归

- 未确认筛选前不得操作网站筛选器。
- 未二次确认不得选择冲突岗位。
- 岗位内容变化后旧冲突确认失效。
- 转换只产生待审阅 `ApplicationTask`。
- Synthetic ATS、Moka/DJI 回归和任何真实页面审计都断言 `submissionCount === 0`。
- 真实页面只允许到最终人工审阅，不点击或批准最终提交控件。

## P0 验收标准

1. 三类入口被稳定识别，无法识别时明确失败。
2. 用户能在执行前查看和修改知识库岗位期望映射出的筛选条件。
3. 在单次保护预算内读取全部筛选结果；触发阈值时完整保存并可从游标继续。
4. 正常推荐只排除明确冲突，未知项保留并降低置信度。
5. 冲突岗位在独立列表中保留匹配分、证据、差距和明确冲突说明。
6. 排序可解释、可复现，每个结果带评分、置信度、版本和内容哈希。
7. DeepSeek 不能改变排名、列表归属或产生硬冲突；Embedding 故障不调用 DeepSeek。
8. 应用重启后会话可恢复，不重复岗位、事件、浏览器操作或投递任务。
9. 档案、期望、评分和岗位内容变化使旧结果明确过期，且不自动重跑。
10. Moka/Mokahr 与 DJI 的领域、集成、Browser E2E、安全回归、TypeScript 和构建全部通过。
11. 所有 ATS 验收路径保持 `submissionCount === 0`。

## 实施边界

实施计划应按以下依赖顺序拆分，但本规格获批前不得开始实现：

1. contracts、数据库迁移、仓储和状态机；
2. Browser Job Snapshot、全局租约和版本化 Job Adapter；
3. 筛选确认、分页提取、预算和恢复；
4. 确定性评分、混合召回和 DeepSeek 咨询边界；
5. API 与工作台 UI；
6. Synthetic ATS、Moka/DJI Browser E2E 和提交安全回归。

每项功能严格按 TDD：先写能够稳定复现失败的测试，再写最小实现。先运行 owning tests，再运行浏览器集成、Moka/DJI 回归、全量测试、类型检查和构建。
