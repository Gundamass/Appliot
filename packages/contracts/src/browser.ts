import { z } from "zod";

export const ActionClassSchema = z.enum([
  "safe_edit",
  "intermediate_save",
  "intermediate_navigation",
  "unknown_side_effect",
  "terminal_submit"
]);

export const FormFieldSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(["text", "textarea", "select", "radio", "checkbox", "date", "file"]),
  required: z.boolean(),
  options: z.array(z.string()),
  currentValue: z.unknown(),
  semanticHint: z.string().optional()
}).strict().superRefine((field, context) => {
  if (!Object.prototype.hasOwnProperty.call(field, "currentValue")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["currentValue"],
      message: "Required"
    });
  }
});

export const PageActionSchema = z.object({
  id: z.string(),
  text: z.string(),
  class: ActionClassSchema
}).strict();

export const FormSnapshotSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  url: z.string().url(),
  title: z.string(),
  stage: z.enum(["login", "application_form", "review", "success", "unknown"]),
  fields: z.array(FormFieldSchema),
  actions: z.array(PageActionSchema),
  errors: z.array(z.string())
}).strict();

export const ExecutableCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("fill"),
    taskId: z.string(),
    snapshotId: z.string(),
    fieldId: z.string(),
    value: z.unknown(),
    approval: z.string()
  }).strict(),
  z.object({
    type: z.literal("select"),
    taskId: z.string(),
    snapshotId: z.string(),
    fieldId: z.string(),
    value: z.string(),
    approval: z.string()
  }).strict(),
  z.object({
    type: z.literal("upload"),
    taskId: z.string(),
    snapshotId: z.string(),
    fieldId: z.string(),
    fileId: z.string(),
    approval: z.string()
  }).strict(),
  z.object({
    type: z.literal("click_intermediate"),
    taskId: z.string(),
    snapshotId: z.string(),
    actionId: z.string(),
    approval: z.string()
  }).strict()
]).superRefine((command, context) => {
  if (command.type === "fill" && !Object.prototype.hasOwnProperty.call(command, "value")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["value"],
      message: "Required"
    });
  }
});

export const WorkerRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("capture_snapshot"),
    taskId: z.string()
  }).strict(),
  z.object({
    type: z.literal("execute"),
    command: ExecutableCommandSchema
  }).strict()
]);

export const WorkerResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    snapshot: FormSnapshotSchema
  }).strict(),
  z.object({
    type: z.literal("execution_result"),
    taskId: z.string(),
    snapshotId: z.string(),
    commandType: z.enum(["fill", "select", "upload", "click_intermediate"]),
    status: z.enum(["applied", "blocked", "failed"]),
    snapshot: FormSnapshotSchema,
    errors: z.array(z.string())
  }).strict()
]);

export type ActionClass = z.infer<typeof ActionClassSchema>;
export type FormField = z.infer<typeof FormFieldSchema>;
export type PageAction = z.infer<typeof PageActionSchema>;
export type FormSnapshot = z.infer<typeof FormSnapshotSchema>;
export type ExecutableCommand = z.infer<typeof ExecutableCommandSchema>;
export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;
export type WorkerResponse = z.infer<typeof WorkerResponseSchema>;
