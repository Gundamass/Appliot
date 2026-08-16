import { describe, expect, it } from "vitest";
import { mokaJobAdapter } from "./moka-job-adapter.js";
import {
  campusMokaApplicationFixture,
  campusMokaDetailFixture,
  campusMokaListFixture,
  jobExpectationFixture,
  mokaApplicationFixture,
  mokaChallengeFixture,
  mokaContractDriftFixture,
  mokaDetailFixture,
  mokaListFixture,
  mokaLoginFixture
} from "./fixtures.js";

describe("mokaJobAdapter", () => {
  it("identifies supported Moka entry kinds without guessing login or challenge pages", () => {
    expect(mokaJobAdapter.identify(mokaListFixture)).toBe("job_list");
    expect(mokaJobAdapter.identify(mokaDetailFixture)).toBe("job_detail");
    expect(mokaJobAdapter.identify(mokaApplicationFixture)).toBe("application_form");
    expect(mokaJobAdapter.identify(mokaLoginFixture)).toBe("unsupported");
    expect(mokaJobAdapter.identify(mokaChallengeFixture)).toBe("unsupported");
  });

  it("identifies campus_apply entry kinds for arbitrary Mokahr tenants", () => {
    expect(mokaJobAdapter.identify(campusMokaListFixture)).toBe("job_list");
    expect(mokaJobAdapter.identify(campusMokaDetailFixture)).toBe("job_detail");
    expect(mokaJobAdapter.identify(campusMokaApplicationFixture)).toBe("application_form");
  });

  it("preserves same-domain canonical URLs from campus_apply lists", () => {
    expect(mokaJobAdapter.extractList(campusMokaListFixture).postings).toEqual([
      expect.objectContaining({
        sourceJobId: "java-lead",
        canonicalUrl: "https://app.mokahr.com/campus_apply/acme-campus/39595#/jobs/java-lead"
      })
    ]);
  });

  it("maps supported site filters and keeps salary as local-only", () => {
    const plan = mokaJobAdapter.mapFilters(jobExpectationFixture);

    expect(plan).toMatchObject({ source: "moka", adapterVersion: "moka-job-v1" });
    expect(plan.mapped).toEqual(expect.arrayContaining([
      { criterionIndex: 0, key: "keyword", values: ["Java"] },
      { criterionIndex: 1, key: "location", values: ["深圳"] },
      { criterionIndex: 2, key: "employment_type", values: ["全职"] }
    ]));
    expect(plan.localOnly).toContainEqual({ criterionIndex: 3, reasonCode: "unsupported_salary" });
  });

  it("extracts bounded list and detail postings with normalized requirements", () => {
    expect(mokaJobAdapter.extractList(mokaListFixture)).toMatchObject({
      hasNext: true,
      nextCursor: "page-2",
      postings: [{ source: "moka", sourceJobId: "moka-job-1", title: "Java 技术负责人" }]
    });
    const detail = mokaJobAdapter.extractDetail(mokaDetailFixture);
    expect(detail).toMatchObject({
      source: "moka",
      adapterVersion: "moka-job-v1",
      title: "Java 技术负责人",
      location: "深圳"
    });
    expect(detail.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "education", normalizedValue: "本科及以上", required: true }),
      expect.objectContaining({ category: "experience_years", normalizedValue: "5", required: true })
    ]));
  });

  it("rejects a contradictory list snapshot as adapter contract drift", () => {
    expect(() => mokaJobAdapter.extractList(mokaContractDriftFixture))
      .toThrow("job_adapter_contract_mismatch");
  });

  it("rejects a posting URL outside the adapter source", () => {
    const foreignPosting = {
      ...campusMokaListFixture,
      jobCards: [{ ...campusMokaListFixture.jobCards[0]!, canonicalUrl: "https://jobs.example.test/job/1001" }]
    };

    expect(() => mokaJobAdapter.extractList(foreignPosting))
      .toThrow("job_adapter_contract_mismatch");
  });

  it("does not infer Java from a JavaScript requirement", () => {
    const detail = {
      ...mokaDetailFixture,
      visibleText: ["JavaScript 和 TypeScript"]
    };

    expect(mokaJobAdapter.extractDetail(detail).requirements).toEqual([
      expect.objectContaining({ category: "skill", normalizedValue: "JavaScript" }),
      expect.objectContaining({ category: "skill", normalizedValue: "TypeScript" })
    ]);
  });
});
