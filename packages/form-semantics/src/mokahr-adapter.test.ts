import { describe, expect, it } from "vitest";
import {
  classifyMokahrAddActions,
  isMokahrPage,
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
      { actionId: "add-work", section: "work" },
      { actionId: "add-project", section: "projects" }
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
