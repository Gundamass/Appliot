import { Check } from "lucide-react";
import type { ApplicationDisplayPhase } from "@resume/contracts";

interface TaskStageStepperProps {
  phase: ApplicationDisplayPhase;
  counts: { completed: number; attention: number };
}

const STAGES: Array<{ key: ApplicationDisplayPhase; label: string }> = [
  { key: "deterministic_fill", label: "确定性填写" },
  { key: "semantic_fill", label: "语义补全" },
  { key: "dynamic_validation", label: "动态校验" },
  { key: "review_handoff", label: "等待审核" }
];

export function TaskStageStepper({ phase, counts }: TaskStageStepperProps) {
  const activeIndex = STAGES.findIndex((stage) => stage.key === phase);
  return <section className="task-stage-stepper" aria-label="任务阶段">
    <div className="stage-summary"><span>任务进度</span><strong>{counts.completed} 项已完成</strong>{counts.attention > 0 && <em>{counts.attention} 项待处理</em>}</div>
    <ol>
      {STAGES.map((stage, index) => <li
        key={stage.key}
        className={index < activeIndex ? "complete" : index === activeIndex ? "current" : "pending"}
        aria-label={`${stage.label}阶段`}
        aria-current={index === activeIndex ? "step" : undefined}
      >
        <span>{index < activeIndex ? <Check aria-hidden="true" size={13} /> : index + 1}</span>
        <strong>{stage.label}</strong>
      </li>)}
    </ol>
  </section>;
}
