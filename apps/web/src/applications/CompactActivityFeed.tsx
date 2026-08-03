import type { ApplicationTaskProgressEvent } from "@resume/contracts";
import { Clock3 } from "lucide-react";
import { activityLabel, recentActivities } from "./application-workbench.js";

interface CompactActivityFeedProps {
  activities: ApplicationTaskProgressEvent[];
}

export function CompactActivityFeed({ activities }: CompactActivityFeedProps) {
  const visible = recentActivities(activities);
  return <details className="compact-activity-feed">
    <summary><Clock3 aria-hidden="true" size={16} /><span>最近活动</span><small>{activities.filter((event) => event.type !== "state_changed").length} 条</small></summary>
    {visible.length === 0 ? <p>暂无浏览器活动</p> : <ol>
      {visible.map((event) => <li key={event.id}><span>{activityLabel(event)}</span><time dateTime={event.createdAt}>{formatTime(event.createdAt)}</time></li>)}
    </ol>}
  </details>;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(value));
}
