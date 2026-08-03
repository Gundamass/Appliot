import type { ApplicationCommand, ApplicationCommandType, ApplicationTask, ApplicationTaskProgressEvent, ApplicationTaskState } from "@resume/contracts";
import { Activity, ArrowLeft, Check, ChevronRight, CircleAlert, ClipboardList, Database, ExternalLink, FileText, Hand, History, MonitorUp, RotateCw, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApplicationApi, ApplicationRecoveryCommand } from "./api.js";
import { ContentReviewPage } from "./ContentReviewPage.js";
import { CompactActivityFeed } from "./CompactActivityFeed.js";
import { deriveAttentionItems, deriveDisplayPhase } from "./application-workbench.js";
import { LiveBrowserStatus } from "./LiveBrowserStatus.js";
import { QuestionPanel, type QuestionSubmission } from "./QuestionPanel.js";
import { TaskAttentionList } from "./TaskAttentionList.js";
import { TaskStageStepper } from "./TaskStageStepper.js";
import { useTaskEvents, type TaskEventConnection } from "./useTaskEvents.js";

interface ApplicationTaskPageProps {
  taskId: string;
  api: Pick<ApplicationApi, "get" | "command"> & Partial<Pick<ApplicationApi, "recover" | "delete">>;
  connectEvents?: TaskEventConnection;
  onNavigate?(path: string): void;
}

const STATE_LABELS: Record<ApplicationTaskState, string> = {
  created: "任务已创建", observing_page: "正在分析投递页面", waiting_for_login: "等待登录",
  needs_questions: "等待补充信息", awaiting_content_review: "等待内容审核", filling: "正在填写",
  validating: "正在校验", navigating: "正在进入下一页", review_locked: "等待人工最终审核",
  cancelled: "任务已取消", failed: "任务失败"
};

const PHASES = [
  { key: "prepare", label: "准备资料" },
  { key: "observe", label: "识别页面" },
  { key: "fill", label: "填写信息" },
  { key: "validate", label: "校验内容" },
  { key: "review", label: "人工审核" }
] as const;

export function ApplicationTaskPage({ taskId, api, connectEvents, onNavigate }: ApplicationTaskPageProps) {
  const [task, setTask] = useState<ApplicationTask>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busyCommand, setBusyCommand] = useState<ApplicationCommandType>();
  const [busyRecovery, setBusyRecovery] = useState<ApplicationRecoveryCommand>();
  const [activities, setActivities] = useState<ApplicationTaskProgressEvent[]>([]);
  const taskGeneration = useRef(0);
  const projectionVersion = useRef(0);
  const lastEventId = useRef(0n);
  const latestEventState = useRef<ApplicationTaskState | undefined>(undefined);
  const activeTaskId = useRef(taskId);
  activeTaskId.current = taskId;

  const loadTask = useCallback(async (generation: number, version: number) => {
    try {
      const next = await api.get(taskId);
      if (taskGeneration.current !== generation || projectionVersion.current !== version || next.id !== taskId) return;
      setTask(latestEventState.current === undefined ? next : { ...next, state: latestEventState.current });
      setError(undefined);
    } catch {
      if (taskGeneration.current !== generation || projectionVersion.current !== version) return;
      setError("任务加载失败，请重试");
    } finally {
      if (taskGeneration.current === generation && projectionVersion.current === version) setLoading(false);
    }
  }, [api, taskId]);

  useEffect(() => {
    const generation = ++taskGeneration.current;
    projectionVersion.current = 0;
    lastEventId.current = 0n;
    latestEventState.current = undefined;
    setTask(undefined);
    setLoading(true);
    setError(undefined);
    setBusyCommand(undefined);
    setBusyRecovery(undefined);
    setActivities([]);
    void loadTask(generation, 0);
    return () => {
      if (taskGeneration.current === generation) taskGeneration.current += 1;
    };
  }, [loadTask]);

  const refreshProjection = useCallback(() => {
    const generation = taskGeneration.current;
    const version = ++projectionVersion.current;
    setTask((current) => current?.id === taskId ? { ...current, commands: [] } : current);
    void loadTask(generation, version);
  }, [loadTask, taskId]);

  const onEvent = useCallback((event: ApplicationTaskProgressEvent) => {
    if (event.taskId !== taskId || activeTaskId.current !== taskId) return;
    const eventId = BigInt(event.id);
    if (eventId <= lastEventId.current) return;
    lastEventId.current = eventId;
    const generation = taskGeneration.current;
    const version = ++projectionVersion.current;
    setActivities((current) => [...current, event].slice(-50));
    if (event.type === "state_changed") latestEventState.current = event.state;
    setTask((current) => current?.id === taskId && event.type === "state_changed"
      ? { ...current, state: event.state, commands: [] }
      : current);
    setBusyCommand(undefined);
    setBusyRecovery(undefined);
    void loadTask(generation, version);
  }, [loadTask, taskId]);
  const onHistoryReset = useCallback((event: { taskId: string }) => {
    if (event.taskId !== taskId || activeTaskId.current !== taskId) return;
    setActivities([]);
    refreshProjection();
  }, [refreshProjection, taskId]);
  const connection = useTaskEvents(taskId, { onEvent, onHistoryReset }, connectEvents);
  const currentTask = task?.id === taskId ? task : undefined;

  const host = useMemo(() => {
    try { return currentTask ? new URL(currentTask.applicationUrl).host : ""; } catch { return ""; }
  }, [currentTask]);
  const attentionItems = useMemo(
    () => currentTask ? deriveAttentionItems(currentTask, activities) : [],
    [activities, currentTask]
  );
  const displayPhase = useMemo(
    () => currentTask ? deriveDisplayPhase(currentTask, activities) : "deterministic_fill",
    [activities, currentTask]
  );
  const completedCount = activities.filter((event) => event.type === "operation_completed").length;
  const [selectedAttentionId, setSelectedAttentionId] = useState<string>();
  useEffect(() => {
    if (attentionItems.length === 0) {
      setSelectedAttentionId(undefined);
      return;
    }
    setSelectedAttentionId((current) => attentionItems.some((item) => item.id === current) ? current : attentionItems[0]!.id);
  }, [attentionItems]);
  const hasVisibleCommand = currentTask?.commands.some((command) => ["open_browser", "resume", "cancel"].includes(command)) ?? false;
  const canDeleteTask = currentTask !== undefined
    && api.delete !== undefined
    && ["review_locked", "cancelled", "failed"].includes(currentTask.state);

  const runCommand = async (command: ApplicationCommand) => {
    const generation = taskGeneration.current;
    const version = ++projectionVersion.current;
    setBusyCommand(command.type);
    setError(undefined);
    try {
      const next = await api.command(taskId, command);
      if (taskGeneration.current === generation && projectionVersion.current === version && next.id === taskId) setTask(next);
    } catch {
      if (taskGeneration.current !== generation || projectionVersion.current !== version) return;
      setError("操作失败，请根据当前页面状态重试");
    } finally {
      if (taskGeneration.current === generation) setBusyCommand(undefined);
    }
  };

  const runRecovery = async (command: ApplicationRecoveryCommand) => {
    if (command === "cancel") return runCommand({ type: "cancel" });
    if (!api.recover) {
      setError("恢复服务暂不可用，请稍后重试");
      return;
    }
    const generation = taskGeneration.current;
    const version = ++projectionVersion.current;
    setBusyRecovery(command);
    setError(undefined);
    try {
      const next = await api.recover(taskId, command);
      if (taskGeneration.current === generation && projectionVersion.current === version && next.id === taskId) setTask(next);
    } catch {
      if (taskGeneration.current !== generation || projectionVersion.current !== version) return;
      setError("恢复操作失败，请检查受控浏览器中的当前页面");
    } finally {
      if (taskGeneration.current === generation) setBusyRecovery(undefined);
    }
  };

  const retryLoad = () => {
    const generation = taskGeneration.current;
    const version = ++projectionVersion.current;
    setLoading(true);
    void loadTask(generation, version);
  };

  const deleteTask = async () => {
    if (!api.delete) return;
    setError(undefined);
    try {
      await api.delete(taskId);
      onNavigate?.("/applications/new");
    } catch {
      setError("删除任务失败，请稍后重试");
    }
  };

  const submitQuestions = (submission: QuestionSubmission) => {
    const promote = new Set(submission.promoteFieldPaths);
    const questionsById = new Map(currentTask?.questions.map((question) => [question.id, question]));
    return runCommand({
      type: "answer_questions",
      answers: submission.answers.map((answer) => ({
        ...answer,
        promoteToProfile: promote.has(questionsById.get(answer.id)?.fieldPath ?? "")
      }))
    });
  };

  return <div className="app-shell application-shell">
    <aside className="application-rail" aria-label="应用导航">
      <div className="rail-brand"><FileText aria-hidden="true" size={21} /><strong>简历投递助手</strong></div>
      <nav aria-label="主导航">
        <button type="button" onClick={() => onNavigate?.("/")}><Database aria-hidden="true" size={17} />候选人档案</button>
        <button className="active" type="button" aria-current="page"><ClipboardList aria-hidden="true" size={17} />投递任务</button>
        <button type="button" onClick={() => onNavigate?.("/applications/new")}><Activity aria-hidden="true" size={17} />审核中心</button>
      </nav>
      <div className="rail-footer"><ShieldCheck aria-hidden="true" size={16} />仅本机运行</div>
    </aside>
    <div className="application-content">
      <header className="app-header application-workbench-header">
        <div><span>投递工作台</span><h1>实时任务控制</h1></div>
        <div className="local-state"><ShieldCheck aria-hidden="true" size={16} />数据仅保存在本机</div>
      </header>
      <main className="application-main">
        <button className="application-back" type="button" onClick={() => onNavigate?.("/applications/new")}><ArrowLeft aria-hidden="true" size={17} />新建任务</button>
        {loading ? <div className="state-panel" role="status"><span className="spinner" />正在加载任务</div> : error && !currentTask ? (
          <div className="state-panel error-state" role="alert"><strong>{error}</strong><button className="button secondary" type="button" onClick={retryLoad}>重新加载</button></div>
        ) : currentTask ? <>
          <section className="task-header-band">
            <div className="task-heading"><span>投递任务</span><h2>{host || "招聘官网"}</h2><a href={currentTask.applicationUrl} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" size={14} />查看目标页面</a></div>
            <LiveBrowserStatus connection={connection} taskState={currentTask.state} activities={activities} />
          </section>
          <h2 className="workbench-title">投递任务工作台</h2>
          <TaskStageStepper phase={displayPhase} counts={{ completed: completedCount, attention: attentionItems.length }} />
          <section className="task-workspace">
            <ProgressSummary
              compact
              task={currentTask}
              activities={activities}
              connection={connection}
              busy={busyCommand !== undefined || busyRecovery !== undefined}
              onRecovery={(command) => void runRecovery(command)}
            />
            <div className="task-workbench-grid">
              <TaskAttentionList items={attentionItems} selectedId={selectedAttentionId} onSelect={setSelectedAttentionId} />
              <section className="task-attention-detail" aria-label="处理详情">
                {currentTask.state === "needs_questions" && currentTask.commands.includes("answer_questions") && currentTask.questions.length > 0 && <QuestionPanel
                  questions={currentTask.questions}
                  busy={busyCommand !== undefined}
                  onSubmit={submitQuestions}
                />}
                {currentTask.state === "awaiting_content_review" && currentTask.contentReview && <ContentReviewPage
                  review={currentTask.contentReview}
                  busy={busyCommand !== undefined}
                  canApprove={currentTask.commands.includes("approve_content")}
                  canReject={currentTask.commands.includes("reject_content")}
                  onApprove={(editedValue) => runCommand({ type: "approve_content", reviewId: currentTask.contentReview!.id, editedValue })}
                  onReject={() => runCommand({ type: "reject_content", reviewId: currentTask.contentReview!.id })}
                />}
                {currentTask.state !== "needs_questions" && currentTask.state !== "awaiting_content_review" && <div className="detail-empty"><span>当前动作</span><strong>{selectedAttentionId ? "已选中处理项" : "系统正在安全推进"}</strong><p>需要人工判断的内容会在这里集中显示。</p></div>}
              </section>
            </div>
            <CompactActivityFeed activities={activities} />
            {(hasVisibleCommand || canDeleteTask) && <section className="task-actions" aria-label="当前可用操作">
              {currentTask.commands.includes("open_browser") && <button className="button secondary" type="button" disabled={busyCommand !== undefined} onClick={() => void runCommand({ type: "open_browser" })}><MonitorUp aria-hidden="true" size={16} />打开受控浏览器</button>}
              {currentTask.commands.includes("resume") && <button className="button primary" type="button" disabled={busyCommand !== undefined} onClick={() => void runCommand({ type: "resume" })}><RotateCw aria-hidden="true" size={16} />我已完成登录，继续</button>}
              {currentTask.commands.includes("resume_with_profile") && <button className="button primary" type="button" disabled={busyCommand !== undefined} onClick={() => void runCommand({ type: "resume_with_profile" })}><RotateCw aria-hidden="true" size={16} />我已补全档案，重新匹配</button>}
              {currentTask.commands.includes("cancel") && <button className="button quiet danger" type="button" disabled={busyCommand !== undefined} onClick={() => void runCommand({ type: "cancel" })}><X aria-hidden="true" size={16} />取消任务</button>}
              {canDeleteTask && <button className="button quiet danger" type="button" disabled={busyCommand !== undefined} onClick={() => void deleteTask()}><X aria-hidden="true" size={16} />删除任务</button>}
            </section>}
            {error && <p className="inline-error" role="alert">{error}</p>}
          </section>
        </> : null}
      </main>
    </div>
  </div>;
}

interface ProgressSummaryProps {
  task: ApplicationTask;
  activities: ApplicationTaskProgressEvent[];
  connection?: "connecting" | "connected" | "disconnected";
  busy?: boolean;
  compact?: boolean;
  onRecovery?(command: ApplicationRecoveryCommand): void;
}

export function ProgressSummary({ task, activities, connection = "connected", busy = false, compact = false, onRecovery }: ProgressSummaryProps) {
  const [now, setNow] = useState(Date.now);
  const latestLifecycle = [...activities].reverse().find((event) =>
    event.type === "operation_started" || event.type === "operation_completed" || event.type === "operation_failed");
  const latestPause = [...activities].reverse().find((event) => event.type === "task_paused" || event.type === "task_resumed");
  const current = latestLifecycle?.type === "operation_started"
    && (!latestPause || BigInt(latestLifecycle.id) > BigInt(latestPause.id))
    ? latestLifecycle
    : undefined;
  const observedOperation = useRef<{ key: string; at: number } | undefined>(undefined);
  const operationKey = current ? `${task.id}:${current.id}` : undefined;
  if (current && observedOperation.current?.key !== operationKey) {
    observedOperation.current = { key: operationKey!, at: Date.now() };
  }
  const latestResult = [...activities].reverse().find((event) => event.type === "operation_completed" || event.type === "operation_failed");
  const paused = latestPause?.type === "task_paused"
    && (!latestLifecycle || BigInt(latestPause.id) > BigInt(latestLifecycle.id));
  const failed = paused && latestResult?.type === "operation_failed" ? latestResult : undefined;
  const action = failed
    ? `${failed.progress.displayCategory}${failed.operation.status === "timed_out" ? "填写超时" : "填写失败"}`
    : paused
      ? "已暂停自动填写"
    : current
      ? operationTitle(current)
      : task.state === "waiting_for_login"
        ? "请在受控浏览器中完成登录"
        : STATE_LABELS[task.state];
  const phaseIndex = currentPhase(task.state, current?.operation.kind);
  const history = activities.filter((event) => event.type !== "state_changed").slice(-5).reverse();

  useEffect(() => {
    if (!current) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [current?.id]);

  return <section className={`progress-summary${paused ? " paused" : ""}`} aria-labelledby="current-state-title" aria-live="polite">
    <div className="progress-primary">
      <div className="task-state-mark">{paused ? <CircleAlert aria-hidden="true" size={24} /> : <MonitorUp aria-hidden="true" size={24} />}</div>
      <div className="progress-action">
        <span>当前动作</span>
        <h2 id="current-state-title">{action}</h2>
        {connection === "disconnected" && <p>上次状态：{STATE_LABELS[task.state]}</p>}
      </div>
      {current && !paused && <dl className="progress-metrics">
        <div><dt>字段进度</dt><dd>第 {current.progress.current} / {current.progress.total} 项</dd></div>
        <div><dt>已用时</dt><dd>{formatElapsed(current.operation.elapsedMs + Math.max(0, now - (observedOperation.current?.at ?? now)))}</dd></div>
      </dl>}
    </div>

    {paused ? <div className="progress-result stalled" role="status">
      <div><strong>{failed ? failureReason(failed.operation.errorCode) : "检测到你正在操作页面"}</strong><span>系统已暂停自动填写，避免继续覆盖页面内容。</span></div>
      <div className="recovery-actions" aria-label="暂停恢复操作">
        {task.recoveryCommands.includes("retry_current") && <button className="button primary" type="button" disabled={busy} onClick={() => onRecovery?.("retry_current")}><RotateCw aria-hidden="true" size={15} />重试当前项</button>}
        {task.recoveryCommands.includes("manual_done") && <button className="button secondary" type="button" disabled={busy} onClick={() => onRecovery?.("manual_done")}><Hand aria-hidden="true" size={15} />我已手动完成</button>}
        {task.recoveryCommands.includes("cancel") && <button className="button quiet danger" type="button" disabled={busy} onClick={() => onRecovery?.("cancel")}><X aria-hidden="true" size={15} />取消任务</button>}
      </div>
    </div> : latestResult?.type === "operation_completed" ? <p className="progress-result"><Check aria-hidden="true" size={16} />上一项：{latestResult.progress.displayCategory}已填写并验证成功</p> : null}

    {!compact && <ol className="phase-track" aria-label="任务阶段">
      {PHASES.map((phase, index) => <li key={phase.key} className={index < phaseIndex ? "complete" : index === phaseIndex ? "current" : "pending"} aria-label={`${phase.label}阶段`} aria-current={index === phaseIndex ? "step" : undefined}>
        <span>{index < phaseIndex ? <Check aria-hidden="true" size={12} /> : index + 1}</span><strong>{phase.label}</strong>
      </li>)}
    </ol>}

    {!compact && <details className="activity-details">
      <summary><History aria-hidden="true" size={15} />执行历史<span>最近 {history.length} 条</span><ChevronRight className="details-chevron" aria-hidden="true" size={15} /></summary>
      <ol>{history.map((event) => <li key={event.id}><time dateTime={event.createdAt}>{formatTime(event.createdAt)}</time><span>{activityText(event)}</span></li>)}</ol>
    </details>}
  </section>;
}

function findLatest(activities: ApplicationTaskProgressEvent[], type: "operation_started") {
  return [...activities].reverse().find((event): event is Extract<ApplicationTaskProgressEvent, { type: typeof type }> => event.type === type);
}

function operationTitle(event: Extract<ApplicationTaskProgressEvent, { type: "operation_started" }>): string {
  const verb = event.operation.kind === "observe" ? "正在识别" : event.operation.kind === "validate" ? "正在校验" : event.operation.kind === "navigate" ? "正在进入下一页" : "正在填写";
  return `${verb}${event.progress.displayCategory}`;
}

function formatElapsed(elapsedMs: number): string {
  return `已用时 ${(elapsedMs / 1000).toFixed(elapsedMs % 1000 === 0 ? 0 : 1)} 秒`;
}

function failureReason(errorCode?: string): string {
  if (errorCode === "TIMEOUT") return "等待页面响应超时";
  if (errorCode === "FIELD_NOT_FOUND") return "页面中未找到该字段";
  if (errorCode === "READBACK_MISMATCH") return "填写结果回读不一致";
  if (errorCode === "VALIDATION_FAILED") return "页面校验未通过";
  if (errorCode === "WORKER_DISCONNECTED") return "受控浏览器连接中断";
  return "当前操作未能完成";
}

function currentPhase(state: ApplicationTaskState, kind?: string): number {
  if (state === "review_locked") return 4;
  if (kind === "validate" || state === "validating") return 3;
  if (["filling", "needs_questions", "awaiting_content_review", "navigating"].includes(state) || ["fill", "select", "upload", "navigate"].includes(kind ?? "")) return 2;
  if (["observing_page", "waiting_for_login"].includes(state) || kind === "observe") return 1;
  return 0;
}

function activityText(event: ApplicationTaskProgressEvent): string {
  if (event.type === "state_changed") return STATE_LABELS[event.state];
  if (event.type === "operation_started") return `${event.progress.displayCategory}开始${event.operation.kind === "validate" ? "校验" : "处理"}`;
  if (event.type === "operation_completed") return `${event.progress.displayCategory}处理成功`;
  if (event.type === "operation_failed") return `${event.progress.displayCategory}${event.operation.status === "timed_out" ? "处理超时" : "处理失败"}`;
  if (event.type === "task_paused") return `${event.activity.displayCategory}已暂停自动处理`;
  if (event.type === "task_resumed") return "页面验证通过，已继续处理";
  const labels = { page_changed: "页面已变化", page_stable: "页面已稳定", user_activity: "检测到用户操作", worker_connected: "受控浏览器已连接", worker_disconnected: "受控浏览器连接中断" } as const;
  return labels[event.activity.kind];
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));
}
