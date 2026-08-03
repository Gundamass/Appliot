import { AlertTriangle, ChevronRight, CircleHelp, FileDiff, Hand } from "lucide-react";
import type { AttentionItem } from "./application-workbench.js";

interface TaskAttentionListProps {
  items: AttentionItem[];
  selectedId: string | undefined;
  onSelect(id: string): void;
}

export function TaskAttentionList({ items, selectedId, onSelect }: TaskAttentionListProps) {
  return <section className="task-attention-list" aria-labelledby="task-attention-title">
    <header><div><span>风险聚焦</span><h2 id="task-attention-title">需要你处理</h2></div><strong>{items.length}</strong></header>
    {items.length === 0 ? <p className="attention-empty">当前没有需要处理的项目</p> : <ul>
      {items.map((item) => {
        const Icon = item.kind === "content_review" ? FileDiff : item.kind === "question" ? CircleHelp : item.kind === "paused" ? Hand : AlertTriangle;
        return <li key={item.id}>
          <button type="button" aria-pressed={selectedId === item.id} onClick={() => onSelect(item.id)}>
            <Icon aria-hidden="true" size={17} />
            <span><strong>{item.label}</strong><small>{item.summary}</small></span>
            <ChevronRight aria-hidden="true" size={16} />
          </button>
        </li>;
      })}
    </ul>}
  </section>;
}
