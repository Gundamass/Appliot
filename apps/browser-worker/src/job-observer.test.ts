import { describe, expect, it, vi } from "vitest";
import { JobObserver } from "./job-observer.js";

const rawSnapshot = {
  entryHint: "job_list" as const,
  visibleText: ["岗位列表", "Java Tech Lead"],
  jobCards: [{
    sourceJobId: "job-1",
    canonicalUrl: "https://jobs.example.test/job/1",
    title: "Java Tech Lead",
    organization: "Example",
    location: "深圳",
    summary: "负责平台架构"
  }],
  filterState: [{ key: "location", values: ["深圳"] }],
  pagination: { kind: "page" as const, current: 1, hasNext: true, nextCursor: "page-2" }
};

function createPage() {
  return {
    url: vi.fn(() => "https://jobs.example.test/list"),
    title: vi.fn(async () => "岗位列表"),
    evaluate: vi.fn(async (_script: string) => rawSnapshot)
  };
}

describe("JobObserver", () => {
  it("returns only a bounded structured job snapshot", async () => {
    const page = createPage();
    const detector = { inspect: vi.fn(async () => ({ boundaries: [] })) };
    const snapshot = await new JobObserver(page as never, detector as never).observe("jm-1");

    expect(snapshot).toMatchObject({
      ownerId: "jm-1",
      entryHint: "job_list",
      jobCards: [{ title: "Java Tech Lead" }],
      pagination: { nextCursor: "page-2" }
    });
    expect(snapshot).not.toHaveProperty("rawDom");
    expect(snapshot).not.toHaveProperty("selectors");
  });

  it("returns challenge diagnostics instead of interpreting an unsupported boundary as no jobs", async () => {
    const page = createPage();
    const challenge = {
      kind: "unsupported_iframe" as const,
      detectedAt: "2026-08-16T00:00:00.000Z",
      reasonCode: "visible_iframe_boundary"
    };
    const detector = {
      inspect: vi.fn(async () => ({
        boundaries: [{ kind: "iframe", visible: true, interactive: true, reasonCode: "visible_interactive_iframe" }],
        challenge
      }))
    };
    const snapshot = await new JobObserver(page as never, detector as never).observe("jm-1");

    expect(snapshot.challenge).toEqual(challenge);
    expect(snapshot.boundaries).toHaveLength(1);
  });

  it("applies only mapped filters and returns the observed readback", async () => {
    const page = {
      ...createPage(),
      waitForTimeout: vi.fn(async () => undefined)
    };
    const detector = { inspect: vi.fn(async () => ({ boundaries: [] })) };
    const observer = new JobObserver(page as never, detector as never);
    const plan = {
      source: "moka" as const,
      adapterVersion: "moka-job-v1",
      mapped: [{ criterionIndex: 0, key: "location", values: ["深圳"] }],
      localOnly: [{ criterionIndex: 1, reasonCode: "unsupported_salary" }]
    };

    const snapshot = await observer.applyFilters("jm-1", plan);

    expect(page.evaluate.mock.calls[0]?.[0]).toEqual(expect.stringContaining(JSON.stringify(plan.mapped)));
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(snapshot.filterState).toEqual([{ key: "location", values: ["深圳"] }]);
  });

  it("advances with an opaque cursor and observes the resulting page", async () => {
    const page = {
      ...createPage(),
      waitForLoadState: vi.fn(async () => undefined),
      waitForTimeout: vi.fn(async () => undefined)
    };
    const detector = { inspect: vi.fn(async () => ({ boundaries: [] })) };

    await new JobObserver(page as never, detector as never).advance("jm-1", "page-2");

    expect(page.evaluate.mock.calls[0]?.[0]).toEqual(expect.stringContaining(JSON.stringify("page-2")));
    expect(page.waitForLoadState).toHaveBeenCalledWith("domcontentloaded");
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  });
});
