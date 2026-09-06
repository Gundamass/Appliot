import { describe, expect, it } from "vitest";
import {
  ApplicationFieldSemanticSchema,
  ApplicationSkillContentSchema,
  ApplicationSkillVersionSchema,
  SkillBindingSchema,
  SkillDirectiveSchema,
  SkillEvaluationSchema,
  SkillEvolutionPatchSchema,
  SkillExecutionRecordSchema,
  type ApplicationSkillContent,
  type ApplicationSkillVersion,
  type SkillBinding,
  type SkillDirective,
  type SkillEvaluation,
  type SkillEvolutionPatch,
  type SkillExecutionRecord
} from "./application-skill.js";

const hash = "a".repeat(64);

const baiduCampusSkill = {
  capabilities: [
    "observe",
    "fill_empty_fields",
    "select_option",
    "upload_approved_file",
    "readback",
    "full_page_audit"
  ],
  pageVariants: [{
    id: "baidu-campus-application",
    match: {
      routePatterns: ["/jobs/campus/apply/**"],
      requiredTexts: ["教育经历", "简历"],
      requiredFields: ["basics.name", "basics.phone", "education[].institution"]
    },
    workflowEntry: "observe-form"
  }],
  fields: [{
    semantic: "basics.name",
    controlTypes: ["text"],
    locatorHints: [
      { key: "name-label", by: "label", text: "姓名" },
      { key: "name-test-id", by: "stable_attribute", attribute: "data-testid", value: "candidate-name" },
      { key: "name-css", by: "css", selector: "input[data-testid=\"candidate-name\"]" }
    ]
  }, {
    semantic: "education[].institution",
    controlTypes: ["text", "select"],
    locatorHints: [
      { key: "school-role", by: "role", role: "textbox", name: "学校名称" },
      { key: "school-placeholder", by: "placeholder", text: "请输入学校名称" }
    ]
  }, {
    semantic: "basics.resumeFile",
    controlTypes: ["file"],
    locatorHints: [{ key: "resume-label", by: "label", text: "上传简历" }]
  }],
  workflow: [{
    id: "observe-form",
    when: { kind: "page-variant", variantId: "baidu-campus-application" },
    actions: [{ capability: "observe" }],
    success: ["page_observed"],
    next: "fill-fields"
  }, {
    id: "fill-fields",
    when: {
      kind: "all",
      conditions: [
        { kind: "field-present", semantic: "basics.name" },
        { kind: "field-empty", semantic: "basics.name" }
      ]
    },
    actions: [
      { capability: "fill_empty_fields", semantics: ["basics.name", "education[].institution"] },
      { capability: "select_option", semantics: ["education[].degree"] },
      { capability: "upload_approved_file", semantic: "basics.resumeFile" }
    ],
    success: ["fields_resolved", "writes_read_back"],
    next: "verify-form"
  }, {
    id: "verify-form",
    when: { kind: "not", condition: { kind: "challenge-present" } },
    actions: [
      { capability: "readback", semantics: ["basics.name", "education[].institution"] },
      { capability: "full_page_audit" }
    ],
    success: ["writes_read_back", "audit_clean"],
    next: "continue_or_wait"
  }],
  recovery: {
    maxRetries: 3,
    actions: ["reobserve", "scroll-into-view", "refresh-node-ref"]
  }
} as const;

const versionFixture = {
  skillId: "baidu-application",
  version: "1.2.1",
  parentVersion: "1.2.0",
  schemaVersion: 1,
  contentHash: hash,
  site: "baidu",
  allowedDomains: ["talent.baidu.com"],
  pageFingerprintRule: {
    ruleId: "baidu-campus-application-v1",
    ruleHash: hash
  },
  status: "candidate",
  content: baiduCampusSkill,
  createdBy: {
    kind: "evolution_agent",
    actorId: "skill-evolution-v1",
    evolutionRunId: "evolution-run-1"
  },
  createdAt: "2026-09-06T08:00:00.000Z"
} as const;

function replaceFirstLocator(locator: unknown) {
  return {
    ...baiduCampusSkill,
    fields: [{
      ...baiduCampusSkill.fields[0],
      locatorHints: [locator]
    }, ...baiduCampusSkill.fields.slice(1)]
  };
}

describe("ApplicationSkillContentSchema", () => {
  it("accepts a closed Baidu campus application skill", () => {
    const parsed = ApplicationSkillContentSchema.parse(baiduCampusSkill);
    expect(parsed.capabilities).toEqual([
      "observe",
      "fill_empty_fields",
      "select_option",
      "upload_approved_file",
      "readback",
      "full_page_audit"
    ]);
    expect(parsed.fields.map((field) => field.semantic)).toEqual([
      "basics.name",
      "education[].institution",
      "basics.resumeFile"
    ]);
  });

  it.each([
    ["JavaScript actions", { ...baiduCampusSkill, workflow: [{ action: "script", source: "document.querySelector('form')" }] }],
    ["XPath locator kinds", replaceFirstLocator({ key: "xpath", by: "xpath", value: "//input" })],
    ["CSS combinators", replaceFirstLocator({ key: "css", by: "css", selector: "form > input[data-testid=\"name\"]" })],
    ["CSS pseudo selectors", replaceFirstLocator({ key: "css", by: "css", selector: "input:first-child" })],
    ["CSS ids", replaceFirstLocator({ key: "css", by: "css", selector: "#dynamic-1723456789" })],
    ["absolute URLs", { ...baiduCampusSkill, pageVariants: [{ ...baiduCampusSkill.pageVariants[0], match: { ...baiduCampusSkill.pageVariants[0].match, routePatterns: ["https://evil.example/apply"] } }] }],
    ["raw profile values", { ...baiduCampusSkill, profileValues: { name: "张三", phone: "13800138000" } }],
    ["approval tokens", { ...baiduCampusSkill, workflow: [{ ...baiduCampusSkill.workflow[0], actions: [{ capability: "observe", approval: "token-secret" }] }] }],
    ["evaluator weights", { ...baiduCampusSkill, evaluator: { weights: { completion: 1 } } }],
    ["audit switches", { ...baiduCampusSkill, auditEnabled: false }],
    ["terminal submit", { ...baiduCampusSkill, capabilities: [...baiduCampusSkill.capabilities, "submit"] }],
    ["registry metadata", { ...baiduCampusSkill, skillId: "evil", site: "evil.example", schemaVersion: 2 }],
    ["more than three retries", { ...baiduCampusSkill, recovery: { maxRetries: 4, actions: ["reobserve"] } }]
  ])("rejects %s", (_name, candidate) => {
    expect(() => ApplicationSkillContentSchema.parse(candidate)).toThrow();
  });

  it("requires restricted CSS to be the final locator fallback", () => {
    const candidate = {
      ...baiduCampusSkill,
      fields: [{
        ...baiduCampusSkill.fields[0],
        locatorHints: [
          { key: "css", by: "css", selector: "input[data-testid=\"candidate-name\"]" },
          { key: "label", by: "label", text: "姓名" }
        ]
      }, ...baiduCampusSkill.fields.slice(1)]
    };
    expect(() => ApplicationSkillContentSchema.parse(candidate)).toThrow();
  });

  it("accepts only canonical application field semantics", () => {
    expect(ApplicationFieldSemanticSchema.parse("projects[].description")).toBe("projects[].description");
    expect(() => ApplicationFieldSemanticSchema.parse("projects[19].secretValue")).toThrow();
  });

  it("accepts canonical derived and split-date semantics used by current forms", () => {
    expect(ApplicationFieldSemanticSchema.parse("education[].hasLaboratory")).toBe("education[].hasLaboratory");
    expect(ApplicationFieldSemanticSchema.parse("work[].startDate.month")).toBe("work[].startDate.month");
    expect(ApplicationFieldSemanticSchema.parse("awards[].date.day")).toBe("awards[].date.day");
  });
});

describe("application skill registry and runtime contracts", () => {
  it("parses registry-owned immutable version metadata", () => {
    const parsed: ApplicationSkillVersion = ApplicationSkillVersionSchema.parse(versionFixture);
    expect(parsed.site).toBe("baidu");
    expect(() => ApplicationSkillVersionSchema.parse({ ...versionFixture, allowedDomains: ["https://talent.baidu.com"] })).toThrow();
    expect(() => ApplicationSkillVersionSchema.parse({ ...versionFixture, evaluatorWeights: { safety: 1 } })).toThrow();
  });

  it("parses a stable skill binding", () => {
    const binding: SkillBinding = SkillBindingSchema.parse({
      skillId: "baidu-application",
      version: "1.2.1",
      site: "baidu",
      pageFingerprintHash: hash,
      allocationId: "allocation-1"
    });
    expect(binding.version).toBe("1.2.1");
  });

  it("keeps public directives finite and value-free", () => {
    const directives: SkillDirective[] = [
      SkillDirectiveSchema.parse({ kind: "resolve-field", semantic: "basics.name", locatorKeys: ["name-label"] }),
      SkillDirectiveSchema.parse({ kind: "verify-field", semantic: "basics.name" }),
      SkillDirectiveSchema.parse({ kind: "recover", action: "reobserve" })
    ];
    expect(directives).toHaveLength(3);
    expect(() => SkillDirectiveSchema.parse({ kind: "resolve-field", semantic: "basics.name", locatorKeys: [], value: "张三" })).toThrow();
    expect(() => SkillDirectiveSchema.parse({ kind: "submit", approval: "secret" })).toThrow();
  });

  it("parses a redacted execution record", () => {
    const record: SkillExecutionRecord = SkillExecutionRecordSchema.parse({
      recordId: "skill-record-1",
      taskId: "application-task-1",
      attemptId: "attempt-1",
      binding: SkillBindingSchema.parse({
        skillId: "baidu-application",
        version: "1.2.1",
        site: "baidu",
        pageFingerprintHash: hash,
        allocationId: "allocation-1"
      }),
      pageVariantId: "baidu-campus-application",
      fieldOutcomes: [{
        semantic: "basics.name",
        outcome: "verified",
        nodeRef: { documentId: "document-identity", nodeId: "node-identity-0001", observedAt: 1 }
      }],
      counts: { observed: 3, planned: 2, verified: 1, auditMismatches: 0, userCorrections: 0 },
      auditMismatchClasses: [],
      retries: 0,
      recoveries: 0,
      durationMs: 1200,
      terminalResult: "completed_pre_submit",
      startedAt: "2026-09-06T08:00:00.000Z",
      completedAt: "2026-09-06T08:00:01.200Z"
    });
    expect(record.terminalResult).toBe("completed_pre_submit");
    expect(() => SkillExecutionRecordSchema.parse({ ...record, rawFieldValue: "张三" })).toThrow();
  });

  it("parses fixed-policy evaluation facts without weights", () => {
    const evaluation: SkillEvaluation = SkillEvaluationSchema.parse({
      evaluationId: "evaluation-1",
      executionRecordId: "skill-record-1",
      evaluatorVersion: "1.0.0",
      source: "online",
      safetyViolations: 0,
      incorrectWrites: 0,
      fieldAccuracy: 1,
      requiredCompletion: 0.95,
      userCorrections: 0,
      retries: 0,
      recoveries: 0,
      durationMs: 1200,
      decision: "pass",
      evaluatedAt: "2026-09-06T08:01:00.000Z"
    });
    expect(evaluation.fieldAccuracy).toBe(1);
    expect(() => SkillEvaluationSchema.parse({ ...evaluation, weights: { accuracy: 0.8 } })).toThrow();
  });

  it("allows patches only against evolvable content paths", () => {
    const patch: SkillEvolutionPatch = SkillEvolutionPatchSchema.parse({
      parentContentHash: hash,
      operations: [{
        op: "add",
        path: "/fields/-",
        value: {
          semantic: "basics.email",
          controlTypes: ["text"],
          locatorHints: [{ key: "email-label", by: "label", text: "邮箱" }]
        }
      }]
    });
    expect(patch.operations).toHaveLength(1);
    expect(() => SkillEvolutionPatchSchema.parse({
      parentContentHash: hash,
      operations: [{ op: "replace", path: "/status", value: "champion" }]
    })).toThrow();
    expect(() => SkillEvolutionPatchSchema.parse({
      parentContentHash: hash,
      operations: [{ op: "add", path: "/workflow/-", value: { action: "script", source: "alert(1)" } }]
    })).toThrow();
  });

  it("exports inferred content and record types", () => {
    const content: ApplicationSkillContent = ApplicationSkillContentSchema.parse(baiduCampusSkill);
    const version: ApplicationSkillVersion = ApplicationSkillVersionSchema.parse(versionFixture);
    const record: SkillExecutionRecord | undefined = undefined;
    expect(content.pageVariants).toHaveLength(1);
    expect(version.contentHash).toBe(hash);
    expect(record).toBeUndefined();
  });
});
