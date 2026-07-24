import { applyAnswer as applyAnswerToRepository } from "./corrections.js";
import { planField } from "./planner.js";
import { retrieveCandidates } from "./retriever.js";
import { verifyField } from "./verifier.js";
import type { FieldAnswer, FieldRequest, RagDependencies, RagService } from "./types.js";

export function createRagService(dependencies: RagDependencies): RagService {
  return {
    async resolveField(request) {
      return resolveField(request, dependencies);
    },
    applyAnswer(answer) {
      return applyAnswerToRepository(answer, dependencies.repository);
    }
  };
}

export async function resolveField(request: FieldRequest, dependencies: RagDependencies) {
  const plan = planField(request);
  const retrieval = await retrieveCandidates(request, plan, dependencies);
  return verifyField(request, plan, retrieval);
}

export { applyAnswerToRepository as applyAnswer };
export { planField } from "./planner.js";
export { retrieveCandidates } from "./retriever.js";
export { verifyField, evidenceSupportsValue, validateFieldValue } from "./verifier.js";
export { buildQuestion, type QuestionReason } from "./questions.js";
export { buildSelfEvaluationDraft, tailorSelfEvaluation, validateEditedSelfEvaluation, type TailorSelfEvaluationInput } from "./self-evaluation.js";
export type {
  FieldAnswer,
  FieldDecision,
  FieldRequest,
  FieldType,
  EmbeddingSearchPort,
  EmbeddingSearchResult,
  KeywordSearchInput,
  KeywordSearchPort,
  PlanningRisk,
  ProfileRepositoryPort,
  RagDependencies,
  RagService,
  RequiredRange,
  RetrievalPlan,
  RetrievalResult,
  RetrievalSource,
  RetrievalStrategy,
  RetrievedCandidate
} from "./types.js";
export { EmbeddingSearchUnavailableError } from "./types.js";
