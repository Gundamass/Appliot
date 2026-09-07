import { describe, expect, it, vi } from "vitest";
import {
  ApplicationSkillVersionSchema,
  SkillBindingSchema,
  type ApplicationSkillVersion,
  type FormSnapshot,
  type SkillBinding
} from "@resume/contracts";
import {
  createApplicationSkillRuntime,
  SkillSelector,
  type SkillBindingStorePort,
  type SkillPageAllocation,
  type SkillRegistrySelectionPort
} from "./skill-selector.js";

const PAGE_HASH = "c".repeat(64);

describe("SkillSelector", () => {
  it("selects only the Champion before controlled live allocation is enabled", async () => {
    const allocation = allocationFixture({ championPercent: 50, challengerPercent: 50 });
    const registry = new FakeRegistry(allocation, [
      skillFixture("1.0.0", "champion"),
      skillFixture("1.1.0", "challenger")
    ]);

    const selection = await new SkillSelector(registry, new MemoryBindingStore()).selectForTask({
      taskId: "task-before-live-allocation",
      site: "baidu",
      pageFingerprintHash: PAGE_HASH
    });

    expect(selection).toMatchObject({ kind: "selected", binding: { version: "1.0.0" } });
  });

  it("persists only a strict SkillBinding and returns the same binding after restart and promotion", async () => {
    const store = new MemoryBindingStore();
    const registry = new FakeRegistry(allocationFixture({ championPercent: 100, challengerPercent: 0 }), [
      skillFixture("1.0.0", "champion")
    ]);
    const input = { taskId: "task-pinned", site: "baidu" as const, pageFingerprintHash: PAGE_HASH };

    const first = await new SkillSelector(registry, store).selectForTask(input);
    expect(first.kind).toBe("selected");
    expect(store.lastCandidate === undefined ? undefined : Object.keys(store.lastCandidate).sort()).toEqual([
      "allocationId",
      "pageFingerprintHash",
      "site",
      "skillId",
      "version"
    ]);
    expect(SkillBindingSchema.safeParse(store.lastCandidate).success).toBe(true);

    registry.allocation = {
      ...allocationFixture({ championPercent: 100, challengerPercent: 0 }),
      allocationId: "allocation-promoted",
      championVersion: "2.0.0"
    };
    registry.versions.set("baidu-application@2.0.0", skillFixture("2.0.0", "champion"));
    const readsBeforeRestart = registry.allocationReads;

    const afterRestart = await new SkillSelector(registry, store).selectForTask(input);

    expect(afterRestart).toEqual(first);
    expect(registry.allocationReads).toBe(readsBeforeRestart);
    expect(store.persistedCount).toBe(1);
  });

  it("atomically pins exactly one winner during concurrent first selection", async () => {
    const store = new MemoryBindingStore();
    const registry = new FakeRegistry(allocationFixture({ championPercent: 100, challengerPercent: 0 }), [
      skillFixture("1.0.0", "champion")
    ]);
    const selector = new SkillSelector(registry, store);
    const input = { taskId: "task-concurrent", site: "baidu" as const, pageFingerprintHash: PAGE_HASH };

    const [left, right] = await Promise.all([
      selector.selectForTask(input),
      selector.selectForTask(input)
    ]);

    expect(left).toEqual(right);
    expect(left.kind).toBe("selected");
    expect(store.putAttempts).toBe(2);
    expect(store.persistedCount).toBe(1);
    expect(store.size).toBe(1);
  });

  it("hands off to observe-only when no page allocation matches, without invoking write or execution hooks", async () => {
    const registry = new FakeRegistry(undefined, []);
    const store = new MemoryBindingStore();
    const forbiddenWrite = vi.fn();
    const forbiddenExecute = vi.fn();
    Object.assign(registry, { write: forbiddenWrite, execute: forbiddenExecute });

    const result = await new SkillSelector(registry, store).selectForTask({
      taskId: "task-unmatched",
      site: "baidu",
      pageFingerprintHash: PAGE_HASH
    });

    expect(result).toEqual({ kind: "observe_only_handoff", reason: "page_unmatched" });
    expect(store.putAttempts).toBe(0);
    expect(forbiddenWrite).not.toHaveBeenCalled();
    expect(forbiddenExecute).not.toHaveBeenCalled();
  });

  it.each([
    ["missing champion", []],
    ["non-champion champion slot", [skillFixture("1.0.0", "candidate")]],
    ["malformed registry object", [{ skillId: "unsafe", version: "1.0.0" }]]
  ])("hands off to observe-only for %s", async (_label, versions) => {
    const registry = new FakeRegistry(
      allocationFixture({ championPercent: 100, challengerPercent: 0 }),
      versions as ApplicationSkillVersion[]
    );
    const store = new MemoryBindingStore();

    const result = await new SkillSelector(registry, store).selectForTask({
      taskId: "task-unsafe",
      site: "baidu",
      pageFingerprintHash: PAGE_HASH
    });

    expect(result).toEqual({ kind: "observe_only_handoff", reason: "safe_version_unavailable" });
    expect(store.putAttempts).toBe(0);
  });

  it("falls back to the valid champion when an allocated challenger is not safe", async () => {
    const registry = new FakeRegistry(allocationFixture({ championPercent: 0, challengerPercent: 100 }), [
      skillFixture("1.0.0", "champion"),
      skillFixture("1.1.0", "quarantined")
    ]);

    const result = await new SkillSelector(registry, new MemoryBindingStore()).selectForTask({
      taskId: "task-quarantined-challenger",
      site: "baidu",
      pageFingerprintHash: PAGE_HASH
    });

    expect(result).toMatchObject({ kind: "selected", binding: { version: "1.0.0" } });
  });

  it("matches the observed application page before pinning and compiles finite directives", async () => {
    const store = new MemoryBindingStore();
    const registry = new FakeRegistry(undefined, [skillFixture("1.0.0", "champion")]);
    const runtime = createApplicationSkillRuntime({ registry, bindingStoreFor: () => store });

    const result = await runtime.resolve({
      runId: "run-matched",
      taskId: "task-matched",
      snapshot: applicationSnapshot()
    });

    expect(result).toMatchObject({
      kind: "selected",
      binding: { skillId: "baidu-application", version: "1.0.0", site: "baidu" },
      pageVariantId: "application-form",
      allocation: "champion",
      directives: expect.arrayContaining([{ kind: "verify-field", semantic: "basics.name" }])
    });
    expect(registry.boundPages).toHaveLength(1);
    expect(store.persistedCount).toBe(1);
  });

  it("hands off before binding when a writable semantic maps to multiple observed controls", async () => {
    const store = new MemoryBindingStore();
    const skill = skillFixture("1.0.0", "champion");
    skill.content.capabilities = ["observe", "fill_empty_fields", "readback", "full_page_audit"];
    skill.content.workflow[0]!.actions = [
      { capability: "fill_empty_fields", semantics: ["basics.name"] },
      { capability: "readback", semantics: ["basics.name"] },
      { capability: "full_page_audit" }
    ];
    const registry = new FakeRegistry(undefined, [skill]);
    const runtime = createApplicationSkillRuntime({ registry, bindingStoreFor: () => store });
    const original = applicationSnapshot().fields[0]!;

    const result = await runtime.resolve({
      runId: "run-duplicate-semantic",
      taskId: "task-duplicate-semantic",
      snapshot: applicationSnapshot({
        fields: [original, {
          ...original,
          id: "candidate-name-duplicate",
          nodeRef: { ...original.nodeRef, nodeId: "node-candidate-name-duplicate" }
        }]
      })
    });

    expect(result).toEqual({ kind: "observe_only_handoff", reason: "safe_version_unavailable" });
    expect(registry.boundPages).toHaveLength(0);
    expect(store.putAttempts).toBe(0);
  });

  it("does not pin or write registry allocation state for an unmatched company landing page", async () => {
    const store = new MemoryBindingStore();
    const registry = new FakeRegistry(undefined, [skillFixture("1.0.0", "champion")]);
    const runtime = createApplicationSkillRuntime({ registry, bindingStoreFor: () => store });

    const result = await runtime.resolve({
      runId: "run-unmatched",
      taskId: "task-unmatched-page",
      snapshot: applicationSnapshot({ url: "https://talent.baidu.com/jobs/campus" })
    });

    expect(result).toEqual({ kind: "observe_only_handoff", reason: "page_unmatched" });
    expect(registry.boundPages).toHaveLength(0);
    expect(store.putAttempts).toBe(0);
  });

  it("does not overwrite an existing controlled allocation while pinning the Champion", async () => {
    const store = new MemoryBindingStore();
    const registry = new FakeRegistry(undefined, [skillFixture("1.0.0", "champion")]);
    const runtime = createApplicationSkillRuntime({ registry, bindingStoreFor: () => store });
    const first = await runtime.resolve({
      runId: "run-allocation",
      taskId: "task-allocation-first",
      snapshot: applicationSnapshot()
    });
    expect(first.kind).toBe("selected");
    const controlled = {
      ...registry.allocation!,
      challengerVersion: "1.1.0",
      championPercent: 90,
      challengerPercent: 10
    };
    registry.allocation = controlled;

    const second = await runtime.resolve({
      runId: "run-allocation-2",
      taskId: "task-allocation-second",
      snapshot: applicationSnapshot({ taskId: "task-allocation-second" })
    });

    expect(second).toMatchObject({ kind: "selected", binding: { version: "1.0.0" } });
    expect(registry.allocation).toEqual(controlled);
    expect(registry.boundPages).toHaveLength(1);
  });

  it("fails closed when an already-bound task is redirected outside its Skill domain", async () => {
    const store = new MemoryBindingStore();
    const registry = new FakeRegistry(undefined, [skillFixture("1.0.0", "champion")]);
    const runtime = createApplicationSkillRuntime({ registry, bindingStoreFor: () => store });
    const first = await runtime.resolve({
      runId: "run-cross-origin",
      taskId: "task-cross-origin",
      snapshot: applicationSnapshot()
    });
    if (first.kind !== "selected") throw new Error("expected initial Skill binding");

    const redirected = await runtime.resolve({
      runId: "run-cross-origin",
      taskId: "task-cross-origin",
      binding: first.binding,
      snapshot: applicationSnapshot({ url: "https://evil.example/apply" })
    });

    expect(redirected).toEqual({ kind: "observe_only_handoff", reason: "page_unmatched" });
  });
});

class FakeRegistry implements SkillRegistrySelectionPort {
  public allocationReads = 0;
  public readonly versions = new Map<string, unknown>();
  public readonly boundPages: SkillBinding[] = [];

  public constructor(
    public allocation: SkillPageAllocation | undefined,
    versions: readonly ApplicationSkillVersion[]
  ) {
    for (const version of versions) {
      this.versions.set(`${version.skillId}@${version.version}`, version);
    }
  }

  public async getPageAllocation(): Promise<SkillPageAllocation | undefined> {
    this.allocationReads += 1;
    return this.allocation;
  }

  public async getVersion(skillId: string, version: string): Promise<unknown> {
    return this.versions.get(`${skillId}@${version}`);
  }

  public getChampionForSite(site: SkillBinding["site"]): unknown {
    return [...this.versions.values()].find((value) => {
      const parsed = ApplicationSkillVersionSchema.safeParse(value);
      return parsed.success && parsed.data.site === site && parsed.data.status === "champion";
    });
  }

  public bindPage(binding: SkillBinding): void {
    this.boundPages.push(binding);
  }

  public setAllocation(input: SkillPageAllocation): void {
    this.allocation = input;
  }
}

class MemoryBindingStore implements SkillBindingStorePort {
  private readonly bindings = new Map<string, SkillBinding>();
  public putAttempts = 0;
  public persistedCount = 0;
  public lastCandidate: SkillBinding | undefined;

  public get size(): number {
    return this.bindings.size;
  }

  public async get(taskId: string): Promise<SkillBinding | undefined> {
    await Promise.resolve();
    return this.bindings.get(taskId);
  }

  public async putIfAbsent(taskId: string, binding: SkillBinding): Promise<SkillBinding> {
    this.putAttempts += 1;
    this.lastCandidate = binding;
    await Promise.resolve();
    const existing = this.bindings.get(taskId);
    if (existing !== undefined) return existing;
    this.bindings.set(taskId, binding);
    this.persistedCount += 1;
    return binding;
  }
}

function allocationFixture(percentages: {
  championPercent: number;
  challengerPercent: number;
}): SkillPageAllocation {
  return {
    allocationId: "allocation-baicu-campus",
    skillId: "baidu-application",
    site: "baidu",
    pageFingerprintHash: PAGE_HASH,
    championVersion: "1.0.0",
    challengerVersion: "1.1.0",
    ...percentages
  };
}

function skillFixture(
  version: string,
  status: ApplicationSkillVersion["status"]
): ApplicationSkillVersion {
  return ApplicationSkillVersionSchema.parse({
    skillId: "baidu-application",
    version,
    schemaVersion: 1,
    contentHash: version === "1.0.0" ? "a".repeat(64) : "b".repeat(64),
    site: "baidu",
    allowedDomains: ["talent.baidu.com"],
    pageFingerprintRule: { ruleId: "baidu-application", ruleHash: "d".repeat(64) },
    status,
    content: {
      capabilities: ["observe", "readback", "full_page_audit"],
      pageVariants: [{
        id: "application-form",
        match: {
          routePatterns: ["/jobs/application"],
          requiredTexts: ["Application"],
          requiredFields: ["basics.name"]
        },
        workflowEntry: "verify-form"
      }],
      fields: [{
        semantic: "basics.name",
        controlTypes: ["text"],
        locatorHints: [{ key: "candidate-name", by: "label", text: "Name" }]
      }],
      workflow: [{
        id: "verify-form",
        actions: [
          { capability: "readback", semantics: ["basics.name"] },
          { capability: "full_page_audit" }
        ],
        success: ["writes_read_back", "audit_clean"],
        next: "continue_or_wait"
      }],
      recovery: { maxRetries: 1, actions: ["reobserve"] }
    },
    createdBy: { kind: "manual_seed", actorId: "test-suite" },
    createdAt: "2026-09-07T08:00:00.000Z"
  });
}

function applicationSnapshot(overrides: Partial<FormSnapshot> = {}): FormSnapshot {
  return {
    id: "snapshot-application",
    taskId: "task-matched",
    url: "https://talent.baidu.com/jobs/application",
    title: "Application",
    stage: "application_form",
    frameRef: { documentId: "document-application", kind: "main" },
    mutationEpoch: 1,
    fields: [{
      id: "candidate-name",
      label: "Name",
      type: "text",
      required: true,
      options: [],
      currentValue: "",
      semanticHint: "basics.name",
      nodeRef: { documentId: "document-application", nodeId: "node-candidate-name", observedAt: 1 }
    }],
    actions: [],
    errors: [],
    ...overrides
  };
}
