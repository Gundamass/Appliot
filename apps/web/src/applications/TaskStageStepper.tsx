import { Check } from "lucide-react";
import type { ApplicationAutofillPhase, ApplicationExecutionProgress } from "@resume/contracts";

interface TaskStageStepperProps {
  progress: ApplicationExecutionProgress;
}

const STAGES: Array<{ key: ApplicationAutofillPhase; label: string }> = [
  { key: "waiting_for_form", label: "等待表单" },
  { key: "deterministic_fill", label: "确定性填写" },
  { key: "semantic_fill", label: "语义补全" },
  { key: "readback_validation", label: "回读校验" },
  { key: "final_review", label: "最终审核" }
];

export function TaskStageStepper({ progress }: TaskStageStepperProps) {
  const statuses = new Map(progress.phases.map((entry) => [entry.phase, entry.status]));
  return <section className="task-stage-stepper" aria-label="任务阶段">
    <ol>
      {STAGES.map((stage, index) => {
        const status = statuses.get(stage.key) ?? "pending";
        const current = stage.key === progress.currentPhase;
        return <li
        key={stage.key}
        className={status === "completed" ? "complete" : current ? "current" : status}
        aria-label={`${stage.label}阶段`}
        aria-current={current ? "step" : undefined}
      >
        <span>{status === "completed" ? <Check aria-hidden="true" size={13} /> : index + 1}</span>
        <strong>{stage.label}</strong>
      </li>})}
    </ol>
  </section>;
}
