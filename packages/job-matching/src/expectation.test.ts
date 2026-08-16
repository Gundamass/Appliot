import type { ProfileFact } from "@resume/contracts";
import { describe, expect, it } from "vitest";
import {
  hasUsableJobExpectation,
  jobExpectationSnapshot,
  projectJobExpectations
} from "./expectation.js";

function fact(
  id: string,
  fieldPath: string,
  value: ProfileFact["value"],
  status: ProfileFact["status"],
  revision: number,
  scope: ProfileFact["scope"] = "profile"
): ProfileFact {
  return {
    id,
    fieldPath,
    value,
    status,
    confidence: 1,
    scope,
    ...(scope === "application" ? { taskId: "application-1" } : {}),
    evidence: [{
      documentId: "fixture",
      page: 1,
      text: typeof value === "string" ? value : JSON.stringify(value),
      extraction: status === "extracted" ? "pdf_text" : "user"
    }],
    revision
  };
}

describe("projectJobExpectations", () => {
  it("prefers reviewed facts, then canonical paths, then newer revisions", () => {
    const projected = projectJobExpectations([
      fact("legacy-reviewed", "preferences.location", "上海", "user_confirmed", 8),
      fact("canonical-extracted", "preferences.targetCity", "北京", "extracted", 9),
      fact("canonical-reviewed-old", "preferences.targetCity", "深圳", "user_corrected", 2),
      fact("canonical-reviewed-new", "preferences.targetCity", "杭州", "user_confirmed", 3),
      fact("empty", "preferences.industry", "   ", "user_corrected", 1)
    ]);

    expect(projected).toContainEqual({
      kind: "location",
      canonicalPath: "preferences.targetCity",
      fieldPath: "preferences.targetCity",
      label: "地点",
      values: ["杭州"],
      factId: "canonical-reviewed-new",
      status: "user_confirmed",
      needsConfirmation: false
    });
    expect(projected.some((item) => item.kind === "industry")).toBe(false);
  });

  it("breaks otherwise equal ties by fact id", () => {
    const projected = projectJobExpectations([
      fact("role-z", "preferences.targetRole", "Go", "user_confirmed", 2),
      fact("role-a", "preferences.targetRole", "Java", "user_corrected", 2)
    ]);

    expect(projected.find((item) => item.kind === "target_role")?.factId).toBe("role-a");
  });

  it("trims and deduplicates string arrays while preserving first occurrence order", () => {
    const projected = projectJobExpectations([
      fact("mode", "preferences.workMode", [" 远程 ", "", "现场", "远程", 3, null], "extracted", 1)
    ]);

    expect(projected[0]?.values).toEqual(["远程", "现场"]);
  });

  it("ignores application-scoped, superseded, unrelated, and empty facts", () => {
    expect(projectJobExpectations([
      fact("application", "preferences.targetRole", "Java", "user_confirmed", 1, "application"),
      fact("superseded", "preferences.industry", "软件", "superseded", 1),
      fact("unrelated", "basics.name", "Ada", "user_confirmed", 1),
      fact("empty-array", "preferences.salary", [" ", null], "user_confirmed", 1)
    ])).toEqual([]);
  });
});

describe("job expectation snapshot", () => {
  it("marks extracted values for confirmation and excludes them from snapshots", () => {
    const facts = [fact("role", "preferences.targetRole", "Java", "extracted", 1)];

    expect(projectJobExpectations(facts)[0]?.needsConfirmation).toBe(true);
    expect(hasUsableJobExpectation(facts)).toBe(false);
    expect(jobExpectationSnapshot(facts, 4, "2026-08-16T00:00:00.000Z")).toEqual({
      revision: 4,
      confirmedAt: "2026-08-16T00:00:00.000Z",
      criteria: []
    });
  });

  it("builds required criteria from all reviewed expectation fields", () => {
    const facts = [
      fact("role", "preferences.targetRole", "Java", "user_confirmed", 1),
      fact("city", "preferences.targetCity", "上海", "user_corrected", 1),
      fact("employment", "preferences.employmentType", "全职", "user_confirmed", 1),
      fact("industry", "preferences.industry", "软件", "user_confirmed", 1),
      fact("mode", "preferences.workMode", "混合办公", "user_confirmed", 1),
      fact("salary", "preferences.salary", "30k-40k", "user_confirmed", 1)
    ];

    expect(hasUsableJobExpectation(facts)).toBe(true);
    expect(jobExpectationSnapshot(facts, 6, "2026-08-16T00:00:00.000Z").criteria).toEqual([
      { kind: "target_role", values: ["Java"], strength: "required" },
      { kind: "location", values: ["上海"], strength: "required" },
      { kind: "employment_type", values: ["全职"], strength: "required" },
      { kind: "industry", values: ["软件"], strength: "required" },
      { kind: "work_mode", values: ["混合办公"], strength: "required" },
      { kind: "salary", values: ["30k-40k"], strength: "required" }
    ]);
  });
});
