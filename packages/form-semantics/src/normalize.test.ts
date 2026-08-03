import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { classifyAction } from "./action-classifier.js";
import { normalizeForm } from "./normalize.js";
import { collectRawFormObservation } from "./snapshot-script.js";

describe("form semantics", () => {
  it.each([
    ["下一步", "application_form", "intermediate_navigation"],
    ["保存草稿", "application_form", "intermediate_save"],
    ["提交申请", "review", "terminal_submit"],
    ["确认投递", "review", "terminal_submit"],
    ["立即申请", "application_form", "terminal_submit"],
    ["发送验证码", "login", "unknown_side_effect"],
    ["确认", "review", "unknown_side_effect"]
  ] as const)("classifies %s on %s as %s", (text, stage, expected) => {
    expect(classifyAction({ text, stage, nearbyText: stage === "review" ? "确认后将正式投递" : "" })).toBe(expected);
  });

  it("normalizes accessible fields into stable opaque IDs without leaking DOM paths", async () => {
    const html = await readFile(join(process.cwd(), "../../tests/fixtures/forms/generic-application.html"), "utf8");
    const dom = new JSDOM(html, { url: "https://ats.example.test/application" });
    const raw = collectRawFormObservation(dom.window.document);
    const context = {
      taskId: "task-1",
      url: dom.window.location.href,
      title: dom.window.document.title,
      stage: "application_form" as const
    };

    const first = normalizeForm(raw, context);
    const second = normalizeForm(raw, context);

    expect(first.fields).toEqual(second.fields);
    expect(first.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "姓名", type: "text", required: true, currentValue: "" }),
      expect.objectContaining({ label: "最高学历", type: "select", options: ["本科", "硕士", "博士"] }),
      expect.objectContaining({ label: "接受调剂", type: "checkbox", currentValue: false }),
      expect.objectContaining({ label: "简历附件", type: "file", currentValue: "" })
    ]));
    expect(first.fields.every((field) => /^field_[a-f0-9]{16}$/.test(field.id))).toBe(true);
    expect(JSON.stringify(first)).not.toContain("#full-name");
    expect(first.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "保存草稿", class: "intermediate_save" }),
      expect.objectContaining({ text: "下一步", class: "intermediate_navigation" }),
      expect.objectContaining({ text: "提交申请", class: "terminal_submit" })
    ]));
  });
});
