# 生产模型与 OCR 适配器设计规格

日期：2026-07-23

状态：已确认，待实现计划

关联规格：`docs/superpowers/specs/2026-07-22-resume-application-assistant-design.md`

## 1. 背景与目标

基础版本已经定义简历入库、事实证据、RAG 闭环、受控浏览器填写和禁止提交等边界，但生产启动仍缺少真实的结构化模型、词向量和 OCR 实现。本规格为这些能力定义可部署的生产适配器，同时保留已有的职责分离和用户审核约束。

本阶段交付以下能力：

- 使用 DeepSeek API 完成结构化生成。
- 使用远程 GPU 服务器上的 Qwen3-Embedding-8B 生成词向量。
- 使用远程 GPU 服务器上的 DeepSeek-OCR 2 处理扫描或异常 PDF 页面。
- 从项目根目录 `.env.local` 加载本地应用配置。
- 在远程服务不可用时允许本地应用降级启动，但禁止开始依赖该服务的新任务。
- 将生产依赖组合进 API，同时保持自动化测试不访问真实密钥、付费 API 或远程 GPU。

本规格不改变以下不可变约束：

- 系统绝不提交职位申请。
- 自我评价的岗位适配版本必须由用户查看并确认。
- 相似度检索结果不是事实，事实必须经过证据验证。
- 缺失、冲突或低可信信息必须追问用户，不能猜测。
- 浏览器自动化只能执行中间操作，最终停在用户审核状态。

## 2. 已确认的部署条件

远程服务器条件如下：

- Ubuntu 20.04.6 LTS，不允许升级系统。
- Linux 5.15，x86-64。
- 8 张 NVIDIA RTX A6000，每张约 48 GB 显存。
- 本项目获得物理 GPU 5 的使用权。
- NVIDIA 驱动 580.82.09，驱动声明支持 CUDA 13.0，并向下兼容所选 CUDA 用户态运行库。
- `heqing` 用户没有 sudo 权限，也不属于 `docker` 组。
- 不使用系统 Docker，不修改 Docker socket 权限，不改动其他用户的 GPU 进程。
- 模型和离线依赖可在本地下载后上传到服务器。

因此远程节点采用用户空间 Conda 部署。宿主机不安装新的系统 CUDA、cuDNN、Python 或容器运行时组件。

## 3. 总体架构

系统由三个模型职责组成：

```text
本地 Web/API
  |
  +-- DeepSeekStructuredModelProvider
  |     -> https://api.deepseek.com
  |
  +-- RemoteEmbeddingProvider
  |     -> SSH tunnel -> Qwen3-Embedding-8B Worker
  |
  +-- RemoteOcrEngine
        -> SSH tunnel -> DeepSeek-OCR-2 Worker
```

DeepSeek 只负责结构化生成、缺失信息判断和自我评价微调。Qwen3 只负责向量化。DeepSeek-OCR 2 只负责页面图像转 Markdown。三个职责使用独立接口，任何一个实现都不能隐式替代另一个实现。

现有 `ModelProvider` 拆分为：

```ts
interface StructuredModelProvider {
  generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T>;
}

interface EmbeddingProvider {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}
```

OCR 继续通过领域层 `OcrEngine` 使用。HTTP、鉴权、模型名和重试逻辑位于基础设施实现中，领域层不依赖远程协议。

## 4. 本地配置加载

本地开发和生产启动从项目根目录 `.env.local` 加载配置。该文件已经存在，必须继续被 Git 忽略。任何代码、测试、日志和错误信息都不得读取后打印其中的秘密值。

Node 24 启动脚本使用 `--env-file-if-exists=.env.local`。配置模块提供纯函数 `loadConfig(env)`，接收注入的环境变量映射并通过 Zod 验证。自动化测试只传入内存中的假值，不加载真实 `.env.local`。

配置分为核心配置和适配器配置：

- 数据库路径、监听地址等核心配置错误时，API 在监听端口前失败。
- 一个适配器的配置全部缺失时，该适配器标记为 `unconfigured`，API 可以降级启动。
- 一个适配器只配置了一部分，或者 URL、超时、重试次数、维度等值非法时，视为配置错误，API 在监听前失败，避免拼写错误被静默当成服务离线。
- 适配器配置完整但远程服务暂时不可达时，API 降级启动并将其标记为 `unavailable`。

建议配置如下：

```dotenv
DATABASE_FILE=data/resume-assistant.sqlite

DEEPSEEK_API_KEY=...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL_DEFAULT=deepseek-v4-flash
DEEPSEEK_MODEL_ESCALATION=deepseek-v4-pro
DEEPSEEK_THINKING=disabled
DEEPSEEK_TIMEOUT_MS=60000
DEEPSEEK_MAX_RETRIES=2

EMBEDDING_BASE_URL=http://127.0.0.1:18080
EMBEDDING_API_TOKEN=...
EMBEDDING_MODEL=Qwen/Qwen3-Embedding-8B
EMBEDDING_MODEL_REVISION=1d8ad4ca9b3dd8059ad90a75d4983776a23d44af
EMBEDDING_DIMENSIONS=4096
EMBEDDING_TIMEOUT_MS=60000

OCR_BASE_URL=http://127.0.0.1:43121
OCR_API_TOKEN=...
OCR_MODEL=deepseek-ai/DeepSeek-OCR-2
OCR_MODEL_REVISION=aaa02f3811945a91062062994c5c4a3f4c0af2b0
OCR_TIMEOUT_MS=180000
```

启动和健康接口可以显示变量名、适配器状态、非秘密模型名和 revision，但不能显示 API Key、Bearer Token 或带凭据的 URL。

## 5. DeepSeek 结构化模型适配器

### 5.1 模型选择

默认模型为 `deepseek-v4-flash`，关闭 thinking，用于常规结构化抽取和自我评价适配。`deepseek-v4-pro` 只在默认模型输出经过本地验证仍失败后升级一次。

不得使用即将停用的 `deepseek-chat` 或 `deepseek-reasoner`。模型名必须来自配置，响应中如果包含 `reasoning_content`，适配器不得保存、转发或记录该字段。

### 5.2 JSON 输出与验证

请求使用 DeepSeek 的 JSON Output：

```json
{ "response_format": { "type": "json_object" } }
```

系统提示必须明确包含 `json`，并为目标结构提供输出示例。DeepSeek 只保证 JSON 语法，不保证满足应用 Schema，因此本地仍需执行：

1. 检查 HTTP 状态和响应结构。
2. 将空 `content` 视为可重试错误。
3. 解析 JSON。
4. 使用调用方提供的 Zod Schema 验证。
5. 对事实执行来源页码、引用文本和字段关联验证。
6. 在有限重试后，允许从 flash 升级一次到 pro。
7. 升级仍失败时返回明确错误，不保存部分结果。

网络错误、`429` 和可恢复的 `5xx` 使用带抖动的有限退避。非 `429` 的 `4xx`、Schema 永久不匹配和安全验证失败不能无限重试。所有请求受 `AbortController` 超时控制。

### 5.3 启动行为

API 启动时不调用 DeepSeek，不产生付费请求。配置完整只代表 `configured`。首次任务调用成功后可更新运行状态；失败时状态变为 `unavailable`，但本地资料查看和手工编辑仍可使用。

## 6. Qwen3 Embedding Worker

### 6.1 模型与运行时

模型固定为 `Qwen/Qwen3-Embedding-8B` revision `1d8ad4ca9b3dd8059ad90a75d4983776a23d44af`，许可证为 Apache 2.0。模型使用 FP16、4096 维输出和 L2 归一化。

Worker 使用独立 Python 3.10 Conda 环境、PyTorch 和 Sentence Transformers。模型以单例加载，不为每个请求重新初始化。优先使用 PyTorch SDPA；Flash Attention 只有在存在与固定 PyTorch/CUDA/Python 组合匹配的预编译包且通过验收时才启用，不能把现场编译作为基础安装的必要条件。

### 6.2 查询与文档编码

文档文本直接编码，不添加指令。查询文本使用固定英文指令：

```text
Instruct: Retrieve verified resume facts relevant to completing a job application field.
Query: {query}
```

指令文本本身具有版本。指令、模型 revision、维度或归一化方式发生变化时，必须生成新的索引版本并完整重建，禁止新旧向量混用。

### 6.3 HTTP 协议

Worker 提供：

```text
GET  /healthz
GET  /readyz
POST /v1/embeddings
```

`/healthz` 只确认进程存活。`/readyz` 只有在模型加载完成、revision 匹配且 GPU 可用时返回成功。Embedding 请求使用 Bearer Token，并限制请求体大小、单批文本数量和单条文本长度。

响应必须满足以下契约：

- 返回向量数量与输入数量一致。
- 每条向量恰好 4096 维。
- 每个元素为有限数值。
- 每条向量完成 L2 归一化。
- 响应包含模型名、revision 和维度。

Node 适配器再次验证这些条件。任何不匹配都拒绝写入索引。

## 7. DeepSeek-OCR 2 Worker

### 7.1 模型与运行时

使用 `deepseek-ai/DeepSeek-OCR-2` revision `aaa02f3811945a91062062994c5c4a3f4c0af2b0`，许可证为 Apache 2.0。模型约 3.39B 参数，使用 BF16。

Worker 使用独立 Python 3.12.9 Conda 环境。基础兼容组合遵循官方 CUDA 11.8、PyTorch 2.6.0 和对应依赖。该环境与 Embedding 环境隔离，因为两者所需 Transformers 版本不同。

DeepSeek-OCR 2 使用固定 revision 中的自定义模型代码。模型和代码在本地下载、校验并上传，运行时启用 Hugging Face 离线模式，不允许动态获取新的 `trust_remote_code` 内容。

### 7.2 PDF 处理顺序

OCR 不是默认入口。每一页先执行 PDF 原生文本提取，并评估非空字符数、可打印字符比例和乱码特征：

- 文本层可用时，保存 `source=pdf_text`，不调用 OCR。
- 文本层为空、明显过短或乱码比例异常时，将该页渲染为 PNG 并调用 OCR。
- OCR 失败时保留页面失败状态，不以空文本创建成功的文档版本。

固定 OCR 提示词为：

```text
<image>
<|grounding|>Convert the document to markdown.
```

Worker 使用确定性生成设置，将返回内容规范化为 Markdown 文本。它不负责事实抽取，也不把生成内容标记为已验证事实。

### 7.3 HTTP 协议

Worker 提供：

```text
GET  /healthz
GET  /readyz
POST /v1/ocr
```

OCR 接口只接受 PNG 或 JPEG 二进制图片，不接受 URL 和服务器文件路径。接口限制请求体、图片尺寸和单次页数，并使用 Bearer Token。每个请求只处理一页，Worker 串行执行 OCR，防止并发页面耗尽显存。

成功响应至少包含：

```json
{
  "text": "Markdown OCR result",
  "model": "deepseek-ai/DeepSeek-OCR-2",
  "modelRevision": "aaa02f3811945a91062062994c5c4a3f4c0af2b0",
  "mode": "document_to_markdown",
  "elapsedMs": 1234
}
```

空文本、模型不匹配和截断输出均视为失败。Node 客户端最多自动重试一次；仍失败时将该页交给用户处理。

### 7.4 生成式 OCR 风险

DeepSeek-OCR 2 是生成式视觉模型，不能提供传统 OCR 同等语义的逐字符置信度，并可能遗漏、合并或错误生成内容。因此：

- 原生 PDF 文本始终优先。
- OCR 页面必须保存页码和 `source=ocr`。
- 姓名、联系方式、学校、日期等关键事实必须关联原始页面证据。
- 仅来自 OCR 且无法验证的字段进入待确认状态。
- OCR 输出不能直接触发浏览器填写或提交。
- 首次上线必须使用真实中文、英文、扫描版和双栏简历做人工对照验收。

第一阶段不部署 PaddleOCR。只有评测证明特定数字或字符需要独立复核时，才单独设计传统 OCR 校验器。

## 8. 远程用户空间部署

### 8.1 目录

远程资产统一放在：

```text
/home/heqing/resume-ai/
  envs/
    embedding/
    ocr/
  models/
    Qwen3-Embedding-8B/
    DeepSeek-OCR-2/
  services/
    embedding/
    ocr/
  cache/
  logs/
  run/
  tmp/
```

模型、Linux x86-64 离线依赖、服务代码和 SHA-256 清单在本地准备后上传。Python 和 Conda 依赖必须使用锁定版本及哈希，不能在服务器安装时解析浮动的 `latest` 版本。安装程序必须先校验清单，再创建 Conda 环境。不得上传或复用 Windows Conda 环境。

### 8.2 GPU 隔离

两个 Worker 启动前都设置：

```bash
CUDA_VISIBLE_DEVICES=5
HF_HUB_OFFLINE=1
TRANSFORMERS_OFFLINE=1
```

容器外的物理 GPU 5 会在进程内映射为 `cuda:0`。启动验收必须使用宿主机 `nvidia-smi` 确认新增显存只出现在物理 GPU 5。服务不得选择其他 GPU，也不得停止现有 GPU 任务。

Qwen3 Embedding 和 DeepSeek-OCR 2 可以同时驻留一张 A6000。若 GPU 5 被其他未授权进程占用导致显存不足，Worker 标记为未就绪并退出或等待人工处理，不迁移到其他 GPU。

### 8.3 进程管理

优先使用用户级 systemd。若用户 linger 不可用，则使用用户目录中的 Supervisor，提供 `start-all`、`stop-all`、`status` 和 `logs` 命令。服务只监听 `127.0.0.1`。

没有系统权限时不能承诺服务器重启后自动恢复。如果系统策略不允许用户服务常驻，文档必须明确要求登录后运行 `start-all`，不能通过修改系统服务或 Docker 权限绕过管理员。

日志按大小轮转，只记录请求 ID、耗时、状态码、模型名、revision 和错误类型。日志不得记录简历正文、图片、向量、Bearer Token 或 DeepSeek API Key。临时文件在成功、失败和超时路径中都必须清理。

### 8.4 SSH 隧道

远程端口不对公网开放。本地通过 SSH 隧道访问：

```powershell
ssh -N `
  -L 18080:127.0.0.1:18080 `
  -L 43121:127.0.0.1:43121 `
  heqing@server
```

即使使用 SSH 隧道，两个 Worker 仍要求独立 Bearer Token，因为共享服务器上的其他本地用户也能访问回环端口。Token 文件权限必须为 `600`。密码、SSH 私钥、DeepSeek Key 和服务 Token 不通过聊天、Git 或日志传递。

## 9. RAG 闭环与索引一致性

每个填写任务必须依次执行：

1. 根据表单字段和岗位描述规划所需信息。
2. 为每个信息需求生成查询。
3. 从当前简历版本的已验证事实和证据中检索候选。
4. 验证事实 ID、版本、页码、来源、日期和字段适用性。
5. 对缺失、冲突、低可信或只来自 OCR 的关键事实追问用户。
6. 将用户修正保存为新修订，并只重建受影响的向量记录。
7. 生成待填写计划并进入用户审核。

向量记录必须携带模型名、revision、维度、归一化方式、查询指令版本和资料版本。检索层只能读取与当前索引元数据完全匹配的记录。

自我评价岗位适配同时保存原文、适配版本、差异、使用的事实 ID、模型版本和提示词版本。用户确认适配文本后才能进入自动填写。

## 10. 健康状态与降级行为

本地 API 暴露不含秘密值的适配器状态：

```text
unconfigured  配置整体缺失
configured    云端适配器配置完整，但尚未用付费请求探测
checking      正在检查远程服务
ready         已配置且可用
unavailable   已配置但暂时不可达或未就绪
invalid       配置或模型契约不匹配
```

降级规则如下：

- DeepSeek 不可用时，可以查看和手工维护资料，不能智能抽取或微调。
- Embedding 不可用时，可以浏览已解析资料，不能开始新的 RAG 填写任务。
- OCR 不可用时，原生文本 PDF 仍可解析；遇到异常页时明确失败。
- SSH 隧道断开时显示远程推理节点离线，不能静默跳过检索或 OCR。
- 数据库或核心配置无效时，API 在监听前失败。
- 自动填写任务开始前执行完整预检。Qwen3 和 OCR Worker 必须为 `ready`；需要 DeepSeek 的步骤至少要求其为 `configured` 或 `ready`，实际调用失败时立即停止本次任务并转为 `unavailable`。

健康检查不得调用付费 DeepSeek API。远程 Worker 的就绪检查可以确认模型已加载，但不能记录或返回 GPU 上其他进程的信息。

## 11. 错误处理与重试

- 所有远程调用必须有超时和请求 ID。
- 只对幂等调用执行有限重试。
- `401`、模型名不匹配、revision 不匹配和维度不匹配不得重试。
- Embedding 仅对网络错误、`429` 和可恢复 `5xx` 重试。
- OCR 最多自动重试一次，不能保存第一次的部分文本。
- DeepSeek 使用配置的有限重试，并只允许一次模型升级。
- GPU 显存不足时 Worker 未就绪，不抢占其他 GPU。
- 模型 revision 变化时旧索引仍可读，但新模型在完成全量重建前不能接管检索。

错误消息面向用户说明可执行动作，例如检查 SSH 隧道、启动 Worker 或人工填写；内部错误日志不包含请求正文和秘密值。

## 12. 浏览器自动化边界

生产适配器不会改变动作策略层。浏览器执行器可以执行登录后的页面跳转、普通按钮点击、下拉选择和字段输入，但：

- 提交按钮和等价提交操作在策略层硬性禁止。
- 提交限制不能依赖按钮文案或单一 DOM 选择器。
- 自动填写前必须通过 RAG 验证和内容审核。
- 最终页面展示字段来源、自我评价差异、缺失项和冲突项。
- 用户只能在受控浏览器中自行完成最终提交。

## 13. 测试策略

### 13.1 TypeScript 单元和契约测试

- `loadConfig(env)` 覆盖完整、缺失、部分配置、非法 URL、非法数值和秘密脱敏。
- DeepSeek 假服务器覆盖 JSON 成功、空内容、无效 JSON、Schema 失败、超时、`429`、`5xx`、不可重试 `4xx` 和一次升级。
- Embedding 假服务器覆盖数量、维度、有限数值、模型/revision 不匹配、鉴权、超时和降级状态。
- OCR 假服务器覆盖媒体类型、空文本、模型/revision 不匹配、超时、单次重试和原生 PDF 优先。
- 自动化测试不得读取真实 `.env.local`，不得调用付费 DeepSeek 或远程 GPU。

### 13.2 Python Worker 测试

- 请求 Schema、Bearer Token、请求体限制和错误响应。
- 模型加载失败和 GPU 不可用时的就绪状态。
- Embedding 返回数量、4096 维、有限值和归一化。
- OCR 拒绝 URL、任意文件路径、非法图片和多页请求。
- 日志和异常中不出现输入文本、图片数据或 Token。

### 13.3 GPU 验收

1. 宿主机 `nvidia-smi` 证明新增显存只出现在物理 GPU 5。
2. 相同输入重复生成稳定、有限且归一化的向量。
3. 中文简历查询对相关事实的相似度高于人工选择的无关事实。
4. 中文、英文、扫描版和双栏简历 OCR 包含人工指定的关键锚点。
5. OCR 页面保留页码并进入证据验证流程。
6. 两个 Worker 同时运行时不发生显存不足或迁移 GPU。

### 13.4 端到端与安全验收

- 导入原生文本 PDF 时不调用 OCR。
- 导入扫描 PDF 时只对需要的页面调用 OCR。
- 远程服务停止或 SSH 隧道断开时，本地应用正确降级。
- 用户修正事实后只更新受影响的向量记录。
- 自我评价适配版本在填写前展示差异并要求确认。
- 浏览器自动填写最终停在审核页面，所有提交路径继续被策略层拒绝。

## 14. 实施范围

本规格对应一个实施计划，按以下顺序交付：

1. 拆分结构化生成与 Embedding 接口，并迁移现有假实现和调用方。
2. 实现纯配置加载、`.env.local` 启动脚本和秘密脱敏。
3. 实现 DeepSeek 结构化 Provider 及验证、重试和升级逻辑。
4. 实现远程 Embedding Provider 和 Qwen3 Worker。
5. 实现远程 OCR Engine、DeepSeek-OCR 2 Worker和 PDF 异常页判定。
6. 组合生产依赖、健康状态和降级启动。
7. 增加用户空间部署脚本、离线清单和运维文档。
8. 执行自动化测试、GPU 验收和安全回归。

远程服务器的真实安装在代码与离线资产准备完成后执行。连接服务器时只使用用户提供的 SSH 主机、端口、用户名和已经配置好的公钥认证；不索取或传输密码、私钥和 API Key。

## 15. 完成标准

只有同时满足以下条件，本阶段才算完成：

- 本地 API 能从 `.env.local` 安全加载生产配置。
- DeepSeek Provider 通过 JSON、Zod 和证据验证测试。
- Qwen3 Worker 在物理 GPU 5 上返回符合契约的 4096 维向量。
- DeepSeek-OCR 2 Worker 在物理 GPU 5 上处理约定的简历样本。
- 远程服务离线时本地应用按设计降级，依赖任务被阻止。
- 日志、错误和健康接口不泄露秘密或简历内容。
- RAG 继续执行规划、检索、验证、追问和修正闭环。
- 自我评价适配结果在填写前由用户确认。
- 浏览器中间操作可以自动执行，但所有自动提交路径保持禁止。
- 单元测试、契约测试、类型检查、构建和安全回归全部通过。
