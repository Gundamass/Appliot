import { ClipboardCheck, FileText, MessageCircle, ShieldCheck, Sparkles } from "lucide-react";
import type { ReactNode } from "react";

export type WorkspaceView = "chat" | "applications" | "profile";

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
  { id: "applications", label: "投递进度", icon: ClipboardCheck },
  { id: "profile", label: "我的简历", icon: FileText }
];

export function WorkspaceFrame({ activeView, children, onSelectView }: WorkspaceFrameProps) {
  return (
    <div className="workspace-shell">
      <header className="workspace-topbar">
        <div className="workspace-topbar-brand">
          <span className="workspace-mark"><Sparkles aria-hidden="true" size={15} /></span>
          <div><strong>岗位投递助手</strong><span>候选人工作台</span></div>
        </div>
        <div className="workspace-topmeta">
          <span className="workspace-online"><ShieldCheck aria-hidden="true" size={14} />受控浏览器已连接</span>
          <span>桌面工作区</span>
        </div>
      </header>
      <div className="profile-workspace">
        <aside className="workspace-sidebar">
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
    </div>
  );
}
