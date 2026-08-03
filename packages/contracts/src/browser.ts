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
  class: ActionClassSchema,
  context: z.string().max(2000).optional()
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
    type: z.literal("handshake"),
    approvalKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
  }).strict(),
  z.object({
    type: z.literal("open"),
    taskId: z.string(),
    url: z.string().url()
  }).strict(),
  z.object({
    type: z.literal("capture_snapshot"),
    taskId: z.string()
  }).strict(),
  z.object({
    type: z.literal("execute"),
    executionEpoch: z.number().int().nonnegative(),
    command: ExecutableCommandSchema
  }).strict(),
  z.object({
    type: z.literal("invalidate_execution"),
    taskId: z.string(),
    executionEpoch: z.number().int().nonnegative()
  }).strict(),
  z.object({
    type: z.literal("shutdown")
  }).strict()
]);

export const WorkerActivityErrorCodeSchema = z.enum([
  "WORKER_EXITED",
  "IPC_DISCONNECTED",
  "REQUEST_TIMEOUT"
]);

export const WorkerActivitySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("page_changed"),
    taskId: z.string().min(1)
  }).strict(),
  z.object({
    type: z.literal("page_stable"),
    taskId: z.string().min(1),
    fingerprint: z.string().min(1).max(256)
  }).strict(),
  z.object({
    type: z.literal("page_unstable"),
    taskId: z.string().min(1),
    fingerprint: z.string().min(1).max(256)
  }).strict(),
  z.object({
    type: z.literal("user_activity"),
    taskId: z.string().min(1),
    fieldId: z.string().min(1).max(128),
    activity: z.enum(["input", "change", "click"])
  }).strict(),
  z.object({
    type: z.literal("worker_connected"),
    taskId: z.string().min(1)
  }).strict(),
  z.object({
    type: z.literal("worker_disconnected"),
    taskId: z.string().min(1),
    code: WorkerActivityErrorCodeSchema.optional()
  }).strict()
]);

export const WorkerResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("activity"),
    activity: WorkerActivitySchema
  }).strict(),
  z.object({
    type: z.literal("ready")
  }).strict(),
  z.object({
    type: z.literal("stopped")
  }).strict(),
  z.object({
    type: z.literal("opened"),
    taskId: z.string(),
    url: z.string().url(),
    title: z.string()
  }).strict(),
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
    actualValue: z.unknown(),
    snapshot: FormSnapshotSchema,
    errors: z.array(z.string())
  }).strict(),
  z.object({
    type: z.literal("worker_error"),
    code: z.string(),
    message: z.string()
  }).strict()
]).superRefine((response, context) => {
  if (response.type === "execution_result" && !Object.prototype.hasOwnProperty.call(response, "actualValue")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["actualValue"],
      message: "Required"
    });
  }
});

export type ActionClass = z.infer<typeof ActionClassSchema>;
export type FormField = z.infer<typeof FormFieldSchema>;
export type PageAction = z.infer<typeof PageActionSchema>;
export type FormSnapshot = z.infer<typeof FormSnapshotSchema>;
export type ExecutableCommand = z.infer<typeof ExecutableCommandSchema>;
export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;
export type WorkerActivityErrorCode = z.infer<typeof WorkerActivityErrorCodeSchema>;
export type WorkerActivity = z.infer<typeof WorkerActivitySchema>;
export type WorkerResponse = z.infer<typeof WorkerResponseSchema>;
