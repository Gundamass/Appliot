import { describe, expect, it } from "vitest";
import {
  ApplicationSkillVersionSchema,
  SkillDirectiveSchema,
  type ApplicationSkillVersion,
  type SkillDirective
} from "@resume/contracts";
import {
  SkillInterpreter,
  type NormalizedSkillPageObservation,
  type PageMatch
} from "./skill-interpreter.js";

describe("SkillInterpreter", () => {
  it("matches one exact origin, route, landmark, and semantic signature", () => {
    const interpreter = new SkillInterpreter();
    const match = interpreter.matchPage(observationFixture(), skillFixture());

    expect(match).toEqual({
      kind: "matched",
      pageVariantId: "personal-form",
      fingerprintHash: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(interpreter.matchPage(observationFixture(), skillFixture())).toEqual(match);
  });

  it("returns origin and fingerprint misses without compiling directives", () => {
    const interpreter = new SkillInterpreter();
    const skill = skillFixture();
    const originMiss = interpreter.matchPage({
      ...observationFixture(),
      origin: "https://careers.example.com"
    }, skill);
    const fingerprintMiss = interpreter.matchPage({
      ...observationFixture(),
      route: "/jobs/list",
      landmarks: ["职位列表"],
      fields: []
    }, skill);

    expect(originMiss).toEqual({ kind: "unmatched", reason: "origin" });
    expect(fingerprintMiss).toEqual({ kind: "unmatched", reason: "fingerprint" });
    expect(interpreter.compileDirectives(originMiss, ["basics.name"])).toEqual([]);
    expect(interpreter.compileDirectives(fingerprintMiss, ["basics.name"])).toEqual([]);
  });

  it("returns an ambiguity when the top variants do not clear the fixed lead margin", () => {
    const interpreter = new SkillInterpreter();
    const skill = skillFixture();
    skill.content.pageVariants.push({
      id: "personal-form-alternate",
      match: {
        routePatterns: ["/jobs/application"],
        requiredTexts: ["基本信息"],
        requiredFields: ["basics.name", "basics.email"]
      },
      workflowEntry: "fill-personal"
    });
    const match = interpreter.matchPage({
      ...observationFixture(),
      landmarks: ["申请职位", "个人信息", "基本信息"]
    }, skill);

    expect(match).toEqual({
      kind: "ambiguous",
      candidateIds: ["personal-form", "personal-form-alternate"]
    });
    expect(interpreter.compileDirectives(match, ["basics.name"])).toEqual([]);
  });

  it("preserves requested semantic order, removes duplicates, and keeps CSS locator keys last", () => {
    const interpreter = new SkillInterpreter();
    const match = interpreter.matchPage(observationFixture(), skillFixture());
    const directives = interpreter.compileDirectives(match, [
      "basics.name",
      "basics.email",
      "basics.name"
    ]);

    expect(directives).toEqual([
      { kind: "resolve-field", semantic: "basics.name", locatorKeys: ["candidate-name", "candidate-name-css"] },
      { kind: "resolve-field", semantic: "basics.email", locatorKeys: ["candidate-email"] },
      { kind: "verify-field", semantic: "basics.name" },
      { kind: "verify-field", semantic: "basics.email" },
      { kind: "recover", action: "reobserve" },
      { kind: "recover", action: "refresh-node-ref" }
    ]);
    directives.forEach((directive) => expect(SkillDirectiveSchema.safeParse(directive).success).toBe(true));
  });

  it("evaluates finite all, any, and not conditions against normalized observations", () => {
    const interpreter = new SkillInterpreter();
    const skill = skillFixture();
    skill.content.workflow = [
      {
        id: "all-step",
        when: {
          kind: "all",
          conditions: [
            { kind: "page-variant", variantId: "personal-form" },
            { kind: "field-present", semantic: "basics.name" }
          ]
        },
        actions: [{ capability: "readback", semantics: ["basics.name"] }],
        success: ["writes_read_back"],
        next: "any-step"
      },
      {
        id: "any-step",
        when: {
          kind: "any",
          conditions: [
            { kind: "field-empty", semantic: "basics.email" },
            { kind: "capability-available", capability: "readback" }
          ]
        },
        actions: [{ capability: "readback", semantics: ["basics.email"] }],
        success: ["writes_read_back"],
        next: "not-step"
      },
      {
        id: "not-step",
        when: { kind: "not", condition: { kind: "challenge-present" } },
        actions: [
          { capability: "readback", semantics: ["basics.phone"] },
          { capability: "full_page_audit" }
        ],
        success: ["audit_clean"],
        next: "continue_or_wait"
      }
    ];
    skill.content.pageVariants[0]!.workflowEntry = "all-step";
    const match = interpreter.matchPage(observationFixture(), skill);

    expect(interpreter.compileDirectives(match, ["basics.phone", "basics.email", "basics.name"]))
      .toEqual(expect.arrayContaining([
        { kind: "verify-field", semantic: "basics.name" },
        { kind: "verify-field", semantic: "basics.email" },
        { kind: "verify-field", semantic: "basics.phone" }
      ]));

    const challenged = interpreter.matchPage({ ...observationFixture(), challengePresent: true }, skill);
    expect(interpreter.compileDirectives(challenged, ["basics.phone", "basics.email", "basics.name"]))
      .not.toContainEqual({ kind: "verify-field", semantic: "basics.phone" });
  });

  it("bounds recovery directives by maxRetries and the contract ceiling", () => {
    const interpreter = new SkillInterpreter();
    const skill = skillFixture();
    skill.content.recovery = {
      maxRetries: 1,
      actions: ["reobserve", "scroll-into-view", "refresh-node-ref"]
    };
    const match = interpreter.matchPage(observationFixture(), skill);
    const recoveries = interpreter.compileDirectives(match, ["basics.name"])
      .filter((directive): directive is Extract<SkillDirective, { kind: "recover" }> => directive.kind === "recover");

    expect(recoveries).toEqual([{ kind: "recover", action: "reobserve" }]);
    expect(recoveries).toHaveLength(1);
  });

  it("rejects malicious unvalidated Skills and never compiles their submit or unsafe CSS data", () => {
    const interpreter = new SkillInterpreter();
    const malicious = structuredClone(skillFixture()) as unknown as Record<string, unknown>;
    const content = malicious.content as Record<string, unknown>;
    content.capabilities = ["observe", "terminal_submit", "full_page_audit"];
    const fields = content.fields as Array<Record<string, unknown>>;
    fields[0]!.locatorHints = [
      { key: "unsafe-css", by: "css", selector: "button[onclick=submit()]" },
      { key: "candidate-name", by: "label", text: "姓名" }
    ];

    const match = interpreter.matchPage(observationFixture(), malicious);

    expect(match).toEqual({ kind: "unmatched", reason: "fingerprint" });
    expect(interpreter.compileDirectives(match, ["basics.name"])).toEqual([]);
  });

  it("returns no directives for a forged matched object", () => {
    const interpreter = new SkillInterpreter();
    const forged: PageMatch = {
      kind: "matched",
      pageVariantId: "personal-form",
      fingerprintHash: "f".repeat(64)
    };

    expect(interpreter.compileDirectives(forged, ["basics.name"])).toEqual([]);
  });
});

function observationFixture(): NormalizedSkillPageObservation {
  return {
    origin: "https://talent.baidu.com",
    route: "/jobs/application/personal",
    landmarks: ["申请职位", "个人信息"],
    fields: [
      { semantic: "basics.name", empty: true },
      { semantic: "basics.email", empty: false },
      { semantic: "basics.phone", empty: false }
    ],
    availableCapabilities: ["observe", "fill_empty_fields", "readback", "full_page_audit"],
    challengePresent: false
  };
}

function skillFixture(): ApplicationSkillVersion {
  return ApplicationSkillVersionSchema.parse({
    skillId: "baidu-application",
    version: "1.0.0",
    schemaVersion: 1,
    contentHash: "a".repeat(64),
    site: "baidu",
    allowedDomains: ["talent.baidu.com"],
    pageFingerprintRule: { ruleId: "baidu-application", ruleHash: "b".repeat(64) },
    status: "champion",
    content: {
      capabilities: ["observe", "fill_empty_fields", "readback", "full_page_audit"],
      pageVariants: [{
        id: "personal-form",
        match: {
          routePatterns: ["/jobs/application"],
          requiredTexts: ["个人信息"],
          requiredFields: ["basics.name", "basics.email"]
        },
        workflowEntry: "fill-personal"
      }],
      fields: [
        {
          semantic: "basics.name",
          controlTypes: ["text"],
          locatorHints: [
            { key: "candidate-name", by: "label", text: "姓名" },
            { key: "candidate-name-css", by: "css", selector: "input[data-field=\"candidateName\"]" }
          ]
        },
        {
          semantic: "basics.email",
          controlTypes: ["text"],
          locatorHints: [{ key: "candidate-email", by: "role", role: "textbox", name: "邮箱" }]
        },
        {
          semantic: "basics.phone",
          controlTypes: ["text"],
          locatorHints: [{ key: "candidate-phone", by: "label", text: "手机号码" }]
        }
      ],
      workflow: [{
        id: "fill-personal",
        actions: [
          { capability: "fill_empty_fields", semantics: ["basics.email", "basics.name"] },
          { capability: "readback", semantics: ["basics.email", "basics.name"] },
          { capability: "full_page_audit" }
        ],
        success: ["writes_read_back", "audit_clean"],
        next: "continue_or_wait"
      }],
      recovery: { maxRetries: 2, actions: ["reobserve", "refresh-node-ref"] }
    },
    createdBy: { kind: "manual_seed", actorId: "test-suite" },
    createdAt: "2026-09-07T08:00:00.000Z"
  });
}
