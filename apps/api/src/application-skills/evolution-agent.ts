import { z } from "zod";
import type { StructuredModelProvider } from "@resume/model-provider";
import {
  ApplicationFieldSemanticSchema,
  ApplicationSkillContentSchema,
  ApplicationSkillVersionSchema,
  SkillEvolutionPatchSchema,
  type ApplicationSkillContent,
  type ApplicationSkillVersion,
  type SkillEvolutionPatch
} from "@resume/contracts";
import { ReplayExecutionOutcomeSchema } from "./skill-execution-recorder.js";
import { canonicalSkillContentHash } from "./skill-registry.js";
import { validateSkillCandidate, type SkillValidationIssueCode } from "./skill-validator.js";

const IdentifierSchema = z.string().min(1).max(128).regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const VersionSchema = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
const ControlRoleSchema = z.enum([
  "none", "textbox", "combobox", "checkbox", "radio", "button", "option", "listbox", "link"
]);
const ControlTagSchema = z.enum(["input", "textarea", "select", "button", "fieldset"]);
const ControlTypeSchema = z.enum([
  "text", "tel", "email", "url", "number", "date", "month", "checkbox", "radio", "file",
  "hidden", "select-one", "select-multiple", "textarea", "button", "submit"
]);
const ParentRoleSchema = z.enum(["none", "form", "group", "fieldset", "radiogroup", "listbox"]);
const FieldErrorClassSchema = z.enum([
  "field_missing", "ambiguous_field", "stale_node_ref", "write_failed", "readback_mismatch",
  "audit_mismatch", "challenge"
]);
const TrainingControlSchema = z.object({
  role: ControlRoleSchema,
  tag: ControlTagSchema,
  type: ControlTypeSchema,
  labelHash: HashSchema,
  optionHashes: z.array(HashSchema).max(500),
  relativeStructure: z.object({
    parentRole: ParentRoleSchema,
    depth: z.number().int().min(0).max(32),
    siblingIndex: z.number().int().min(0).max(10_000)
  }).strict(),
  hidden: z.boolean()
}).passthrough();
const TrainingExampleSchema = z.object({
  sampleId: IdentifierSchema,
  capturedAt: z.string().datetime(),
  partition: z.literal("training"),
  site: z.enum(["moka", "dji", "baidu"]),
  pageFingerprintHash: HashSchema,
  scenarioClass: IdentifierSchema,
  controls: z.array(TrainingControlSchema).max(500),
  expectedSemantics: z.array(ApplicationFieldSemanticSchema).max(200),
  observedOutcome: ReplayExecutionOutcomeSchema
}).passthrough();
const PromptFieldOutcomeSchema = z.object({
  semantic: ApplicationFieldSemanticSchema,
  outcome: z.enum(["resolved", "filled", "verified", "skipped", "missing", "failed"]),
  errorClass: FieldErrorClassSchema.optional()
}).passthrough();
const OpportunitySchema = z.object({
  opportunityId: IdentifierSchema,
  theme: z.object({
    pageVariantId: IdentifierSchema,
    semantic: ApplicationFieldSemanticSchema.optional(),
    errorClass: z.union([FieldErrorClassSchema, z.literal("fingerprint_drift")])
  }).passthrough(),
  triggers: z.array(z.enum([
    "repeated_actionable_failure", "fingerprint_drift", "challenger_repeated_recovery"
  ])).max(8),
  executionChain: z.array(z.object({
    recordId: IdentifierSchema,
    completedAt: z.string().datetime(),
    terminalResult: z.enum(["completed_pre_submit", "handoff", "blocked", "failed", "cancelled"]),
    fieldOutcomes: z.array(PromptFieldOutcomeSchema).max(200)
  }).passthrough()).max(20)
}).passthrough();
const EvolutionAgentInputSchema = z.object({
  evolutionRunId: IdentifierSchema,
  candidateVersion: VersionSchema,
  createdAt: z.string().datetime(),
  parent: ApplicationSkillVersionSchema,
  trainingExamples: z.array(TrainingExampleSchema).max(200),
  opportunity: OpportunitySchema
}).passthrough();

const VALIDATOR_ISSUE_VOCABULARY: readonly SkillValidationIssueCode[] = [
  "SCHEMA_INVALID",
  "CAPABILITY_EXPANSION",
  "UNBOUNDED_RECOVERY",
  "UNREACHABLE_VARIANT",
  "UNREACHABLE_WORKFLOW",
  "UNREFERENCED_LOCATOR_KEY",
  "MISSING_FIELD_DEFINITION",
  "MISSING_READBACK",
  "ORIGIN_MISMATCH"
];

export interface EvolutionAgentInput {
  readonly evolutionRunId: string;
  readonly candidateVersion: string;
  readonly createdAt: string;
  readonly parent: ApplicationSkillVersion;
  readonly trainingExamples: readonly unknown[];
  readonly opportunity: unknown;
  readonly [key: string]: unknown;
}

export type EvolutionAgentResult =
  | { readonly kind: "candidate"; readonly content: ApplicationSkillContent; readonly contentHash: string }
  | { readonly kind: "rejected"; readonly reason: "provider" | "schema" | "parent" | "unchanged" | "validation" };

export interface SkillEvolutionAgent {
  generate(input: EvolutionAgentInput): Promise<EvolutionAgentResult>;
}

export function createSkillEvolutionAgent(
  provider: StructuredModelProvider,
  options: { readonly timeoutMs?: number } = {}
): SkillEvolutionAgent {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new Error("skill_evolution_timeout_invalid");
  }

  return {
    async generate(input) {
      const parsedInput = EvolutionAgentInputSchema.safeParse(input);
      if (!parsedInput.success) return { kind: "rejected", reason: "schema" };
      const data = parsedInput.data;
      if (canonicalSkillContentHash(data.parent.content) !== data.parent.contentHash
        || (data.parent.status !== "champion" && data.parent.status !== "challenger")
        || compareVersions(data.candidateVersion, data.parent.version) <= 0) {
        return { kind: "rejected", reason: "parent" };
      }

      let rawPatch: unknown;
      try {
        rawPatch = await withTimeout(provider.generateStructured({
          system: [
            "Generate exactly one declarative Application Skill patch.",
            "Use only add, replace, and remove operations allowed by the supplied schema.",
            "Do not produce executable code, selectors outside the schema, navigation, network actions, or terminal submission."
          ].join(" "),
          user: JSON.stringify(promptProjection(data)),
          schema: SkillEvolutionPatchSchema,
          jsonExample: {
            parentContentHash: data.parent.contentHash,
            operations: [{
              op: "replace",
              path: "/recovery",
              value: { maxRetries: 1, actions: ["reobserve"] }
            }]
          }
        }), timeoutMs);
      } catch {
        return { kind: "rejected", reason: "provider" };
      }

      const patchResult = SkillEvolutionPatchSchema.safeParse(rawPatch);
      if (!patchResult.success) return { kind: "rejected", reason: "schema" };
      const patch = patchResult.data;
      if (patch.parentContentHash !== data.parent.contentHash) {
        return { kind: "rejected", reason: "parent" };
      }
      const content = applyPatch(data.parent.content, patch);
      if (content === undefined) return { kind: "rejected", reason: "schema" };
      const contentHash = canonicalSkillContentHash(content);
      if (contentHash === data.parent.contentHash) return { kind: "rejected", reason: "unchanged" };

      const candidateResult = ApplicationSkillVersionSchema.safeParse({
        ...data.parent,
        version: data.candidateVersion,
        parentVersion: data.parent.version,
        status: "candidate",
        content,
        contentHash,
        createdBy: {
          kind: "evolution_agent",
          actorId: "skill-evolution-agent",
          evolutionRunId: data.evolutionRunId
        },
        createdAt: data.createdAt
      });
      if (!candidateResult.success) return { kind: "rejected", reason: "schema" };
      if (!validateSkillCandidate(candidateResult.data, data.parent).valid) {
        return { kind: "rejected", reason: "validation" };
      }
      return deepFreeze({ kind: "candidate", content, contentHash });
    }
  };
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function promptProjection(input: z.infer<typeof EvolutionAgentInputSchema>) {
  return {
    parent: {
      skillId: input.parent.skillId,
      site: input.parent.site,
      version: input.parent.version,
      contentHash: input.parent.contentHash,
      content: input.parent.content
    },
    trainingExamples: input.trainingExamples.map((sample) => ({
      sampleId: sample.sampleId,
      capturedAt: sample.capturedAt,
      site: sample.site,
      pageFingerprintHash: sample.pageFingerprintHash,
      scenarioClass: sample.scenarioClass,
      controls: sample.controls.map((control) => ({
        role: control.role,
        tag: control.tag,
        type: control.type,
        labelHash: control.labelHash,
        optionHashes: control.optionHashes,
        relativeStructure: control.relativeStructure,
        hidden: control.hidden
      })),
      expectedSemantics: sample.expectedSemantics,
      observedOutcome: ReplayExecutionOutcomeSchema.parse(sample.observedOutcome)
    })),
    opportunity: {
      opportunityId: input.opportunity.opportunityId,
      theme: {
        pageVariantId: input.opportunity.theme.pageVariantId,
        ...(input.opportunity.theme.semantic === undefined ? {} : { semantic: input.opportunity.theme.semantic }),
        errorClass: input.opportunity.theme.errorClass
      },
      triggers: input.opportunity.triggers,
      executionChain: input.opportunity.executionChain.map((entry) => ({
        recordId: entry.recordId,
        completedAt: entry.completedAt,
        terminalResult: entry.terminalResult,
        fieldOutcomes: entry.fieldOutcomes.map(({ semantic, outcome, errorClass }) => ({
          semantic,
          outcome,
          ...(errorClass === undefined ? {} : { errorClass })
        }))
      }))
    },
    validatorIssueVocabulary: VALIDATOR_ISSUE_VOCABULARY
  };
}

function applyPatch(
  parent: ApplicationSkillContent,
  patch: SkillEvolutionPatch
): ApplicationSkillContent | undefined {
  const content = structuredClone(parent);
  const mutable = content as unknown as Record<string, unknown>;
  for (const operation of patch.operations) {
    if (operation.op === "replace") {
      const key = operation.path.slice(1);
      mutable[key] = structuredClone(operation.value);
      continue;
    }
    if (operation.op === "add") {
      const key = operation.path.slice(1, -2);
      const target = mutable[key];
      if (!Array.isArray(target)) return undefined;
      target.push(structuredClone(operation.value));
      continue;
    }
    const match = operation.path.match(/^\/(pageVariants|fields)\/(\d+)$/u);
    if (match === null) return undefined;
    const target = mutable[match[1]!];
    const index = Number(match[2]);
    if (!Array.isArray(target) || index >= target.length) return undefined;
    target.splice(index, 1);
  }
  const result = ApplicationSkillContentSchema.safeParse(content);
  return result.success ? result.data : undefined;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(new Error("skill_evolution_provider_timeout")), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}
