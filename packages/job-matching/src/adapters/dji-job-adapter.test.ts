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
  it("identifies DJI list, detail and application entries only on the DJI host", () => {
    expect(djiJobAdapter.identify(djiListFixture)).toBe("job_list");
    expect(djiJobAdapter.identify(djiDetailFixture)).toBe("job_detail");
    expect(djiJobAdapter.identify(djiApplicationFixture)).toBe("application_form");
    expect(djiJobAdapter.identify(mokaListFixture)).toBe("unsupported");
  });

  it("uses DJI filter keys and leaves unsupported salary local", () => {
    const plan = djiJobAdapter.mapFilters(jobExpectationFixture);

    expect(plan).toMatchObject({ source: "dji", adapterVersion: "dji-job-v1" });
    expect(plan.mapped).toEqual(expect.arrayContaining([
      { criterionIndex: 0, key: "keyword", values: ["Java"] },
      { criterionIndex: 1, key: "work_location", values: ["深圳"] },
      { criterionIndex: 2, key: "job_type", values: ["全职"] }
    ]));
    expect(plan.localOnly).toContainEqual({ criterionIndex: 3, reasonCode: "unsupported_salary" });
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
