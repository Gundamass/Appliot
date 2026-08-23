import { BriefcaseBusiness, ClipboardCheck, FileText, MessageCircle, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

export type WorkspaceView = "chat" | "jobs" | "applications" | "profile";

interface WorkspaceFrameProps {
  activeView: WorkspaceView;
  children: ReactNode;
  onSelectView(view: WorkspaceView): void;
}

const WORKSPACE_VIEWS: Array<{
  id: WorkspaceView;
  label: string;
  icon: typeof FileText;
}> = [
  { id: "chat", label: "对话首页", icon: MessageCircle },
  { id: "jobs", label: "我的岗位", icon: BriefcaseBusiness },
  { id: "applications", label: "投递进度", icon: ClipboardCheck },
  { id: "profile", label: "我的简历", icon: FileText }
];

export function WorkspaceFrame({ activeView, children, onSelectView }: WorkspaceFrameProps) {
  return (
    <div className="profile-workspace">
      <aside className="workspace-sidebar">
        <div className="workspace-brand">
          <MessageCircle aria-hidden="true" size={22} />
          <div><strong>简历投递助手</strong><span>候选人工作台</span></div>
        </div>
        <nav className="workspace-navigation" aria-label="候选人工作台">
          {WORKSPACE_VIEWS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={activeView === item.id ? "page" : undefined}
                onClick={() => onSelectView(item.id)}
              >
                <Icon aria-hidden="true" size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="workspace-local-state"><ShieldCheck aria-hidden="true" size={16} />本地加密保存</div>
      </aside>
      <div className="workspace-content">{children}</div>
    </div>
  );
}
