import type { ProfileCompleteness, ProfileDocumentSummary } from "@resume/contracts";
import { FileSearch, ListChecks, Save } from "lucide-react";

export type ProfileSaveState = "saved" | "dirty" | "saving";

interface ProfileSummaryBarProps {
  candidateName: string;
  targetRole?: string | undefined;
  completeness?: ProfileCompleteness | undefined;
  missingCount: number;
  latestDocument?: ProfileDocumentSummary | undefined;
  saveState: ProfileSaveState;
  onSave(): void;
  onOpenParser(): void;
  onFillMissing(): void;
}

export function ProfileSummaryBar({
  candidateName,
  targetRole,
  completeness,
  missingCount,
  latestDocument,
  saveState,
  onSave,
  onOpenParser,
  onFillMissing
}: ProfileSummaryBarProps) {
  const percentage = completeness
    ? Math.round((completeness.completed / Math.max(1, completeness.total)) * 100)
    : undefined;
  const stateLabel = saveState === "saving"
    ? "正在保存档案"
    : saveState === "dirty"
      ? "有未保存的更改"
      : "所有更改已保存";

  return (
    <section className="profile-summary-bar" aria-label="档案全局信息">
      <div className="profile-summary-person">
        <span className="profile-summary-avatar" aria-hidden="true">{candidateName.trim().slice(0, 1) || "候"}</span>
        <div><strong>{candidateName || "候选人"}</strong><span>{targetRole ? `目标岗位：${targetRole}` : "尚未填写目标岗位"}</span></div>
      </div>
      <div className="profile-summary-completeness">
        <div><span>档案完整度</span><strong>{percentage === undefined ? "--" : `${percentage}%`}</strong></div>
        <span className="profile-summary-progress" aria-label={percentage === undefined ? "档案完整度暂不可用" : `档案完整度 ${percentage}%`}>
          <i style={{ width: `${percentage ?? 0}%` }} />
        </span>
      </div>
      <div className="profile-summary-meta">
        <span><strong>{missingCount} 项待补全</strong><small>{latestDocument?.filename ?? "尚未导入简历"}</small></span>
        <span className={`profile-save-state ${saveState}`} role="status">{stateLabel}</span>
      </div>
      <div className="profile-summary-actions">
        <button className="button secondary" type="button" onClick={onFillMissing}>
          <ListChecks aria-hidden="true" size={16} />补全资料
        </button>
        <button className="button secondary" type="button" onClick={onOpenParser}>
          <FileSearch aria-hidden="true" size={16} />简历解析
        </button>
        <button className="button primary" type="button" disabled={saveState !== "dirty"} onClick={onSave}>
          <Save aria-hidden="true" size={16} />保存档案
        </button>
      </div>
    </section>
  );
}
