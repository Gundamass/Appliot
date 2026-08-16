import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "@resume/model-provider";
import type { FieldDefinition } from "@resume/form-semantics";
import {
  FieldOntologyIndex,
  fieldOntologyKey,
  type EmbeddingIdentity
} from "./field-ontology-index.js";

const identity: EmbeddingIdentity = {
  model: "embedding-model",
  modelRevision: "revision-1",
  instructionVersion: "ontology-v1"
};

const baseDefinition: FieldDefinition = {
  semantic: "education[].major",
  label: "专业",
  aliases: ["所学专业"],
  types: ["text", "select"],
  sections: ["education"],
  risk: "normal",
  description: "候选人的专业"
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("fieldOntologyKey", () => {
  it.each([
    ["semantic", { semantic: "education[].fieldOfStudy" }],
    ["label", { label: "主修专业" }],
    ["aliases", { aliases: ["专业名称"] }],
    ["types", { types: ["text"] }],
    ["sections", { sections: ["basics"] }],
    ["risk", { risk: "sensitive" }],
    ["description", { description: "另一份说明" }]
  ] as const)("changes when definition %s changes", (_property, patch) => {
    const changed = { ...baseDefinition, ...patch } as FieldDefinition;
    expect(fieldOntologyKey([changed], identity)).not.toBe(fieldOntologyKey([baseDefinition], identity));
  });

  it.each([
    ["model", { model: "other-model" }],
    ["modelRevision", { modelRevision: "revision-2" }],
    ["instructionVersion", { instructionVersion: "ontology-v2" }]
  ] as const)("changes when identity %s changes", (_property, patch) => {
    expect(fieldOntologyKey([baseDefinition], { ...identity, ...patch }))
      .not.toBe(fieldOntologyKey([baseDefinition], identity));
  });

  it("ignores object property insertion order but preserves definition order", () => {
    const reordered: FieldDefinition = {
      description: baseDefinition.description,
      risk: baseDefinition.risk,
      sections: baseDefinition.sections,
      types: baseDefinition.types,
      aliases: baseDefinition.aliases,
      label: baseDefinition.label,
      semantic: baseDefinition.semantic
    };
    const second = { ...baseDefinition, semantic: "education[].degree", label: "学历" };

    expect(fieldOntologyKey([reordered], identity)).toBe(fieldOntologyKey([baseDefinition], identity));
    expect(fieldOntologyKey([baseDefinition, second], identity))
      .not.toBe(fieldOntologyKey([second, baseDefinition], identity));
  });
});

describe("FieldOntologyIndex", () => {
  it("singleflights concurrent builds and protects cached vectors from mutation", async () => {
    const gate = deferred<number[][]>();
    const embedDocuments = vi.fn(() => gate.promise);
    const provider: EmbeddingProvider = { embedDocuments, embedQuery: vi.fn() };
    const index = new FieldOntologyIndex(provider);

    const loads = Array.from({ length: 20 }, () => index.load([baseDefinition], identity));
    await vi.waitFor(() => expect(embedDocuments).toHaveBeenCalledTimes(1));
    gate.resolve([[1, 0]]);
    const results = await Promise.all(loads);

    expect(results).toHaveLength(20);
    expect(results.every((vectors) => Object.isFrozen(vectors) && Object.isFrozen(vectors[0]))).toBe(true);
    expect(() => (results[0]![0] as unknown as number[])[0] = 99).toThrow();
    await expect(index.load([baseDefinition], identity)).resolves.toEqual([[1, 0]]);
    expect(embedDocuments).toHaveBeenCalledTimes(1);
  });

  it("removes failed in-flight builds so a later call can retry", async () => {
    const first = deferred<number[][]>();
    const embedDocuments = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce([[0, 1]]);
    const index = new FieldOntologyIndex({ embedDocuments, embedQuery: vi.fn() });
    const loads = Array.from({ length: 20 }, () => index.load([baseDefinition], identity));
    await vi.waitFor(() => expect(embedDocuments).toHaveBeenCalledTimes(1));
    first.reject(new Error("offline"));

    await expect(Promise.all(loads)).rejects.toThrow("offline");
    await expect(index.load([baseDefinition], identity)).resolves.toEqual([[0, 1]]);
    expect(embedDocuments).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["count mismatch", []],
    ["empty vector", [[]]],
    ["non-finite vector", [[Number.NaN]]],
    ["inconsistent dimensions", [[1, 0], [1]]]
  ])("rejects %s without publishing partial vectors", async (_case, vectors) => {
    const twoDefinitions = [
      baseDefinition,
      { ...baseDefinition, semantic: "education[].degree", label: "学历" }
    ];
    const embedDocuments = vi.fn().mockResolvedValue(vectors);
    const index = new FieldOntologyIndex({ embedDocuments, embedQuery: vi.fn() });

    await expect(index.load(twoDefinitions, identity)).rejects.toThrow();
    await expect(index.load(twoDefinitions, identity)).rejects.toThrow();
    expect(embedDocuments).toHaveBeenCalledTimes(2);
  });
});
