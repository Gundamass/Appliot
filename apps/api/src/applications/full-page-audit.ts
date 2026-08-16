import type { FormField, FormSnapshot } from "@resume/contracts";
import { fieldOperationKey } from "./field-operation-key.js";

export type FullPageAuditReason = "field_applied" | "phase_boundary" | "final_review";

export interface AuditMismatch {
  operationKey: string;
  fieldId: string;
  expectedValue: unknown;
  actualValue: unknown;
}

export interface FullPageAuditCoordinator {
  recordApplied(operationKey: string, expectedValue: unknown, fieldId?: string): void;
  shouldAudit(reason: FullPageAuditReason): boolean;
  audit(snapshot: FormSnapshot): AuditMismatch[];
}

interface AuditLedgerEntry {
  expectedValue: unknown;
  fieldId?: string;
}

const PERIODIC_AUDIT_INTERVAL = 8;

export function createFullPageAuditCoordinator(taskId: string): FullPageAuditCoordinator {
  const ledger = new Map<string, AuditLedgerEntry>();
  let appliedSinceSuccessfulAudit = 0;

  return {
    recordApplied(operationKey, expectedValue, fieldId) {
      ledger.set(operationKey, {
        expectedValue,
        ...(fieldId === undefined ? {} : { fieldId })
      });
      appliedSinceSuccessfulAudit += 1;
    },

    shouldAudit(reason) {
      return reason !== "field_applied"
        || appliedSinceSuccessfulAudit >= PERIODIC_AUDIT_INTERVAL;
    },

    audit(snapshot) {
      const fieldsByOperation = indexFields(taskId, snapshot.fields);
      const mismatches: AuditMismatch[] = [];

      for (const [operationKey, entry] of ledger) {
        const candidates = fieldsByOperation.get(operationKey) ?? [];
        const observed = candidates.length === 1 ? candidates[0] : undefined;
        if (observed !== undefined && valuesMatch(entry.expectedValue, observed.currentValue, observed)) {
          continue;
        }
        mismatches.push({
          operationKey,
          fieldId: entry.fieldId ?? observed?.id ?? operationKey,
          expectedValue: entry.expectedValue,
          actualValue: observed?.currentValue
        });
      }

      if (mismatches.length === 0) appliedSinceSuccessfulAudit = 0;
      return mismatches;
    }
  };
}

function indexFields(taskId: string, fields: readonly FormField[]): Map<string, FormField[]> {
  const indexed = new Map<string, FormField[]>();
  for (const field of fields) {
    if (field.semanticHint === undefined) continue;
    const entryIndex = entryIndexFromSemanticPath(field.semanticHint);
    const operationKey = fieldOperationKey({
      taskId,
      semanticPath: field.semanticHint,
      controlRole: field.interactionMode ?? field.type,
      fieldLabel: field.label,
      ...(field.sectionHint === undefined ? {} : { sectionHint: field.sectionHint }),
      ...(entryIndex === undefined ? {} : { entryIndex })
    });
    const current = indexed.get(operationKey) ?? [];
    current.push(field);
    indexed.set(operationKey, current);
  }
  return indexed;
}

function entryIndexFromSemanticPath(semanticPath: string): number | undefined {
  const match = /^[^[.]+\[(\d+)\]/u.exec(semanticPath);
  return match === null ? undefined : Number(match[1]);
}

function valuesMatch(expected: unknown, actual: unknown, field: FormField): boolean {
  return JSON.stringify(normalizeValue(expected, field)) === JSON.stringify(normalizeValue(actual, field));
}

function normalizeValue(value: unknown, field: FormField): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item, field)).sort(compareNormalizedValues);
  }
  if (field.type === "checkbox" || typeof value === "boolean") {
    const booleanValue = normalizeBoolean(value);
    if (booleanValue !== undefined) return booleanValue;
  }
  if (typeof value !== "string") return value;

  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (isDateComponent(field)) {
    const component = normalized.replace(/\s*(?:year|month|day|\u5e74|\u6708|\u65e5|\u53f7)$/iu, "");
    if (/^\d{1,4}$/u.test(component)) return String(Number(component));
    return component;
  }
  return normalized;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (["true", "checked", "yes", "1"].includes(normalized)) return true;
  if (["false", "unchecked", "no", "0", ""].includes(normalized)) return false;
  return undefined;
}

function isDateComponent(field: FormField): boolean {
  return field.type === "date"
    || /(?:^|\.)(?:startDate|endDate|birthDate|date)\.(?:year|month|day)$/u.test(field.semanticHint ?? "");
}

function compareNormalizedValues(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
