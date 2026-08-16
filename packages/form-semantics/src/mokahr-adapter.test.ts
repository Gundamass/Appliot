import { describe, expect, it } from "vitest";
import {
  classifyMokahrAddActions,
  isMokahrPage,
  sectionHintForText,
  sortMokahrEntryFields,
  type MokahrObservedAction,
  type MokahrObservedField
} from "./mokahr-adapter.js";

const actions: MokahrObservedAction[] = [
  { id: "add-education", text: "添加", nearbyText: "教育经历" },
  { id: "add-work", text: "添加", nearbyText: "实习/工作经历" },
  { id: "add-project", text: "添加", nearbyText: "项目经历" },
  { id: "preview", text: "预览并提交", nearbyText: "" }
];

describe("Mokahr 动态区块适配", () => {
  it("通过 Mokahr/DJI URL 或页面特征识别页面", () => {
    expect(isMokahrPage({ url: "https://apply.careers.dji.com/campus-recruitment/dji/143359" })).toBe(true);
    expect(isMokahrPage({
      url: "https://careers.example.com/apply",
      pageText: "Moka 招聘 教育经历 项目经历"
    })).toBe(true);
    expect(isMokahrPage({ url: "https://careers.example.com/apply", pageText: "候选人申请表" })).toBe(false);
  });

  it("将添加动作归属到教育、工作和项目区块", () => {
    expect(classifyMokahrAddActions(actions)).toEqual([
      { actionId: "add-education", section: "education" },
      { actionId: "add-work", section: "work_combined" },
      { actionId: "add-project", section: "projects" }
    ]);
  });

  it("识别获奖和实验室区块的添加动作", () => {
    expect(classifyMokahrAddActions([
      { id: "add-award", text: "添加", nearbyText: "获奖经历" },
      { id: "add-lab", text: "添加", nearbyText: "实验室经历" }
    ])).toEqual([
      { actionId: "add-award", section: "awards" },
      { actionId: "add-lab", section: "laboratory" }
    ]);
  });

  it("为新增项目条目按稳定的填写顺序返回字段", () => {
    const fields: MokahrObservedField[] = [
      { id: "project-highlights", label: "项目要点" },
      { id: "project-name", label: "项目名称" },
      { id: "project-end", label: "结束时间" },
      { id: "project-description", label: "项目描述" },
      { id: "project-stack", label: "技术栈" },
      { id: "project-start", label: "开始时间" }
    ];

    expect(sortMokahrEntryFields("projects", fields).map((field) => field.id)).toEqual([
      "project-name",
      "project-start",
      "project-end",
      "project-description",
      "project-stack",
      "project-highlights"
    ]);
  });
});

describe("Mokahr section hints", () => {
  it("separates work, internship, combined work, and language sections", () => {
    expect(sectionHintForText("\u5b9e\u4e60\u7ecf\u5386")).toBe("internship");
    expect(sectionHintForText("\u6b63\u5f0f\u5de5\u4f5c\u7ecf\u5386")).toBe("work");
    expect(sectionHintForText("\u5de5\u4f5c/\u5b9e\u4e60\u7ecf\u5386")).toBe("work_combined");
    expect(sectionHintForText("\u8bed\u8a00\u80fd\u529b")).toBe("languages");
  });
});
