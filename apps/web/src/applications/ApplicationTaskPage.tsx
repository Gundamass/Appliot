import type { ApplicationCommand, ApplicationCommandType, ApplicationExecutionProgress, ApplicationTask, ApplicationTaskProgressEvent, ApplicationTaskState } from "@resume/contracts";
import { ArrowLeft, CircleAlert, ExternalLink, Hand, MonitorUp, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApplicationApi, ApplicationRecoveryCommand } from "./api.js";
import { ContentReviewPage } from "./ContentReviewPage.js";
import { CompactActivityFeed } from "./CompactActivityFeed.js";
import { FieldCoveragePanel } from "./FieldCoveragePanel.js";
import { CHALLENGE_LABELS, deriveAttentionItems, executionProgressForTask } from "./application-workbench.js";
import { LiveBrowserStatus } from "./LiveBrowserStatus.js";
import { QuestionPanel, type QuestionSubmission } from "./QuestionPanel.js";
import { TaskAttentionList } from "./TaskAttentionList.js";
import { TaskStageStepper } from "./TaskStageStepper.js";
import { useTaskEvents, type TaskEventConnection } from "./useTaskEvents.js";
import { WorkspaceFrame, type WorkspaceView } from "../workspace/WorkspaceFrame.js";

interface ApplicationTaskPageProps {
  taskId: string;
  api: Pick<ApplicationApi, "get" | "command"> & Partial<Pick<ApplicationApi, "recover" | "delete">>;
  connectEvents?: TaskEventConnection;
  onNavigate?(path: string): void;
}

const STATE_LABELS: Record<ApplicationTaskState, string> = {
  created: "任务已创建", observing_page: "等待进入简历填写页面", waiting_for_login: "等待登录",
  needs_questions: "等待补充信息", awaiting_content_review: "等待内容审核", awaiting_challenge: "等待人工处理", filling: "正在填写",
  validating: "正在校验", navigating: "正在进入下一页", review_locked: "等待人工最终审核",
  cancelled: "任务已取消", failed: "任务失败"
};

function profileSyncErrorMessage(error: string | undefined): string {
  switch (error) {
    case "profile_sync_incomplete":
      return "最新档案仍缺少当前页面所需资料";
    case "browser_unavailable":
    case "browser_worker_unavailable":
    case "worker_disconnected":
      return "受控浏览器当前不可用，请恢复连接后重试";
    case "profile_sync_not_allowed":
      return "当前任务状态不允许同步档案";
    case "profile_sync_in_progress":
      return "档案正在同步，请稍候";
    case "profile_refresh_failed":
    case "profile_sync_failed":
      return "重新匹配档案后仍未能完成填写";
    default:
      return "档案同步未完成，请检查受控浏览器页面后重试";
  }
}

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
  const latestExecutionProgress = useRef<ApplicationExecutionProgress | undefined>(undefined);
  const activeTaskId = useRef(taskId);
  activeTaskId.current = taskId;

  const loadTask = useCallback(async (generation: number, version: number) => {
    try {
      const next = await api.get(taskId);
      if (taskGeneration.current !== generation || projectionVersion.current !== version || next.id !== taskId) return;
      setTask({
        ...next,
        ...(latestEventState.current === undefined ? {} : { state: latestEventState.current }),
        ...(latestExecutionProgress.current === undefined
          ? {}
          : { executionProgress: latestExecutionProgress.current })
      });
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
    latestExecutionProgress.current = undefined;
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
    if (event.type === "execution_progress_changed") latestExecutionProgress.current = event.executionProgress;
    setTask((current) => {
      if (current?.id !== taskId) return current;
      if (event.type === "state_changed") return { ...current, state: event.state, commands: [] };
      if (event.type === "execution_progress_changed") {
        return { ...current, executionProgress: event.executionProgress };
      }
      return current;
    });
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
  const taskTitle = currentTask?.name ?? (host || "投递任务");
  const attentionItems = useMemo(
    () => currentTask ? deriveAttentionItems(currentTask, activities) : [],
    [activities, currentTask]
  );
  const executionProgress = useMemo(
    () => currentTask ? executionProgressForTask(currentTask) : undefined,
    [currentTask]
  );
  const [selectedAttentionId, setSelectedAttentionId] = useState<string>();
  useEffect(() => {
    if (attentionItems.length === 0) {
      setSelectedAttentionId(undefined);
      return;
    }
    setSelectedAttentionId((current) => attentionItems.some((item) => item.id === current) ? current : attentionItems[0]!.id);
  }, [attentionItems]);
  const hasVisibleCommand = currentTask?.commands.some((command) => ["open_browser", "resume", "resume_after_challenge", "resume_with_profile", "sync_profile", "cancel"].includes(command)) ?? false;
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
    if (!window.confirm(`确定删除“${taskTitle}”这条投递任务记录吗？`)) return;
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

  const selectWorkspaceView = (view: WorkspaceView) => {
    const destination = view === "profile" ? "/?view=profile" : view === "jobs" ? "/?view=jobs" : view === "applications" ? "/?view=applications" : "/";
    onNavigate?.(destination);
  };

  return <WorkspaceFrame activeView="applications" onSelectView={selectWorkspaceView}>
    <section className="workspace-view application-shell embedded-application-shell" aria-labelledby="workspace-task-title">
      <header className="workspace-view-header">
        <div><span>投递工作台</span><h1 id="workspace-task-title">实时任务控制</h1></div>
      </header>
      <main className="application-main">
        <button className="application-back" type="button" onClick={() => onNavigate?.("/?view=reviews")}><ArrowLeft aria-hidden="true" size={17} />返回投递审核</button>
        {loading ? <div className="state-panel" role="status"><span className="spinner" />正在加载任务</div> : error && !currentTask ? (
          <div className="state-panel error-state" role="alert"><strong>{error}</strong><button className="button secondary" type="button" onClick={retryLoad}>重新加载</button></div>
        ) : currentTask ? <>
          <section className="task-header-band">
            <div className="task-heading"><span>投递任务</span><h2>{taskTitle}</h2><a href={currentTask.applicationUrl} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" size={14} />查看目标页面</a></div>
            <LiveBrowserStatus connection={connection} taskState={currentTask.state} activities={activities} />
          </section>
          {currentTask.profileSyncStatus === "failed" && <section className="profile-sync-warning" role="alert">
            <div><CircleAlert aria-hidden="true" size={17} /><strong>档案同步失败</strong><span>{profileSyncErrorMessage(currentTask.profileSyncError)}</span></div>
            {currentTask.profileRevisionApplied !== undefined && <small>已应用档案版本：{currentTask.profileRevisionApplied}</small>}
          </section>}
          {currentTask.profileSyncStatus === "pending" && <p className="profile-sync-pending" role="status"><RotateCw aria-hidden="true" size={15} />正在将最新档案匹配到当前投递任务</p>}
          <h2 className="workbench-title">投递任务工作台</h2>
          {executionProgress && <TaskStageStepper progress={executionProgress} />}
          <section className="task-workspace">
            <ProgressSummary
              task={currentTask}
              activities={activities}
              connection={connection}
              busy={busyCommand !== undefined || busyRecovery !== undefined}
              onRecovery={(command) => void runRecovery(command)}
            />
            {currentTask.fieldCoverage && <FieldCoveragePanel coverage={currentTask.fieldCoverage} />}
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
                {currentTask.state === "awaiting_challenge" && currentTask.challenge && <section className="challenge-panel" role="alert">
                  <CircleAlert aria-hidden="true" size={22} />
                  <div>
                    <span>需要人工处理</span>
                    <h3>{CHALLENGE_LABELS[currentTask.challenge.kind]}</h3>
                    <p>请在受控浏览器中完成处理，然后点击继续填写。</p>
                  </div>
                </section>}
                {currentTask.state !== "needs_questions" && currentTask.state !== "awaiting_content_review" && currentTask.state !== "awaiting_challenge" && <div className="detail-empty"><span>当前动作</span><strong>{selectedAttentionId ? "已选中处理项" : "系统正在安全推进"}</strong><p>需要人工判断的内容会在这里集中显示。</p></div>}
              </section>
            </div>
            <CompactActivityFeed activities={activities} />
            {(hasVisibleCommand || canDeleteTask) && <section className="task-actions" aria-label="当前可用操作">
              {currentTask.commands.includes("open_browser") && <button className="button secondary" type="button" disabled={busyCommand !== undefined} onClick={() => void runCommand({ type: "open_browser" })}><MonitorUp aria-hidden="true" size={16} />打开受控浏览器</button>}
              {currentTask.commands.includes("resume") && <button className="button primary" type="button" disabled={busyCommand !== undefined} onClick={() => void runCommand({ type: "resume" })}><RotateCw aria-hidden="true" size={16} />我已完成登录，继续</button>}
              {currentTask.commands.includes("resume_after_challenge") && <button className="button primary" type="button" disabled={busyCommand !== undefined} onClick={() => void runCommand({ type: "resume_after_challenge" })}><RotateCw aria-hidden="true" size={16} />继续填写</button>}
              {currentTask.commands.includes("resume_with_profile") && <button className="button primary" type="button" disabled={busyCommand !== undefined} onClick={() => void runCommand({ type: "resume_with_profile" })}><RotateCw aria-hidden="true" size={16} />我已补全档案，重新匹配</button>}
              {currentTask.commands.includes("sync_profile") && <button className="button primary" type="button" disabled={busyCommand !== undefined} onClick={() => void runCommand({ type: "sync_profile" })}><RotateCw aria-hidden="true" size={16} />重新同步档案</button>}
              {currentTask.commands.includes("cancel") && <button className="button quiet danger" type="button" disabled={busyCommand !== undefined} onClick={() => void runCommand({ type: "cancel" })}><X aria-hidden="true" size={16} />取消任务</button>}
              {canDeleteTask && <button className="button quiet danger" type="button" disabled={busyCommand !== undefined} onClick={() => void deleteTask()}><X aria-hidden="true" size={16} />删除任务</button>}
            </section>}
            {error && <p className="inline-error" role="alert">{error}</p>}
          </section>
        </> : null}
      </main>
    </section>
  </WorkspaceFrame>;
}

interface ProgressSummaryProps {
  task: ApplicationTask;
  activities: ApplicationTaskProgressEvent[];
  connection?: "connecting" | "connected" | "disconnected";
  busy?: boolean;
  onRecovery?(command: ApplicationRecoveryCommand): void;
}

const EXECUTION_PHASE_LABELS: Record<ApplicationExecutionProgress["currentPhase"], string> = {
  waiting_for_form: "等待表单",
  deterministic_fill: "确定性填写",
  semantic_fill: "语义补全",
  readback_validation: "回读校验",
  final_review: "最终审核"
};

export function ProgressSummary({ task, activities, connection = "connected", busy = false, onRecovery }: ProgressSummaryProps) {
  const execution = executionProgressForTask(task);
  const latestLifecycle = [...activities].reverse().find((event) =>
    event.type === "operation_started" || event.type === "operation_completed" || event.type === "operation_failed");
  const latestPause = [...activities].reverse().find((event) => event.type === "task_paused" || event.type === "task_resumed");
  const latestResult = [...activities].reverse().find((event) => event.type === "operation_completed" || event.type === "operation_failed");
  const paused = latestPause?.type === "task_paused"
    && (!latestLifecycle || BigInt(latestPause.id) > BigInt(latestLifecycle.id));
  const failed = paused && latestResult?.type === "operation_failed" ? latestResult : undefined;
  const action = failed
    ? `${failed.progress.displayCategory}${failed.operation.status === "timed_out" ? "填写超时" : "填写失败"}`
    : paused
      ? "已暂停自动填写"
      : execution.current.action;

  return <section className={`progress-summary${paused ? " paused" : ""}`} aria-labelledby="current-state-title" aria-live="polite">
    <div className="progress-primary">
      <div className="task-state-mark">{paused ? <CircleAlert aria-hidden="true" size={24} /> : <MonitorUp aria-hidden="true" size={24} />}</div>
      <div className="progress-action">
        <span>当前：{EXECUTION_PHASE_LABELS[execution.currentPhase]}</span>
        <h2 id="current-state-title">{action}</h2>
        {connection === "disconnected" && <p>上次状态：{STATE_LABELS[task.state]}</p>}
      </div>
      {!paused && execution.current.attempt !== undefined && <span className="progress-attempt">
        尝试 {execution.current.attempt}/{execution.current.maxAttempts}
      </span>}
    </div>

    <div className="execution-counts" aria-label="填写统计">
      <span><strong>精确</strong> {execution.counts.exact}</span>
      <span><strong>语义</strong> {execution.counts.semantic}</span>
      <span><strong>用户已有</strong> {execution.counts.user}</span>
      <span><strong>未匹配</strong> {execution.counts.missing}</span>
      <span><strong>失败</strong> {execution.counts.failed}</span>
    </div>

    {paused ? <div className="progress-result stalled" role="status">
      <div><strong>{failed ? failureReason(failed.operation.errorCode) : "检测到你正在操作页面"}</strong><span>系统已暂停自动填写，避免继续覆盖页面内容。</span></div>
      <div className="recovery-actions" aria-label="暂停恢复操作">
        {task.recoveryCommands.includes("retry_current") && <button className="button primary" type="button" disabled={busy} onClick={() => onRecovery?.("retry_current")}><RotateCw aria-hidden="true" size={15} />重试当前项</button>}
        {task.recoveryCommands.includes("manual_done") && <button className="button secondary" type="button" disabled={busy} onClick={() => onRecovery?.("manual_done")}><Hand aria-hidden="true" size={15} />我已手动完成</button>}
        {task.recoveryCommands.includes("cancel") && <button className="button quiet danger" type="button" disabled={busy} onClick={() => onRecovery?.("cancel")}><X aria-hidden="true" size={15} />取消任务</button>}
      </div>
    </div> : null}
  </section>;
}

function failureReason(errorCode?: string): string {
  if (errorCode === "TIMEOUT") return "等待页面响应超时";
  if (errorCode === "FIELD_NOT_FOUND") return "页面中未找到该字段";
  if (errorCode === "READBACK_MISMATCH") return "填写结果回读不一致";
  if (errorCode === "VALIDATION_FAILED") return "页面校验未通过";
  if (errorCode === "WORKER_DISCONNECTED") return "受控浏览器连接中断";
  return "当前操作未能完成";
}

