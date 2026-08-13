import { describe, expect, it } from "vitest";
import type { FormSnapshot, ProfileFact } from "@resume/contracts";
import { planRepeatedSectionActions } from "./repeated-section-planner.js";

const snapshot = (fields: FormSnapshot["fields"], actions: FormSnapshot["actions"]): FormSnapshot => ({
  id: "snapshot", taskId: "task", url: "https://example.com/apply", title: "Apply",
  stage: "application_form", fields, actions, errors: []
});

const fact = (fieldPath: string): ProfileFact => ({
  id: fieldPath, fieldPath, value: "value", status: "user_confirmed", confidence: 1,
  scope: "profile", revision: 1, evidence: []
});

describe("repeated section planner", () => {
  it("plans one project add when profile has three entries and page has two", () => {
    const fields = [0, 1].map((index) => ({
      id: `project-${index}`, label: "项目名称", type: "text" as const, required: false,
      options: [], currentValue: "", semanticHint: `projects[${index}].name`
    }));
    const actions = [{ id: "add-project", text: "添加", class: "intermediate_navigation" as const, context: "项目经历" }];
    expect(planRepeatedSectionActions(snapshot(fields, actions), [
      fact("projects[0].name"), fact("projects[1].name"), fact("projects[2].name")
    ])).toEqual([{ section: "projects", actionId: "add-project", missingEntries: 1 }]);
  });

  it("does not add an entry when page count already matches profile count", () => {
    const fields = [{ id: "award-0", label: "获奖名称", type: "text" as const, required: false,
      options: [], currentValue: "", semanticHint: "awards[0].name" }];
    const actions = [{ id: "add-award", text: "添加", class: "intermediate_navigation" as const, context: "获奖经历" }];
    expect(planRepeatedSectionActions(snapshot(fields, actions), [fact("awards[0].name")])).toEqual([]);
  });

  it("plans a laboratory entry when campus facts exceed the page entries", () => {
    const fields = [{ id: "lab-0", label: "实验室名称", type: "text" as const,
      required: false, options: [], currentValue: "", semanticHint: "campus[0].name" }];
    const actions = [{ id: "add-lab", text: "添加", class: "intermediate_navigation" as const, context: "实验室经历" }];
    expect(planRepeatedSectionActions(snapshot(fields, actions), [
      fact("campus[0].name"), fact("campus[1].name")
    ])).toEqual([{ section: "laboratory", actionId: "add-lab", missingEntries: 1 }]);
  });
});
