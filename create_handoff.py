#!/usr/bin/env python3
"""Generate the current development handoff without reading private runtime data."""

from __future__ import annotations

import argparse
import shutil
import subprocess
from datetime import datetime
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent
DEFAULT_OUTPUT = REPO_ROOT / "HANDOFF.md"
RTK = shutil.which("rtk")


def git(*args: str) -> str:
    if RTK is None:
        raise RuntimeError("rtk is required; read C:\\Users\\admin\\.codex\\RTK.md")
    result = subprocess.run(
        [RTK, "git", *args],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return result.stdout.strip()


def fenced(value: str, language: str = "text") -> str:
    return f"```{language}\n{value or '(none)'}\n```"


def build_handoff() -> str:
    generated_at = datetime.now().astimezone().isoformat(timespec="seconds")
    branch = git("branch", "--show-current") or "(detached HEAD)"
    commit = git("rev-parse", "--short", "HEAD")
    status = git("status", "--short")
    changed_files = len(status.splitlines()) if status else 0

    return f"""# Appliot 开发交接

生成时间：`{generated_at}`  
仓库：`{REPO_ROOT}`  
分支：`{branch}`  
HEAD：`{commit}`  
未提交路径数：`{changed_files}`

## 交接目标

继续稳定化候选人档案驱动的 ATS 自动填写。当前重点不是扩充技术名词，而是先让 Moka/Mokahr 主文档流程和 DJI 路径达到可验证、可恢复、不会错写且绝不自动提交的工程质量。

## 开始前必须遵守

1. 阅读本文件、会话提供的 `AGENTS.md` 指令和 `C:\\Users\\admin\\.codex\\RTK.md`。
2. 所有 Shell 命令必须以 `rtk` 开头。
3. 根目录存在 `.codegraph/`；理解或定位代码时，先使用 `rtk codegraph explore`。
4. 当前工作树包含大量已有修改。禁止 `reset`、`checkout`、清理或回退不属于自己的修改。
5. 不读取、提交或展示 `.env.local`、本地数据库、简历、浏览器配置、日志中的隐私信息。
6. 最终投递提交继续由 ActionPolicy 和 Browser Worker 两侧禁止。

## 当前 Git 现场

{fenced(status)}

这些修改包含正在进行的稳定化实现和测试。不要仅根据文件名推断任务已经完成；先阅读差异和测试，再决定续写位置。未跟踪的 `experience-routing.*` 与 `field-operation-key.*` 也是当前工作的一部分。

## 已收敛的架构决议

采用限域、渐进式架构：

```text
XState 控制面
  + 版本化 ATS Adapter / 字段本体
  + Trigram 与 Dense 的受限混合召回
  + DeepSeek 对健康 Top-3 候选做按需歧义仲裁
  + Playwright Runtime 执行与 DOM 闭环回读
  + 本地脱敏 TraceSink
```

首个正式支持范围仅为 **Moka/Mokahr 主文档流程与 DJI 路径**。对 iframe、Shadow DOM、验证码或风控边界，MVP 应明确检测并交给用户处理，不得静默越过或声称通用支持。

暂不引入：

- BM25：当前约 83 个中文短字段更适合别名、规则和字符 Trigram。
- BGE-Reranker：默认关闭；先做 Shadow Evaluation，只有 Top-K 召回正确而 Top-1 排序持续错误时再启用。
- Langfuse：MVP 先实现平台无关、脱敏的 TraceSink，后续再考虑自托管 Langfuse。
- Browser-Use、LangGraph：不进入生产执行链，避免与确定性控制面重叠。

## 已确认的后续功能：岗位匹配与推荐

用户提供招聘链接后，如果首先进入岗位列表页，系统应读取岗位列表及详情，并根据候选人档案给出可解释的匹配结果：

```text
打开招聘链接
  -> 识别岗位列表与岗位详情
  -> 提取并归一化岗位要求
  -> 硬性条件过滤
  -> Trigram / Dense 混合匹配
  -> 必要时 DeepSeek 歧义仲裁
  -> 展示推荐岗位或“暂无符合岗位”
  -> 同时展示最接近岗位及具体差距
  -> 用户确认岗位
  -> 进入现有简历填写流程
```

职责边界：

- 岗位匹配模块只分析、排序和解释，不自动替用户选择岗位。
- 用户确认岗位后才打开对应岗位并等待进入简历填写页。
- 匹配模块不获得最终提交权限，也不改变双重禁止自动提交的安全策略。
- 岗位匹配会话与投递任务分离，避免抓取、推荐和表单填写耦合进 `ApplicationService`。

建议技术边界：

- Playwright + 版本化 ATS Job Adapter 提取岗位卡片与详情，首批仍限 Moka/Mokahr 与 DJI。
- 使用统一 `JobPosting`、`JobRequirement`、`MatchEvidence` 和 `JobMatchResult` 契约。
- 先以学历、地点、专业、经验和明确必需技能做硬性条件判断，再进行技术栈、项目、实习和职责的加权匹配。
- 使用现有 Trigram + Dense Embedding；暂不因该功能直接加入 BM25 或 BGE-Reranker。
- DeepSeek 只接收结构化岗位要求和健康召回的 Top-K 档案证据，用于歧义验证与解释，不允许生成候选人经历。
- 前端必须展示匹配证据、缺失项和置信度，不能只展示一个无法解释的百分比。

建议增加独立状态流：

```text
opening_job_page
  -> extracting_jobs
  -> matching_jobs
  -> awaiting_job_selection
  -> waiting_for_form
```

优先级：先完成下述 Browser Runtime 与 Embedding P0，再为岗位匹配补充独立设计和实施计划。不要在当前稳定化任务中顺手把它塞进现有 `ApplicationService`。

## P0：必须先处理

1. **动态 DOM 错写**：`apps/browser-worker/src/dom-registry.ts` 依赖 `nth(index)`，动态插入或重排可能把值写到错误控件。引入 `FrameRef`、`NodeRef`、`MutationEpoch` 和 `NodeRegistry`；旧引用失效后必须重新观察、规划和授权。
2. **受控组件假成功**：`executor.ts` 写入后立即回读，React/Vue 状态可能稍后回滚。执行事务改为 `prepare -> apply -> 等待稳定 -> 局部回读 -> 第二次稳定回读 -> 周期性全页审计`。
3. **Challenge 状态缺失**：新增 `awaiting_challenge` 和 `ChallengeCoordinator`。CAPTCHA、403、429、设备验证或风控出现时，废止 execution epoch 与授权并暂停动作。
4. **iframe / Shadow DOM 漏观测**：MVP 先检测边界并人工接管，不能把未扫描区域当成“没有字段”。
5. **Embedding 批量契约冲突**：Ontology 约 83 项，但远程 Provider 每批上限 32。改为 `32/32/19` 分批，并禁止基础设施失败后逐字段触发 DeepSeek。

## P1：紧随其后

- 将约 1535 行的 `ApplicationService` 拆出 `ResolutionScheduler`、`ControlTransactionCoordinator`、`ChallengeCoordinator` 和 `TraceSink`。
- 字段解析不要用无界 `Promise.all` 冲击远程 GPU Worker；默认 GPU 并发为 1。
- Fact Embedding Index 增加 singleflight，并按模型版本、本体版本缓存。
- Verifier 只评估有效候选，不能让尾部无效候选阻断正确 Top-1。
- Embedding 基础设施失败与语义歧义必须分开；只有健康召回结果允许进入 DeepSeek 仲裁。
- 避免每个控件执行后都做全页扫描，优先局部回读，按周期执行全页审计。
- 增加真实 ATS 的脱敏 DOM 回放和 Moka/DJI 回归证据。

## 已有文档

- `docs/superpowers/specs/2026-08-14-ats-autofill-stability-design.md`
- `docs/superpowers/plans/2026-08-14-ats-autofill-stability.md`
- `docs/superpowers/reports/2026-08-07-domestic-first-ats-regression.md`

现有 9 项实施计划早于本轮架构仲裁，未完整覆盖 Browser Runtime P0。不要直接从原 Task 1 机械执行；应先更新设计和计划，把 Runtime 身份、稳定回读、Challenge 和 Embedding 调度放在最前面。

## 下一窗口执行顺序

1. 运行 `rtk git status --short --branch`，确认现场与本文件一致。
2. 用 `rtk git diff -- <相关文件>` 和 `rtk codegraph explore \"<问题或符号>\"` 理解现有修改，不要覆盖用户工作。
3. 对五个 P0 做代码级复核，优先定位 `dom-registry.ts`、`executor.ts`、`observer.ts`、浏览器 contracts、Embedding Provider 与 Ontology 索引构建。
4. 更新稳定化设计和实施计划，明确 Moka/DJI 限域、失败边界、状态迁移、重试预算和验收测试。
5. 按 TDD 实施：每个 P0 先写能稳定复现的失败测试，再写最小修复。
6. 先跑 owning tests，再跑浏览器集成、Moka/DJI 回归，最后执行全量测试、类型检查和构建。
7. 真实页面测试只到最终审核，验证 `submissionCount === 0`；不得点击或批准最终提交控件。
8. P0 验收后，为“岗位匹配与推荐”编写独立设计与计划；保持岗位匹配会话和投递任务职责分离。

## 第一阶段验收线

- DOM 重排后旧 `NodeRef` 失效，绝不自动绑定到同序号的新控件。
- React/Vue 受控控件在稳定窗口后仍保持目标值才算成功。
- CAPTCHA、403、429、设备验证和风控页面进入明确的 `awaiting_challenge`。
- iframe / Shadow DOM 边界被检测并展示，不会静默漏填。
- 83 项 Ontology 按 32 上限分批，GPU 并发受控，Fact Index 只构建一次。
- 基础设施故障不触发 DeepSeek；歧义仲裁只接收健康召回的 Top-3。
- Moka/DJI 自动填写停在最终审核，自动提交次数始终为 0。

## 建议的新会话首条提示

```text
请先阅读 HANDOFF.md、会话提供的 AGENTS.md、C:\\Users\\admin\\.codex\\RTK.md，以及 HANDOFF.md 中列出的三份设计、计划和回归文档。

当前工作区有大量未提交修改，禁止 reset、checkout、clean 或回退。先运行：
rtk git status --short --branch
rtk codegraph explore \"验证 ATS 自动填写 Runtime P0、Embedding 批处理和当前改动的调用路径\"

本轮不要直接加入 BM25、BGE、Langfuse、Browser-Use 或 LangGraph。先更新稳定化设计与计划，将以下 P0 放到实施顺序最前面：
1. nth(index) 在动态 DOM 下可能错写
2. 受控组件即时回读假成功
3. awaiting_challenge / ChallengeCoordinator 缺失
4. iframe / Shadow DOM 边界漏观测
5. 83 项 Ontology 超过 Embedding 32 项批上限
6. GPU 限流与 Fact Index singleflight

按 TDD 执行，首个正式支持范围仅为 Moka/Mokahr 主文档和 DJI 路径。任何真实页面测试都必须停在最终审核，最终提交继续被双重禁止。

P0 稳定化完成后，继续为 HANDOFF.md 中的“岗位匹配与推荐”编写独立设计：从招聘岗位列表提取岗位，结合候选人档案输出推荐岗位、暂无符合岗位和最接近岗位，并展示匹配证据与差距。系统不得自动选岗，用户确认后才进入现有填写流程。
```

## 交接时未执行的事项

本交接只生成现场文档，没有修改业务实现，也没有运行项目测试。新窗口不能把当前工作树视为已验证通过。
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成当前仓库的中文开发交接文档")
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"输出路径，默认为 {DEFAULT_OUTPUT}",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(build_handoff(), encoding="utf-8")
    print(f"handoff written: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
