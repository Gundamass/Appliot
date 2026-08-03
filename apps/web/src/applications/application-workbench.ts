import type {
  ApplicationDisplayPhase,
  ApplicationTask,
  ApplicationTaskProgressEvent
} from "@resume/contracts";

export interface AttentionItem {
  id: string;
  kind: "content_review" | "question" | "failed" | "paused";
  label: string;
  summary: string;
  severity: "high" | "medium";
}

export function deriveDisplayPhase(
  task: ApplicationTask,
  activities: ApplicationTaskProgressEvent[]
): ApplicationDisplayPhase {
  if (["needs_questions", "awaiting_content_review", "review_locked", "failed", "cancelled"].includes(task.state)) {
    return "review_handoff";
  }
  if (["validating", "navigating"].includes(task.state)) return "dynamic_validation";

  const latestOperation = [...activities].reverse().find((event) =>
    event.type === "operation_started"
    || event.type === "operation_completed"
    || event.type === "operation_failed"
  );
  if (latestOperation) {
    if (latestOperation.progress.displayPhase !== undefined) return latestOperation.progress.displayPhase;
    if (latestOperation.progress.phase === "validating" || latestOperation.progress.phase === "navigating") {
      return "dynamic_validation";
    }
  }
  return "deterministic_fill";
}

export function deriveAttentionItems(
  task: ApplicationTask,
  activities: ApplicationTaskProgressEvent[]
): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (task.contentReview) {
    items.push({
      id: task.contentReview.id,
      kind: "content_review",
      label: task.contentReview.fieldLabel,
      summary: "等待你确认填写内容",
      severity: "high"
    });
  }
  for (const question of task.questions) {
    items.push({
      id: question.id,
      kind: "question",
      label: question.label ?? question.pageText,
      summary: question.text,
      severity: "high"
    });
  }
  const latestFailure = [...activities].reverse().find((event) => event.type === "operation_failed");
  if (latestFailure?.type === "operation_failed") {
    items.push({
      id: `failure-${latestFailure.id}`,
      kind: "failed",
      label: latestFailure.progress.displayCategory,
      summary: latestFailure.operation.errorCode === "TIMEOUT" ? "操作超时，等待恢复" : "操作未完成，等待恢复",
      severity: "high"
    });
  }
  const latestPause = [...activities].reverse().find((event) => event.type === "task_paused");
  if (latestPause?.type === "task_paused" && task.recoveryCommands.length > 0) {
    items.push({
      id: `pause-${latestPause.id}`,
      kind: "paused",
      label: latestPause.activity.displayCategory,
      summary: latestPause.activity.kind === "user_activity" ? "检测到用户操作，自动填写已暂停" : "自动处理已暂停",
      severity: "medium"
    });
  }
  const priority: Record<AttentionItem["kind"], number> = {
    content_review: 0,
    question: 1,
    failed: 2,
    paused: 3
  };
  return items.sort((left, right) => priority[left.kind] - priority[right.kind]);
}

export function recentActivities(
  activities: ApplicationTaskProgressEvent[],
  limit = 3
): ApplicationTaskProgressEvent[] {
  return activities.filter((event) => event.type !== "state_changed").slice(-limit).reverse();
}

export function activityLabel(event: ApplicationTaskProgressEvent): string {
  if (event.type === "operation_started") return `${event.progress.displayCategory}处理中`;
  if (event.type === "operation_completed") return `${event.progress.displayCategory}处理成功`;
  if (event.type === "operation_failed") return `${event.progress.displayCategory}${event.operation.status === "timed_out" ? "处理超时" : "处理失败"}`;
  if (event.type === "task_paused") {
    return event.activity.kind === "user_activity" ? "检测到用户操作，自动处理已暂停" : "自动处理已暂停";
  }
  if (event.type === "task_resumed") return "页面稳定，已恢复处理";
  if (event.type === "browser_activity") {
    const labels = {
      page_changed: "页面已变化",
      page_stable: "页面已稳定",
      user_activity: "检测到用户操作",
      worker_connected: "受控浏览器已连接",
      worker_disconnected: "受控浏览器已断开"
    } as const;
    return labels[event.activity.kind];
  }
  return "任务状态已更新";
}
