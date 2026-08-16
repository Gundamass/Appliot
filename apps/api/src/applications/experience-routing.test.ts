import { describe, expect, it } from "vitest";
import type { ProfileFact } from "@resume/contracts";
import { classifyEmploymentType, compatibleExperienceIndexes } from "./experience-routing.js";

function fact(
  fieldPath: string,
  value: ProfileFact["value"],
  status: ProfileFact["status"] = "user_confirmed",
  revision = 1
): ProfileFact {
  return {
    id: `${fieldPath}-${revision}`,
    fieldPath,
    value,
    status,
    confidence: 1,
    scope: "profile",
    revision,
    evidence: []
  };
}

describe("experience routing", () => {
  it("classifies only explicit internship and formal employment types", () => {
    expect(classifyEmploymentType("Java \u540e\u7aef\u5b9e\u4e60")).toBe("internship");
    expect(classifyEmploymentType("\u5168\u804c")).toBe("work");
    expect(classifyEmploymentType(undefined)).toBe("unknown");
    expect(classifyEmploymentType("\u5176\u4ed6")).toBe("unknown");
  });

  it("returns only confirmed compatible profile indexes in profile order", () => {
    const facts = [
      fact("work[0].employmentType", "\u5b9e\u4e60"),
      fact("work[1].employmentType", "\u5168\u804c"),
      fact("work[2].employmentType", "Java \u540e\u7aef\u5b9e\u4e60"),
      fact("work[3].company", "Unknown Ltd"),
      fact("work[4].employmentType", "\u5168\u804c", "extracted")
    ];

    expect(compatibleExperienceIndexes(facts, "internship")).toEqual([0, 2]);
    expect(compatibleExperienceIndexes(facts, "work")).toEqual([1]);
    expect(compatibleExperienceIndexes(facts, "work_combined")).toEqual([0, 1, 2]);
  });

  it("uses the latest revision and excludes a superseded employment type", () => {
    const facts = [
      fact("work[0].employmentType", "\u5b9e\u4e60", "user_confirmed", 1),
      fact("work[0].employmentType", "\u5b9e\u4e60", "superseded", 2)
    ];

    expect(compatibleExperienceIndexes(facts, "internship")).toEqual([]);
  });
});
