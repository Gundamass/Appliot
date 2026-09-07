import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ApplicationFieldSemanticSchema,
  SkillBindingSchema,
  SkillExecutionRecordSchema,
  type SkillExecutionRecord
} from "@resume/contracts";

const FieldErrorClassSchema = z.enum([
  "field_missing",
  "ambiguous_field",
  "stale_node_ref",
  "write_failed",
  "readback_mismatch",
  "audit_mismatch",
  "challenge"
]);

const FirstErrorClassSchema = z.enum([
  ...FieldErrorClassSchema.options,
  "browser_ownership_lost",
  "timeout"
]);

const FieldPlanSchema = z.object({
  semantic: ApplicationFieldSemanticSchema,
  outcome: z.enum(["resolved", "filled", "skipped", "missing", "failed"]),
  errorClass: FieldErrorClassSchema.optional()
}).strict();

const ReadbackSchema = z.object({
  semantic: ApplicationFieldSemanticSchema,
  outcome: z.enum(["verified", "missing", "failed"]),
  errorClass: FieldErrorClassSchema.optional()
}).strict();

const FailureSchema = z.object({
  stage: z.enum(["observe", "match", "resolve", "write", "readback", "audit", "recovery"]),
  errorClass: FirstErrorClassSchema,
  semantic: ApplicationFieldSemanticSchema.optional()
}).strict();

const AuditMismatchClassSchema = z.enum([
  "required_empty",
  "unexpected_value",
  "unverified_write",
  "hidden_control",
  "unexpected_navigation"
]);

const SkillExecutionRecordInputSchema = z.object({
  taskId: z.string().min(1).max(128).regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u),
  attemptId: z.string().min(1).max(128).regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u),
  binding: SkillBindingSchema,
  pageVariantId: z.string().min(1).max(128).regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u),
  allocation: z.enum(["champion", "challenger"]),
  observedSemantics: z.array(ApplicationFieldSemanticSchema).max(200),
  fieldPlans: z.array(FieldPlanSchema).max(200),
  readbacks: z.array(ReadbackSchema).max(200),
  auditMismatchClasses: z.array(AuditMismatchClassSchema).max(50),
  failures: z.array(FailureSchema).max(50),
  userCorrections: z.number().int().nonnegative(),
  retries: z.number().int().min(0).max(3),
  recoveries: z.number().int().min(0).max(3),
  durationMs: z.number().int().nonnegative(),
  terminalResult: z.enum(["completed_pre_submit", "handoff", "blocked", "failed", "cancelled"]),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime()
}).strict();

export type SkillExecutionRecordInput = z.infer<typeof SkillExecutionRecordInputSchema>;

export interface SkillExecutionRecordSinkPort {
  append(record: SkillExecutionRecord): Promise<void>;
}

export class SkillExecutionRecorderInputError extends Error {
  public constructor(public readonly code: "forbidden_sensitive_material" | "invalid_execution_evidence") {
    super(code);
    this.name = "SkillExecutionRecorderInputError";
  }
}

export class SkillExecutionRecorder {
  public constructor(private readonly sink: SkillExecutionRecordSinkPort) {}

  public async record(input: unknown): Promise<SkillExecutionRecord> {
    if (containsForbiddenMaterial(input)) {
      throw new SkillExecutionRecorderInputError("forbidden_sensitive_material");
    }

    const parsed = SkillExecutionRecordInputSchema.safeParse(input);
    if (!parsed.success || Date.parse(parsed.data.completedAt) < Date.parse(parsed.data.startedAt)) {
      throw new SkillExecutionRecorderInputError("invalid_execution_evidence");
    }

    const data = parsed.data;
    const record = deepFreeze(SkillExecutionRecordSchema.parse({
      recordId: executionRecordId(data),
      taskId: data.taskId,
      attemptId: data.attemptId,
      binding: data.binding,
      pageVariantId: data.pageVariantId,
      allocation: data.allocation,
      fieldOutcomes: fieldOutcomes(data),
      counts: {
        observed: uniqueCount(data.observedSemantics),
        planned: uniqueCount(data.fieldPlans.map((plan) => plan.semantic)),
        verified: uniqueCount(
          data.readbacks
            .filter((readback) => readback.outcome === "verified")
            .map((readback) => readback.semantic)
        ),
        auditMismatches: data.auditMismatchClasses.length,
        userCorrections: data.userCorrections
      },
      auditMismatchClasses: [...new Set(data.auditMismatchClasses)],
      ...(data.failures[0] === undefined ? {} : { firstError: data.failures[0] }),
      retries: data.retries,
      recoveries: data.recoveries,
      durationMs: data.durationMs,
      terminalResult: data.terminalResult,
      startedAt: data.startedAt,
      completedAt: data.completedAt
    }));

    await this.sink.append(record);
    return record;
  }
}

function fieldOutcomes(data: SkillExecutionRecordInput): SkillExecutionRecord["fieldOutcomes"] {
  const outcomes = new Map<string, SkillExecutionRecord["fieldOutcomes"][number]>();
  for (const plan of data.fieldPlans) {
    outcomes.set(plan.semantic, {
      semantic: plan.semantic,
      outcome: plan.outcome,
      ...(plan.errorClass === undefined ? {} : { errorClass: plan.errorClass })
    });
  }
  for (const readback of data.readbacks) {
    outcomes.set(readback.semantic, {
      semantic: readback.semantic,
      outcome: readback.outcome,
      ...(readback.errorClass === undefined ? {} : { errorClass: readback.errorClass })
    });
  }
  return [...outcomes.values()];
}

function executionRecordId(data: SkillExecutionRecordInput): string {
  const identity = [
    data.taskId,
    data.attemptId,
    data.binding.skillId,
    data.binding.version,
    data.binding.allocationId
  ].join("\0");
  const hash = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 32);
  return `skill-record-${hash}`;
}

function uniqueCount(values: readonly string[]): number {
  return new Set(values).size;
}

const FORBIDDEN_KEY = /(?:name|phone|email|resume|value|selector|dom|screenshot|approval.*token|url)/iu;
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PHONE_VALUE = /^\+?\d{7,15}$/u;
const QUERY_URL_VALUE = /^https?:\/\/[^\s?#]+(?:[^\s#]*)\?[^\s#]+/iu;
const API_KEY_VALUE = /^sk-(?:proj-)?[A-Za-z0-9_-]{6,}$/u;
const JWT_VALUE = /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}$/u;

function containsForbiddenMaterial(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") {
    return EMAIL_VALUE.test(value)
      || PHONE_VALUE.test(value)
      || QUERY_URL_VALUE.test(value)
      || API_KEY_VALUE.test(value)
      || JWT_VALUE.test(value);
  }
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) return value.some((item) => containsForbiddenMaterial(item, seen));
  return Object.entries(value).some(([key, nested]) => (
    FORBIDDEN_KEY.test(key) || containsForbiddenMaterial(nested, seen)
  ));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}
