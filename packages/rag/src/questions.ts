import type { JsonValue } from "@resume/contracts";
import type { FieldRequest } from "./types.js";

export type QuestionReason = "missing" | "conflict";

export function buildQuestion(request: FieldRequest, reason: QuestionReason, values: JsonValue[] = []): string {
  const prefix = `Please provide ${quote(request.label.trim())} (${request.semantic.trim()}) for this application task only because `;
  if (reason === "missing") return `${prefix}no supported information was found.`;
  return `${prefix}the retrieved evidence has conflicting values: ${values.map(formatValue).join(", ")}.`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function formatValue(value: JsonValue): string {
  return JSON.stringify(value);
}
