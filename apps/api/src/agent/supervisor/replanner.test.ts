import { describe, expect, it } from "vitest";
import { ObservationRefSchema } from "@resume/contracts";
import { createPlanner } from "./planner.js";
import { createReplanner } from "./replanner.js";
import { intentForApplication } from "./planner.test.js";

const newObservation = ObservationRefSchema.parse({
  id: "observation-2",
  kind: "browser",
  sourceRef: "snapshot:2",
  contentHash: "b".repeat(64),
  snapshotId: "snapshot-2",
  executionEpoch: 2,
  createdAt: "2026-09-03T00:01:00.000Z"
});

describe("Replanner", () => {
  it("creates a new revision when an observation invalidates a prerequisite", async () => {
    const plan = await createPlanner({ idFactory: () => "plan-id", now: () => "2026-09-03T00:00:00.000Z" })
      .create(intentForApplication);
    const replanner = createReplanner({ now: () => "2026-09-03T00:01:00.000Z" });

    const next = await replanner.replan(plan, {
      reason: "target_page_changed",
      observations: [newObservation]
    });

    expect(next.revision).toBe(plan.revision + 1);
    expect(next.previousRevision).toBe(plan.revision);
    expect(next.revisionHistory?.at(-1)?.revision).toBe(plan.revision);
  });
});
