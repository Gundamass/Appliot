import type { ConversationJobMatchAction, ConversationProcessEvent } from "@resume/contracts";
import type { JobMatchSession } from "../job-matching/api.js";
import { ConversationJobCards } from "./ConversationJobCards.js";
import { ConversationJobFilters } from "./ConversationJobFilters.js";
import type { ConversationProcessGroup } from "./conversation-process-model.js";

export interface ConversationJobMatchFlowProps {
  conversationId?: string;
  session: JobMatchSession;
  process?: ConversationProcessGroup;
  onAction(action: ConversationJobMatchAction): void | Promise<void>;
  onAdjustFilters?(): void;
}

export function ConversationJobMatchFlow({ conversationId, session, process, onAction, onAdjustFilters }: ConversationJobMatchFlowProps) {
  const ownerConversationId = conversationId ?? session.id;
  return (
    <section className="conversation-job-match-flow" aria-label="对话内岗位匹配">
      {process ? <ConversationJobProcess process={process} /> : null}
      <header className="conversation-job-match-heading">
        <div>
          <strong>岗位匹配</strong>
          <span>{stateLabel(session.state)}</span>
        </div>
        {session.source ? <small>{sourceLabel(session.source)}</small> : null}
      </header>
      {session.state === "awaiting_filter_confirmation" ? (
        <ConversationJobFilters
          conversationId={ownerConversationId}
          session={session}
          onAction={onAction}
          {...(onAdjustFilters === undefined ? {} : { onAdjustFilters })}
        />
      ) : null}
      {isReadingState(session.state) ? <ReadingState session={session} onAction={onAction} conversationId={ownerConversationId} /> : null}
      {session.state === "awaiting_login" || session.state === "awaiting_challenge" ? (
        <WaitingForHumanState session={session} onAction={onAction} conversationId={ownerConversationId} />
      ) : null}
      {session.state === "paused" ? <PausedState session={session} onAction={onAction} conversationId={ownerConversationId} /> : null}
      {session.state === "awaiting_job_selection" || session.state === "selected" ? (
        <ConversationJobCards conversationId={ownerConversationId} session={session} onAction={onAction} />
      ) : null}
      {session.state === "failed" ? <p className="conversation-job-match-error" role="alert">岗位匹配暂时失败，请查看上方执行过程后重试。</p> : null}
      {session.state === "cancelled" ? <p className="conversation-job-match-status">岗位匹配已取消。</p> : null}
      {session.state === "expired" ? <p className="conversation-job-match-error" role="alert">岗位匹配会话已过期，请重新开始。</p> : null}
    </section>
  );
}

function ConversationJobProcess({ process }: { process: ConversationProcessGroup }) {
  return (
    <section className="conversation-job-match-process" aria-label="岗位匹配执行过程">
      <ol aria-label="执行过程">
        {process.steps.map((step) => (
          <li key={step.stepId} className={step.status}>
            <span className="conversation-job-process-point" aria-hidden="true" />
            <span className="conversation-job-process-copy">
              <strong>{stageLabel(step.stage)}</strong>
              <small>{step.summary}</small>
              {step.status === "waiting" ? <em>等待处理</em> : null}
              {step.status === "failed" ? <em>处理失败</em> : null}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ReadingState({ session, conversationId, onAction }: { session: JobMatchSession; conversationId: string; onAction: ConversationJobMatchFlowProps["onAction"] }) {
  const extracting = session.state === "extracting_jobs";
  return (
    <section className="conversation-job-match-status" aria-live="polite">
      <strong>{extracting ? "正在读取岗位" : session.state === "matching_jobs" ? "正在匹配岗位" : "正在打开招聘页面"}</strong>
      <p>{session.cursor ? `已读取 ${session.cursor.pagesRead} 页，发现 ${session.cursor.newJobs} 个岗位` : "正在整理招聘页面中的岗位信息"}</p>
      {extracting ? <button type="button" className="conversation-button" onClick={() => dispatch(onAction, pauseAction(conversationId, session))}>暂停读取</button> : null}
    </section>
  );
}

function WaitingForHumanState({ session, conversationId, onAction }: { session: JobMatchSession; conversationId: string; onAction: ConversationJobMatchFlowProps["onAction"] }) {
  const login = session.state === "awaiting_login";
  return (
    <section className="conversation-job-match-status waiting" role="status">
      <strong>{login ? "等待登录招聘网站" : "等待人工验证"}</strong>
      <p>{login ? "请在受控浏览器中完成登录，完成后继续读取岗位。" : "请完成验证码或页面挑战，系统不会自动绕过验证。"}</p>
      <button type="button" className="conversation-button primary" onClick={() => dispatch(onAction, continueAction(conversationId, session))}>继续读取</button>
    </section>
  );
}

function PausedState({ session, conversationId, onAction }: { session: JobMatchSession; conversationId: string; onAction: ConversationJobMatchFlowProps["onAction"] }) {
  return (
    <section className="conversation-job-match-status">
      <strong>读取已暂停</strong>
      <p>岗位匹配会话已保留，可以继续读取而不会丢失当前版本。</p>
      <button type="button" className="conversation-button primary" onClick={() => dispatch(onAction, continueAction(conversationId, session))}>继续读取</button>
    </section>
  );
}

function isReadingState(state: JobMatchSession["state"]): boolean {
  return state === "created" || state === "opening_job_page" || state === "applying_filters" || state === "extracting_jobs" || state === "matching_jobs";
}

function pauseAction(conversationId: string, session: JobMatchSession): ConversationJobMatchAction {
  return {
    conversationId,
    sessionId: session.id,
    action: "pause",
    sessionVersion: session.version,
    idempotencyKey: actionKey("pause", session.version)
  };
}

function continueAction(conversationId: string, session: JobMatchSession): ConversationJobMatchAction {
  return {
    conversationId,
    sessionId: session.id,
    action: "continue",
    sessionVersion: session.version,
    idempotencyKey: actionKey("continue", session.version)
  };
}

function actionKey(action: string, version: number): string {
  return `inline-job-match:${action}:${version}`;
}

function dispatch(onAction: ConversationJobMatchFlowProps["onAction"], action: ConversationJobMatchAction): void {
  void onAction(action);
}

function stateLabel(state: JobMatchSession["state"]): string {
  return ({
    created: "准备读取",
    awaiting_filter_confirmation: "等待确认筛选",
    opening_job_page: "正在打开招聘页面",
    awaiting_login: "等待登录",
    applying_filters: "正在应用筛选",
    extracting_jobs: "正在读取岗位",
    matching_jobs: "正在匹配岗位",
    awaiting_job_selection: "等待选择岗位",
    selected: "已选择岗位",
    converted_to_application: "已创建投递任务",
    awaiting_challenge: "等待人工验证",
    paused: "已暂停",
    failed: "处理失败",
    cancelled: "已取消",
    expired: "已过期"
  } as Record<JobMatchSession["state"], string>)[state];
}

function stageLabel(stage: ConversationProcessEvent["stage"]): string {
  return ({
    understanding_request: "理解请求",
    searching_recruitment_site: "搜索官方招聘入口",
    validating_recruitment_site: "校验招聘入口",
    recruitment_site_found: "找到招聘入口",
    waiting_for_confirmation: "等待确认",
    processing_confirmation: "处理确认",
    reading_recruitment_site: "读取招聘页面",
    loading_recommendations: "加载岗位推荐",
    matching_jobs: "匹配岗位",
    loading_application_progress: "查询投递进度",
    creating_job_match_session: "创建岗位匹配",
    job_match_session_ready: "岗位匹配已准备好",
    creating_application_task: "创建受控投递任务",
    generating_response: "生成回复",
    completed: "完成",
    failed: "处理失败"
  } as Record<ConversationProcessEvent["stage"], string>)[stage];
}

function sourceLabel(source: NonNullable<JobMatchSession["source"]>): string {
  return ({ baidu: "百度招聘", dji: "大疆招聘", moka: "Moka 招聘" } as Record<string, string>)[source] ?? source;
}
