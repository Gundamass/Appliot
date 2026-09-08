import { describe, expect, it } from "vitest";
import { djiJobAdapter } from "./dji-job-adapter.js";
import {
  djiApplicationFixture,
  djiDetailFixture,
  djiListFixture,
  jobExpectationFixture,
  mokaListFixture
} from "./fixtures.js";

describe("djiJobAdapter", () => {
  it("normalizes the current DJI campus landing page to its live jobs portal", () => {
    expect(djiJobAdapter.normalizeEntryUrl?.(
      new URL("https://careers.dji.com/zh-CN/campus?source=RM-Title")
    )?.toString()).toBe(
      "https://apply.careers.dji.com/campus-recruitment/dji/143359?locale=zh-CN#/"
    );
  });

  it("identifies DJI list, detail and application entries only on the DJI host", () => {
    expect(djiJobAdapter.identify(djiListFixture)).toBe("job_list");
    expect(djiJobAdapter.identify(djiDetailFixture)).toBe("job_detail");
    expect(djiJobAdapter.identify(djiApplicationFixture)).toBe("application_form");
    expect(djiJobAdapter.identify(mokaListFixture)).toBe("unsupported");
  });

  it("identifies the current DJI campus portal list after the landing-page redirect", () => {
    expect(djiJobAdapter.identify({
      ...djiListFixture,
      url: "https://apply.careers.dji.com/campus-recruitment/dji/143359?locale=zh-CN#/",
      jobCards: [{
        ...djiListFixture.jobCards[0]!,
        canonicalUrl: "https://apply.careers.dji.com/campus-recruitment/dji/143359?locale=zh-CN#/job/job-1"
      }]
    })).toBe("job_list");
  });

  it("uses DJI filter keys and leaves unsupported salary local", () => {
    const plan = djiJobAdapter.mapFilters(jobExpectationFixture);

    expect(plan).toMatchObject({ source: "dji", adapterVersion: "dji-job-v1" });
    expect(plan.mapped).toEqual(expect.arrayContaining([
      { criterionIndex: 0, key: "keyword", values: ["Java"] },
      { criterionIndex: 1, key: "work_location", values: ["深圳"] },
    ]));
    expect(plan.localOnly).toEqual(expect.arrayContaining([
      { criterionIndex: 2, reasonCode: "unsupported_employment_type" },
      { criterionIndex: 3, reasonCode: "unsupported_salary" }
    ]));
  });

  it("does not send an unrestricted location to the DJI portal", () => {
    const expectation = {
      ...jobExpectationFixture,
      criteria: jobExpectationFixture.criteria.map((criterion) => criterion.kind === "location"
        ? { ...criterion, values: ["\u5168\u56fd"] }
        : criterion)
    };
    const plan = djiJobAdapter.mapFilters(expectation);

    expect(plan.mapped).not.toContainEqual(expect.objectContaining({ key: "work_location" }));
    expect(plan.localOnly).toContainEqual({ criterionIndex: 1, reasonCode: "unrestricted_location" });
  });

  it("extracts DJI list and detail data without inventing absent fields", () => {
    expect(djiJobAdapter.extractList(djiListFixture).postings[0]).toMatchObject({
      source: "dji",
      sourceJobId: "dji-job-1",
      title: "后端开发工程师",
      organization: "DJI"
    });
    const detail = djiJobAdapter.extractDetail(djiDetailFixture);
    expect(detail.location).toBe("深圳");
    expect(detail.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "major", normalizedValue: "计算机相关专业", required: true }),
      expect.objectContaining({ category: "skill", normalizedValue: "Java", required: true })
    ]));
    expect(detail).not.toHaveProperty("employmentType");
  });
});
