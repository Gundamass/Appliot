import type { ConversationProcessEvent, ConversationProcessToolName } from "@resume/contracts";
import { AlertCircle, Check, ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ConversationTurnProcess } from "./conversation-process-model.js";

interface ConversationTurnTraceProps {
  process: ConversationTurnProcess;
  isLatestTurn: boolean;
}

const STAGE_LABELS: Record<ConversationProcessEvent["stage"], string> = {
  understanding_request: "理解你的请求",
  searching_recruitment_site: "搜索官方招聘入口",
  validating_recruitment_site: "校验招聘入口",
  recruitment_site_found: "找到招聘入口",
  waiting_for_confirmation: "等待你的确认",
  processing_confirmation: "处理你的确认",
  reading_recruitment_site: "读取招聘入口",
  loading_recommendations: "加载岗位推荐",
  matching_jobs: "匹配岗位",
  loading_application_progress: "查询投递进度",
  creating_job_match_session: "创建岗位匹配",
  job_match_session_ready: "岗位匹配已准备好",
  creating_application_task: "创建受控投递任务",
  generating_response: "生成回复",
  completed: "完成",
  failed: "处理失败"
};

const TOOL_LABELS: Record<ConversationProcessToolName, string> = {
  tavily_search: "Tavily Search",
  url_guard: "招聘入口安全校验",
  browser_worker: "受控浏览器",
  job_matching: "岗位匹配",
  application_progress: "投递进度",
  controlled_application: "受控投递"
};

export function ConversationTurnTrace({ process, isLatestTurn }: ConversationTurnTraceProps) {
  const [expanded, setExpanded] = useState(process.active);
  const manuallyChanged = useRef(false);

  useEffect(() => {
    if (process.active) {
      setExpanded(true);
    } else if (!isLatestTurn && !manuallyChanged.current) {
      setExpanded(false);
    }
  }, [isLatestTurn, process.active]);

  return (
    <section className="conversation-turn-trace" aria-label="本轮执行过程">
      <button
        type="button"
        className="conversation-turn-trace-toggle"
        aria-expanded={expanded}
        aria-label={expanded ? "收起执行过程" : "展开执行过程"}
        onClick={() => {
          manuallyChanged.current = true;
          setExpanded((value) => !value);
        }}
      >
        <TraceSummary process={process} expanded={expanded} />
      </button>
      {expanded ? (
        <ol className="conversation-turn-trace-list" aria-label="本轮执行过程">
          {process.steps.map((step) => <TraceStep key={step.stepId} event={step} />)}
        </ol>
      ) : null}
    </section>
  );
}

function TraceSummary({ process, expanded }: { process: ConversationTurnProcess; expanded: boolean }) {
  const Icon = process.failed ? AlertCircle : process.active ? LoaderCircle : Check;
  const status = process.failed ? "处理失败" : process.active ? "执行中" : "已完成";
  return (
    <span className={`conversation-turn-trace-summary ${process.failed ? "failed" : process.active ? "active" : "completed"}`}>
      <span className="conversation-turn-trace-summary-point"><Icon aria-hidden="true" size={14} className={process.active ? "conversation-turn-trace-spinner" : undefined} /></span>
      <span className="conversation-turn-trace-summary-copy">
        <strong>执行过程</strong>
        <small>{process.steps.length} 个步骤 · {status}{process.totalDurationMs > 0 ? ` · ${formatDuration(process.totalDurationMs)}` : ""}</small>
      </span>
      {expanded ? <ChevronDown aria-hidden="true" size={15} /> : <ChevronRight aria-hidden="true" size={15} />}
    </span>
  );
}

function TraceStep({ event }: { event: ConversationProcessEvent }) {
  return (
    <li className={`conversation-turn-trace-step ${event.status}`}>
      <span className="conversation-turn-trace-point"><StepIcon status={event.status} /></span>
      <span className="conversation-turn-trace-copy">
        <strong>{STAGE_LABELS[event.stage]}</strong>
        <small>{event.summary}</small>
        {event.tool ? <ToolDetail tool={event.tool} /> : null}
        {event.failure && event.failure.summary !== event.summary ? <small className="conversation-turn-trace-failure">{event.failure.summary}</small> : null}
      </span>
      {event.durationMs === undefined ? null : <time className="conversation-turn-trace-duration">{formatDuration(event.durationMs)}</time>}
    </li>
  );
}

function ToolDetail({ tool }: { tool: NonNullable<ConversationProcessEvent["tool"]> }) {
  return (
    <span className="conversation-turn-trace-tool-detail">
      <strong>{TOOL_LABELS[tool.name]}</strong>
      {tool.input.map((item) => <span key={`${item.label}-${item.value}`}>{item.label}：{item.value}</span>)}
      {tool.result ? <span>{tool.result}</span> : null}
    </span>
  );
}

function StepIcon({ status }: { status: ConversationProcessEvent["status"] }) {
  if (status === "completed") return <Check aria-hidden="true" size={12} />;
  if (status === "failed") return <AlertCircle aria-hidden="true" size={12} />;
  return <LoaderCircle aria-hidden="true" size={12} className="conversation-turn-trace-spinner" />;
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${durationMs} 毫秒` : `${(durationMs / 1_000).toFixed(1)} 秒`;
}
