import type { AdapterId, AdapterState, AdapterStatus } from "@resume/contracts";
import { CircleAlert, CircleCheck, CircleDashed, CircleOff, LoaderCircle } from "lucide-react";

const SERVICE_LABELS: Record<AdapterId, string> = {
  deepseek: "DeepSeek",
  embedding: "语义检索",
  ocr: "OCR"
};

const STATE_LABELS: Record<AdapterState, string> = {
  unconfigured: "未配置",
  configured: "已配置",
  checking: "检查中",
  ready: "可用",
  unavailable: "离线",
  invalid: "配置不匹配"
};

const STATE_ICONS = {
  unconfigured: CircleOff,
  configured: CircleDashed,
  checking: LoaderCircle,
  ready: CircleCheck,
  unavailable: CircleAlert,
  invalid: CircleAlert
} satisfies Record<AdapterState, typeof CircleAlert>;

export function ServiceStatus({ statuses, ids }: { statuses: AdapterStatus[]; ids?: AdapterId[] }) {
  const visible = ids === undefined ? statuses : ids.flatMap((id) => {
    const match = statuses.find((status) => status.id === id);
    return match ? [match] : [];
  });
  if (visible.length === 0) return null;

  return (
    <div className="service-status" role="status" aria-label="服务状态">
      {visible.map((status) => {
        const Icon = STATE_ICONS[status.state];
        const stateLabel = status.code === "not_ready" ? "未就绪" : STATE_LABELS[status.state];
        return (
          <span className={`service-state ${status.state}`} key={status.id}>
            <Icon aria-hidden="true" size={14} />
            <span>{SERVICE_LABELS[status.id]} {stateLabel}</span>
          </span>
        );
      })}
    </div>
  );
}
