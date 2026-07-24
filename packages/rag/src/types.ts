import type { DecisionStatus, Evidence, JsonValue, ProfileFact } from "@resume/contracts";

export type FieldType = "text" | "textarea" | "select" | "boolean" | "date";
export type RetrievalSource = "exact" | "keyword" | "embedding";
export type RetrievalStrategy = "exact" | "keyword" | "embedding";
export type PlanningRisk = "none" | "sensitive_commitment" | "unknown_semantic";

export interface FieldRequest {
  taskId: string;
  fieldId: string;
  semantic: string;
  label: string;
  type: FieldType;
  options?: string[];
  validators?: string[];
  jobDescription?: string;
}

export interface FieldAnswer extends FieldRequest {
  value: JsonValue;
  evidence: Evidence[];
  scope?: "application" | "profile";
  promoteToProfile?: boolean;
  profileFactId?: string;
}

export interface RequiredRange {
  min?: string;
  max?: string;
}

export interface RetrievalPlan {
  semantic: string;
  requestType: FieldType;
  requiredSources: Array<"application" | "profile">;
  requiredRange?: RequiredRange | undefined;
  needsJobDescription: boolean;
  autoFillEligible: boolean;
  risk: PlanningRisk;
  validators: string[];
  strategy: RetrievalStrategy[];
  valid: boolean;
  invalidReason?: string;
}

export interface FieldDecision {
  fieldId: string;
  status: DecisionStatus;
  value?: JsonValue | undefined;
  evidence: Evidence[];
  confidence: number;
  question?: string;
  validators: string[];
}

export interface ProfileRepositoryPort {
  resolveForTask(taskId: string, fieldPath: string): ProfileFact | undefined;
  listActive(): ProfileFact[];
  putTaskAnswer(taskId: string, fieldPath: string, value: JsonValue, evidence: Evidence[]): ProfileFact;
  correct(factId: string, value: JsonValue, evidence: Evidence[]): ProfileFact;
}

export interface KeywordSearchInput {
  query: string;
  semantic: string;
  taskId: string;
  limit: number;
  jobDescription?: string;
}

export interface KeywordSearchPort {
  search(input: KeywordSearchInput): Promise<ProfileFact[]>;
}

export interface EmbeddingSearchResult {
  fact: ProfileFact;
  score: number;
}

export interface EmbeddingSearchPort {
  search(input: {
    query: string;
    taskId: string;
    limit: number;
    jobDescription?: string;
  }): Promise<EmbeddingSearchResult[]>;
}

export interface RagDependencies {
  repository: ProfileRepositoryPort;
  search?: KeywordSearchPort;
  embeddingSearch?: EmbeddingSearchPort;
}

export interface RetrievedCandidate {
  fact: ProfileFact;
  source: RetrievalSource;
  score: number;
}

export interface RetrievalResult {
  candidates: RetrievedCandidate[];
  invalidReason?: string;
}

export interface RagService {
  resolveField(request: FieldRequest): Promise<FieldDecision>;
  applyAnswer(answer: FieldAnswer): ProfileFact;
}
