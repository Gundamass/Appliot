import { z } from "zod";
import {
  ChallengeDiagnosticSchema,
  ChallengeKindSchema,
  DomBoundarySchema
} from "./browser-diagnostics.js";
import {
  FilterPlanSchema,
  JobFilterStateSchema,
  JobPageSnapshotSchema
} from "./job-matching.js";

export {
  ChallengeDiagnosticSchema,
  ChallengeKindSchema,
  DomBoundarySchema
} from "./browser-diagnostics.js";
export type {
  ChallengeDiagnostic,
  ChallengeKind,
  DomBoundary
} from "./browser-diagnostics.js";

export const ActionClassSchema = z.enum([
  "safe_edit",
  "intermediate_save",
  "intermediate_navigation",
  "unknown_side_effect",
  "terminal_submit"
]);

export const PageSectionHintSchema = z.enum([
  "basics",
  "preferences",
  "education",
  "work",
  "internship",
  "work_combined",
  "projects",
  "campus",
  "awards",
  "languages",
  "publications",
  "certificates",
  "self"
]);

export const FrameRefSchema = z.object({
  documentId: z.string().min(16).max(128),
  kind: z.literal("main")
}).strict();

export const NodeRefSchema = z.object({
  documentId: FrameRefSchema.shape.documentId,
  nodeId: z.string().min(16).max(128),
  observedAt: z.number().int().nonnegative()
}).strict();

export const StableExecutionErrorCodeSchema = z.enum([
  "control_unstable",
  "controlled_value_reverted",
  "stale_node_ref",
  "node_role_changed",
  "execution_invalidated"
]);

export const FormFieldSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(["text", "textarea", "select", "radio", "checkbox", "date", "file"]),
  required: z.boolean(),
  options: z.array(z.string()),
  optionsTruncated: z.boolean().optional(),
  currentValue: z.unknown(),
  controlKind: z.enum(["native", "custom"]).optional(),
  interactionMode: z.enum(["native", "search", "choice_group", "date_group", "file"]).optional(),
  sectionHint: PageSectionHintSchema.optional(),
  semanticHint: z.string().optional(),
  semanticSource: z.enum(["dji_catalog"]).optional(),
  nodeRef: NodeRefSchema
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
  context: z.string().max(2000).optional(),
  nodeRef: NodeRefSchema
}).strict();

export const FormSnapshotSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  url: z.string().url(),
  title: z.string(),
  stage: z.enum(["login", "application_form", "review", "success", "unknown"]),
  frameRef: FrameRefSchema,
  mutationEpoch: z.number().int().nonnegative(),
  boundaries: z.array(DomBoundarySchema).max(50).optional(),
  challenge: ChallengeDiagnosticSchema.optional(),
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
    nodeRef: NodeRefSchema,
    executionEpoch: z.number().int().nonnegative(),
    value: z.unknown(),
    approval: z.string()
  }).strict(),
  z.object({
    type: z.literal("select"),
    taskId: z.string(),
    snapshotId: z.string(),
    fieldId: z.string(),
    nodeRef: NodeRefSchema,
    executionEpoch: z.number().int().nonnegative(),
    value: z.string(),
    approval: z.string()
  }).strict(),
  z.object({
    type: z.literal("upload"),
    taskId: z.string(),
    snapshotId: z.string(),
    fieldId: z.string(),
    nodeRef: NodeRefSchema,
    executionEpoch: z.number().int().nonnegative(),
    fileId: z.string(),
    approval: z.string()
  }).strict(),
  z.object({
    type: z.literal("click_intermediate"),
    taskId: z.string(),
    snapshotId: z.string(),
    actionId: z.string(),
    nodeRef: NodeRefSchema,
    executionEpoch: z.number().int().nonnegative(),
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
    type: z.literal("capture_job_snapshot"),
    ownerId: z.string().min(1)
  }).strict(),
  z.object({
    type: z.literal("apply_job_filters"),
    ownerId: z.string().min(1),
    plan: FilterPlanSchema,
    executionEpoch: z.number().int().nonnegative()
  }).strict(),
  z.object({
    type: z.literal("advance_job_page"),
    ownerId: z.string().min(1),
    cursor: z.string().min(1).max(1_024).optional(),
    executionEpoch: z.number().int().nonnegative()
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
    type: z.literal("release_task"),
    taskId: z.string().min(1)
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
    type: z.literal("released"),
    taskId: z.string().min(1)
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
    type: z.literal("job_snapshot"),
    snapshot: JobPageSnapshotSchema
  }).strict(),
  z.object({
    type: z.literal("job_filter_result"),
    ownerId: z.string().min(1),
    filterState: z.array(JobFilterStateSchema).max(100),
    snapshot: JobPageSnapshotSchema
  }).strict(),
  z.object({
    type: z.literal("job_page_advanced"),
    ownerId: z.string().min(1),
    snapshot: JobPageSnapshotSchema
  }).strict(),
  z.object({
    type: z.literal("execution_result"),
    taskId: z.string(),
    snapshotId: z.string(),
    commandType: z.enum(["fill", "select", "upload", "click_intermediate"]),
    status: z.enum(["applied", "blocked", "failed"]),
    actualValue: z.unknown(),
    snapshot: FormSnapshotSchema,
    errors: z.array(z.string()),
    warnings: z.array(z.string()).optional()
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
export type PageSectionHint = z.infer<typeof PageSectionHintSchema>;
export type FrameRef = z.infer<typeof FrameRefSchema>;
export type NodeRef = z.infer<typeof NodeRefSchema>;
export type StableExecutionErrorCode = z.infer<typeof StableExecutionErrorCodeSchema>;
export type FormField = z.infer<typeof FormFieldSchema>;
export type PageAction = z.infer<typeof PageActionSchema>;
export type FormSnapshot = z.infer<typeof FormSnapshotSchema>;
export type ExecutableCommand = z.infer<typeof ExecutableCommandSchema>;
export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;
export type WorkerActivityErrorCode = z.infer<typeof WorkerActivityErrorCodeSchema>;
export type WorkerActivity = z.infer<typeof WorkerActivitySchema>;
export type WorkerResponse = z.infer<typeof WorkerResponseSchema>;
