import type { FormField } from "@resume/contracts";
import { z } from "zod";
import type { StructuredModelProvider } from "@resume/model-provider";
import {
  FIELD_DEFINITIONS,
  fieldDefinitionText,
  resolveDeterministicSemantic,
  type FieldDefinition,
  type FieldSection
} from "@resume/form-semantics";
import type { EmbeddingProvider } from "@resume/model-provider";

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
    field: Pick<FormField, "label" | "type" | "options" | "semanticHint">,
    context: FieldSemanticContext,
    phase: FieldResolutionPhase
  ): Promise<FieldSemanticDecision>;
}

export interface FieldSemanticResolverOptions {
  embeddingProvider?: EmbeddingProvider;
  structuredProvider?: StructuredModelProvider;
  definitions?: readonly FieldDefinition[];
  minimumSimilarity?: number;
  minimumMargin?: number;
}

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
  let documentVectors: Promise<number[][]> | undefined;

  const loadDocumentVectors = async (): Promise<number[][]> => {
    if (!options.embeddingProvider) throw new Error("embedding unavailable");
    documentVectors ??= options.embeddingProvider.embedDocuments(definitions.map(fieldDefinitionText));
    try {
      const vectors = await documentVectors;
      if (vectors.length !== definitions.length) throw new Error("embedding count mismatch");
      return vectors.map(validatedVector);
    } catch (error) {
      documentVectors = undefined;
      throw error;
    }
  };

  return {
    async resolve(field, context, phase) {
      const deterministic = resolveDeterministicSemantic({
        label: field.label,
        type: field.type,
        ...(field.semanticHint === undefined ? {} : { semanticHint: field.semanticHint }),
        ...(context.entryContext === undefined ? {} : { entryContext: context.entryContext })
      });
      if (deterministic) {
        return {
          status: "mapped",
          semantic: deterministic.semantic,
          source: deterministic.source,
          confidence: deterministic.confidence
        };
      }
      if (phase === "deterministic") {
        return { status: "unresolved", reason: "exact_match_not_found" };
      }
      if (!options.embeddingProvider) {
        return deepSeekResolve(field, context, definitions, options.structuredProvider);
      }

      let vectors: number[][];
      let query: number[];
      try {
        [vectors, query] = await Promise.all([
          loadDocumentVectors(),
          options.embeddingProvider.embedQuery(fieldQuery(field, context))
        ]);
        query = validatedVector(query);
      } catch {
        return deepSeekResolve(field, context, definitions, options.structuredProvider);
      }

      const candidates = definitions.flatMap((definition, index): FieldSemanticCandidate[] => {
        if (!definition.types.includes(field.type)) return [];
        if (context.section && !definition.sections.includes(context.section)) return [];
        if ((field.type === "select" || field.type === "radio") && field.options.length === 0) return [];
        const semantic = materialize(definition.semantic, context.entryContext);
        const vector = vectors[index];
        if (!semantic || !vector) return [];
        return [{
          semantic,
          label: definition.label,
          similarity: cosineSimilarity(query, vector),
          risk: definition.risk
        }];
      }).sort((left, right) => right.similarity - left.similarity || left.semantic.localeCompare(right.semantic));

      const top = candidates[0];
      if (!top) return deepSeekResolve(field, context, definitions, options.structuredProvider);
      const reviewCandidates = candidates.slice(0, 3);
      if (top.similarity < minimumSimilarity) {
        const deepseek = await deepSeekResolve(field, context, definitions, options.structuredProvider);
        return deepseek.status === "mapped"
          ? deepseek
          : { status: "review", candidates: reviewCandidates, reason: "similarity_below_threshold" };
      }
      const runnerUp = candidates[1];
      if (runnerUp && top.similarity - runnerUp.similarity < minimumMargin) {
        const deepseek = await deepSeekResolve(field, context, definitions, options.structuredProvider);
        return deepseek.status === "mapped"
          ? deepseek
          : { status: "review", candidates: reviewCandidates, reason: "ambiguous_candidates" };
      }
      if (top.risk !== "normal") {
        return { status: "review", candidates: reviewCandidates, reason: "risk_requires_review" };
      }
      return {
        status: "mapped",
        semantic: top.semantic,
        source: "embedding",
        confidence: top.similarity
      };
    }
  };
}

async function deepSeekResolve(
  field: Pick<FormField, "label" | "type" | "options" | "semanticHint">,
  context: FieldSemanticContext,
  definitions: readonly FieldDefinition[],
  provider: StructuredModelProvider | undefined
): Promise<FieldSemanticDecision> {
  if (!provider) return { status: "unresolved", reason: "embedding_unavailable" };
  const candidates = definitions
    .filter((definition) => definition.types.includes(field.type))
    .filter((definition) => context.section === undefined || definition.sections.includes(context.section))
    .map((definition) => ({ semantic: definition.semantic, label: definition.label, aliases: definition.aliases }))
    .slice(0, 200);
  try {
    const result = await provider.generateStructured({
      system: "你是招聘表单字段语义映射器。只能从候选字段中选择一个语义路径。无法确定时返回 confidence 0，不得编造路径。只返回 JSON。",
      user: JSON.stringify({
        field: { label: field.label, type: field.type, options: field.options, semanticHint: field.semanticHint },
        context,
        candidates
      }),
      schema: DEEPSEEK_SEMANTIC_SCHEMA,
      jsonExample: { semantic: "education[].school", confidence: 0.95 }
    });
    const semantic = materialize(result.semantic, context.entryContext);
    const definition = definitions.find((candidate) => candidate.semantic === result.semantic
      || materialize(candidate.semantic, context.entryContext) === semantic);
    if (!definition || semantic === undefined || result.confidence < 0.9) {
      return { status: "unresolved", reason: "incompatible_field" };
    }
    if (!definition.types.includes(field.type)
      || context.section !== undefined && !definition.sections.includes(context.section)) {
      return { status: "unresolved", reason: "incompatible_field" };
    }
    return { status: "mapped", semantic, source: "deepseek", confidence: result.confidence };
  } catch {
    return { status: "unresolved", reason: "embedding_unavailable" };
  }
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

function cosineSimilarity(left: number[], right: number[]): number {
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

function validateThreshold(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`);
}
