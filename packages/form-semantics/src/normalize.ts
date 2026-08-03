import { createHash } from "node:crypto";
import { FormSnapshotSchema, type FormField, type FormSnapshot } from "@resume/contracts";
import { classifyAction } from "./action-classifier.js";
import type { RawFormField, RawFormObservation } from "./snapshot-script.js";

export interface FormContext {
  taskId: string;
  url: string;
  title: string;
  stage: FormSnapshot["stage"];
}

export function normalizeForm(raw: RawFormObservation, context: FormContext): FormSnapshot {
  const fields = raw.fields.map((field) => normalizeField(field));
  const actions = raw.actions.map((action) => ({
    id: opaqueId("action", action.path),
    text: action.text || action.ariaLabel || "未命名操作",
    class: classifyAction({
      text: action.text,
      ariaLabel: action.ariaLabel,
      nearbyText: action.nearbyText,
      stage: context.stage
    }),
    ...(action.nearbyText === "" ? {} : { context: action.nearbyText })
  }));
  const snapshotSeed = JSON.stringify({ context, fields, actions, errors: raw.errors });
  return FormSnapshotSchema.parse({
    id: opaqueId("snapshot", snapshotSeed),
    taskId: context.taskId,
    url: context.url,
    title: context.title,
    stage: context.stage,
    fields,
    actions,
    errors: raw.errors
  });
}

function normalizeField(raw: RawFormField): FormField {
  const label = [raw.explicitLabel, raw.wrappingLabel, raw.ariaLabel, raw.ariaLabelledBy, raw.nearbyText, raw.name]
    .find((candidate) => candidate.trim() !== "") ?? "未命名字段";
  return {
    id: opaqueId("field", raw.path),
    label,
    type: fieldType(raw),
    required: raw.required,
    options: raw.options,
    currentValue: raw.value,
    ...(raw.name === "" ? {} : { semanticHint: raw.name })
  };
}

function fieldType(raw: RawFormField): FormField["type"] {
  if (raw.tag === "textarea") return "textarea";
  if (raw.tag === "select") return "select";
  if (raw.inputType === "checkbox") return "checkbox";
  if (raw.inputType === "radio") return "radio";
  if (raw.inputType === "date") return "date";
  if (raw.inputType === "file") return "file";
  return "text";
}

function opaqueId(prefix: "field" | "action" | "snapshot", value: string): string {
  return `${prefix}_${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16)}`;
}
