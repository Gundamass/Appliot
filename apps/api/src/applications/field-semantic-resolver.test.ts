import { describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "@resume/model-provider";
import type { FieldDefinition } from "@resume/form-semantics";
import { createFieldSemanticResolver } from "./field-semantic-resolver.js";

const definitions: FieldDefinition[] = [
  {
    semantic: "education[].enrollmentType",
    label: "培养类别",
    aliases: ["招生方式"],
    types: ["select", "text"],
    sections: ["education"],
    risk: "normal",
    description: "统招、定向、委培等培养方式"
  },
  {
    semantic: "education[].degreeType",
    label: "学历类型",
    aliases: ["教育类型"],
    types: ["select", "text"],
    sections: ["education"],
    risk: "normal",
    description: "全日制或非全日制学历类型"
  },
  {
    semantic: "preferences.willingToTravel",
    label: "是否接受出差",
    aliases: ["出差意愿"],
    types: ["select", "radio"],
    sections: ["preferences"],
    risk: "commitment",
    description: "候选人是否接受工作出差"
  }
];

class StubEmbeddingProvider implements EmbeddingProvider {
  documentCalls = 0;
  queryCalls = 0;

  constructor(
    private readonly documents: number[][],
    private readonly query: number[],
    private readonly failure?: Error
  ) {}

  async embedDocuments(): Promise<number[][]> {
    this.documentCalls += 1;
    if (this.failure) throw this.failure;
    return structuredClone(this.documents);
  }

  async embedQuery(): Promise<number[]> {
    this.queryCalls += 1;
    if (this.failure) throw this.failure;
    return [...this.query];
  }
}

describe("字段语义解析器", () => {
  it("精确别名命中时不调用向量服务", async () => {
    const embedding = new StubEmbeddingProvider([], [], new Error("不应调用"));
    const resolver = createFieldSemanticResolver({ embeddingProvider: embedding });

    await expect(resolver.resolve({
      label: "个人联系电话",
      type: "text",
      options: []
    }, {}, "deterministic")).resolves.toMatchObject({
      status: "mapped",
      semantic: "basics.phone",
      source: "exact_alias"
    });
    expect(embedding.documentCalls).toBe(0);
    expect(embedding.queryCalls).toBe(0);
  });

  it("语义阶段在相似度、候选差距和上下文均满足时映射字段", async () => {
    const embedding = new StubEmbeddingProvider(
      [[1, 0], [0, 1], [-1, 0]],
      [0.98, 0.2]
    );
    const resolver = createFieldSemanticResolver({
      embeddingProvider: embedding,
      definitions,
      minimumSimilarity: 0.8,
      minimumMargin: 0.1
    });

    await expect(resolver.resolve({
      label: "培养方式",
      type: "select",
      options: ["统招", "定向", "委培"]
    }, {
      section: "education",
      entryContext: "education[0]"
    }, "semantic")).resolves.toMatchObject({
      status: "mapped",
      semantic: "education[0].enrollmentType",
      source: "embedding"
    });
    expect(embedding.documentCalls).toBe(1);
    expect(embedding.queryCalls).toBe(1);
  });

  it("候选差距不足时返回待审核而不是强行映射", async () => {
    const embedding = new StubEmbeddingProvider(
      [[1, 0], [0, 1], [-1, 0]],
      [0.71, 0.7]
    );
    const resolver = createFieldSemanticResolver({
      embeddingProvider: embedding,
      definitions,
      minimumSimilarity: 0.6,
      minimumMargin: 0.1
    });

    const decision = await resolver.resolve({
      label: "教育形式",
      type: "select",
      options: ["统招", "全日制"]
    }, {
      section: "education",
      entryContext: "education[0]"
    }, "semantic");

    expect(decision.status).toBe("review");
    if (decision.status === "review") expect(decision.candidates).toHaveLength(2);
  });

  it("默认安全阈值在 0.89 时待审核，在 0.90 时允许映射", async () => {
    const resolveAt = async (similarity: number) => {
      const resolver = createFieldSemanticResolver({
        embeddingProvider: new StubEmbeddingProvider(
          [[1, 0]],
          [similarity, Math.sqrt(1 - similarity ** 2)]
        ),
        definitions: [definitions[0]!]
      });
      return resolver.resolve({
        label: "培养方式",
        type: "select",
        options: ["统招"]
      }, {
        section: "education",
        entryContext: "education[0]"
      }, "semantic");
    };

    await expect(resolveAt(0.89)).resolves.toMatchObject({
      status: "review",
      reason: "similarity_below_threshold"
    });
    await expect(resolveAt(0.9)).resolves.toMatchObject({
      status: "mapped",
      confidence: 0.9
    });
  });

  it("承诺类字段即使相似度足够也不得自动映射", async () => {
    const embedding = new StubEmbeddingProvider(
      [[1, 0], [0, 1], [0.99, 0.01]],
      [1, 0]
    );
    const resolver = createFieldSemanticResolver({
      embeddingProvider: embedding,
      definitions,
      minimumSimilarity: 0.8,
      minimumMargin: 0.1
    });

    await expect(resolver.resolve({
      label: "可否长期出差",
      type: "select",
      options: ["是", "否"]
    }, { section: "preferences" }, "semantic")).resolves.toMatchObject({
      status: "review",
      reason: "risk_requires_review"
    });
  });

  it("向量服务不可用时返回未解析而不是抛出异常", async () => {
    const resolver = createFieldSemanticResolver({
      embeddingProvider: new StubEmbeddingProvider([], [], new Error("offline")),
      definitions
    });

    await expect(resolver.resolve({
      label: "培养方式",
      type: "select",
      options: ["统招"]
    }, {
      section: "education",
      entryContext: "education[0]"
    }, "semantic")).resolves.toEqual({
      status: "unresolved",
      reason: "embedding_unavailable"
    });
  });
});
