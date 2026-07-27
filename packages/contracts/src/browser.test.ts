import { describe, expect, it } from "vitest";
import { ExecutableCommandSchema } from "./browser.js";

describe("browser command contracts", () => {
  it("rejects terminal submit because it is not executable", () => {
    expect(ExecutableCommandSchema.safeParse({
      type: "submit",
      taskId: "task-1",
      actionId: "final"
    }).success).toBe(false);
  });

  it("accepts fill and intermediate-click commands with opaque IDs", () => {
    expect(ExecutableCommandSchema.safeParse({
      type: "fill",
      taskId: "task-1",
      snapshotId: "snapshot-1",
      fieldId: "field-name",
      value: "Ada Lovelace",
      approval: "approval-1"
    }).success).toBe(true);
    expect(ExecutableCommandSchema.safeParse({
      type: "click_intermediate",
      taskId: "task-1",
      snapshotId: "snapshot-1",
      actionId: "action-save",
      approval: "approval-2"
    }).success).toBe(true);
  });

  it("rejects arbitrary browser scripting", () => {
    expect(ExecutableCommandSchema.safeParse({
      type: "evaluate",
      taskId: "task-1",
      script: "document.querySelector('form').submit()"
    }).success).toBe(false);
  });
});
