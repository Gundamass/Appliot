# Tavily Remote MCP 招聘入口搜索设计

## 1. 背景

当前对话流程已经能够识别“帮我投递百度校园招聘”一类公司级投递意图，但招聘入口发现依赖浏览器模拟搜索。真实测试中，搜索引擎可能跳转到验证码或风控页面，使招聘入口发现失败，也把与招聘网站无关的登录挑战引入 Browser Worker。

本期用 Tavily 官方 Remote MCP 替换浏览器搜索。API 服务通过 Streamable HTTP 连接：

```text
https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILY_API_KEY}
```

Tavily 只负责发现候选招聘入口。候选结果仍需经过安全校验和用户确认，之后才进入现有岗位推荐与受控投递流程。

## 2. 目标

1. 当用户表达“投递某公司校园招聘/社会招聘”等意图时，通过 Tavily Remote MCP 搜索候选招聘官网。
2. 将 Tavily 结果转换为项目内部稳定的数据结构，不让 MCP 返回格式渗透到对话图和前端。
3. 对候选 URL 做协议、主机和公网地址校验，并通过对话卡片要求用户确认。
4. 用户确认招聘入口后，复用现有 Browser Worker、岗位匹配、岗位选择和受控投递能力。
5. API Key 只来自运行时配置，日志、错误和审计事件不得泄露密钥。
6. 搜索失败时给出可恢复路径：允许用户粘贴官方招聘链接继续。

## 3. 非目标

- 不再实现或保留百度、必应等搜索引擎页面的浏览器模拟搜索作为降级路径。
- 不接入 Firecrawl、Exa、xAI 或其他搜索服务。
- 首期不调用 Tavily 的 `extract`、`map`、`crawl` 或 `research` 能力。
- 不让 Tavily 读取简历、个人资料、投递历史或其他个人信息。
- 不根据搜索排序自动认定某个链接是官方招聘网站。
- 不改变现有岗位匹配评分、岗位选择、受控填写、人工登录接管、验证码接管和最终提交锁。
- 不实现企业招聘状态跟踪。

## 4. 总体架构

```text
用户公司级投递意图
        |
        v
ConversationGraph
  提取 companyName / recruitmentType
        |
        v
RecruitmentSiteSearchPort
        |
        v
TavilyRemoteMcpClient
  Streamable HTTP + tools/call
  仅允许 tavily-search
        |
        v
结果标准化 -> URL 安全校验 -> 候选排序/去重
        |
        v
招聘入口确认卡
        |
    用户确认
        |
        v
Browser Worker 打开已确认链接
        |
        v
现有岗位推荐 -> 用户选择 -> 受控投递
```

搜索阶段不创建浏览器会话。Browser Worker 只接收用户已经确认且再次通过安全校验的招聘入口 URL。

## 5. 组件边界

### 5.1 `RecruitmentSiteSearchPort`

对话图只依赖内部搜索端口，不直接依赖 MCP SDK 或 Tavily 字段。端口输入为：

```ts
type RecruitmentSiteSearchInput = {
  companyName: string;
  recruitmentType: "campus" | "social" | "internship" | "unknown";
};
```

`companyName` 必须是对话图已提取并完成长度、空白和控制字符校验的公司名称。输入中不得包含简历文本、姓名、电话、邮箱、学校、工作经历或投递历史。

端口返回：

```ts
type RecruitmentSiteCandidate = {
  title: string;
  url: string;
  snippet: string;
  source: "tavily";
  sourceScore?: number;
};

type RecruitmentSiteSearchResult = {
  query: string;
  candidates: RecruitmentSiteCandidate[];
};
```

内部类型只保留生成确认卡需要的信息。Tavily 的原始响应不写入业务状态或数据库。

### 5.2 `TavilyRemoteMcpClient`

该组件负责：

- 使用 Tavily 官方 Remote MCP Endpoint 建立 Streamable HTTP 会话；
- 完成 MCP 初始化并调用 `tools/call`；
- 强制工具白名单，只允许 `tavily-search`；
- 设置超时、响应大小上限和可控重试；
- 解析 MCP content，拒绝缺失 URL 或结构异常的结果；
- 将传输错误映射为内部错误，不把完整 Endpoint 或请求头带入日志。

首期调用参数固定为：

```json
{
  "query": "<公司名> <招聘类型中文词> 招聘 官网",
  "search_depth": "basic",
  "topic": "general",
  "max_results": 5,
  "include_images": false,
  "include_raw_content": false
}
```

招聘类型映射为：`campus -> 校园招聘`、`social -> 社会招聘`、`internship -> 实习招聘`、`unknown -> 招聘`。禁止模型自行拼接额外个人信息或自由修改 Tavily 参数。

### 5.3 结果标准化与排序

客户端最多接收 5 条搜索结果，按以下顺序处理：

1. 解析并规范化 URL，移除 fragment；
2. 丢弃未通过安全校验的结果；
3. 按规范化 URL 去重；
4. 保留 Tavily 原顺序和 `score`，但不把排序视为“官网认证”；
5. 最多向对话层返回 3 个候选。

标题和摘要要做长度限制与纯文本处理。它们属于外部不可信内容，只能展示，不能被当作系统指令或用于触发工具调用。

### 5.4 ConversationGraph

ConversationGraph 继续负责意图识别和人机确认：

1. 提取公司名与招聘类型；信息不足时先向用户追问。
2. 调用 `RecruitmentSiteSearchPort`。
3. 有候选结果时展示招聘入口确认卡，包含公司名、标题、域名、摘要和“确认此入口”操作；有多个候选时允许用户明确选择。
4. 用户确认后记录选中的 URL，再询问是否需要岗位推荐。
5. 用户选择岗位推荐后，才启动现有岗位读取和匹配流程。
6. 用户不需要推荐时，不擅自选择岗位或开始投递；继续询问其希望如何提供具体岗位。

重新搜索、选择候选和确认 URL 都是对话状态变化，不是最终投递授权。最终提交仍必须经过现有人工确认。

## 6. 配置与密钥保护

运行时使用以下配置：

```text
TAVILY_API_KEY=<secret>
TAVILY_MCP_ENDPOINT=https://mcp.tavily.com/mcp/
TAVILY_MCP_TIMEOUT_MS=10000
```

`TAVILY_API_KEY` 为必填秘密配置，不进入仓库、前端构建产物、数据库或审计事件。客户端在内存中构造官方 URL 查询参数 `tavilyApiKey`，不允许业务层传入完整带密钥 URL。

所有日志和错误在输出前必须对以下内容脱敏：

- `tavilyApiKey` 查询参数；
- `Authorization` 请求头（若后续切换为官方支持的 Bearer 方式）；
- MCP 会话相关的敏感请求头。

生产启动时缺少 API Key，应将 Tavily 搜索能力标记为不可用并给出明确配置错误，不能静默降级到浏览器搜索。测试使用假 Endpoint 和假 Key，不访问 Tavily 生产服务。

## 7. URL 安全规则

所有 Tavily 候选和用户手工粘贴的链接共用同一套校验：

- 只允许 `https:`；
- 禁止 URL 用户名和密码；
- 禁止 `localhost`、`.local`、环回、链路本地、私网、保留地址和其他非公网目标；
- 禁止裸 IP URL；
- 限制 URL 总长度；
- Browser Worker 导航前再次校验，并对重定向后的每个目标执行同等限制。

校验通过只代表链接可安全进入确认流程，不代表它是企业官网。域名与公司名不一致、聚合招聘站、广告页或可疑标题应降低展示优先级或附加风险提示，但不能由系统静默替用户确认。

## 8. 对话体验

成功示例：

```text
用户：帮我投递百度校园招聘
系统：通过 Tavily 搜索“百度 校园招聘 招聘 官网”
系统：展示 1～3 个招聘入口候选
用户：确认其中一个入口
系统：是否需要我根据你的简历推荐岗位？
用户：需要
系统：打开已确认入口，进入现有岗位推荐和受控投递流程
```

搜索结果为空或服务不可用时：

```text
系统：暂时没有找到可确认的招聘入口。你可以稍后重试，或粘贴该公司的官方招聘链接。
```

不得显示 API Key、原始 MCP 报文、堆栈或内部网络信息。

## 9. 超时、错误与恢复

内部错误至少区分：

- `TAVILY_NOT_CONFIGURED`：缺少 API Key；
- `TAVILY_TIMEOUT`：连接或调用超过 10 秒；
- `TAVILY_UNAVAILABLE`：网络、限流或服务端临时错误；
- `TAVILY_PROTOCOL_ERROR`：MCP 初始化、工具调用或响应结构不符合预期；
- `NO_SAFE_CANDIDATE`：结果为空或全部被安全规则过滤。

仅对连接中断、HTTP 429 和 5xx 做一次短退避重试；参数错误、协议错误和安全校验失败不重试。任何错误都不得启动浏览器搜索。用户可重试当前搜索，或粘贴官方链接进入同一确认卡流程。

## 10. 与现有能力的兼容边界

- 招聘入口确认完成前，不创建 Browser Worker 任务。
- 确认完成后，Browser Worker 仍负责页面打开、登录/验证码人工接管和页面读取。
- 岗位数据进入现有岗位匹配模块，保留原有过滤、评分、推荐理由和用户选择逻辑。
- 受控投递继续保留字段回读、风险控制、审核节点和最终提交硬锁。
- Tavily 搜索成功不等于用户授权投递，也不等于招聘网站已登录。
- 现有投递进度只展示本系统创建的投递任务；本期不查询或同步企业招聘状态。

## 11. 测试策略

### 11.1 单元测试

- 查询构造只包含公司名、招聘类型和固定词，不包含候选人信息。
- MCP 客户端只允许 `tavily-search`，固定安全参数不能被调用方覆盖。
- 正常 MCP content 能转换为内部候选；畸形、超大和缺少 URL 的响应被拒绝。
- URL 规范化、去重和 3 条候选上限正确。
- `http`、凭据 URL、localhost、私网地址、裸 IP 和危险重定向被拒绝。
- 日志脱敏覆盖查询参数和 Authorization 头。
- 超时、429、5xx、协议错误和无安全候选映射为稳定错误码。

### 11.2 集成测试

使用本地假 Streamable HTTP MCP Server 验证初始化、`tools/call`、超时、一次重试和响应解析，不依赖真实 Tavily 网络或额度。

ConversationGraph 覆盖：

- 公司级意图 -> Tavily 搜索 -> 候选确认卡；
- 用户选择候选 -> 询问是否岗位推荐；
- 用户确认推荐 -> 复用现有岗位推荐流程；
- 搜索失败 -> 提示重试或粘贴链接，且 Browser Worker 未被调用；
- 用户粘贴链接 -> 安全校验 -> 同一确认流程；
- 未确认招聘入口时不能创建投递任务。

### 11.3 可选烟雾测试

仅在开发者显式提供 `TAVILY_API_KEY` 时运行真实 Remote MCP 烟雾测试，验证能返回至少一个结构合法的 HTTPS 候选。该测试默认跳过，不作为离线 CI 的必要条件，也不输出查询后的完整连接 URL。

## 12. 验收标准

1. “帮我投递百度校园招聘”不再触发百度、必应或其他搜索页的浏览器自动化。
2. API 服务通过 Tavily 官方 Remote MCP 的 `tavily-search` 获得候选结果。
3. 请求不包含简历或个人信息，响应中的不可信文本不能触发工具或跳过确认。
4. 用户看到安全候选并明确确认后，系统才询问是否进行岗位推荐。
5. 未确认 URL 时 Browser Worker、岗位读取和投递任务均不会启动。
6. 搜索失败不会降级为浏览器搜索，并允许用户粘贴官方链接恢复流程。
7. 现有岗位匹配和受控投递测试继续通过，最终提交仍需人工授权。
8. API Key 不进入源码、前端、持久化数据、测试快照或日志。
9. 企业招聘状态跟踪未被引入。

## 13. 官方参考

- Tavily MCP 文档：<https://docs.tavily.com/documentation/mcp>
- Tavily MCP 官方仓库：<https://github.com/tavily-ai/tavily-mcp>
- Tavily Remote MCP Endpoint：<https://mcp.tavily.com/mcp/>
