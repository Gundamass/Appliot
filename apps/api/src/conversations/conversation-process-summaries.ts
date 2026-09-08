import {
  type ConversationProcessToolSummary
} from "@resume/contracts";
import type { ConversationToolName, ConversationToolResult } from "./conversation-tools.js";

type SummaryInput = {
  company?: unknown;
  recruitmentType?: unknown;
};

export function summarizeToolStart(name: ConversationToolName, input: unknown): ConversationProcessToolSummary {
  switch (name) {
    case "discover_recruitment_site": {
      const value = asSummaryInput(input);
      return {
        name: "tavily_search",
        input: [
          { label: "公司", value: boundedValue(value.company, "未指定公司", 120) },
          { label: "招聘类型", value: recruitmentTypeLabel(value.recruitmentType) }
        ]
      };
    }
    case "create_job_match_session":
      return { name: "browser_worker", input: [{ label: "范围", value: "已确认招聘入口" }] };
    case "list_recommendations":
    case "show_recommendation":
      return { name: "job_matching", input: [{ label: "操作", value: "读取岗位推荐" }] };
    case "list_application_tasks":
    case "show_application_task":
      return { name: "application_progress", input: [{ label: "操作", value: "读取本系统投递任务" }] };
    case "create_application_task":
      return { name: "controlled_application", input: [{ label: "操作", value: "创建受控投递任务" }] };
  }
}

export function summarizeToolResult(
  name: ConversationToolName,
  input: unknown,
  result: ConversationToolResult
): ConversationProcessToolSummary {
  const summary = summarizeToolStart(name, input);
  if (name === "discover_recruitment_site") {
    return { ...summary, result: `找到 ${result.recruitmentSearch?.candidates.length ?? 0} 个候选招聘入口` };
  }
  if (name === "create_job_match_session") {
    return { ...summary, result: "招聘页面已读取，等待筛选确认" };
  }
  if (name === "create_application_task") {
    return { ...summary, result: "受控投递任务已创建，尚未最终提交" };
  }
  return { ...summary, result: `返回 ${result.cards.length} 条记录` };
}

function asSummaryInput(input: unknown): SummaryInput {
  if (typeof input !== "object" || input === null) return {};
  const value = input as Record<string, unknown>;
  return { company: value.company, recruitmentType: value.recruitmentType };
}

function boundedValue(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  return value.trim().replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, maxLength);
}

function recruitmentTypeLabel(value: unknown): string {
  if (value === "campus") return "校园招聘";
  if (value === "social") return "社会招聘";
  if (value === "internship") return "实习招聘";
  return "招聘";
}
