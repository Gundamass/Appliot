import { expect, test } from "@playwright/test";
import { SyntheticReplayRunner } from "../../apps/api/src/ats-adapters/synthetic-replay-runner.js";
import {
  startSyntheticAts,
  type SyntheticAtsServer
} from "../../apps/synthetic-ats/src/server.js";
import type { AiHintPackProposal } from "../../packages/contracts/src/ats-adapter.js";

test("candidate pack fills marker values through controlled execution without submitting", async () => {
  let synthetic: SyntheticAtsServer | undefined;
  const runner = new SyntheticReplayRunner({
    async startSyntheticAts() {
      synthetic = await startSyntheticAts();
      return synthetic;
    }
  });

  const replay = await runner.run(proposalFor("adapter-replay-basic"));
  const state = synthetic?.state(replay.taskId);

  expect(state?.runtime.values).toMatchObject({
    name: "MARKER_basics_name",
    school: "MARKER_education_0_institution",
    unrelatedSentinel: "UNCHANGED"
  });
  expect(state?.runtime.writeCounts.unrelatedSentinel ?? 0).toBe(0);
  expect(state?.submissionCount).toBe(0);
  expect(replay.reports).toHaveLength(1);
  expect(replay.reports[0]?.status).toBe("passed");
  expect(replay.reports[0]?.submissionCount).toBe(0);
  expect(replay.reports[0]?.assertions.every((assertion) => assertion.passed)).toBe(true);
});

function proposalFor(fixtureId: string): AiHintPackProposal {
  return {
    proposalId: "browser-replay-proposal",
    taskId: "browser-replay-task",
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
        fixtureId,
        expectedProfilePaths: ["basics.name", "education[0].institution"]
      }]
    },
    unsupportedBoundaries: [],
    rejectedActions: ["terminal_submit"],
    createdAt: "2026-08-17T00:00:00.000Z"
  };
}
