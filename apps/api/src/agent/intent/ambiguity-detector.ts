import type {
  IntentAmbiguity,
  IntentEntities,
  MissingInformation,
  PrimaryGoal,
  SubGoal
} from "@resume/contracts";
import type { IntentContext, IntentDraft } from "./intent-context.js";

export interface AmbiguityDetectionResult {
  ambiguities: IntentAmbiguity[];
  missing: MissingInformation[];
}

export interface AmbiguityDetector {
  detect(draft: IntentDraft, context: IntentContext): AmbiguityDetectionResult;
}

export function createAmbiguityDetector(): AmbiguityDetector {
  return {
    detect(draft, context) {
      const ambiguities: IntentAmbiguity[] = [];
      const missing: MissingInformation[] = [];
      const applicationTask = isApplicationTask(draft.primaryGoal, draft.subGoals);
      const hasTargetJob = hasEntity(draft.entities, "targetJob") || hasEntity(draft.entities, "applicationUrl");
      if (applicationTask && !hasTargetJob && context.availableJobs.length !== 1) {
        missing.push({ field: "targetJob", reason: "需要明确要申请的目标岗位", blocking: true, priority: 90 });
        if (context.availableJobs.length > 1) {
          ambiguities.push({
            id: "target-job-ambiguous",
            field: "targetJob",
            reason: "存在多个候选岗位",
            severity: "high",
            candidateValues: context.availableJobs.map((job) => job.id)
          });
        }
      }

      if (applicationTask && !hasEntity(draft.entities, "resumeRef") && context.availableResumes.length > 1) {
        missing.push({ field: "resumeRef", reason: "需要选择用于申请的简历", blocking: true, priority: 60 });
        ambiguities.push({
          id: "resume-ambiguous",
          field: "resumeRef",
          reason: "存在多份可用简历",
          severity: "medium",
          candidateValues: context.availableResumes.map((resume) => resume.id)
        });
      }

      return { ambiguities, missing };
    }
  };
}

function isApplicationTask(primaryGoal: PrimaryGoal | undefined, subGoals: SubGoal[]): boolean {
  return primaryGoal === "prepare_application"
    || primaryGoal === "fill_application"
    || primaryGoal === "submit_application"
    || subGoals.some((goal) => ["prepare_application", "fill_application", "submit_application"].includes(goal));
}

function hasEntity(entities: IntentEntities, key: string): boolean {
  return entities[key] !== undefined;
}
