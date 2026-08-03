import { describe, expect, it } from "vitest";
import { classifyAction } from "./action-classifier.js";

describe("classifyAction", () => {
  it("classifies a section add action as safe intermediate navigation", () => {
    expect(classifyAction({ text: "添加", nearbyText: "项目经历", stage: "application_form" })).toBe("intermediate_navigation");
  });
  it("classifies preview and submit as a terminal submission", () => {
    expect(classifyAction({ text: "预览并提交", stage: "application_form" })).toBe("terminal_submit");
  });
});
