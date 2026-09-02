# Agent Runtime、Supervisor 与智能意图理解重构设计

## 状态

已完成设计讨论，等待用户审阅文档。本文描述一次彻底重构，不保留旧 agent-v1 Runtime 兼容层。

## 1. 背景与目标

当前项目已经具备简历解析、岗位匹配、申请执行、LangGraph 中断恢复、TraceSink、LangSmith 和浏览器安全控制等能力，但主流程仍偏固定编排，用户需要以接近流程参数的方式表达需求。

本次重构目标是建立以自然语言目标为入口、以意图模型为核心、以 Supervisor/Planner 为决策中枢、以专用 Agent 和 Capability Catalog 为执行边界的 Agent Runtime。

目标行为：

~~~text
用户表达目标
  → 意图识别
  → 必要时主动澄清
  → 隐含目标分解
  → Supervisor 动态规划
  → 专用 Agent 执行
  → 观察与证据校验
  → 失败后重规划
  → 最终提交前人工确认
~~~

## 2. 非目标

- 不保留 agent-v1 与 agent-v2 双轨运行时。
- 不保留旧 GraphService 作为新任务入口。
- 不让模型直接执行 Playwright、数据库或任意代码。
- 不允许模型推断最终提交授权或编造履历事实。
- 不在本阶段引入无 Supervisor 约束的 Agent-to-Agent 总线。
- 不把完整 PDF、完整 DOM、Cookie、Token 或未脱敏 Prompt 注入 Supervisor 上下文。

## 3. 核心设计原则

1. 自主能力优先：低风险、可回滚、可验证的步骤自动执行。
2. 人工最终确认：不可逆的外部提交始终经过人工审批。
3. 意图先于计划：任何任务必须先生成经过校验的 CanonicalIntent。
4. 观察驱动执行：浏览器动作必须基于当前 snapshot、NodeRef 和 execution epoch。
5. 结构化边界：模型输出必须经过 Zod/JSON Schema 校验。
6. 证据可追溯：事实、观察、动作和结果都通过引用关联。
7. 历史可审计：计划重规划产生新 revision，不覆盖历史。
8. 最小权限：模型只能使用 Capability Catalog 声明的能力。

## 4. 总体架构

~~~text
用户输入
  ↓
Intent Understanding
  ├─ 任务类型识别
  ├─ 实体与槽位抽取
  ├─ 约束/偏好提取
  ├─ 隐含目标推断
  ├─ 歧义与缺失信息检测
  └─ 风险评估
        ↓
Canonical Intent
        ↓
Agent Runtime (LangGraph 状态执行层)
        ↓
Supervisor / Planner
        ├─ ResumeAgent
        ├─ JobMatchingAgent
        ├─ ApplicationAgent
        └─ ReviewAgent
              ↓
       Capability Catalog + Policy Engine
              ↓
       Observation / Evidence / TraceSink
~~~

LangGraph 继续作为状态化执行和中断恢复引擎，但不再承载所有业务决策。Runtime、Supervisor、Agent、Capability 和 Policy 通过显式接口通信。

建议目录：

~~~text
apps/api/src/agent/
  intent/
  runtime/
  supervisor/
  agents/
  capabilities/
  policy/
  observations/
  events/
~~~

现有 apps/api/src/agent/main-graph.ts、state.ts 和 packages/contracts/src/agent-graph.ts 应重构为上述新边界对应的模块，而不是继续向主图添加业务分支。

## 5. 智能意图理解

### 5.1 Canonical Intent

~~~ts
interface CanonicalIntent {
  intentId: string;
  schemaVersion: string;
  rawInputRef: string;
  primaryGoal: PrimaryGoal;
  subGoals: SubGoal[];
  entities: IntentEntities;
  constraints: IntentConstraint[];
  preferences: IntentPreference[];
  successCriteria: SuccessCriterion[];
  riskProfile: RiskProfile;
  confidence: number;
  ambiguities: IntentAmbiguity[];
  missingInformation: MissingInformation[];
  autonomyLevel: "suggest" | "prepare" | "execute_with_approval";
  evidenceRefs: EvidenceRef[];
  createdAt: string;
}
~~~

初始任务类型：

~~~ts
type PrimaryGoal =
  | "analyze_resume"
  | "analyze_job"
  | "match_resume_to_job"
  | "prepare_application"
  | "fill_application"
  | "submit_application"
  | "track_application"
  | "update_resume_profile";
~~~

### 5.2 意图理解流水线

~~~text
输入预处理
  → LLM 结构化抽取
  → Schema 与业务规则校验
  → 记忆/证据对齐
  → 歧义检测与风险评估
  → Canonical Intent
~~~

当关键参数缺失或冲突时返回澄清请求，而不是猜测：

~~~ts
type IntentResolution =
  | { type: "resolved"; intent: CanonicalIntent }
  | {
      type: "needs_clarification";
      intent: Partial<CanonicalIntent>;
      question: ClarificationRequest;
    }
  | { type: "rejected"; reason: string };
~~~

澄清一次只询问当前最重要的问题，并将用户回答写入新的意图版本。

### 5.3 来源、置信度与冲突

每个关键字段都记录来源：

~~~ts
type IntentValueSource =
  | "user_explicit"
  | "user_clarified"
  | "verified_memory"
  | "document_evidence"
  | "environment_observation"
  | "model_inference";
~~~

优先级：当前用户明确表达 > 用户澄清 > 已验证记忆 > 当前文档证据 > 环境观察 > 模型推断。

工作年限、公司、职位、学历、技术栈、薪资、地点和入职时间发生冲突时，必须保留冲突并进入人工确认。

### 5.4 主动任务分解

“帮我投这个岗位”应被分解为识别岗位、读取职位描述、选择简历、匹配分析、材料准备、表单填写、回读校验和人工确认等步骤。

可以主动推断必要的低风险中间步骤，但不能推断提交授权、主观问答、敏感信息、履历事实或任何不可逆操作。

## 6. Agent Runtime

~~~ts
interface AgentRuntime {
  start(input: AgentRunInput): Promise<AgentRunResult>;
  resume(runId: string, input: HumanResume): Promise<AgentRunResult>;
  cancel(runId: string): Promise<AgentRunResult>;
  inspect(runId: string): Promise<RuntimeSnapshot>;
}
~~~

Runtime 统一负责：

- 运行循环；
- LangGraph checkpoint；
- 步骤、工具、token 和时间预算；
- 超时、重试和幂等；
- 取消与 AbortSignal；
- 人工中断和恢复；
- TraceSink；
- 终态判断。

运行状态：

~~~text
INTENT → PLAN → DISPATCH → WAIT → INSPECT
                         ├→ PLAN_AGAIN
                         ├→ HUMAN_GATE
                         ├→ COMPLETE
                         └→ FAIL
~~~

Checkpoint 只保存 Runtime 状态、PlanState、当前步骤、记忆/证据引用、待处理中断、预算、版本 hash 和已完成 action ID。不保存 Playwright 对象、Cookie、密码、Token、完整 DOM、未脱敏 Prompt 或大型二进制数据。

## 7. Supervisor 与 Planner

Supervisor 负责任务分解、Agent/Capability 选择、观察后的重规划、人工请求和完成判断；不直接操作浏览器、数据库或最终提交。

~~~ts
type SupervisorDecision =
  | { type: "dispatch_agent"; agent: string; input: JsonValue; reason: string }
  | { type: "invoke_tool"; capability: string; input: JsonValue; reason: string }
  | { type: "ask_human"; interrupt: HumanInterrupt }
  | { type: "finish"; outcome: "completed" | "blocked"; summary: string }
  | { type: "fail"; code: string; retryable: boolean };
~~~

Planner 产生版本化计划：

~~~ts
interface PlanStep {
  id: string;
  objective: string;
  owner: "resume" | "job_matching" | "application" | "review";
  status: "pending" | "running" | "completed" | "blocked" | "skipped";
  dependsOn: string[];
  inputRefs: string[];
  outputRefs: string[];
  attempt: number;
  maxAttempts: number;
}
~~~

重规划创建新 planRevision，保留旧版本、触发原因和差异。

计划必须由独立 PlanValidator 校验：依赖无环、Agent/Capability 存在、引用有效、风险和调用者匹配、未绕过审批且预算足够。

## 8. 专用 Agent

~~~ts
interface SpecialistAgent {
  readonly name: string;
  readonly version: string;
  execute(input: SpecialistAgentInput): Promise<SpecialistAgentResult>;
}
~~~

专用 Agent：

- ResumeAgent：PDF/OCR 解析、字段标准化、证据整理；
- JobMatchingAgent：岗位理解、ATS 分析、LightRAG 检索和语义匹配；
- ApplicationAgent：DOM 观察、字段定位、填写、回读和异常暂停；
- ReviewAgent：事实、证据、风险和最终 payload 独立审查。

Agent 之间只通过结构化输入、输出引用和观察引用通信，不共享隐式可变状态。

## 9. Capability Catalog 与 Policy Engine

Capability 定义包含 name/version、kind、input/output schema、allowedCallers、risk、sideEffect、requiresApproval、idempotency、timeout 和 handler。

最终提交工具必须类似：

~~~ts
{
  name: "final_submit",
  kind: "act",
  risk: "irreversible",
  allowedCallers: ["graph"],
  requiresApproval: true
}
~~~

高风险工具不能由 Supervisor 或模型直接调用。所有调用经过 Schema 校验和 Policy Engine。

## 10. 浏览器安全与人工确认

浏览器动作必须绑定 snapshotId、executionEpoch、NodeRef 和 targetFingerprint。页面变化、快照过期、目标指纹变化或 NodeRef 失效时，必须重新观察。

自动执行低风险、可回滚、可验证动作；最终投递、对外消息、删除数据、身份挑战、敏感事实冲突和疑似 Prompt Injection 必须人工确认。

最终提交批准至少绑定：

~~~ts
interface FinalSubmitApproval {
  approvalId: string;
  runId: string;
  planRevision: number;
  executionEpoch: number;
  snapshotId: string;
  targetFingerprint: string;
  payloadHash: string;
  approvedBy: "human";
  approvedAt: string;
  expiresAt: string;
}
~~~

提交前必须再次验证页面、目标、epoch、plan revision、payload hash 和审批有效期。任一变化都会使审批失效。

外部网页、职位描述、附件、OCR、DOM 和 RAG 文档一律视为不可信数据，不能改变系统提示、工具权限或人工确认规则。检测到疑似 Prompt Injection 时暂停并进入安全审查。

## 11. 上下文、记忆与事件流

Supervisor 每轮只接收分层上下文：

~~~text
L0 运行元数据
L1 任务目标
L2 工作记忆
L3 环境观察
L4 长期记忆
L5 策略约束
~~~

记忆分类：profile_fact、preference、task_memory、execution_observation。用户修正优先于模型抽取；冲突事实保留版本；执行观察默认不升级为长期记忆。

权威审计流写入 SQLite TraceSink，实时进度通过现有 SSE/事件总线推送，LangSmith 只接收脱敏投影。

统一事件包括：run_started、intent_resolved、clarification_requested、clarification_received、plan_created、plan_revised、agent_dispatched、capability_called、observation_received、human_interrupt、approval_granted、checkpoint_saved、retry_scheduled、run_completed、run_failed、run_cancelled。

## 12. 重试、重规划、预算与终态

暂时性网络错误或限流可指数退避；陈旧观察必须重新观察；Schema 错误最多进行一次结构化修复；业务前置条件失败进入重规划；权限、安全和不可逆失败不得盲目重试。

建议初始可配置预算：

~~~text
单步骤最大尝试次数：2
单次运行最大重规划次数：8
单次运行最大步骤数：32
单次运行最大工具调用数：80
默认最长运行时间：15 分钟
~~~

终态：completed、blocked、failed、cancelled、expired。只有验收条件满足且证据完整时，才能标记 completed。

取消任务时停止新副作用动作、发送 AbortSignal、保存 checkpoint 并使当前 execution epoch 失效。恢复时生成新 epoch 并重新观察环境。

## 13. 彻底重构路线

### P0：核心契约与 Runtime

- 建立 CanonicalIntent、RuntimeState、PlanState、Decision 和事件 Schema；
- 实现唯一 AgentRuntime 入口；
- 建立 Capability Catalog、Policy Engine 和新 checkpoint；
- 将主 LangGraph 改为 Runtime 状态图；
- 旧 checkpoint 只保留审计，不作为新 Runtime 状态恢复。

### P1：智能意图理解

- 实现结构化抽取、来源/置信度、冲突检测和主动澄清；
- 建立意图到计划的转换；
- 支持隐含目标分解；
- 确保高风险授权不会被隐式推断。

### P2：Supervisor 与专用 Agent

- 重写 Supervisor、Planner、PlanValidator 和 Replanner；
- 重写 ResumeAgent、JobMatchingAgent、ApplicationAgent 和 ReviewAgent；
- 建立观察、证据和回读闭环；
- 实现最终提交硬性安全门。

### P3：评测闭环与持续优化

- 建立 Intent、Execution、Safety 三类评测集；
- 支持 Trace 回放和离线对比；
- 评估模型、Prompt、策略和工具版本；
- 使用人工反馈优化意图理解和规划策略，但不允许线上无审计自修改。

## 14. 测试与验收

测试分层：契约测试、意图测试、Planner 测试、Runtime 测试、专用 Agent 测试、Capability/安全测试和端到端回放测试。

必须覆盖：多目标表达、澄清收敛、事实冲突、计划依赖循环、预算耗尽、checkpoint 恢复、取消、页面变化、旧 NodeRef 失效、Prompt Injection、审批过期和 payload hash 变化。

关键指标：

~~~text
关键约束召回率 ≥ 98%
高风险授权误推断率 = 0
澄清平均轮数 ≤ 2
计划与 Canonical Intent 一致率 ≥ 95%
越权工具调用次数 = 0
绕过人工确认次数 = 0
错误自动提交次数 = 0
~~~

最终验收要求：所有任务先经过 CanonicalIntent；关键歧义可主动澄清；Supervisor 输出结构化决策；Planner 支持重规划；工具经过 Catalog 和 Policy；checkpoint 可恢复；全链路可审计和回放；最终提交始终人工确认；取消、超时、重试、失败和阻塞均有明确终态。

## 15. 结论

该架构符合 Agent 开发范式的核心要求：模型负责理解、规划和选择；Runtime 负责状态、预算、恢复和终态；专用 Agent 负责领域执行；Capability Catalog 负责权限边界；Policy Engine 负责安全约束；人工负责最终不可逆决策。

相较于固定工作流，新的系统具备更强的意图理解、主动澄清、隐含目标分解和观察驱动重规划能力，同时不会把“自主”误解为“无约束执行”。
