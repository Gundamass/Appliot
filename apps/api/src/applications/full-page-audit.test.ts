import type { FormField, FormSnapshot } from "@resume/contracts";
import { describe, expect, it } from "vitest";
import { fieldOperationKey } from "./field-operation-key.js";
import { createFullPageAuditCoordinator } from "./full-page-audit.js";

const taskId = "task-1";

function field(overrides: Partial<FormField> = {}): FormField {
  return {
    id: "field-email",
    label: "Email",
    type: "text",
    required: true,
    options: [],
    currentValue: "me@example.com",
    sectionHint: "basics",
    semanticHint: "basics.email",
    nodeRef: {
      documentId: "document-00000001",
      nodeId: "node-000000000001",
      observedAt: 8
    },
    ...overrides
  };
}

function snapshot(fields: FormField[]): FormSnapshot {
  return {
    id: "snapshot-audit",
    taskId,
    url: "https://jobs.example.test/application",
    title: "Application",
    stage: "application_form",
    frameRef: { documentId: "document-00000001", kind: "main" },
    mutationEpoch: 8,
    fields,
    actions: [],
    errors: []
  };
}

function operationKey(target: FormField): string {
  const entryIndex = target.semanticHint === undefined
    ? undefined
    : /^[^[.]+\[(\d+)\]/u.exec(target.semanticHint)?.[1];
  return fieldOperationKey({
    taskId,
    semanticPath: target.semanticHint!,
    controlRole: target.interactionMode ?? target.type,
    fieldLabel: target.label,
    ...(target.sectionHint === undefined ? {} : { sectionHint: target.sectionHint }),
    ...(entryIndex === undefined ? {} : { entryIndex: Number(entryIndex) })
  });
}

describe("full-page audit coordinator", () => {
  it("requests a periodic audit only after eight successful field applies", () => {
    const coordinator = createFullPageAuditCoordinator(taskId);

    for (let index = 0; index < 7; index += 1) {
      coordinator.recordApplied(`field-${index}`, "ok");
    }
    expect(coordinator.shouldAudit("field_applied")).toBe(false);

    coordinator.recordApplied("field-7", "ok");
    expect(coordinator.shouldAudit("field_applied")).toBe(true);
  });

  it.each(["phase_boundary", "final_review"] as const)(
    "forces an audit at the %s boundary",
    (reason) => {
      const coordinator = createFullPageAuditCoordinator(taskId);

      expect(coordinator.shouldAudit(reason)).toBe(true);
    }
  );

  it("reports a changed value by stable operation key", () => {
    const coordinator = createFullPageAuditCoordinator(taskId);
    const applied = field();
    coordinator.recordApplied(operationKey(applied), applied.currentValue);

    expect(coordinator.audit(snapshot([field({ currentValue: "changed@example.com" })]))).toEqual([{
      operationKey: operationKey(applied),
      fieldId: applied.id,
      expectedValue: "me@example.com",
      actualValue: "changed@example.com"
    }]);
  });

  it("matches a rerendered field when its DOM field id changes", () => {
    const coordinator = createFullPageAuditCoordinator(taskId);
    const applied = field();
    coordinator.recordApplied(operationKey(applied), applied.currentValue);

    expect(coordinator.audit(snapshot([field({
      id: "field-email-rerendered",
      nodeRef: {
        documentId: "document-00000001",
        nodeId: "node-000000000099",
        observedAt: 9
      }
    })]))).toEqual([]);
  });

  it("resets the periodic threshold only after a successful audit", () => {
    const coordinator = createFullPageAuditCoordinator(taskId);
    const appliedFields = Array.from({ length: 8 }, (_, index) => field({
      id: `field-${index}`,
      label: `Field ${index}`,
      semanticHint: `basics.field${index}`,
      currentValue: `value-${index}`
    }));
    for (const applied of appliedFields) {
      coordinator.recordApplied(operationKey(applied), applied.currentValue);
    }

    expect(coordinator.shouldAudit("field_applied")).toBe(true);
    expect(coordinator.audit(snapshot(appliedFields))).toEqual([]);
    expect(coordinator.shouldAudit("field_applied")).toBe(false);

    for (const applied of appliedFields) {
      coordinator.recordApplied(operationKey(applied), applied.currentValue);
    }
    expect(coordinator.audit(snapshot(appliedFields.map((applied, index) =>
      index === 0 ? { ...applied, currentValue: "reverted" } : applied
    )))).toHaveLength(1);
    expect(coordinator.shouldAudit("field_applied")).toBe(true);
  });

  it("normalizes split date and boolean readback values", () => {
    const coordinator = createFullPageAuditCoordinator(taskId);
    const month = field({
      id: "field-start-month",
      label: "Start month",
      type: "select",
      currentValue: "04",
      sectionHint: "work",
      semanticHint: "work[0].startDate.month"
    });
    const consent = field({
      id: "field-consent",
      label: "Consent",
      type: "checkbox",
      currentValue: true,
      semanticHint: "basics.consent"
    });
    coordinator.recordApplied(operationKey(month), "04");
    coordinator.recordApplied(operationKey(consent), true);

    expect(coordinator.audit(snapshot([
      field({ ...month, currentValue: "4 month" }),
      field({ ...consent, currentValue: "checked" })
    ]))).toEqual([]);
  });
});
