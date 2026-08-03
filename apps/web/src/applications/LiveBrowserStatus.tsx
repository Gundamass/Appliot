import { CircleCheck, CircleSlash, MousePointer2, Wifi } from "lucide-react";
import type { ApplicationTaskProgressEvent, ApplicationTaskState } from "@resume/contracts";

interface LiveBrowserStatusProps {
  connection: "connecting" | "connected" | "disconnected";
  taskState: ApplicationTaskState;
  activities: ApplicationTaskProgressEvent[];
}

export function LiveBrowserStatus({ connection, taskState, activities }: LiveBrowserStatusProps) {
  const latestActivity = [...activities].reverse().find((event) =>
    event.type === "browser_activity" || event.type === "task_paused" || event.type === "task_resumed"
  );
  const userOperating = latestActivity !== undefined
    && ((latestActivity.type === "browser_activity" && latestActivity.activity.kind === "user_activity")
      || (latestActivity.type === "task_paused" && latestActivity.activity.kind === "user_activity"));
  const stable = latestActivity?.type === "browser_activity" && latestActivity.activity.kind === "page_stable"
    || latestActivity?.type === "task_resumed";
  const disconnected = connection === "disconnected"
    || (latestActivity?.type === "browser_activity" && latestActivity.activity.kind === "worker_disconnected");
  const state = disconnected ? "disconnected" : userOperating ? "user" : stable ? "stable" : connection;
  const content = state === "disconnected"
    ? { title: "实时连接已中断，正在恢复", detail: "已保留最近一次页面状态" }
    : state === "user"
      ? { title: "用户操作中", detail: "自动填写已暂停" }
      : state === "stable"
        ? { title: "页面稳定", detail: "可以继续安全处理" }
        : state === "connecting"
          ? { title: "正在连接受控浏览器", detail: "等待浏览器 Worker 响应" }
          : { title: "受控浏览器已连接", detail: taskState === "waiting_for_login" ? "等待你完成登录" : "可以实时回读页面" };
  const Icon = state === "disconnected" ? CircleSlash : state === "user" ? MousePointer2 : state === "stable" ? CircleCheck : Wifi;

  return <section className={`live-browser-status ${state}`} role="status" aria-label="受控浏览器状态" aria-live="polite">
    <Icon aria-hidden="true" size={17} />
    <div><strong>{content.title}</strong><span>{content.detail}</span></div>
  </section>;
}
