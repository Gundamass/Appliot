import type { ProfileCompleteness } from "@resume/contracts";
import { FIELD_DEFINITIONS } from "@resume/form-semantics/field-registry";
import { CheckCircle2, CircleAlert, ExternalLink, FileUser } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ApplicationApiError, type ApplicationApi } from "./api.js";

interface ApplicationStartPanelProps {
  profileCompleteness?: ProfileCompleteness | undefined;
  applicationApi: Pick<ApplicationApi, "create">;
  onTaskCreated(taskId: string): void;
  onViewChange?(view: "profile"): void;
}

export function ApplicationStartPanel({ profileCompleteness, applicationApi, onTaskCreated, onViewChange }: ApplicationStartPanelProps) {
  const [applicationUrl, setApplicationUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [activeTaskId, setActiveTaskId] = useState<string>();
  const missing = profileCompleteness?.sections.flatMap((section) => section.missing) ?? [];
  const percentage = profileCompleteness
    ? Math.round((profileCompleteness.completed / Math.max(1, profileCompleteness.total)) * 100)
    : undefined;

  const createTask = async (event: FormEvent) => {
    event.preventDefault();
    const value = applicationUrl.trim();
    if (!isHttpUrl(value)) {
      setError("请输入完整的 http 或 https 链接");
      return;
    }
    setBusy(true);
    setError(undefined);
    setActiveTaskId(undefined);
    try {
      const task = await applicationApi.create({ applicationUrl: value });
      onTaskCreated(task.id);
    } catch (caught) {
      if (caught instanceof ApplicationApiError && caught.code === "browser_task_in_use" && caught.taskId) {
        setError("受控浏览器正在处理另一个投递任务。");
        setActiveTaskId(caught.taskId);
      } else {
        setError(caught instanceof Error ? caught.message : "任务创建失败，请检查链接和浏览器服务后重试");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="application-start-panel">
      <section className="application-preflight" aria-labelledby="application-preflight-title">
        <header>
          <div><span>投递前检查</span><h2 id="application-preflight-title">档案准备度</h2></div>
          {missing.length === 0 ? <CheckCircle2 aria-hidden="true" size={21} /> : <CircleAlert aria-hidden="true" size={21} />}
        </header>
        <div className="preflight-summary">
          <strong>{percentage === undefined ? "正在读取" : `${percentage}%`}</strong>
          <span>{missing.length === 0 ? "已具备常用投递资料" : `${missing.length} 个字段可能触发追问`}</span>
        </div>
        {missing.length > 0 && (
          <div className="preflight-missing">
            <p>建议先补全</p>
            <ul>{missing.slice(0, 8).map((path) => <li key={path}>{labelFor(path)}</li>)}</ul>
            {onViewChange && <button className="button secondary" type="button" onClick={() => onViewChange("profile")}><FileUser aria-hidden="true" size={16} />补全档案</button>}
          </div>
        )}
      </section>

      <section className="application-connect" aria-labelledby="application-connect-title">
        <header><span>受控浏览器</span><h2 id="application-connect-title">连接招聘官网</h2></header>
        <form onSubmit={(event) => void createTask(event)}>
          <label>
            <span>投递官网链接</span>
            <div className="application-url-field"><ExternalLink aria-hidden="true" size={18} /><input aria-label="投递官网链接" value={applicationUrl} onChange={(event) => setApplicationUrl(event.target.value)} placeholder="https://career.example.com/jobs/..." /></div>
          </label>
          <button className="button primary" type="submit" disabled={busy}>{busy ? "正在连接" : "开始识别并填写"}</button>
        </form>
        {error && <p className="inline-error" role="alert">{error}</p>}
        {activeTaskId && <button className="button secondary" type="button" onClick={() => onTaskCreated(activeTaskId)}>进入当前任务</button>}
        <p className="application-safety-note">系统只执行页面识别、资料填写和中间步骤，最终提交始终由你确认。</p>
      </section>
    </div>
  );
}

function labelFor(path: string): string {
  const normalized = path.replace(/\[\d+\]/gu, "[]");
  return FIELD_DEFINITIONS.find((field) => field.semantic === normalized)?.label ?? path;
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
