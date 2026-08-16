import { describe, expect, it } from "vitest";
import type { EmbeddingProvider, StructuredModelProvider } from "@resume/model-provider";
import { FIELD_DEFINITIONS, type FieldDefinition } from "@resume/form-semantics";
import {
  createFieldSemanticResolver as createResolver,
  type FieldSemanticResolverOptions
} from "./field-semantic-resolver.js";
import {
  FieldOntologyIndex,
  type EmbeddingIdentity
} from "./field-ontology-index.js";

const embeddingIdentity: EmbeddingIdentity = {
  model: "test-embedding",
  modelRevision: "test-revision",
  instructionVersion: "test-instruction-v1"
};

function createFieldSemanticResolver(options: FieldSemanticResolverOptions = {}) {
  if (options.embeddingProvider === undefined) return createResolver(options);
  return createResolver({
    ...options,
    ontologyIndex: new FieldOntologyIndex(options.embeddingProvider),
    embeddingIdentity
  });
}

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

class StubStructuredProvider implements StructuredModelProvider {
  calls = 0;
  readonly inputs: Array<{ system: string; user: string; jsonExample: unknown }> = [];

  constructor(
    private readonly response: unknown = { semantic: "awards[].name", confidence: 0.96 },
    private readonly failure?: Error
  ) {}

  async generateStructured<T>(input: {
    system: string;
    user: string;
    jsonExample: unknown;
  }): Promise<T> {
    this.calls += 1;
    this.inputs.push({ system: input.system, user: input.user, jsonExample: input.jsonExample });
    if (this.failure !== undefined) throw this.failure;
    return structuredClone(this.response) as T;
  }
}

describe("字段语义解析器", () => {
  it("配置向量服务时要求显式提供 ontology index 和 embedding identity", () => {
    const embedding = new StubEmbeddingProvider([[1, 0]], [1, 0]);

    expect(() => createResolver({ embeddingProvider: embedding })).toThrow("field_ontology_index_required");
    expect(() => createResolver({
      embeddingProvider: embedding,
      ontologyIndex: new FieldOntologyIndex(embedding)
    })).toThrow("embedding_identity_required");
  });

  it("没有栏目上下文时不调用向量或 DeepSeek 进行全局语义猜测", async () => {
    const embedding = new StubEmbeddingProvider([[1, 0]], [1, 0]);
    const structured = new StubStructuredProvider();
    const resolver = createFieldSemanticResolver({
      embeddingProvider: embedding,
      structuredProvider: structured,
      definitions: [{
        semantic: "basics.wechat",
        label: "微信号",
        aliases: ["微信"],
        types: ["text"],
        sections: ["basics"],
        risk: "sensitive",
        description: "候选人的微信联系方式"
      }]
    });

    await expect(resolver.resolve({
      label: "其他信息",
      type: "text",
      options: []
    }, {}, "semantic")).resolves.toEqual({
      status: "unresolved",
      reason: "exact_match_not_found"
    });
    expect(embedding.documentCalls).toBe(0);
    expect(embedding.queryCalls).toBe(0);
    expect(structured.calls).toBe(0);
  });

  it("只在语言能力栏目内映射具体语言条目的掌握程度", async () => {
    const languageDefinitions: FieldDefinition[] = [
      {
        semantic: "basics.wechat",
        label: "微信号",
        aliases: ["微信"],
        types: ["text"],
        sections: ["basics"],
        risk: "sensitive",
        description: "候选人的微信联系方式"
      },
      {
        semantic: "languages[].proficiency",
        label: "掌握程度",
        aliases: ["语言水平"],
        types: ["text", "select"],
        sections: ["languages"],
        risk: "normal",
        description: "候选人的语言掌握程度"
      }
    ];
    const resolver = createFieldSemanticResolver({
      embeddingProvider: new StubEmbeddingProvider([[1, 0], [0.95, 0.05]], [1, 0]),
      definitions: languageDefinitions,
      minimumSimilarity: 0.9,
      minimumMargin: 0.08
    });

    await expect(resolver.resolve({
      label: "语言水平",
      type: "text",
      options: [],
      semanticHint: "languages[0]"
    }, {
      section: "languages",
      entryContext: "languages[0]"
    }, "semantic")).resolves.toMatchObject({
      status: "mapped",
      semantic: "languages[0].proficiency"
    });
  });

  it("语言栏目不能借用基础信息中的微信号", async () => {
    const resolver = createFieldSemanticResolver({
      embeddingProvider: new StubEmbeddingProvider([[1, 0]], [1, 0]),
      definitions: [{
        semantic: "basics.wechat",
        label: "微信号",
        aliases: ["微信"],
        types: ["text"],
        sections: ["basics"],
        risk: "sensitive",
        description: "候选人的微信联系方式"
      }]
    });

    await expect(resolver.resolve({
      label: "语言水平",
      type: "text",
      options: [],
      semanticHint: "languages[0]"
    }, {
      section: "languages",
      entryContext: "languages[0]"
    }, "semantic")).resolves.toMatchObject({ status: "unresolved" });
  });

  it("获奖栏目中的赛事名称不能映射到项目名称", async () => {
    const resolver = createFieldSemanticResolver({
      embeddingProvider: new StubEmbeddingProvider([[1, 0]], [1, 0]),
      definitions: [{
        semantic: "projects[].name",
        label: "项目名称",
        aliases: ["项目名"],
        types: ["text"],
        sections: ["projects"],
        risk: "normal",
        description: "项目名称"
      }]
    });

    await expect(resolver.resolve({
      label: "赛事名称",
      type: "text",
      options: [],
      semanticHint: "awards[0]"
    }, {
      section: "awards",
      entryContext: "awards[0]"
    }, "semantic")).resolves.toMatchObject({ status: "unresolved" });
  });

  it("文本控件不能映射到仅支持文件上传的字段", async () => {
    const resolver = createFieldSemanticResolver({
      embeddingProvider: new StubEmbeddingProvider([[1, 0]], [1, 0]),
      definitions: [{
        semantic: "basics.resumeFile",
        label: "简历附件",
        aliases: ["上传简历"],
        types: ["file"],
        sections: ["basics"],
        risk: "normal",
        description: "候选人的简历文件"
      }]
    });

    await expect(resolver.resolve({
      label: "简历附件",
      type: "text",
      options: []
    }, { section: "basics" }, "semantic")).resolves.toMatchObject({ status: "unresolved" });
  });
  it("配置 structured provider 但缺少 embedding 基础设施时不调用 DeepSeek", async () => {
    const provider = new StubStructuredProvider();
    const resolver = createFieldSemanticResolver({
      definitions: [{
        semantic: "awards[].name",
        label: "获奖名称",
        aliases: ["奖项名称"],
        types: ["text"],
        sections: ["awards"],
        risk: "normal",
        description: "获奖名称"
      }],
      structuredProvider: provider
    });

    await expect(resolver.resolve({
      label: "赛事项目",
      type: "text",
      options: [],
      semanticHint: "awards[0]"
    }, { section: "awards", entryContext: "awards[0]" }, "semantic")).resolves.toEqual({
      status: "unresolved",
      reason: "embedding_unavailable"
    });
    expect(provider.calls).toBe(0);
  });
  it("将赛事名称在语义阶段映射到当前获奖经历名称", async () => {
    const awardDefinitions: FieldDefinition[] = [
      {
        semantic: "awards[].name",
        label: "获奖名称",
        aliases: ["奖项名称"],
        types: ["text"],
        sections: ["awards"],
        risk: "normal",
        description: "奖项或荣誉名称"
      },
      {
        semantic: "awards[].description",
        label: "获奖描述",
        aliases: ["奖项描述"],
        types: ["text", "textarea"],
        sections: ["awards"],
        risk: "normal",
        description: "奖项的原文说明"
      }
    ];
    const embedding = new StubEmbeddingProvider([[1, 0], [0, 1]], [1, 0]);
    const resolver = createFieldSemanticResolver({
      embeddingProvider: embedding,
      definitions: awardDefinitions,
      minimumSimilarity: 0.8,
      minimumMargin: 0.1
    });
    const field = {
      label: "赛事名称",
      type: "text" as const,
      options: [],
      semanticHint: "awards[0]"
    };
    const context = { section: "awards" as const, entryContext: "awards[0]" };

    await expect(resolver.resolve(field, context, "deterministic")).resolves.toEqual({
      status: "unresolved",
      reason: "exact_match_not_found"
    });
    await expect(resolver.resolve(field, context, "semantic")).resolves.toMatchObject({
      status: "mapped",
      semantic: "awards[0].name",
      source: "embedding"
    });
  });

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

  it("maps a production text definition from an empty-option custom search select", async () => {
    const embedding = new StubEmbeddingProvider(
      FIELD_DEFINITIONS.map((definition) => definition.semantic === "awards[].name" ? [1, 0] : [0, 1]),
      [1, 0]
    );
    const resolver = createFieldSemanticResolver({
      embeddingProvider: embedding
    });

    await expect(resolver.resolve({
      label: "\u8d5b\u4e8b\u540d\u79f0",
      type: "select",
      options: [],
      controlKind: "custom",
      interactionMode: "search",
      semanticHint: "awards[0]"
    }, { section: "awards", entryContext: "awards[0]" }, "semantic")).resolves.toMatchObject({
      status: "mapped",
      semantic: "awards[0].name",
      source: "embedding"
    });
  });

  it("does not treat a native empty-option select as profile text", async () => {
    const embedding = new StubEmbeddingProvider(
      FIELD_DEFINITIONS.map((definition) => definition.semantic === "awards[].name" ? [1, 0] : [0, 1]),
      [1, 0]
    );
    const resolver = createFieldSemanticResolver({ embeddingProvider: embedding });

    await expect(resolver.resolve({
      label: "\u8d5b\u4e8b\u540d\u79f0",
      type: "select",
      options: [],
      controlKind: "native",
      interactionMode: "native",
      semanticHint: "awards[0]"
    }, { section: "awards", entryContext: "awards[0]" }, "semantic")).resolves.toEqual({
      status: "unresolved",
      reason: "incompatible_field"
    });
  });

  it.each([
    {
      name: "document rejection",
      provider: {
        async embedDocuments(): Promise<number[][]> { throw new Error("documents offline"); },
        async embedQuery(): Promise<number[]> { return [1, 0]; }
      }
    },
    {
      name: "query rejection",
      provider: {
        async embedDocuments(): Promise<number[][]> { return [[1, 0], [0, 1]]; },
        async embedQuery(): Promise<number[]> { throw new Error("query offline"); }
      }
    },
    {
      name: "document count mismatch",
      provider: {
        async embedDocuments(): Promise<number[][]> { return [[1, 0]]; },
        async embedQuery(): Promise<number[]> { return [1, 0]; }
      }
    },
    {
      name: "document dimension mismatch",
      provider: {
        async embedDocuments(): Promise<number[][]> { return [[1, 0], [0, 1, 0]]; },
        async embedQuery(): Promise<number[]> { return [1, 0]; }
      }
    },
    {
      name: "query dimension mismatch",
      provider: {
        async embedDocuments(): Promise<number[][]> { return [[1, 0], [0, 1]]; },
        async embedQuery(): Promise<number[]> { return [1, 0, 0]; }
      }
    },
    {
      name: "document NaN",
      provider: {
        async embedDocuments(): Promise<number[][]> { return [[1, 0], [Number.NaN, 1]]; },
        async embedQuery(): Promise<number[]> { return [1, 0]; }
      }
    },
    {
      name: "query NaN",
      provider: {
        async embedDocuments(): Promise<number[][]> { return [[1, 0], [0, 1]]; },
        async embedQuery(): Promise<number[]> { return [Number.NaN, 0]; }
      }
    },
    {
      name: "zero-length document vector",
      provider: {
        async embedDocuments(): Promise<number[][]> { return [[1, 0], []]; },
        async embedQuery(): Promise<number[]> { return [1, 0]; }
      }
    },
    {
      name: "zero-length query vector",
      provider: {
        async embedDocuments(): Promise<number[][]> { return [[1, 0], [0, 1]]; },
        async embedQuery(): Promise<number[]> { return []; }
      }
    }
  ])("$name is infrastructure failure and never invokes DeepSeek", async ({ provider }) => {
    const structured = new StubStructuredProvider({
      semantic: "education[].enrollmentType",
      confidence: 0.99
    });
    const resolver = createFieldSemanticResolver({
      embeddingProvider: provider,
      structuredProvider: structured,
      definitions: definitions.slice(0, 2),
      minimumSimilarity: 0.8,
      minimumMargin: 0.1
    });

    await expect(resolver.resolve({
      label: "未知培养方式",
      type: "select",
      options: ["统招", "全日制"]
    }, {
      section: "education",
      entryContext: "education[0]"
    }, "semantic")).resolves.toEqual({
      status: "unresolved",
      reason: "embedding_unavailable"
    });
    expect(structured.calls).toBe(0);
  });

  it("健康歧义只把排序后的 Top-3 脱敏候选交给 DeepSeek，并拒绝第 4 候选", async () => {
    const ambiguousDefinitions: FieldDefinition[] = [
      {
        semantic: "basics.candidateOne",
        label: "候选一",
        aliases: ["一号别名"],
        types: ["text"],
        sections: ["basics"],
        risk: "normal",
        description: "一号完整说明"
      },
      {
        semantic: "basics.candidateTwo",
        label: "候选二",
        aliases: ["二号别名"],
        types: ["text"],
        sections: ["basics"],
        risk: "sensitive",
        description: "二号完整说明"
      },
      {
        semantic: "basics.candidateThree",
        label: "候选三",
        aliases: ["三号别名"],
        types: ["text"],
        sections: ["basics"],
        risk: "normal",
        description: "三号完整说明"
      },
      {
        semantic: "basics.candidateFour",
        label: "候选四",
        aliases: ["四号别名"],
        types: ["text"],
        sections: ["basics"],
        risk: "normal",
        description: "四号完整说明"
      }
    ];
    const structured = new StubStructuredProvider({
      semantic: "basics.candidateFour",
      confidence: 0.99
    });
    const resolver = createFieldSemanticResolver({
      embeddingProvider: new StubEmbeddingProvider(
        [[1, 0], [0.999, 0.045], [0.98, 0.2], [0.95, 0.31]],
        [1, 0]
      ),
      structuredProvider: structured,
      definitions: ambiguousDefinitions,
      minimumSimilarity: 0.9,
      minimumMargin: 0.08
    });

    const decision = await resolver.resolve({
      label: "未知基础字段",
      type: "text",
      options: []
    }, { section: "basics" }, "semantic");

    expect(decision).toMatchObject({
      status: "review",
      reason: "ambiguous_candidates",
      candidates: [
        { semantic: "basics.candidateOne" },
        { semantic: "basics.candidateTwo" },
        { semantic: "basics.candidateThree" }
      ]
    });
    expect(structured.calls).toBe(1);
    const payload = JSON.parse(structured.inputs[0]!.user) as { candidates: Array<Record<string, unknown>> };
    expect(payload.candidates).toHaveLength(3);
    expect(payload.candidates.map((candidate) => Object.keys(candidate).sort())).toEqual([
      ["label", "risk", "semantic", "similarity"],
      ["label", "risk", "semantic", "similarity"],
      ["label", "risk", "semantic", "similarity"]
    ]);
    expect(payload.candidates.map(({ semantic, label, risk }) => ({ semantic, label, risk }))).toEqual([
      { semantic: "basics.candidateOne", label: "候选一", risk: "normal" },
      { semantic: "basics.candidateTwo", label: "候选二", risk: "sensitive" },
      { semantic: "basics.candidateThree", label: "候选三", risk: "normal" }
    ]);
    expect(structured.inputs[0]!.user).not.toContain("别名");
    expect(structured.inputs[0]!.user).not.toContain("完整说明");
  });

  it("健康但没有兼容候选时返回 incompatible_field 且不调用 DeepSeek", async () => {
    const structured = new StubStructuredProvider();
    const resolver = createFieldSemanticResolver({
      embeddingProvider: new StubEmbeddingProvider([[1, 0]], [1, 0]),
      structuredProvider: structured,
      definitions: [{
        semantic: "projects[].name",
        label: "项目名称",
        aliases: ["项目名"],
        types: ["text"],
        sections: ["projects"],
        risk: "normal",
        description: "项目名称"
      }]
    });

    await expect(resolver.resolve({
      label: "未知获奖字段",
      type: "text",
      options: []
    }, {
      section: "awards",
      entryContext: "awards[0]"
    }, "semantic")).resolves.toEqual({
      status: "unresolved",
      reason: "incompatible_field"
    });
    expect(structured.calls).toBe(0);
  });

  it.each(["commitment", "sensitive"] as const)(
    "%s 风险不会仅因风险进入 DeepSeek",
    async (risk) => {
      const structured = new StubStructuredProvider();
      const resolver = createFieldSemanticResolver({
        embeddingProvider: new StubEmbeddingProvider([[1, 0]], [1, 0]),
        structuredProvider: structured,
        definitions: [{
          semantic: `preferences.${risk}Field`,
          label: `${risk} 候选`,
          aliases: [],
          types: ["text"],
          sections: ["preferences"],
          risk,
          description: `${risk} 风险字段`
        }],
        minimumSimilarity: 0.9,
        minimumMargin: 0.08
      });

      await expect(resolver.resolve({
        label: "未知求职偏好",
        type: "text",
        options: []
      }, { section: "preferences" }, "semantic")).resolves.toMatchObject({
        status: "review",
        reason: "risk_requires_review"
      });
      expect(structured.calls).toBe(0);
    }
  );

  it.each([
    ["Legal Name", "text", "basics.name"],
    ["Phone Number", "text", "basics.phone"],
    ["Where are you currently located?", "text", "basics.currentLocation"],
    ["When can you start a new role?", "text", "preferences.availability"],
    ["Are you willing to relocate?", "radio", "preferences.willingToRelocate"]
  ] as const)("maps common ATS label %s deterministically", async (label, type, semantic) => {
    const resolver = createFieldSemanticResolver();
    await expect(resolver.resolve({ label, type, options: type === "radio" ? ["Yes", "No"] : [] }, {}, "deterministic"))
      .resolves.toMatchObject({ status: "mapped", semantic, source: "exact_alias" });
  });
});
