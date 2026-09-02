import { describe, expect, it } from "vitest";
import { createAmbiguityDetector } from "./ambiguity-detector.js";

describe("AmbiguityDetector", () => {
  it("marks a target job as blocking when several jobs are available", () => {
    const detector = createAmbiguityDetector();
    const result = detector.detect({
      primaryGoal: "prepare_application",
      subGoals: ["fill_application"],
      entities: {},
      constraints: [],
      preferences: [],
      successCriteria: [],
      confidence: 0.8
    }, {
      availableJobs: [
        { id: "job-1", label: "后端工程师" },
        { id: "job-2", label: "高级后端工程师" }
      ],
      availableResumes: [{ id: "resume-1", label: "2026 简历" }]
    });

    expect(result.missing.some((item) => item.field === "targetJob" && item.blocking)).toBe(true);
  });

  it("does not treat an explicit company and job URL as ambiguous", () => {
    const detector = createAmbiguityDetector();
    const result = detector.detect({
      primaryGoal: "analyze_job",
      subGoals: ["identify_target_job"],
      entities: {
        company: { value: "字节跳动", source: "user_explicit", confidence: 1, evidenceRefs: [], requiresConfirmation: false },
        applicationUrl: { value: "https://jobs.example.com/123", source: "user_explicit", confidence: 1, evidenceRefs: [], requiresConfirmation: false }
      },
      constraints: [],
      preferences: [],
      successCriteria: [],
      confidence: 1
    }, { availableJobs: [], availableResumes: [] });

    expect(result.missing).toEqual([]);
    expect(result.ambiguities).toEqual([]);
  });
});
