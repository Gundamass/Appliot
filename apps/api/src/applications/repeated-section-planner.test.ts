import { describe, expect, it } from "vitest";
import type { FormSnapshot, ProfileFact } from "@resume/contracts";
import { planRepeatedSectionActions } from "./repeated-section-planner.js";
const fixtureNodeRef = {
  documentId: "document-fixture-00000001",
  nodeId: "node-fixture-000000000001",
  observedAt: 7
};


const snapshot = (fields: FormSnapshot["fields"], actions: FormSnapshot["actions"]): FormSnapshot => ({frameRef: { documentId: fixtureNodeRef.documentId, kind: "main" as const }, mutationEpoch: fixtureNodeRef.observedAt, 
  id: "snapshot", taskId: "task", url: "https://example.com/apply", title: "Apply",
  stage: "application_form", fields, actions, errors: []
});

const fact = (fieldPath: string, value: ProfileFact["value"] = "value"): ProfileFact => ({
  id: fieldPath, fieldPath, value, status: "user_confirmed", confidence: 1,
  scope: "profile", revision: 1, evidence: []
});

describe("repeated section planner", () => {
  it("plans one project add when profile has three entries and page has two", () => {
    const fields = [0, 1].map((index) => ({ nodeRef: fixtureNodeRef, 
      id: `project-${index}`, label: "项目名称", type: "text" as const, required: false,
      options: [], currentValue: "", semanticHint: `projects[${index}].name`
    }));
    const actions = [{ nodeRef: fixtureNodeRef, id: "add-project", text: "添加", class: "intermediate_navigation" as const, context: "项目经历" }];
    expect(planRepeatedSectionActions(snapshot(fields, actions), [
      fact("projects[0].name"), fact("projects[1].name"), fact("projects[2].name")
    ])).toEqual([{ section: "projects", actionId: "add-project", missingEntries: 1, profileIndexes: [0, 1, 2] }]);
  });

  it("does not add an entry when page count already matches profile count", () => {
    const fields = [{ nodeRef: fixtureNodeRef, id: "award-0", label: "获奖名称", type: "text" as const, required: false,
      options: [], currentValue: "", semanticHint: "awards[0].name" }];
    const actions = [{ nodeRef: fixtureNodeRef, id: "add-award", text: "添加", class: "intermediate_navigation" as const, context: "获奖经历" }];
    expect(planRepeatedSectionActions(snapshot(fields, actions), [fact("awards[0].name")])).toEqual([]);
  });

  it("plans a laboratory entry when campus facts exceed the page entries", () => {
    const fields = [{ nodeRef: fixtureNodeRef, id: "lab-0", label: "实验室名称", type: "text" as const,
      required: false, options: [], currentValue: "", semanticHint: "campus[0].name" }];
    const actions = [{ nodeRef: fixtureNodeRef, id: "add-lab", text: "添加", class: "intermediate_navigation" as const, context: "实验室经历" }];
    expect(planRepeatedSectionActions(snapshot(fields, actions), [
      fact("campus[0].name"), fact("campus[1].name")
    ])).toEqual([{ section: "laboratory", actionId: "add-lab", missingEntries: 1, profileIndexes: [0, 1] }]);
  });

  it("routes formal and internship add actions to compatible profile entries only", () => {
    const facts = [
      fact("work[0].employmentType", "\u5b9e\u4e60"),
      fact("work[1].employmentType", "\u5168\u804c"),
      fact("work[2].employmentType", "Java \u540e\u7aef\u5b9e\u4e60")
    ];
    const formalPage = snapshot([], [{ nodeRef: fixtureNodeRef, 
      id: "add-work", text: "\u6dfb\u52a0", class: "intermediate_navigation", context: "\u6b63\u5f0f\u5de5\u4f5c\u7ecf\u5386"
    }]);
    const internshipPage = snapshot([{ nodeRef: fixtureNodeRef, 
      id: "internship-company", label: "\u5b9e\u4e60\u5355\u4f4d", type: "text", required: false,
      options: [], currentValue: "", sectionHint: "internship", semanticHint: "work[0].company"
    }], [{ nodeRef: fixtureNodeRef, 
      id: "add-internship", text: "\u6dfb\u52a0", class: "intermediate_navigation", context: "\u5b9e\u4e60\u7ecf\u5386"
    }]);

    expect(planRepeatedSectionActions(formalPage, facts)).toEqual([{
      section: "work", actionId: "add-work", missingEntries: 1, profileIndexes: [1]
    }]);
    expect(planRepeatedSectionActions(internshipPage, facts)).toEqual([{
      section: "internship", actionId: "add-internship", missingEntries: 1, profileIndexes: [0, 2]
    }]);
  });
});
