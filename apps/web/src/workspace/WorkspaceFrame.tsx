import { ClipboardCheck, FilePlus2, FileUser, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

export type WorkspaceView = "profile" | "apply" | "reviews";

interface WorkspaceFrameProps {
  activeView: WorkspaceView;
  children: ReactNode;
  onSelectView(view: WorkspaceView): void;
}

const WORKSPACE_VIEWS: Array<{
  id: WorkspaceView;
  label: string;
  icon: typeof FileUser;
}> = [
  { id: "profile", label: "候选人档案", icon: FileUser },
  { id: "apply", label: "新建投递", icon: FilePlus2 },
  { id: "reviews", label: "投递审核", icon: ClipboardCheck }
];

export function WorkspaceFrame({ activeView, children, onSelectView }: WorkspaceFrameProps) {
  return (
    <div className="profile-workspace">
      <aside className="workspace-sidebar">
        <div className="workspace-brand">
          <FileUser aria-hidden="true" size={22} />
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
