import { createHash } from "node:crypto";

export interface FieldOperationKeyInput {
  taskId: string;
  sectionHint?: string;
  entryIndex?: number;
  semanticPath: string;
  controlRole: string;
  fieldLabel?: string;
}

export function fieldOperationKey(input: FieldOperationKeyInput): string {
  const dateComponent = splitDateComponent(input.semanticPath, input.fieldLabel);
  const identity = JSON.stringify([
    input.taskId,
    input.sectionHint ?? null,
    input.entryIndex ?? null,
    input.semanticPath,
    input.controlRole,
    dateComponent ?? null
  ]);
  const digest = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 24);
  return `field-operation:${digest}`;
}

function splitDateComponent(
  semanticPath: string,
  fieldLabel: string | undefined
): "year" | "month" | "day" | undefined {
  const semanticComponent = /\.(year|month|day)$/u.exec(semanticPath)?.[1];
  if (semanticComponent) return semanticComponent as "year" | "month" | "day";
  if (!/(?:^|\.)(?:startDate|endDate|birthDate|date)$/u.test(semanticPath) || fieldLabel === undefined) {
    return undefined;
  }
  const label = fieldLabel.normalize("NFKC");
  if (/(?:year|\u5e74)/iu.test(label)) return "year";
  if (/(?:month|\u6708)/iu.test(label)) return "month";
  if (/(?:day|\u65e5|\u53f7)/iu.test(label)) return "day";
  return undefined;
}
