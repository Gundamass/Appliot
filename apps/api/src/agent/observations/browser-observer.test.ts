import { describe, expect, it } from "vitest";
import { createBrowserObserver } from "./browser-observer.js";

describe("BrowserObserver", () => {
  it("rejects stale epoch, snapshot, target, and node bindings", async () => {
    const observer = createBrowserObserver({
      observe: async () => ({
        snapshotId: "snapshot-new",
        executionEpoch: 2,
        targetFingerprint: "target-new",
        nodeRefs: ["node-new"]
      })
    });
    const current = await observer.observe("task-1", 2);

    expect(observer.validate(current, {
      snapshotId: "snapshot-old",
      executionEpoch: 2,
      targetFingerprint: "target-new",
      nodeRef: "node-new"
    })).toEqual({ valid: false, reason: "stale_observation" });
    expect(observer.validate(current, {
      snapshotId: "snapshot-new",
      executionEpoch: 1,
      targetFingerprint: "target-new",
      nodeRef: "node-new"
    })).toEqual({ valid: false, reason: "stale_execution_epoch" });
    expect(observer.validate(current, {
      snapshotId: "snapshot-new",
      executionEpoch: 2,
      targetFingerprint: "target-new",
      nodeRef: "node-missing"
    })).toEqual({ valid: false, reason: "stale_node_ref" });
  });
});
