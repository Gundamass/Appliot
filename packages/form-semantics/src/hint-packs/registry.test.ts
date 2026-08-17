import { describe, expect, it } from "vitest";
import type { CertifiedHintPack, FormSnapshot } from "@resume/contracts";
import { djiHintPack } from "./dji-pack.js";
import { mokahrHintPack } from "./mokahr-pack.js";
import { createHintPackRegistry, fingerprintSnapshot } from "./registry.js";

const nodeRef = {
  documentId: "document-fixture-00000001",
  nodeId: "node-fixture-000000000001",
  observedAt: 7
};

describe("certified hint-pack registry", () => {
  it("selects the more-specific DJI pack, freezes it, and falls back to review only", () => {
    const registry = createHintPackRegistry({
      builtIns: [mokahrHintPack, djiHintPack],
      local: () => [],
      isRetired: () => false
    });

    const dji = registry.resolve(snapshot("https://app.mokahr.com/campus-recruitment/dji/143359", ["毕业院校"]));
    expect(dji).toMatchObject({
      kind: "certified",
      pack: { packId: "dji-campus", lifecycleStatus: "certified" }
    });
    if (dji.kind !== "certified") throw new Error("expected certified pack");
    expect(Object.isFrozen(dji.pack)).toBe(true);
    expect(Object.isFrozen(dji.pack.fieldRules)).toBe(true);

    expect(registry.resolve(snapshot("https://jobs.example.test/apply", ["姓名"]))).toEqual({
      kind: "review_only",
      reason: "no_certified_pack",
      mismatchedPacks: []
    });
  });

  it("never resolves a candidate and reports matching-site fingerprint drift", () => {
    const candidate = { ...djiHintPack, lifecycleStatus: "candidate" } as unknown as CertifiedHintPack;
    const candidateRegistry = createHintPackRegistry({
      builtIns: [],
      local: () => [candidate],
      isRetired: () => false
    });

    expect(candidateRegistry.resolve(snapshot("https://apply.careers.dji.com/campus", ["毕业院校"]))).toEqual({
      kind: "review_only",
      reason: "no_certified_pack",
      mismatchedPacks: []
    });

    const fingerprintBound = {
      ...djiHintPack,
      match: { ...djiHintPack.match, pageFingerprintHashes: ["f".repeat(64)] }
    };
    const fingerprintRegistry = createHintPackRegistry({
      builtIns: [fingerprintBound],
      local: () => [],
      isRetired: () => false
    });

    expect(fingerprintRegistry.resolve(snapshot("https://apply.careers.dji.com/campus", ["毕业院校"]))).toEqual({
      kind: "review_only",
      reason: "fingerprint_mismatch",
      mismatchedPacks: [{ packId: "dji-campus", version: "1.0.0" }]
    });
  });

  it("keeps host and path pair matching coupled and fingerprints no field values", () => {
    const coupledPack = {
      ...djiHintPack,
      packId: "coupled-test",
      match: {
        ...djiHintPack.match,
        sites: [
          { hostSuffix: "one.example.test", pathPrefixes: ["/one"] },
          { hostSuffix: "two.example.test", pathPrefixes: ["/two"] }
        ]
      }
    };
    const registry = createHintPackRegistry({
      builtIns: [coupledPack],
      local: () => [],
      isRetired: () => false
    });
    const valueA = snapshot("https://one.example.test/one/apply", ["毕业院校"]);
    const valueB = {
      ...valueA,
      fields: [{ ...valueA.fields[0]!, currentValue: "different private value" }]
    };

    expect(registry.resolve(snapshot("https://one.example.test/two/apply", ["毕业院校"])).kind).toBe("review_only");
    expect(fingerprintSnapshot(valueA)).toBe(fingerprintSnapshot(valueB));
  });
});

function snapshot(url: string, labels: string[]): FormSnapshot {
  return {
    id: "snapshot-registry",
    taskId: "task-registry",
    url,
    title: "Certified pack fixture",
    stage: "application_form",
    frameRef: { documentId: nodeRef.documentId, kind: "main" },
    mutationEpoch: nodeRef.observedAt,
    fields: labels.map((label, index) => ({
      id: `field-${index}`,
      label,
      type: "text" as const,
      required: false,
      options: [],
      currentValue: "",
      ...(label === "毕业院校" ? { sectionHint: "education" as const } : {}),
      nodeRef
    })),
    actions: [],
    errors: []
  };
}
