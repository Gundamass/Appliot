import type { ApplicationFieldAssessment, ApplicationFieldCoverage } from "@resume/contracts";

export interface FieldCoverageStore {
  record(taskId: string, assessment: ApplicationFieldAssessment): void;
  has(taskId: string, fieldId: string): boolean;
  markFilled(taskId: string, fieldId: string): void;
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
    has(taskId, fieldId) {
      return tasks.get(taskId)?.has(fieldId) ?? false;
    },
    markFilled(taskId, fieldId) {
      const current = tasks.get(taskId)?.get(fieldId);
      if (current) requireTask(taskId).set(fieldId, { ...current, status: "filled", reason: "页面回读确认填写成功" });
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
