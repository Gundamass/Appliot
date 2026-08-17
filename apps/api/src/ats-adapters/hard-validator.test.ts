import type { HintPackDefinition } from "@resume/contracts";
import { describe, expect, it } from "vitest";
import { validateHintPackCandidate } from "./hard-validator.js";

const hash = (character: string) => character.repeat(64);

function candidate(): HintPackDefinition {
  return {
    schemaVersion: 1,
    packId: "example-ats",
    version: "1.0.0",
    match: {
      sites: [{ hostSuffix: "jobs.example.test", pathPrefixes: ["/apply"] }],
      stages: ["application_form"],
      requiredTextSignals: [],
      pageFingerprintHashes: [hash("a")]
    },
    sectionRules: [],
    fieldRules: [{
      ruleId: "education-institution",
      profilePath: "education[0].institution",
      labelAliases: ["School"],
      sections: ["education"],
      controlTypes: ["text"],
      confidence: 1
    }],
    actionRules: [],
    fixtures: [{ fixtureId: "synthetic-basic", expectedProfilePaths: ["education[0].institution"] }]
  };
}

describe("validateHintPackCandidate", () => {
  it.each([
    ["terminal action", {
      ...candidate(),
      actionRules: [{ kind: "terminal_submit", verbs: ["Submit"], sections: ["education"] }]
    }, "schema_valid"],
    ["unknown action", {
      ...candidate(),
      actionRules: [{ kind: "unknown_side_effect", verbs: ["Continue"], sections: ["education"] }]
    }, "schema_valid"],
    ["type mismatch", {
      ...candidate(),
      fieldRules: [{
        ...candidate().fieldRules[0]!,
        profilePath: "education[0].endDate",
        controlTypes: ["file"]
      }]
    }, "control_type_compatible"],
    ["section mismatch", {
      ...candidate(),
      fieldRules: [{ ...candidate().fieldRules[0]!, sections: ["work"] }]
    }, "section_compatible"],
    ["duplicate observed mapping", {
      ...candidate(),
      fieldRules: [
        candidate().fieldRules[0]!,
        {
          ...candidate().fieldRules[0]!,
          ruleId: "education-major",
          profilePath: "education[0].major"
        }
      ]
    }, "mapping_one_to_one"]
  ] as const)("rejects %s", (_name, input, code) => {
    expect(validateHintPackCandidate(input)).toContainEqual(expect.objectContaining({ code, passed: false }));
  });

  it("fails closed for an unknown profile path", () => {
    const assertions = validateHintPackCandidate({
      ...candidate(),
      fieldRules: [{
        ...candidate().fieldRules[0]!,
        profilePath: "unknownRoot.value"
      }]
    });

    expect(assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "control_type_compatible", passed: false }),
      expect.objectContaining({ code: "section_compatible", passed: false })
    ]));
  });

  it("accepts a compatible declarative mapping without consulting AI", () => {
    expect(validateHintPackCandidate(candidate())).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "schema_valid", passed: true }),
      expect.objectContaining({ code: "policy_safe", passed: true }),
      expect.objectContaining({ code: "mapping_one_to_one", passed: true }),
      expect.objectContaining({ code: "control_type_compatible", passed: true }),
      expect.objectContaining({ code: "section_compatible", passed: true })
    ]));
  });
});
