import { describe, expect, it } from "vitest";
import type { FormSnapshot } from "@resume/contracts";
import { annotateDjiFields } from "./dji-field-catalog.js";

const taskId = "3ed8b553-6fd4-4b42-90ba-0a40fcdc9632";

describe("DJI field catalog", () => {
  it("annotates confirmed DJI fields with stable profile semantics", () => {
    const snapshot = annotateDjiFields(makeSnapshot("https://apply.careers.dji.com/campus-recruitment/dji/143359#/apply", [
      textField("姓名"),
      textField("手机号码"),
      textField("毕业院校"),
      textField("项目名称"),
      selectField("获奖级别", ["国家级", "省级", "校级"])
    ]));

    expect(snapshot.fields.map(({ label, semanticHint }) => ({ label, semanticHint }))).toEqual([
      { label: "姓名", semanticHint: "basics.name" },
      { label: "手机号码", semanticHint: "basics.phone" },
      { label: "毕业院校", semanticHint: "education[0].institution" },
      { label: "项目名称", semanticHint: "projects[0].name" },
      { label: "获奖级别", semanticHint: "awards[0].level" }
    ]);
  });

  it("leaves non-DJI and unknown fields without a catalog semantic", () => {
    const nonDji = annotateDjiFields(makeSnapshot("https://example.com/application", [textField("毕业院校")]));
    const unknown = annotateDjiFields(makeSnapshot("https://apply.careers.dji.com/campus-recruitment/dji/143359#/apply", [
      textField("未命名字段")
    ]));

    expect(nonDji.fields[0]?.semanticHint).toBeUndefined();
    expect(unknown.fields[0]?.semanticHint).toBeUndefined();
  });

  it("rejects catalog entries with an incompatible observed control type", () => {
    const snapshot = annotateDjiFields(makeSnapshot("https://apply.careers.dji.com/campus-recruitment/dji/143359#/apply", [
      selectField("项目名称", ["项目 A", "项目 B"])
    ]));

    expect(snapshot.fields[0]?.semanticHint).toBeUndefined();
  });
});

function makeSnapshot(url: string, fields: FormSnapshot["fields"]): FormSnapshot {
  return {
    id: "snapshot-dji-catalog",
    taskId,
    url,
    title: "DJI Campus Recruitment",
    stage: "application_form",
    fields,
    actions: [],
    errors: []
  };
}

function textField(label: string): FormSnapshot["fields"][number] {
  return { id: `field-${label}`, label, type: "text", required: false, options: [], currentValue: "" };
}

function selectField(label: string, options: string[]): FormSnapshot["fields"][number] {
  return { id: `field-${label}`, label, type: "select", required: false, options, currentValue: "" };
}
