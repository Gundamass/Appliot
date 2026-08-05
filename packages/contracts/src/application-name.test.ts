import { describe, expect, it } from "vitest";
import { ApplicationTaskInputSchema, ApplicationTaskSchema } from "./application.js";
import { suggestApplicationTaskName } from "./application-name.js";

describe("application task names", () => {
  it("suggests a localized DJI task name", () => {
    expect(suggestApplicationTaskName("https://apply.careers.dji.com/campus-recruitment/dji/143359"))
      .toBe("大疆校招投递");
    expect(suggestApplicationTaskName("https://app.mokahr.com/m/campus-recruitment/dji/143359#/jobs"))
      .toBe("大疆校招投递");
  });

  it("falls back to the normalized website hostname", () => {
    expect(suggestApplicationTaskName("https://www.jobs.example.com/apply/1"))
      .toBe("jobs.example.com 投递");
  });

  it("trims valid names and rejects blank or oversized names", () => {
    const applicationUrl = "https://jobs.example.com/apply/1";
    expect(ApplicationTaskInputSchema.parse({ applicationUrl, name: "  后端岗位  " }).name).toBe("后端岗位");
    expect(ApplicationTaskInputSchema.safeParse({ applicationUrl, name: "   " }).success).toBe(false);
    expect(ApplicationTaskInputSchema.safeParse({ applicationUrl, name: "任".repeat(81) }).success).toBe(false);
    expect(ApplicationTaskInputSchema.safeParse({ applicationUrl }).success).toBe(true);
  });

  it("keeps the task name optional for existing task responses", () => {
    const task = ApplicationTaskSchema.parse({
      id: "91dc4bd6-425a-4cab-a38d-d13e33cda771",
      applicationUrl: "https://jobs.example.com/apply/1",
      name: "  大疆后端岗位  ",
      state: "created",
      commands: []
    });

    expect(task.name).toBe("大疆后端岗位");
    expect(ApplicationTaskSchema.safeParse({
      id: "91dc4bd6-425a-4cab-a38d-d13e33cda771",
      applicationUrl: "https://jobs.example.com/apply/1",
      state: "created",
      commands: []
    }).success).toBe(true);
  });
});
