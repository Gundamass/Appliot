import type {
  CanonicalIntent,
  EvidenceRef,
  IntentConstraint,
  IntentEntities,
  IntentPreference,
  PrimaryGoal,
  SubGoal
} from "@resume/contracts";

export interface UserMessage {
  text: string;
  messageId?: string;
  attachmentRefs?: string[];
}

export interface IntentCandidate {
  id: string;
  label: string;
}

export interface IntentContext {
  availableJobs: IntentCandidate[];
  availableResumes: IntentCandidate[];
  evidenceRefs?: EvidenceRef[];
  previousIntent?: CanonicalIntent;
  externalContent?: string[];
}

export interface IntentDraft {
  primaryGoal?: PrimaryGoal;
  subGoals: SubGoal[];
  entities: IntentEntities;
  constraints: IntentConstraint[];
  preferences: IntentPreference[];
  successCriteria: Array<{ id: string; description: string; required: boolean }>;
  confidence: number;
  autonomyLevel?: "suggest" | "prepare" | "execute_with_approval";
  evidenceRefs?: EvidenceRef[];
}
