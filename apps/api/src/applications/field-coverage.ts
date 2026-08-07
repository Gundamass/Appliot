import type { ApplicationFieldAssessment, ApplicationFieldCoverage } from "@resume/contracts";

export interface FieldCoverageStore {
  record(taskId: string, assessment: ApplicationFieldAssessment): void;
  markFilled(taskId: string, fieldId: string, warnings?: string[]): void;
  markFailed(taskId: string, fieldId: string, reason: string): void;
  markUserFilled(taskId: string, field: Pick<ApplicationFieldAssessment, "fieldId" | "label" | "semantic">): void;
  restore(taskId: string, coverage: ApplicationFieldCoverage): void;
  retain(taskId: string, fieldIds: ReadonlySet<string>): void;
  snapshot(taskId: string): ApplicationFieldCoverage | undefined;
  dispose(taskId: string): void;
}

export function summarizeFieldCoverage(fields: ApplicationFieldAssessment[]): ApplicationFieldCoverage {
  const ordered = [...fields].sort((left, right) => left.fieldId.localeCompare(right.fieldId));
  return {
    total: ordered.length,
    ready: count(ordered, "ready"),
    review: count(ordered, "review"),
    missing: count(ordered, "missing"),
    unsupported: count(ordered, "unsupported"),
    filled: count(ordered, "filled"),
    fields: ordered
  };
}

export function createFieldCoverageStore(): FieldCoverageStore {
  const tasks = new Map<string, Map<string, ApplicationFieldAssessment>>();
  const requireTask = (taskId: string) => {
    const existing = tasks.get(taskId);
    if (existing) return existing;
    const created = new Map<string, ApplicationFieldAssessment>();
    tasks.set(taskId, created);
    return created;
  };

  return {
    record(taskId, assessment) {
      requireTask(taskId).set(assessment.fieldId, assessment);
    },
    markFilled(taskId, fieldId, warnings = []) {
      const current = tasks.get(taskId)?.get(fieldId);
      if (current) requireTask(taskId).set(fieldId, {
        ...current,
        status: warnings.length > 0 ? "review" : "filled",
        reason: warnings.length > 0
          ? "已自动恢复并完成填写，建议在最终审核时确认实际选项"
          : "页面回读确认填写成功"
      });
    },
    markFailed(taskId, fieldId, reason) {
      const current = tasks.get(taskId)?.get(fieldId);
      if (current) requireTask(taskId).set(fieldId, {
        ...current,
        status: "missing",
        reason: reason || "field_execution_failed"
      });
    },
    markUserFilled(taskId, field) {
      const current = tasks.get(taskId)?.get(field.fieldId);
      if (current?.status === "filled" || current?.status === "review") return;
      requireTask(taskId).set(field.fieldId, {
        fieldId: field.fieldId,
        label: field.label,
        ...(field.semantic === undefined ? {} : { semantic: field.semantic }),
        status: "filled",
        source: "user",
        confidence: 1,
        reason: "页面已存在用户填写值",
        evidence: []
      });
    },
    restore(taskId, coverage) {
      tasks.set(taskId, new Map(coverage.fields.map((field) => [field.fieldId, field])));
    },
    retain(taskId, fieldIds) {
      const task = tasks.get(taskId);
      if (!task) return;
      for (const fieldId of task.keys()) {
        if (!fieldIds.has(fieldId)) task.delete(fieldId);
      }
    },
    snapshot(taskId) {
      const task = tasks.get(taskId);
      return task === undefined ? undefined : summarizeFieldCoverage([...task.values()]);
    },
    dispose(taskId) {
      tasks.delete(taskId);
    }
  };
}

function count(fields: ApplicationFieldAssessment[], status: ApplicationFieldAssessment["status"]): number {
  return fields.filter((field) => field.status === status).length;
}
