import type { ApplicationTask, ApplicationTaskState } from "@resume/contracts";
import { ArrowRight, CircleAlert, ClipboardCheck, LogIn, MessageSquareText, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";

interface ApplicationReviewInboxProps {
  tasks: ApplicationTask[];
  onOpenTask(taskId: string): void;
  onDeleteTask(task: ApplicationTask): void | Promise<void>;
  deletingTaskId?: string;
  actionError?: string | undefined;
  loading?: boolean | undefined;
  error?: string | undefined;
  onRetry?(): void;
}

const REVIEW_STATES = new Set<ApplicationTaskState>([
  "waiting_for_login",
  "needs_questions",
  "awaiting_content_review",
  "review_locked",
  "failed"
]);

const STATE_META: Partial<Record<ApplicationTaskState, { title: string; description: string; icon: typeof ClipboardCheck }>> = {
  waiting_for_login: { title: "等待登录", description: "请在受控浏览器完成登录后继续。", icon: LogIn },
  needs_questions: { title: "需要补充资料", description: "页面仍有无法安全匹配的字段。", icon: MessageSquareText },
  awaiting_content_review: { title: "等待内容审核", description: "岗位微调内容需要你确认后才能采用。", icon: ClipboardCheck },
  review_locked: { title: "等待最终审核", description: "填写已停止在提交前，请检查招聘页面。", icon: ShieldCheck },
  failed: { title: "任务需要处理", description: "自动流程已暂停，可进入任务查看恢复方式。", icon: CircleAlert }
};

export function ApplicationReviewInbox({ tasks, onOpenTask, onDeleteTask, deletingTaskId, actionError, loading = false, error, onRetry }: ApplicationReviewInboxProps) {
  const reviewTasks = tasks.filter((task) => REVIEW_STATES.has(task.state));
  if (loading) return <div className="review-inbox-state" role="status">正在读取待处理任务</div>;
  if (error) return <div className="review-inbox-state"><p className="inline-error" role="alert">{error}</p>{onRetry && <button className="button secondary" type="button" onClick={onRetry}><RefreshCw aria-hidden="true" size={16} />重新加载</button>}</div>;
  if (reviewTasks.length === 0) return <div className="review-inbox-state"><ClipboardCheck aria-hidden="true" size={24} /><strong>当前没有需要你处理的投递</strong></div>;

  return (
    <div className="application-review-inbox">
      <div className="review-inbox-summary"><strong>{reviewTasks.length}</strong><span>个任务等待人工决策</span></div>
      {actionError && <p className="inline-error" role="alert">{actionError}</p>}
      <div className="review-task-list">
        {reviewTasks.map((task) => {
          const meta = STATE_META[task.state]!;
          const Icon = meta.icon;
          const taskName = task.name ?? hostFor(task.applicationUrl);
          return (
            <article className="review-task" key={task.id}>
              <Icon aria-hidden="true" size={19} />
              <div>
                <span>{meta.title}</span>
                <h2>{taskName}</h2>
                <p>{task.applicationUrl}</p>
                <small>{meta.description}</small>
              </div>
              <div className="review-task-actions">
                <button className="button secondary" type="button" onClick={() => onOpenTask(task.id)}>进入任务<ArrowRight aria-hidden="true" size={15} /></button>
                <button
                  className="icon-button danger"
                  type="button"
                  aria-label={`删除任务：${taskName}`}
                  title={`删除任务：${taskName}`}
                  disabled={deletingTaskId === task.id}
                  onClick={() => {
                    const message = task.commands.includes("cancel")
                      ? `“${taskName}”仍在受控浏览器中运行，删除前会先取消任务。确定删除吗？`
                      : `确定删除“${taskName}”这条投递任务记录吗？`;
                    if (window.confirm(message)) void onDeleteTask(task);
                  }}
                >
                  <Trash2 aria-hidden="true" size={16} />
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function hostFor(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "招聘网站";
  }
}
