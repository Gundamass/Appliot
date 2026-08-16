import type { FormField } from "@resume/contracts";
import { z } from "zod";
import type { StructuredModelProvider } from "@resume/model-provider";
import {
  FIELD_DEFINITIONS,
  resolveDeterministicSemantic,
  type FieldDefinition,
  type FieldSection
} from "@resume/form-semantics";
import type { EmbeddingProvider } from "@resume/model-provider";
import type {
  EmbeddingIdentity,
  FieldOntologyIndex
} from "./field-ontology-index.js";
import type { EmbeddingTraceSink } from "../observability/embedding-trace.js";

export type FieldResolutionPhase = "deterministic" | "semantic";

export interface FieldSemanticContext {
  section?: FieldSection;
  entryContext?: string;
}
export interface FieldSemanticCandidate {
  semantic: string;
  label: string;
  similarity: number;
  risk: FieldDefinition["risk"];
}

export type FieldSemanticDecision =
  | {
      status: "mapped";
      semantic: string;
      source: "exact_alias" | "embedding" | "deepseek";
      confidence: number;
    }
  | {
      status: "review";
      candidates: FieldSemanticCandidate[];
      reason: "similarity_below_threshold" | "ambiguous_candidates" | "risk_requires_review";
    }
  | {
      status: "unresolved";
      reason: "exact_match_not_found" | "embedding_unavailable" | "incompatible_field";
    };

export interface FieldSemanticResolver {
  resolve(
    field: Pick<FormField, "label" | "type" | "options" | "controlKind" | "interactionMode" | "semanticHint">,
    context: FieldSemanticContext,
    phase: FieldResolutionPhase
  ): Promise<FieldSemanticDecision>;
}

export interface FieldSemanticResolverOptions {
  embeddingProvider?: EmbeddingProvider;
  ontologyIndex?: FieldOntologyIndex;
  embeddingIdentity?: EmbeddingIdentity;
  structuredProvider?: StructuredModelProvider;
  definitions?: readonly FieldDefinition[];
  minimumSimilarity?: number;
  minimumMargin?: number;
  traceSink?: EmbeddingTraceSink;
}

type ResolvableField = Pick<
  FormField,
  "label" | "type" | "options" | "controlKind" | "interactionMode" | "semanticHint"
>;
type ReviewReason = Extract<FieldSemanticDecision, { status: "review" }>["reason"];
type EmbeddingRetrieval =
  | { status: "infrastructure_failure" }
  | { status: "healthy_no_candidate" }
  | {
      status: "healthy_ambiguous";
      candidates: FieldSemanticCandidate[];
      reason: Exclude<ReviewReason, "risk_requires_review">;
    }
  | {
      status: "healthy_resolved";
      candidate: FieldSemanticCandidate;
      candidates: FieldSemanticCandidate[];
    };

const DEFAULT_MINIMUM_SIMILARITY = 0.9;
const DEFAULT_MINIMUM_MARGIN = 0.08;
const DEEPSEEK_SEMANTIC_SCHEMA = z.object({
  semantic: z.string().min(1),
  confidence: z.number().min(0).max(1)
}).strict();

export function createFieldSemanticResolver(options: FieldSemanticResolverOptions = {}): FieldSemanticResolver {
  const definitions = options.definitions ?? FIELD_DEFINITIONS;
  const minimumSimilarity = options.minimumSimilarity ?? DEFAULT_MINIMUM_SIMILARITY;
  const minimumMargin = options.minimumMargin ?? DEFAULT_MINIMUM_MARGIN;
  validateThreshold(minimumSimilarity, "minimumSimilarity");
  validateThreshold(minimumMargin, "minimumMargin");
  if (options.embeddingProvider !== undefined && options.ontologyIndex === undefined) {
    throw new Error("field_ontology_index_required");
  }
  if (options.embeddingProvider !== undefined && options.embeddingIdentity === undefined) {
    throw new Error("embedding_identity_required");
  }

  return {
    async resolve(field, context, phase) {
      const derived = derivedSemantic(field, context);
      if (derived !== undefined) {
        return { status: "mapped", semantic: derived, source: "exact_alias", confidence: 1 };
      }
      const deterministic = resolveDeterministicSemantic({
        label: field.label,
        type: field.type,
        ...(field.semanticHint === undefined ? {} : { semanticHint: field.semanticHint }),
        ...(context.entryContext === undefined ? {} : { entryContext: context.entryContext })
      });
      const deterministicDefinition = deterministic === undefined
        ? exactDefinition(definitions, field.label)
        : definitionForSemantic(definitions, deterministic.semantic, context.entryContext);
      const exactSemantic = deterministic === undefined
        ? materialize(deterministicDefinition?.semantic ?? "", context.entryContext)
        : deterministic.semantic;
      if (deterministicDefinition !== undefined
        && exactSemantic !== undefined
        && eligibleDefinition(deterministicDefinition, field, context)) {
        return {
          status: "mapped",
          semantic: exactSemantic,
          source: "exact_alias",
          confidence: 1
        };
      }
      if (phase === "deterministic") {
        return { status: "unresolved", reason: "exact_match_not_found" };
      }
      if (context.section === undefined) {
        return { status: "unresolved", reason: "exact_match_not_found" };
      }
      const retrieval = await classifyEmbeddingRetrieval({
        field,
        context,
        definitions,
        embeddingProvider: options.embeddingProvider,
        ontologyIndex: options.ontologyIndex,
        embeddingIdentity: options.embeddingIdentity,
        minimumSimilarity,
        minimumMargin
      });
      switch (retrieval.status) {
        case "infrastructure_failure":
          recordSemanticResolution(options.traceSink, false, "failed");
          return { status: "unresolved", reason: "embedding_unavailable" };
        case "healthy_no_candidate":
          recordSemanticResolution(options.traceSink, false, "unresolved");
          return { status: "unresolved", reason: "incompatible_field" };
        case "healthy_ambiguous": {
          const deepSeekUsed = options.structuredProvider !== undefined;
          const match = await deepSeekResolve(
            field,
            context,
            retrieval.candidates,
            options.structuredProvider
          );
          if (match === undefined) {
            recordSemanticResolution(options.traceSink, deepSeekUsed, "unresolved");
            return { status: "review", candidates: retrieval.candidates, reason: retrieval.reason };
          }
          if (match.candidate.risk !== "normal") {
            recordSemanticResolution(options.traceSink, deepSeekUsed, "unresolved");
            return { status: "review", candidates: retrieval.candidates, reason: "risk_requires_review" };
          }
          recordSemanticResolution(options.traceSink, deepSeekUsed, "succeeded");
          return {
            status: "mapped",
            semantic: match.candidate.semantic,
            source: "deepseek",
            confidence: match.confidence
          };
        }
        case "healthy_resolved":
          if (retrieval.candidate.risk !== "normal") {
            recordSemanticResolution(options.traceSink, false, "unresolved");
            return { status: "review", candidates: retrieval.candidates, reason: "risk_requires_review" };
          }
          recordSemanticResolution(options.traceSink, false, "succeeded");
          return {
            status: "mapped",
            semantic: retrieval.candidate.semantic,
            source: "embedding",
            confidence: retrieval.candidate.similarity
          };
      }
    }
  };
}

function recordSemanticResolution(
  traceSink: EmbeddingTraceSink | undefined,
  deepSeekUsed: boolean,
  result: "succeeded" | "failed" | "unresolved"
): void {
  try {
    traceSink?.record({ operation: "semantic_resolution", deepSeekUsed, result });
  } catch {
    // Diagnostics must not alter resolution behavior.
  }
}

async function classifyEmbeddingRetrieval(input: {
  field: ResolvableField;
  context: FieldSemanticContext;
  definitions: readonly FieldDefinition[];
  embeddingProvider: EmbeddingProvider | undefined;
  ontologyIndex: FieldOntologyIndex | undefined;
  embeddingIdentity: EmbeddingIdentity | undefined;
  minimumSimilarity: number;
  minimumMargin: number;
}): Promise<EmbeddingRetrieval> {
  if (input.embeddingProvider === undefined
    || input.ontologyIndex === undefined
    || input.embeddingIdentity === undefined) {
    return { status: "infrastructure_failure" };
  }

  let vectors: readonly (readonly number[])[];
  let query: number[];
  try {
    vectors = await input.ontologyIndex.load(input.definitions, input.embeddingIdentity);
    query = validatedVector(await input.embeddingProvider.embedQuery(fieldQuery(input.field, input.context)));
    validateMatchingDimensions(vectors, query);
  } catch {
    return { status: "infrastructure_failure" };
  }

  const candidates = input.definitions.flatMap((definition, index): FieldSemanticCandidate[] => {
    if (!eligibleDefinition(definition, input.field, input.context)) return [];
    if ((input.field.type === "select" || input.field.type === "radio")
      && input.field.options.length === 0
      && !isCustomSearchSelect(input.field)) return [];
    const semantic = materialize(definition.semantic, input.context.entryContext);
    const vector = vectors[index];
    if (semantic === undefined || vector === undefined) return [];
    return [{
      semantic,
      label: definition.label,
      similarity: cosineSimilarity(query, vector),
      risk: definition.risk
    }];
  }).sort((left, right) => right.similarity - left.similarity || left.semantic.localeCompare(right.semantic));

  const top = candidates[0];
  if (top === undefined) return { status: "healthy_no_candidate" };
  const reviewCandidates = candidates.slice(0, 3);
  if (top.similarity < input.minimumSimilarity) {
    return {
      status: "healthy_ambiguous",
      candidates: reviewCandidates,
      reason: "similarity_below_threshold"
    };
  }
  const runnerUp = candidates[1];
  if (runnerUp !== undefined && top.similarity - runnerUp.similarity < input.minimumMargin) {
    return {
      status: "healthy_ambiguous",
      candidates: reviewCandidates,
      reason: "ambiguous_candidates"
    };
  }
  return { status: "healthy_resolved", candidate: top, candidates: reviewCandidates };
}

async function deepSeekResolve(
  field: ResolvableField,
  context: FieldSemanticContext,
  candidates: FieldSemanticCandidate[],
  provider: StructuredModelProvider | undefined
): Promise<{ candidate: FieldSemanticCandidate; confidence: number } | undefined> {
  if (provider === undefined || candidates.length === 0 || candidates.length > 3) return undefined;
  try {
    const result = await provider.generateStructured({
      system: "你是招聘表单字段语义映射器。只能从候选字段中选择一个语义路径。无法确定时返回 confidence 0，不得编造路径。只返回 JSON。",
      user: JSON.stringify({
        field: { label: field.label, type: field.type },
        context,
        candidates
      }),
      schema: DEEPSEEK_SEMANTIC_SCHEMA,
      jsonExample: { semantic: candidates[0]!.semantic, confidence: 0.95 }
    });
    const candidate = candidates.find((entry) => entry.semantic === result.semantic);
    if (candidate === undefined || result.confidence < 0.9) return undefined;
    return { candidate, confidence: result.confidence };
  } catch {
    return undefined;
  }
}

function isCustomSearchSelect(
  field: Pick<FormField, "type" | "controlKind" | "interactionMode">
): boolean {
  return field.type === "select"
    && field.controlKind === "custom"
    && field.interactionMode === "search";
}

function supportsFieldType(
  definition: FieldDefinition,
  field: Pick<FormField, "type" | "options" | "controlKind" | "interactionMode">
): boolean {
  return definition.types.includes(field.type)
    || (field.options.length === 0
      && isCustomSearchSelect(field)
      && definition.types.includes("text"));
}

function eligibleDefinition(
  definition: FieldDefinition,
  field: Pick<FormField, "type" | "options" | "controlKind" | "interactionMode">,
  context: FieldSemanticContext
): boolean {
  if (!supportsFieldType(definition, field)) return false;
  if (context.section !== undefined && !definition.sections.includes(context.section)) return false;
  if (definition.semantic.includes("[]")) {
    return materialize(definition.semantic, context.entryContext) !== undefined;
  }
  return context.entryContext === undefined;
}

function definitionForSemantic(
  definitions: readonly FieldDefinition[],
  semantic: string,
  entryContext: string | undefined
): FieldDefinition | undefined {
  return definitions.find((definition) => materialize(definition.semantic, entryContext) === semantic);
}

function exactDefinition(
  definitions: readonly FieldDefinition[],
  label: string
): FieldDefinition | undefined {
  const normalized = normalizeExactLabel(label);
  return definitions.find((definition) =>
    [definition.label, ...definition.aliases].some((candidate) => normalizeExactLabel(candidate) === normalized));
}

function normalizeExactLabel(value: string): string {
  return value.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "").toLocaleLowerCase();
}

function derivedSemantic(
  field: Pick<FormField, "label" | "type" | "semanticHint">,
  context: FieldSemanticContext
): string | undefined {
  if (field.type !== "select" && field.type !== "radio" && field.type !== "checkbox") return undefined;
  if (!/^(?:education\[\d+\]\.hasLaboratory)$/u.test(field.semanticHint ?? "")) return undefined;
  return context.entryContext === undefined ? undefined : `${context.entryContext}.hasLaboratory`;
}

function fieldQuery(
  field: Pick<FormField, "label" | "type" | "options">,
  context: FieldSemanticContext
): string {
  return [
    `招聘字段：${field.label}`,
    `控件类型：${field.type}`,
    context.section ? `所在栏目：${context.section}` : "",
    field.options.length > 0 ? `可选项：${field.options.join("、")}` : ""
  ].filter(Boolean).join("\n");
}

function materialize(template: string, entryContext: string | undefined): string | undefined {
  if (!template.includes("[]")) return template;
  const root = template.slice(0, template.indexOf("[]"));
  if (!entryContext || !new RegExp(`^${root}\\[\\d+\\]$`, "u").test(entryContext)) return undefined;
  return template.replace(`${root}[]`, entryContext);
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return -1;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function validatedVector(vector: number[]): number[] {
  if (!Array.isArray(vector) || vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("invalid embedding vector");
  }
  return vector;
}

function validateMatchingDimensions(
  vectors: readonly (readonly number[])[],
  query: readonly number[]
): void {
  if (vectors.length === 0 || vectors.some((vector) => vector.length !== query.length)) {
    throw new Error("embedding dimension mismatch");
  }
}

function validateThreshold(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`);
}
