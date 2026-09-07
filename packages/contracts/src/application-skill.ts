import { z } from "zod";
import { NodeRefSchema } from "./browser.js";

const RuntimeIdentifierSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u);
const IdentifierSchema = RuntimeIdentifierSchema.superRefine((value, context) => {
  addPersistedLiteralRiskIssue(value, context, "unsafe_persisted_identifier");
});
const SemanticVersionSchema = z.string()
  .max(64)
  .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const SiteSchema = z.enum(["baidu", "moka", "dji"]);
const DomainSchema = z.string()
  .max(253)
  .regex(/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u);

const ApplicationFieldSemantics = [
  "basics.name",
  "basics.englishName",
  "basics.email",
  "basics.phone",
  "basics.wechat",
  "basics.qq",
  "basics.gender",
  "basics.birthDate",
  "basics.birthDate.year",
  "basics.birthDate.month",
  "basics.birthDate.day",
  "basics.nationality",
  "basics.ethnicity",
  "basics.politicalStatus",
  "basics.maritalStatus",
  "basics.currentLocation",
  "basics.hukouLocation",
  "basics.avatar",
  "basics.resumeFile",
  "identity.idType",
  "identity.idNumber",
  "preferences.targetRole",
  "preferences.targetCity",
  "preferences.employmentType",
  "preferences.industry",
  "preferences.workMode",
  "preferences.salary",
  "preferences.availability",
  "preferences.willingToRelocate",
  "preferences.willingToTravel",
  "education[].institution",
  "education[].degree",
  "education[].degreeType",
  "education[].enrollmentType",
  "education[].major",
  "education[].majorCategory",
  "education[].department",
  "education[].schoolLocation",
  "education[].startDate",
  "education[].startDate.year",
  "education[].startDate.month",
  "education[].startDate.day",
  "education[].endDate",
  "education[].endDate.year",
  "education[].endDate.month",
  "education[].endDate.day",
  "education[].isHighest",
  "education[].isExchange",
  "education[].isJointProgram",
  "education[].gpa",
  "education[].rank",
  "education[].advisor",
  "education[].isNationalKeyLab",
  "education[].hasLaboratory",
  "education[].laboratory",
  "education[].description",
  "work[].company",
  "work[].position",
  "work[].department",
  "work[].employmentType",
  "work[].startDate",
  "work[].startDate.year",
  "work[].startDate.month",
  "work[].startDate.day",
  "work[].endDate",
  "work[].endDate.year",
  "work[].endDate.month",
  "work[].endDate.day",
  "work[].description",
  "projects[].name",
  "projects[].role",
  "projects[].startDate",
  "projects[].startDate.year",
  "projects[].startDate.month",
  "projects[].startDate.day",
  "projects[].endDate",
  "projects[].endDate.year",
  "projects[].endDate.month",
  "projects[].endDate.day",
  "projects[].description",
  "projects[].technologies",
  "projects[].url",
  "projects[].highlights[0]",
  "campus[].name",
  "campus[].role",
  "campus[].startDate",
  "campus[].startDate.year",
  "campus[].startDate.month",
  "campus[].startDate.day",
  "campus[].endDate",
  "campus[].endDate.year",
  "campus[].endDate.month",
  "campus[].endDate.day",
  "campus[].description",
  "campus[].highlights[0]",
  "awards[].name",
  "awards[].date",
  "awards[].date.year",
  "awards[].date.month",
  "awards[].date.day",
  "awards[].level",
  "awards[].description",
  "publications[].title",
  "publications[].type",
  "publications[].publisher",
  "publications[].date",
  "publications[].date.year",
  "publications[].date.month",
  "publications[].date.day",
  "publications[].authors",
  "publications[].url",
  "publications[].description",
  "languages[].name",
  "languages[].proficiency",
  "languages[].speakingListening",
  "languages[].readingWriting",
  "certificates[].name",
  "certificates[].issuer",
  "certificates[].date",
  "certificates[].date.year",
  "certificates[].date.month",
  "certificates[].date.day",
  "certificates[].description",
  "selfEvaluation"
] as const;

export const ApplicationFieldSemanticSchema = z.enum(ApplicationFieldSemantics);
export type ApplicationFieldSemantic = z.infer<typeof ApplicationFieldSemanticSchema>;

export const ApplicationSkillCapabilitySchema = z.enum([
  "observe",
  "fill_empty_fields",
  "select_option",
  "upload_approved_file",
  "readback",
  "full_page_audit"
]);
export type ApplicationSkillCapability = z.infer<typeof ApplicationSkillCapabilitySchema>;

const ControlTypeSchema = z.enum(["text", "textarea", "select", "radio", "checkbox", "date", "file"]);
export const SafeStaticUiHintSchema = z.string().trim().min(1).max(120).superRefine((value, context) => {
  if (addPersistedLiteralRiskIssue(value, context, "unsafe_static_ui_hint")) return;
  const normalized = normalizeRiskText(value);
  if (hasSensitivePath(normalized) || hasExecutableLiteralSyntax(normalized)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "unsafe_static_ui_hint" });
  }
});
export type SafeStaticUiHint = z.infer<typeof SafeStaticUiHintSchema>;

const StableAttributeValueSchema = z.string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/u)
  .refine((value) => !/\d{6,}/u.test(value), "dynamic_attribute_value_not_allowed")
  .refine((value) => !/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/iu.test(value), "dynamic_attribute_value_not_allowed")
  .superRefine((value, context) => {
    addPersistedLiteralRiskIssue(value, context, "unsafe_stable_attribute_value");
  });
const RestrictedCssSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^(?:[a-z][a-z0-9-]*)?(?:\[(?:data-testid|data-field|data-name|name|aria-label)="[A-Za-z][A-Za-z0-9_.-]{0,79}"\])+$/u)
  .superRefine((selector, context) => {
    const values = [...selector.matchAll(/="([^"]+)"/gu)].map((match) => match[1]);
    values.forEach((value, index) => {
      if (!StableAttributeValueSchema.safeParse(value).success) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: "dynamic_css_attribute_not_allowed" });
      }
    });
  });

const LocatorHintSchema = z.discriminatedUnion("by", [
  z.object({ key: IdentifierSchema, by: z.literal("label"), text: SafeStaticUiHintSchema }).strict(),
  z.object({
    key: IdentifierSchema,
    by: z.literal("role"),
    role: z.enum(["textbox", "combobox", "radio", "checkbox", "button"]),
    name: SafeStaticUiHintSchema.optional()
  }).strict(),
  z.object({ key: IdentifierSchema, by: z.literal("placeholder"), text: SafeStaticUiHintSchema }).strict(),
  z.object({
    key: IdentifierSchema,
    by: z.literal("stable_attribute"),
    attribute: z.enum(["data-testid", "data-field", "data-name", "name", "aria-label"]),
    value: StableAttributeValueSchema
  }).strict(),
  z.object({ key: IdentifierSchema, by: z.literal("css"), selector: RestrictedCssSchema }).strict()
]);

const LocatorHintsSchema = z.array(LocatorHintSchema).min(1).max(8).superRefine((hints, context) => {
  const keys = new Set<string>();
  for (const [index, hint] of hints.entries()) {
    if (keys.has(hint.key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "key"], message: "duplicate_locator_key" });
    }
    keys.add(hint.key);
    if (hint.by === "css" && (index === 0 || index !== hints.length - 1)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: "css_must_be_final_fallback" });
    }
  }
});

export const ApplicationSkillFieldSchema = z.object({
  semantic: ApplicationFieldSemanticSchema,
  controlTypes: z.array(ControlTypeSchema).min(1).max(7),
  locatorHints: LocatorHintsSchema
}).strict();
export type ApplicationSkillField = z.infer<typeof ApplicationSkillFieldSchema>;

const RelativeRoutePatternSchema = z.string().min(1).max(240)
  .refine((value) =>
    value.startsWith("/")
      && !value.startsWith("//")
      && !value.includes("://")
      && !/[\\?#]/u.test(value), "relative_route_pattern_required")
  .superRefine((value, context) => {
    if (addPersistedLiteralRiskIssue(value, context, "unsafe_relative_route_pattern")) return;
    if (hasSensitivePath(normalizeRiskText(value))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "unsafe_relative_route_pattern" });
    }
  });

const PageVariantMatchSchema = z.object({
  routePatterns: z.array(RelativeRoutePatternSchema).min(1).max(8),
  requiredTexts: z.array(SafeStaticUiHintSchema).max(12),
  requiredFields: z.array(ApplicationFieldSemanticSchema).max(40)
}).strict();

export const ApplicationSkillPageVariantSchema = z.object({
  id: IdentifierSchema,
  match: PageVariantMatchSchema,
  workflowEntry: IdentifierSchema
}).strict();
export type ApplicationSkillPageVariant = z.infer<typeof ApplicationSkillPageVariantSchema>;

const SkillConditionPredicateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page-variant"), variantId: IdentifierSchema }).strict(),
  z.object({ kind: z.literal("field-present"), semantic: ApplicationFieldSemanticSchema }).strict(),
  z.object({ kind: z.literal("field-empty"), semantic: ApplicationFieldSemanticSchema }).strict(),
  z.object({ kind: z.literal("challenge-present") }).strict(),
  z.object({ kind: z.literal("capability-available"), capability: ApplicationSkillCapabilitySchema }).strict()
]);

export const SkillConditionSchema = z.union([
  SkillConditionPredicateSchema,
  z.object({ kind: z.literal("all"), conditions: z.array(SkillConditionPredicateSchema).min(1).max(8) }).strict(),
  z.object({ kind: z.literal("any"), conditions: z.array(SkillConditionPredicateSchema).min(1).max(8) }).strict(),
  z.object({ kind: z.literal("not"), condition: SkillConditionPredicateSchema }).strict()
]);
export type SkillCondition = z.infer<typeof SkillConditionSchema>;

const WorkflowActionSchema = z.discriminatedUnion("capability", [
  z.object({ capability: z.literal("observe") }).strict(),
  z.object({
    capability: z.literal("fill_empty_fields"),
    semantics: z.array(ApplicationFieldSemanticSchema).min(1).max(100)
  }).strict(),
  z.object({
    capability: z.literal("select_option"),
    semantics: z.array(ApplicationFieldSemanticSchema).min(1).max(100)
  }).strict(),
  z.object({ capability: z.literal("upload_approved_file"), semantic: ApplicationFieldSemanticSchema }).strict(),
  z.object({
    capability: z.literal("readback"),
    semantics: z.array(ApplicationFieldSemanticSchema).min(1).max(100)
  }).strict(),
  z.object({ capability: z.literal("full_page_audit") }).strict()
]);

const WorkflowSuccessSchema = z.enum([
  "page_observed",
  "fields_resolved",
  "writes_read_back",
  "audit_clean",
  "recovery_completed"
]);

export const ApplicationSkillWorkflowStepSchema = z.object({
  id: IdentifierSchema,
  when: SkillConditionSchema.optional(),
  actions: z.array(WorkflowActionSchema).min(1).max(20),
  success: z.array(WorkflowSuccessSchema).min(1).max(5),
  next: z.union([IdentifierSchema, z.literal("continue_or_wait")])
}).strict();
export type ApplicationSkillWorkflowStep = z.infer<typeof ApplicationSkillWorkflowStepSchema>;

export const SkillRecoveryActionSchema = z.enum(["reobserve", "scroll-into-view", "refresh-node-ref"]);
export const ApplicationSkillRecoverySchema = z.object({
  maxRetries: z.number().int().min(0).max(3),
  actions: z.array(SkillRecoveryActionSchema).max(3)
}).strict();

export const ApplicationSkillContentSchema = z.object({
  capabilities: z.array(ApplicationSkillCapabilitySchema).min(1).max(6),
  pageVariants: z.array(ApplicationSkillPageVariantSchema).min(1).max(20),
  fields: z.array(ApplicationSkillFieldSchema).min(1).max(100),
  workflow: z.array(ApplicationSkillWorkflowStepSchema).min(1).max(50),
  recovery: ApplicationSkillRecoverySchema
}).strict().superRefine((content, context) => {
  checkUnique(content.capabilities, context, ["capabilities"], "duplicate_capability");
  checkUnique(content.pageVariants.map((variant) => variant.id), context, ["pageVariants"], "duplicate_page_variant");
  checkUnique(content.fields.map((field) => field.semantic), context, ["fields"], "duplicate_field_semantic");
  checkUnique(content.workflow.map((step) => step.id), context, ["workflow"], "duplicate_workflow_step");

  const declared = new Set(content.capabilities);
  if (!declared.has("full_page_audit")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["capabilities"],
      message: "full_page_audit_capability_required"
    });
  }
  if (!workflowHasAudit(content.workflow)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["workflow"],
      message: "full_page_audit_action_required"
    });
  }
  content.workflow.forEach((step, stepIndex) => {
    step.actions.forEach((action, actionIndex) => {
      if (!declared.has(action.capability)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["workflow", stepIndex, "actions", actionIndex, "capability"],
          message: "undeclared_capability"
        });
      }
    });
  });
});
export type ApplicationSkillContent = z.infer<typeof ApplicationSkillContentSchema>;

const PageFingerprintRuleSchema = z.object({
  ruleId: IdentifierSchema,
  ruleHash: HashSchema
}).strict();

const SkillCreationProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual_seed"), actorId: IdentifierSchema }).strict(),
  z.object({ kind: z.literal("evolution_agent"), actorId: IdentifierSchema, evolutionRunId: RuntimeIdentifierSchema }).strict(),
  z.object({ kind: z.literal("system_migration"), actorId: IdentifierSchema }).strict()
]);

export const ApplicationSkillVersionSchema = z.object({
  skillId: IdentifierSchema,
  version: SemanticVersionSchema,
  parentVersion: SemanticVersionSchema.optional(),
  schemaVersion: z.literal(1),
  contentHash: HashSchema,
  site: SiteSchema,
  allowedDomains: z.array(DomainSchema).min(1).max(8),
  pageFingerprintRule: PageFingerprintRuleSchema,
  status: z.enum(["candidate", "replay_qualified", "challenger", "champion", "retired", "quarantined"]),
  content: ApplicationSkillContentSchema,
  createdBy: SkillCreationProvenanceSchema,
  createdAt: z.string().datetime()
}).strict();
export type ApplicationSkillVersion = z.infer<typeof ApplicationSkillVersionSchema>;

export const SkillBindingSchema = z.object({
  skillId: IdentifierSchema,
  version: SemanticVersionSchema,
  site: SiteSchema,
  pageFingerprintHash: HashSchema,
  allocationId: RuntimeIdentifierSchema
}).strict();
export type SkillBinding = z.infer<typeof SkillBindingSchema>;

export const SkillDirectiveSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("resolve-field"),
    semantic: ApplicationFieldSemanticSchema,
    locatorKeys: z.array(IdentifierSchema).min(1).max(8)
  }).strict(),
  z.object({ kind: z.literal("verify-field"), semantic: ApplicationFieldSemanticSchema }).strict(),
  z.object({ kind: z.literal("recover"), action: SkillRecoveryActionSchema }).strict()
]);
export type SkillDirective = z.infer<typeof SkillDirectiveSchema>;

const SkillFieldOutcomeSchema = z.object({
  semantic: ApplicationFieldSemanticSchema,
  outcome: z.enum(["resolved", "filled", "verified", "skipped", "missing", "failed"]),
  nodeRef: NodeRefSchema.optional(),
  errorClass: z.enum([
    "field_missing",
    "ambiguous_field",
    "stale_node_ref",
    "write_failed",
    "readback_mismatch",
    "audit_mismatch",
    "challenge"
  ]).optional()
}).strict();

const SkillExecutionCountsSchema = z.object({
  observed: z.number().int().nonnegative(),
  planned: z.number().int().nonnegative(),
  verified: z.number().int().nonnegative(),
  auditMismatches: z.number().int().nonnegative(),
  userCorrections: z.number().int().nonnegative()
}).strict();

const SkillFirstErrorSchema = z.object({
  stage: z.enum(["observe", "match", "resolve", "write", "readback", "audit", "recovery"]),
  errorClass: z.enum([
    "field_missing",
    "ambiguous_field",
    "stale_node_ref",
    "write_failed",
    "readback_mismatch",
    "audit_mismatch",
    "challenge",
    "browser_ownership_lost",
    "timeout"
  ]),
  semantic: ApplicationFieldSemanticSchema.optional()
}).strict();

export const SkillExecutionRecordSchema = z.object({
  recordId: RuntimeIdentifierSchema,
  taskId: RuntimeIdentifierSchema,
  attemptId: RuntimeIdentifierSchema,
  binding: SkillBindingSchema,
  pageVariantId: IdentifierSchema,
  fieldOutcomes: z.array(SkillFieldOutcomeSchema).max(200),
  counts: SkillExecutionCountsSchema,
  auditMismatchClasses: z.array(z.enum([
    "required_empty",
    "unexpected_value",
    "unverified_write",
    "hidden_control",
    "unexpected_navigation"
  ])).max(50),
  firstError: SkillFirstErrorSchema.optional(),
  retries: z.number().int().min(0).max(3),
  recoveries: z.number().int().min(0).max(3),
  durationMs: z.number().int().nonnegative(),
  terminalResult: z.enum(["completed_pre_submit", "handoff", "blocked", "failed", "cancelled"]),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime()
}).strict();
export type SkillExecutionRecord = z.infer<typeof SkillExecutionRecordSchema>;

export const SkillEvaluationSchema = z.object({
  evaluationId: RuntimeIdentifierSchema,
  executionRecordId: RuntimeIdentifierSchema,
  evaluatorVersion: SemanticVersionSchema,
  source: z.enum(["replay", "synthetic", "online"]),
  safetyViolations: z.number().int().nonnegative(),
  incorrectWrites: z.number().int().nonnegative(),
  fieldAccuracy: z.number().min(0).max(1),
  requiredCompletion: z.number().min(0).max(1),
  userCorrections: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  recoveries: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  decision: z.enum(["pass", "fail", "equal"]),
  evaluatedAt: z.string().datetime()
}).strict();
export type SkillEvaluation = z.infer<typeof SkillEvaluationSchema>;

const AddPatchOperationSchema = z.discriminatedUnion("path", [
  z.object({ path: z.literal("/capabilities/-"), op: z.literal("add"), value: ApplicationSkillCapabilitySchema }).strict(),
  z.object({ path: z.literal("/pageVariants/-"), op: z.literal("add"), value: ApplicationSkillPageVariantSchema }).strict(),
  z.object({ path: z.literal("/fields/-"), op: z.literal("add"), value: ApplicationSkillFieldSchema }).strict(),
  z.object({ path: z.literal("/workflow/-"), op: z.literal("add"), value: ApplicationSkillWorkflowStepSchema }).strict()
]);

const AuditPreservingCapabilitiesSchema = z.array(ApplicationSkillCapabilitySchema)
  .min(1)
  .max(6)
  .refine((capabilities) => capabilities.includes("full_page_audit"), "full_page_audit_capability_required");
const AuditPreservingWorkflowSchema = z.array(ApplicationSkillWorkflowStepSchema)
  .min(1)
  .max(50)
  .refine(workflowHasAudit, "full_page_audit_action_required");

const ReplacePatchOperationSchema = z.discriminatedUnion("path", [
  z.object({ path: z.literal("/capabilities"), op: z.literal("replace"), value: AuditPreservingCapabilitiesSchema }).strict(),
  z.object({ path: z.literal("/pageVariants"), op: z.literal("replace"), value: z.array(ApplicationSkillPageVariantSchema).min(1).max(20) }).strict(),
  z.object({ path: z.literal("/fields"), op: z.literal("replace"), value: z.array(ApplicationSkillFieldSchema).min(1).max(100) }).strict(),
  z.object({ path: z.literal("/workflow"), op: z.literal("replace"), value: AuditPreservingWorkflowSchema }).strict(),
  z.object({ path: z.literal("/recovery"), op: z.literal("replace"), value: ApplicationSkillRecoverySchema }).strict()
]);

const RemovePatchOperationSchema = z.object({
  op: z.literal("remove"),
  path: z.string().regex(/^\/(?:pageVariants|fields)\/(?:0|[1-9]\d*)$/u)
}).strict();

const SkillPatchOperationSchema = z.union([
  AddPatchOperationSchema,
  ReplacePatchOperationSchema,
  RemovePatchOperationSchema
]);

export const SkillEvolutionPatchSchema = z.object({
  parentContentHash: HashSchema,
  operations: z.array(SkillPatchOperationSchema).min(1).max(64)
}).strict();
export type SkillEvolutionPatch = z.infer<typeof SkillEvolutionPatchSchema>;

function workflowHasAudit(workflow: readonly z.infer<typeof ApplicationSkillWorkflowStepSchema>[]): boolean {
  return workflow.some((step) => step.actions.some((action) => action.capability === "full_page_audit"));
}

function normalizeRiskText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function hasPersistedLiteralRisk(value: string): boolean {
  const normalized = normalizeRiskText(value);
  const compactPhone = normalized.replace(/[\s()+-]/gu, "");
  const credentialWords = normalized.replace(/[_/\-\s]+/gu, " ");
  return /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[a-z]{2,}/iu.test(normalized)
    || /(?:^|\D)1[3-9]\d{9}(?:\D|$)/u.test(compactPhone)
    || /(?:https?|ftp|file|data|javascript):|www\./iu.test(normalized)
    || /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/iu.test(normalized)
    || /(?:^|[^a-f0-9])[a-f0-9]{32,}(?:[^a-f0-9]|$)/iu.test(normalized)
    || /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:[^A-Za-z0-9_-]|$)/u.test(value)
    || /[A-Za-z0-9+_=]{32,}/u.test(value)
    || /(?:^|[^a-z0-9])(?:approval|authorization|bearer|token|secret|api\s*key)(?:$|[^a-z0-9])/iu.test(credentialWords)
    || /批准令牌|审批令牌|密钥|秘钥|口令/u.test(normalized)
    || hasSegmentedOpaqueValue(value);
}

function addPersistedLiteralRiskIssue(value: string, context: z.RefinementCtx, message: string): boolean {
  if (!hasPersistedLiteralRisk(value)) return false;
  context.addIssue({ code: z.ZodIssueCode.custom, message });
  return true;
}

function hasSensitivePath(value: string): boolean {
  return /[a-z]:[\\/]|\\\\|(?:^|[\s/])(?:api|v\d+|home|users|etc|var|tmp)(?:\/|$)/iu.test(value);
}

function hasExecutableLiteralSyntax(value: string): boolean {
  return /(?:^|\s)\/\/[A-Za-z*]|\/html(?:\/|$)|\[[^\]]*@[A-Za-z_:][^\]]*\]/u.test(value)
    || /(?:ancestor|ancestor-or-self|attribute|child|descendant|descendant-or-self|following|following-sibling|namespace|parent|preceding|preceding-sibling|self)\s*::/iu.test(value)
    || /javascript\s*:|document\s*(?:\.|\[)|window\s*(?:\.|\[)|\b(?:eval|fetch|xmlhttprequest)\s*\(/iu.test(value)
    || /\baxios\s*(?:\.[a-z][a-z0-9_]*\s*\(|\()/iu.test(value);
}

function hasSegmentedOpaqueValue(value: string): boolean {
  const chunks = value.split(/[-_/]+/u);
  let run: string[] = [];

  for (const chunk of chunks) {
    if (/^[A-Za-z0-9]{4,}$/u.test(chunk)) {
      run.push(chunk);
      continue;
    }
    if (hasOpaqueChunkWindow(run)) return true;
    run = [];
  }

  return hasOpaqueChunkWindow(run);
}

function hasOpaqueChunkWindow(chunks: readonly string[]): boolean {
  for (let start = 0; start <= chunks.length - 3; start += 1) {
    let combined = "";
    for (let end = start; end < chunks.length; end += 1) {
      combined += chunks[end];
      if (end - start + 1 < 3 || combined.length < 24) continue;

      const normalized = combined.toLowerCase();
      const digitCount = normalized.match(/\d/gu)?.length ?? 0;
      const letterCount = normalized.match(/[a-z]/gu)?.length ?? 0;
      const vowelCount = normalized.match(/[aeiou]/gu)?.length ?? 0;
      const alphaNumericTransitions = normalized.match(/(?:[a-z]\d|\d[a-z])/gu)?.length ?? 0;
      const digitDensity = digitCount / normalized.length;
      const vowelRatio = letterCount === 0 ? 0 : vowelCount / letterCount;

      // These combined thresholds target encoded/random payloads without treating
      // camelCase or long descriptive routes as suspicious on casing alone.
      if (
        shannonEntropy(normalized) >= 4
        && digitCount >= 4
        && digitDensity >= 0.15
        && vowelRatio <= 0.2
        && alphaNumericTransitions >= 4
      ) {
        return true;
      }
    }
  }
  return false;
}

function shannonEntropy(value: string): number {
  const frequencies = new Map<string, number>();
  for (const character of value) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function checkUnique(
  values: readonly string[],
  context: z.RefinementCtx,
  path: Array<string | number>,
  message: string
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message });
  }
}
