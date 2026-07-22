import { EvidenceSchema, JsonValueSchema, type ProfileFact } from "@resume/contracts";
import { planField } from "./planner.js";
import { evidenceSupportsValue, validateFieldValue } from "./verifier.js";
import type { FieldAnswer, ProfileRepositoryPort } from "./types.js";

export function applyAnswer(answer: FieldAnswer, repository: ProfileRepositoryPort): ProfileFact {
  const plan = planField(answer);
  if (!plan.valid) throw new Error(plan.invalidReason ?? "invalid field answer");

  const value = JsonValueSchema.parse(answer.value);
  const evidence = EvidenceSchema.array().min(1).parse(answer.evidence);
  const validationFailure = validateFieldValue(answer, plan, value);
  if (validationFailure) throw new Error(validationFailure);
  if (evidence.some((item) => item.extraction !== "user")) throw new Error("field answers require user evidence");
  if (!evidenceSupportsValue(value, evidence)) throw new Error("field answer evidence does not support its value");

  const promotion = answer.promoteToProfile === true;
  if (!promotion) {
    if (answer.profileFactId) throw new Error("profileFactId requires explicit profile promotion");
    if (answer.scope === "profile") throw new Error("profile scope requires explicit profile promotion");
    return repository.putTaskAnswer(answer.taskId, plan.semantic, value, evidence);
  }

  if (answer.scope === "application") throw new Error("profile promotion cannot use application scope");
  if (!answer.profileFactId) throw new Error("profile promotion requires an existing profile fact target");
  const target = repository.listActive().find((fact) => fact.id === answer.profileFactId);
  if (!target) throw new Error(`profile fact target not found: ${answer.profileFactId}`);
  if (target.scope !== "profile" || target.status === "superseded" || target.fieldPath !== plan.semantic) {
    throw new Error("profile fact target is not suitable for this answer");
  }
  return repository.correct(target.id, value, evidence);
}
