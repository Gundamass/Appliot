import type { AiHintPackProposal } from "@resume/contracts";
import { certifiedTextReference } from "@resume/form-semantics";
import { describe, expect, it, vi } from "vitest";
import {
  startSyntheticAts,
  type SyntheticAtsServer
} from "../../../synthetic-ats/src/server.js";
import { SyntheticReplayRunner } from "./synthetic-replay-runner.js";

function proposal(): AiHintPackProposal {
  return {
    proposalId: "proposal-replay-basic",
    taskId: "adapter-review-task",
    lifecycleStatus: "candidate",
    provider: "test-provider",
    model: "test-model",
    promptVersion: "hint-proposal-v1",
    inputHash: "a".repeat(64),
    outputHash: "b".repeat(64),
    definition: {
      schemaVersion: 1,
      packId: "adapter-replay",
      version: "1.0.0",
      match: {
        sites: [{ hostSuffix: "synthetic.test", pathPrefixes: ["/adapter-replay"] }],
        stages: ["application_form"],
        requiredTextSignals: [],
        pageFingerprintHashes: []
      },
      sectionRules: [],
      fieldRules: [
        {
          ruleId: "full-name",
          profilePath: "basics.name",
          labelAliases: ["Full name"],
          sections: [],
          controlTypes: ["text"],
          confidence: 1
        },
        {
          ruleId: "school",
          profilePath: "education[0].institution",
          labelAliases: ["School"],
          sections: [],
          controlTypes: ["text"],
          confidence: 1
        }
      ],
      actionRules: [],
      fixtures: [{
        fixtureId: "adapter-replay-basic",
        expectedProfilePaths: ["basics.name", "education[0].institution"]
      }]
    },
    unsupportedBoundaries: [],
    rejectedActions: ["terminal_submit"],
    createdAt: "2026-08-17T00:00:00.000Z"
  };
}

function proposalForFixture(fixtureId: string): AiHintPackProposal {
  const result = proposal();
  result.definition.fixtures = [{
    fixtureId,
    expectedProfilePaths: ["basics.name", "education[0].institution"]
  }];
  return result;
}

function repeatedProposal(): AiHintPackProposal {
  const result = proposalForFixture("adapter-replay-repeated");
  result.definition.fixtures[0]!.expectedProfilePaths = ["education[0].institution"];
  result.definition.sectionRules = [{
    section: "education",
    headingAliases: ["教育经历"],
    fieldOrderAliases: [["学校"]]
  }];
  result.definition.fieldRules[1]!.sections = ["education"];
  result.definition.actionRules = [{
    kind: "add_repeated_entry",
    verbs: ["添加"],
    sections: ["education"]
  }];
  return result;
}

describe("SyntheticReplayRunner", () => {
  it("fills synthetic marker values through controlled execution without submitting", async () => {
    let capturedServer: SyntheticAtsServer | undefined;
    const runner = new SyntheticReplayRunner({
      async startSyntheticAts() {
        capturedServer = await startSyntheticAts();
        return capturedServer;
      }
    });

    const replay = await runner.run(proposal());
    const state = capturedServer?.state(replay.taskId);

    expect(state?.runtime.values).toMatchObject({
      name: "MARKER_basics_name",
      school: "MARKER_education_0_institution",
      unrelatedSentinel: "UNCHANGED"
    });
    expect(state?.runtime.writeCounts.unrelatedSentinel ?? 0).toBe(0);
    expect(state?.submissionCount).toBe(0);
    expect(replay.reports).toHaveLength(1);
    expect(replay.reports[0]).toMatchObject({
      fixtureId: "adapter-replay-basic",
      status: "passed",
      submissionCount: 0
    });
    expect(replay.reports[0]?.assertions.every((assertion) => assertion.passed)).toBe(true);
  }, 60_000);

  it("replays persisted ATS text references without exposing the original labels", async () => {
    let capturedServer: SyntheticAtsServer | undefined;
    const runner = new SyntheticReplayRunner({
      async startSyntheticAts() {
        capturedServer = await startSyntheticAts();
        return capturedServer;
      }
    });
    const referenced = proposal();
    referenced.definition.fieldRules[0]!.labelAliases = [certifiedTextReference("Full name")];
    referenced.definition.fieldRules[1]!.labelAliases = [certifiedTextReference("School")];

    const replay = await runner.run(referenced);
    const state = capturedServer?.state(replay.taskId);

    expect(state?.runtime.values).toMatchObject({
      name: "MARKER_basics_name",
      school: "MARKER_education_0_institution"
    });
    expect(state?.submissionCount).toBe(0);
    expect(replay.reports[0]).toMatchObject({ status: "passed", submissionCount: 0 });
  }, 60_000);

  it("fails closed before opening a synthetic browser when deterministic validation fails", async () => {
    const start = vi.fn();
    const runner = new SyntheticReplayRunner({ startSyntheticAts: start });
    const invalid = proposal();
    invalid.definition.fieldRules[0]!.controlTypes = ["file"];

    await expect(runner.run(invalid)).rejects.toThrow("hard_gate_failed");
    expect(start).not.toHaveBeenCalled();
  });

  it("pauses at a visible iframe boundary without writing or submitting", async () => {
    let capturedServer: SyntheticAtsServer | undefined;
    const runner = new SyntheticReplayRunner({
      async startSyntheticAts() {
        capturedServer = await startSyntheticAts();
        return capturedServer;
      }
    });

    const replay = await runner.run(proposalForFixture("adapter-replay-boundary"));
    const state = capturedServer?.state(replay.taskId);
    const report = replay.reports[0];

    expect(state?.runtime.writeCounts.unrelatedSentinel ?? 0).toBe(0);
    expect(state?.submissionCount).toBe(0);
    expect(report).toMatchObject({ status: "passed", submissionCount: 0 });
    expect(report?.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "target_value", passed: true }),
      expect.objectContaining({ code: "boundary_paused", passed: true }),
      expect.objectContaining({ code: "challenge_paused", passed: true }),
      expect.objectContaining({ code: "zero_submit", passed: true })
    ]));
  }, 60_000);

  it.each([
    "adapter-replay-access-denied",
    "adapter-replay-rate-limited"
  ])("pauses on the synthetic %s response without writing", async (fixtureId) => {
    let capturedServer: SyntheticAtsServer | undefined;
    const runner = new SyntheticReplayRunner({
      async startSyntheticAts() {
        capturedServer = await startSyntheticAts();
        return capturedServer;
      }
    });

    const replay = await runner.run(proposalForFixture(fixtureId));
    const state = capturedServer?.state(replay.taskId);
    const report = replay.reports[0];

    expect(state?.runtime.writeCounts.unrelatedSentinel ?? 0).toBe(0);
    expect(state?.submissionCount).toBe(0);
    expect(report).toMatchObject({ status: "passed", submissionCount: 0 });
    expect(report?.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "challenge_paused", passed: true }),
      expect.objectContaining({ code: "zero_submit", passed: true })
    ]));
  }, 60_000);

  it("adds only the declared repeated section before filling its marker", async () => {
    let capturedServer: SyntheticAtsServer | undefined;
    const runner = new SyntheticReplayRunner({
      async startSyntheticAts() {
        capturedServer = await startSyntheticAts();
        return capturedServer;
      }
    });

    const replay = await runner.run(repeatedProposal());
    const state = capturedServer?.state(replay.taskId);
    const report = replay.reports[0];

    expect(state?.runtime.values.school).toBe("MARKER_education_0_institution");
    expect(state?.runtime.repeatedOrder).toEqual(["education"]);
    expect(state?.submissionCount).toBe(0);
    expect(report).toMatchObject({ status: "passed", submissionCount: 0 });
    expect(report?.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "repeat_order", passed: true }),
      expect.objectContaining({ code: "zero_submit", passed: true })
    ]));
  }, 60_000);
});
