import { describe, expect, it, vi } from "vitest";
import type { FormField } from "@resume/contracts";
import type { FieldSemanticResolver } from "./field-semantic-resolver.js";
import { createProductionFieldResolver } from "./production-field-resolver.js";

const field: FormField = {
  id: "field-1",
  label: "未知字段",
  type: "text",
  required: true,
  options: [],
  currentValue: "",
  nodeRef: {
    documentId: "document-fixture-00000001",
    nodeId: "node-fixture-000000000001",
    observedAt: 1
  }
};

describe("生产字段解析器", () => {
  it("embedding 基础设施不可用时不调用资料 RAG", async () => {
    const semanticResolver: FieldSemanticResolver = {
      resolve: vi.fn(async () => ({
        status: "unresolved" as const,
        reason: "embedding_unavailable" as const
      }))
    };
    const resolveField = vi.fn();
    const resolver = createProductionFieldResolver({
      semanticResolver,
      ragService: { resolveField },
      profileRepository: { resolveForTask: vi.fn() }
    });

    await expect(resolver("task-1", field, "semantic")).resolves.toMatchObject({
      status: "needs_question",
      assessment: {
        status: "missing",
        source: "none",
        confidence: 0
      }
    });
    expect(resolveField).not.toHaveBeenCalled();
  });
});
