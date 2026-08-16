import { describe, expect, it } from "vitest";
import { fieldOperationKey } from "./field-operation-key.js";

const baseInput = {
  taskId: "task-1",
  sectionHint: "education",
  entryIndex: 0,
  semanticPath: "education[0].major",
  controlRole: "search"
} as const;

describe("fieldOperationKey", () => {
  it("同一语义字段在 DOM 重渲染后保持稳定且不依赖字段 ID", () => {
    const first = fieldOperationKey(baseInput);
    const rerendered = fieldOperationKey({ ...baseInput });

    expect(first).toBe(rerendered);
    expect(first).not.toContain("field_");
  });

  it.each([
    ["栏目", { sectionHint: "work" }],
    ["条目索引", { entryIndex: 1 }],
    ["语义路径", { semanticPath: "education[0].school" }],
    ["控件角色", { controlRole: "text" }]
  ] as const)("%s 变化时生成不同操作键", (_label, override) => {
    expect(fieldOperationKey({ ...baseInput, ...override })).not.toBe(fieldOperationKey(baseInput));
  });

  it("日期年、月组件分别拥有独立的尝试额度", () => {
    const startYear = fieldOperationKey({
      ...baseInput,
      semanticPath: "projects[0].startDate.year",
      controlRole: "select"
    });
    const startMonth = fieldOperationKey({
      ...baseInput,
      semanticPath: "projects[0].startDate.month",
      controlRole: "select"
    });

    expect(startYear).not.toBe(startMonth);
  });

  it("distinguishes split date controls that share one canonical semantic path", () => {
    const startYear = fieldOperationKey({
      ...baseInput,
      semanticPath: "projects[0].startDate",
      controlRole: "search",
      fieldLabel: "\u5f00\u59cb\u65f6\u95f4 \u5e74"
    });
    const startMonth = fieldOperationKey({
      ...baseInput,
      semanticPath: "projects[0].startDate",
      controlRole: "search",
      fieldLabel: "\u5f00\u59cb\u65f6\u95f4 \u6708"
    });

    expect(startYear).not.toBe(startMonth);
  });
});
