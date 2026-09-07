import { describe, expect, it } from "vitest";
import type { ApplicationSkillVersion } from "@resume/contracts";
import {
  validateSkillCandidate,
  type SkillValidationIssue
} from "./skill-validator.js";

describe("validateSkillCandidate", () => {
  it("accepts a strict, bounded child that preserves its parent safety boundary", () => {
    const parent = versionFixture("1.0.0");
    const candidate = versionFixture("1.1.0", parent.version);

    expect(validateSkillCandidate(candidate, parent)).toEqual({ valid: true, issues: [] });
  });

  it("runs the strict contract first and never accepts a submit capability", () => {
    const parent = versionFixture("1.0.0");
    const candidate = structuredClone(versionFixture("1.1.0", parent.version)) as unknown as Record<string, unknown>;
    const content = candidate.content as Record<string, unknown>;
    content.capabilities = ["observe", "fill_empty_fields", "readback", "full_page_audit", "terminal_submit"];
    candidate.unexpected = true;

    const result = validateSkillCandidate(candidate, parent);

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      code: "SCHEMA_INVALID",
      path: "/content/capabilities/4"
    });
    expect(JSON.stringify(candidate)).toContain("terminal_submit");
  });

  it("rejects capability expansion relative to the parent", () => {
    const parent = versionFixture("1.0.0");
    const candidate = versionFixture("1.1.0", parent.version);
    candidate.content.capabilities.push("select_option");

    expect(validateSkillCandidate(candidate, parent).issues).toContainEqual({
      code: "CAPABILITY_EXPANSION",
      path: "/content/capabilities/4"
    });
  });

  it("rejects workflow cycles that have no decrementing retry edge", () => {
    const candidate = versionFixture("1.1.0", "1.0.0");
    candidate.content.workflow[0]!.next = "audit-loop";
    candidate.content.workflow.push({
      id: "audit-loop",
      actions: [{ capability: "full_page_audit" }],
      success: ["audit_clean"],
      next: "fill-basics"
    });

    expect(validateSkillCandidate(candidate, versionFixture("1.0.0")).issues).toContainEqual({
      code: "UNBOUNDED_RECOVERY",
      path: "/content/workflow/1/next"
    });
  });

  it("reports page variants whose workflow entry does not exist", () => {
    const candidate = versionFixture("1.1.0", "1.0.0");
    candidate.content.pageVariants[0]!.workflowEntry = "missing-step";

    expect(validateSkillCandidate(candidate, versionFixture("1.0.0")).issues).toContainEqual({
      code: "UNREACHABLE_VARIANT",
      path: "/content/pageVariants/0/workflowEntry"
    });
  });

  it("reports workflow steps that no page variant can reach", () => {
    const candidate = versionFixture("1.1.0", "1.0.0");
    candidate.content.workflow.push({
      id: "orphan-step",
      actions: [{ capability: "observe" }],
      success: ["page_observed"],
      next: "continue_or_wait"
    });

    expect(validateSkillCandidate(candidate, versionFixture("1.0.0")).issues).toContainEqual({
      code: "UNREACHABLE_WORKFLOW",
      path: "/content/workflow/1"
    });
  });

  it("reports locator keys whose field is never used by the workflow", () => {
    const candidate = versionFixture("1.1.0", "1.0.0");
    candidate.content.fields.push({
      semantic: "basics.phone",
      controlTypes: ["text"],
      locatorHints: [{ key: "candidate-phone", by: "label", text: "手机号码" }]
    });

    expect(validateSkillCandidate(candidate, versionFixture("1.0.0")).issues).toContainEqual({
      code: "UNREFERENCED_LOCATOR_KEY",
      path: "/content/fields/1/locatorHints/0/key"
    });
  });

  it("requires readback after every fill in the same workflow step", () => {
    const candidate = versionFixture("1.1.0", "1.0.0");
    candidate.content.workflow[0]!.actions = [
      { capability: "fill_empty_fields", semantics: ["basics.name"] },
      { capability: "full_page_audit" }
    ];

    expect(validateSkillCandidate(candidate, versionFixture("1.0.0")).issues).toContainEqual({
      code: "MISSING_READBACK",
      path: "/content/workflow/0/actions/0"
    });
  });

  it("rejects parent site/domain changes and domains outside the registered site origins", () => {
    const parent = versionFixture("1.0.0");
    const candidate = versionFixture("1.1.0", parent.version);
    candidate.site = "dji";
    candidate.allowedDomains = ["apply.careers.dji.com"];

    expect(validateSkillCandidate(candidate, parent).issues).toEqual(expect.arrayContaining<SkillValidationIssue>([
      { code: "ORIGIN_MISMATCH", path: "/site" },
      { code: "ORIGIN_MISMATCH", path: "/allowedDomains" }
    ]));

    const unregisteredOrigin = versionFixture("1.1.0");
    unregisteredOrigin.allowedDomains = ["careers.example.com"];
    expect(validateSkillCandidate(unregisteredOrigin).issues).toContainEqual({
      code: "ORIGIN_MISMATCH",
      path: "/allowedDomains/0"
    });
  });
});

function versionFixture(version: string, parentVersion?: string): ApplicationSkillVersion {
  return {
    skillId: "baidu-application",
    version,
    ...(parentVersion === undefined ? {} : { parentVersion }),
    schemaVersion: 1,
    contentHash: "a".repeat(64),
    site: "baidu",
    allowedDomains: ["talent.baidu.com"],
    pageFingerprintRule: { ruleId: "baidu-application", ruleHash: "b".repeat(64) },
    status: "candidate",
    content: {
      capabilities: ["observe", "fill_empty_fields", "readback", "full_page_audit"],
      pageVariants: [{
        id: "application-form",
        match: {
          routePatterns: ["/jobs/application"],
          requiredTexts: ["申请职位"],
          requiredFields: ["basics.name"]
        },
        workflowEntry: "fill-basics"
      }],
      fields: [{
        semantic: "basics.name",
        controlTypes: ["text"],
        locatorHints: [{ key: "candidate-name", by: "label", text: "姓名" }]
      }],
      workflow: [{
        id: "fill-basics",
        actions: [
          { capability: "fill_empty_fields", semantics: ["basics.name"] },
          { capability: "readback", semantics: ["basics.name"] },
          { capability: "full_page_audit" }
        ],
        success: ["writes_read_back", "audit_clean"],
        next: "continue_or_wait"
      }],
      recovery: { maxRetries: 2, actions: ["reobserve", "refresh-node-ref"] }
    },
    createdBy: { kind: "manual_seed", actorId: "test-suite" },
    createdAt: "2026-09-07T08:00:00.000Z"
  };
}
