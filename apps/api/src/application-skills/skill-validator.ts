import {
  ApplicationSkillVersionSchema,
  type ApplicationFieldSemantic,
  type ApplicationSkillVersion
} from "@resume/contracts";
import type { ZodIssue } from "zod";

export type SkillValidationIssueCode =
  | "SCHEMA_INVALID"
  | "CAPABILITY_EXPANSION"
  | "UNBOUNDED_RECOVERY"
  | "UNREACHABLE_VARIANT"
  | "UNREACHABLE_WORKFLOW"
  | "UNREFERENCED_LOCATOR_KEY"
  | "MISSING_FIELD_DEFINITION"
  | "MISSING_READBACK"
  | "ORIGIN_MISMATCH";

export interface SkillValidationIssue {
  readonly code: SkillValidationIssueCode;
  readonly path: string;
}

export interface SkillValidationResult {
  readonly valid: boolean;
  readonly issues: SkillValidationIssue[];
}

const REGISTERED_DOMAINS: Record<ApplicationSkillVersion["site"], readonly RegExp[]> = {
  baidu: [/^talent\.baidu\.com$/u],
  dji: [/^apply\.careers\.dji\.com$/u, /^app\.mokahr\.com$/u],
  moka: [/^(?:\*\.)?mokahr\.com$/u, /^(?:\*\.)?moka\.com$/u, /^app\.mokahr\.com$/u]
};

export function validateSkillCandidate(candidate: unknown, parent?: unknown): SkillValidationResult {
  const candidateResult = ApplicationSkillVersionSchema.safeParse(candidate);
  if (!candidateResult.success) return invalid(schemaIssues(candidateResult.error.issues));

  let parsedParent: ApplicationSkillVersion | undefined;
  if (parent !== undefined) {
    const parentResult = ApplicationSkillVersionSchema.safeParse(parent);
    if (!parentResult.success) {
      return invalid(schemaIssues(parentResult.error.issues, "/parent"));
    }
    parsedParent = parentResult.data;
  }

  const parsed = candidateResult.data;
  const issues: SkillValidationIssue[] = [];
  validateOrigins(parsed, parsedParent, issues);
  validateCapabilities(parsed, parsedParent, issues);
  validateWorkflowGraph(parsed, issues);
  validateLocatorReferences(parsed, issues);
  validateReadback(parsed, issues);
  return result(issues);
}

function validateOrigins(
  candidate: ApplicationSkillVersion,
  parent: ApplicationSkillVersion | undefined,
  issues: SkillValidationIssue[]
): void {
  candidate.allowedDomains.forEach((domain, index) => {
    if (!REGISTERED_DOMAINS[candidate.site].some((pattern) => pattern.test(domain))) {
      issues.push({ code: "ORIGIN_MISMATCH", path: `/allowedDomains/${index}` });
    }
  });
  if (parent === undefined) return;
  if (candidate.site !== parent.site) {
    issues.push({ code: "ORIGIN_MISMATCH", path: "/site" });
  }
  if (!sameStringSet(candidate.allowedDomains, parent.allowedDomains)) {
    issues.push({ code: "ORIGIN_MISMATCH", path: "/allowedDomains" });
  }
}

function validateCapabilities(
  candidate: ApplicationSkillVersion,
  parent: ApplicationSkillVersion | undefined,
  issues: SkillValidationIssue[]
): void {
  if (parent === undefined) return;
  const allowed = new Set(parent.content.capabilities);
  candidate.content.capabilities.forEach((capability, index) => {
    if (!allowed.has(capability)) {
      issues.push({ code: "CAPABILITY_EXPANSION", path: `/content/capabilities/${index}` });
    }
  });
}

function validateWorkflowGraph(candidate: ApplicationSkillVersion, issues: SkillValidationIssue[]): void {
  const workflow = candidate.content.workflow;
  const indices = new Map(workflow.map((step, index) => [step.id, index]));
  const entries: string[] = [];

  candidate.content.pageVariants.forEach((variant, index) => {
    if (!indices.has(variant.workflowEntry)) {
      issues.push({ code: "UNREACHABLE_VARIANT", path: `/content/pageVariants/${index}/workflowEntry` });
    } else {
      entries.push(variant.workflowEntry);
    }
  });

  const reachable = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const stepId = pending.pop()!;
    if (reachable.has(stepId)) continue;
    reachable.add(stepId);
    const stepIndex = indices.get(stepId);
    if (stepIndex === undefined) continue;
    const next = workflow[stepIndex]!.next;
    if (next !== "continue_or_wait") {
      if (indices.has(next)) pending.push(next);
      else issues.push({ code: "UNREACHABLE_WORKFLOW", path: `/content/workflow/${stepIndex}/next` });
    }
  }

  workflow.forEach((step, index) => {
    if (!reachable.has(step.id)) {
      issues.push({ code: "UNREACHABLE_WORKFLOW", path: `/content/workflow/${index}` });
    }
  });

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): void => {
    if (visited.has(stepId)) return;
    visiting.add(stepId);
    const stepIndex = indices.get(stepId);
    if (stepIndex !== undefined) {
      const next = workflow[stepIndex]!.next;
      if (next !== "continue_or_wait" && indices.has(next)) {
        if (visiting.has(next)) {
          issues.push({ code: "UNBOUNDED_RECOVERY", path: `/content/workflow/${stepIndex}/next` });
        } else {
          visit(next);
        }
      }
    }
    visiting.delete(stepId);
    visited.add(stepId);
  };
  entries.forEach(visit);
}

function validateLocatorReferences(candidate: ApplicationSkillVersion, issues: SkillValidationIssue[]): void {
  const declared = new Set(candidate.content.fields.map((field) => field.semantic));
  const referenced = new Set<ApplicationFieldSemantic>();
  candidate.content.workflow.forEach((step, stepIndex) => {
    step.actions.forEach((action, actionIndex) => {
      if (action.capability === "upload_approved_file") {
        referenced.add(action.semantic);
        if (!declared.has(action.semantic)) {
          issues.push({
            code: "MISSING_FIELD_DEFINITION",
            path: `/content/workflow/${stepIndex}/actions/${actionIndex}/semantic`
          });
        }
      } else if (
        action.capability === "fill_empty_fields"
        || action.capability === "select_option"
        || action.capability === "readback"
      ) {
        action.semantics.forEach((semantic, semanticIndex) => {
          referenced.add(semantic);
          if (!declared.has(semantic)) {
            issues.push({
              code: "MISSING_FIELD_DEFINITION",
              path: `/content/workflow/${stepIndex}/actions/${actionIndex}/semantics/${semanticIndex}`
            });
          }
        });
      }
    });
  });
  candidate.content.fields.forEach((field, fieldIndex) => {
    if (referenced.has(field.semantic)) return;
    field.locatorHints.forEach((_hint, hintIndex) => {
      issues.push({
        code: "UNREFERENCED_LOCATOR_KEY",
        path: `/content/fields/${fieldIndex}/locatorHints/${hintIndex}/key`
      });
    });
  });
}

function validateReadback(candidate: ApplicationSkillVersion, issues: SkillValidationIssue[]): void {
  const workflow = candidate.content.workflow;
  const indices = new Map(workflow.map((step, index) => [step.id, index]));
  candidate.content.workflow.forEach((step, stepIndex) => {
    step.actions.forEach((action, actionIndex) => {
      const written = writtenSemantics(action);
      if (written.length === 0) return;
      if (written.some((semantic) => !hasReadbackAfter(workflow, indices, stepIndex, actionIndex, semantic))) {
        issues.push({ code: "MISSING_READBACK", path: `/content/workflow/${stepIndex}/actions/${actionIndex}` });
      }
    });
  });
}

function hasReadbackAfter(
  workflow: ApplicationSkillVersion["content"]["workflow"],
  indices: ReadonlyMap<string, number>,
  initialStepIndex: number,
  initialActionIndex: number,
  semantic: ApplicationFieldSemantic
): boolean {
  let stepIndex: number | undefined = initialStepIndex;
  let actionIndex = initialActionIndex + 1;
  const visited = new Set<number>();

  while (stepIndex !== undefined && !visited.has(stepIndex)) {
    visited.add(stepIndex);
    const step = workflow[stepIndex]!;
    for (const action of step.actions.slice(actionIndex)) {
      if (action.capability === "readback" && action.semantics.includes(semantic)) return true;
      if (writtenSemantics(action).includes(semantic)) return false;
    }
    if (step.next === "continue_or_wait") return false;
    stepIndex = indices.get(step.next);
    actionIndex = 0;
  }
  return false;
}

function writtenSemantics(
  action: ApplicationSkillVersion["content"]["workflow"][number]["actions"][number]
): readonly ApplicationFieldSemantic[] {
  if (action.capability === "upload_approved_file") return [action.semantic];
  if (action.capability === "fill_empty_fields" || action.capability === "select_option") {
    return action.semantics;
  }
  return [];
}

function schemaIssues(issues: readonly ZodIssue[], prefix = ""): SkillValidationIssue[] {
  return issues.flatMap((issue) => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        code: "SCHEMA_INVALID" as const,
        path: `${prefix}${jsonPointer([...issue.path, key])}`
      }));
    }
    return [{ code: "SCHEMA_INVALID" as const, path: `${prefix}${jsonPointer(issue.path)}` }];
  });
}

function jsonPointer(path: readonly (string | number)[]): string {
  if (path.length === 0) return "/";
  return `/${path.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function invalid(issues: SkillValidationIssue[]): SkillValidationResult {
  return result(issues);
}

function result(issues: SkillValidationIssue[]): SkillValidationResult {
  const unique = [...new Map(issues.map((issue) => [`${issue.code}:${issue.path}`, issue])).values()]
    .sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code));
  return { valid: unique.length === 0, issues: unique };
}
