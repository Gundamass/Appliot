import type { JsonValue } from "@resume/contracts";
import type { FieldRequest } from "./types.js";

export type QuestionReason = "missing" | "conflict";

export function buildQuestion(request: FieldRequest, reason: QuestionReason, values: JsonValue[] = []): string {
  const prefix = `请提供${quote(request.label.trim())}（${request.semantic.trim()}），该信息仅用于本次投递任务，因为`;
  if (reason === "missing") return `${prefix}未找到有证据支持的信息。`;
  return `${prefix}检索证据中存在冲突值：${values.map(formatValue).join("、")}。`;
}

function quote(value: string): string {
  return `“${value}”`;
}

function formatValue(value: JsonValue): string {
  return JSON.stringify(value);
}
