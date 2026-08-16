import type {
  ApplicationAutofillPhase,
  ApplicationExecutionProgress,
  ApplicationTask,
  ApplicationTaskProgressEvent,
  ChallengeKind
} from "@resume/contracts";

export interface AttentionItem {
  id: string;
  kind: "challenge" | "content_review" | "question" | "failed" | "paused";
  label: string;
  summary: string;
  severity: "high" | "medium";
}

export function deriveDisplayPhase(
  task: ApplicationTask,
  _activities: ApplicationTaskProgressEvent[]
): ApplicationAutofillPhase {
  return executionProgressForTask(task).currentPhase;
}

export const CHALLENGE_LABELS: Record<ChallengeKind, string> = {
  captcha: "需要完成验证码",
  access_denied: "页面拒绝了当前访问",
  rate_limited: "页面请求过于频繁",
  device_verification: "需要完成设备验证",
  risk_control: "需要完成安全验证",
  unsupported_iframe: "表单包含暂不支持的嵌入区域",
  unsupported_shadow_dom: "表单包含暂不支持的交互区域"
};

export function executionProgressForTask(task: ApplicationTask): ApplicationExecutionProgress {
  return task.executionProgress ?? {
    currentPhase: "waiting_for_form",
    phases: [
      { phase: "waiting_for_form", status: "running" },
      { phase: "deterministic_fill", status: "pending" },
      { phase: "semantic_fill", status: "pending" },
      { phase: "readback_validation", status: "pending" },
      { phase: "final_review", status: "pending" }
    ],
    current: { action: "等待进入简历填写页面", maxAttempts: 2 },
    counts: { exact: 0, semantic: 0, user: 0, missing: 0, failed: 0 }
  };
}

export function deriveAttentionItems(
  task: ApplicationTask,
  activities: ApplicationTaskProgressEvent[]
): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (task.state === "awaiting_challenge" && task.challenge) {
    items.push({
      id: `challenge-${task.challenge.detectedAt}`,
      kind: "challenge",
      label: CHALLENGE_LABELS[task.challenge.kind],
      summary: "请在受控浏览器中完成处理",
      severity: "high"
    });
  }
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
    challenge: 0,
    content_review: 1,
    question: 2,
    failed: 3,
    paused: 4
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
