import { createHash } from "node:crypto";
import {
  ApplicationSkillVersionSchema,
  SkillBindingSchema,
  type ApplicationSkillVersion,
  type SkillBinding
} from "@resume/contracts";

export interface SkillSelectorInput {
  readonly taskId: string;
  readonly site: SkillBinding["site"];
  readonly pageFingerprintHash: string;
}

export interface SkillPageAllocation {
  readonly allocationId: string;
  readonly skillId: string;
  readonly site: SkillBinding["site"];
  readonly pageFingerprintHash: string;
  readonly championVersion: string;
  readonly challengerVersion?: string;
  readonly championPercent: number;
  readonly challengerPercent: number;
}

export interface SkillRegistrySelectionPort {
  getPageAllocation(input: {
    readonly site: SkillBinding["site"];
    readonly pageFingerprintHash: string;
  }): Promise<SkillPageAllocation | undefined>;
  getVersion(skillId: string, version: string): Promise<unknown>;
}

export interface SkillBindingStorePort {
  get(taskId: string): Promise<unknown>;
  /** Atomically inserts a binding or returns the binding already stored for taskId. */
  putIfAbsent(taskId: string, binding: SkillBinding): Promise<unknown>;
}

export type SkillSelection =
  | { readonly kind: "selected"; readonly binding: SkillBinding }
  | {
    readonly kind: "observe_only_handoff";
    readonly reason: "page_unmatched" | "safe_version_unavailable";
  };

const RUNTIME_IDENTIFIER = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
const HASH = /^[a-f0-9]{64}$/u;
const SITES = new Set<SkillBinding["site"]>(["baidu", "moka", "dji"]);

export class SkillSelector {
  public constructor(
    private readonly registry: SkillRegistrySelectionPort,
    private readonly bindingStore: SkillBindingStorePort
  ) {}

  public async selectForTask(input: SkillSelectorInput): Promise<SkillSelection> {
    if (!validInput(input)) return observeOnly("safe_version_unavailable");

    let stored: unknown;
    try {
      stored = await this.bindingStore.get(input.taskId);
    } catch {
      return observeOnly("safe_version_unavailable");
    }

    if (stored !== undefined) return selectionFromStoredBinding(stored, input);

    let allocation: SkillPageAllocation | undefined;
    try {
      allocation = await this.registry.getPageAllocation({
        site: input.site,
        pageFingerprintHash: input.pageFingerprintHash
      });
    } catch {
      return observeOnly("safe_version_unavailable");
    }

    if (allocation === undefined) return observeOnly("page_unmatched");
    if (!validAllocation(allocation, input)) return observeOnly("safe_version_unavailable");

    const champion = await this.safeVersion(
      allocation.skillId,
      allocation.championVersion,
      allocation.site,
      "champion"
    );
    if (champion === undefined) return observeOnly("safe_version_unavailable");

    let selectedVersion = champion;
    if (
      allocation.challengerPercent > 0
      && allocation.challengerVersion !== undefined
      && stableSkillBucket(input.taskId, allocation.allocationId) < allocation.challengerPercent
    ) {
      const challenger = await this.safeVersion(
        allocation.skillId,
        allocation.challengerVersion,
        allocation.site,
        "challenger"
      );
      if (challenger !== undefined) selectedVersion = challenger;
    }

    const bindingResult = SkillBindingSchema.safeParse({
      skillId: allocation.skillId,
      version: selectedVersion.version,
      site: allocation.site,
      pageFingerprintHash: allocation.pageFingerprintHash,
      allocationId: allocation.allocationId
    });
    if (!bindingResult.success) return observeOnly("safe_version_unavailable");

    try {
      const winner = await this.bindingStore.putIfAbsent(input.taskId, bindingResult.data);
      return selectionFromStoredBinding(winner, input);
    } catch {
      return observeOnly("safe_version_unavailable");
    }
  }

  private async safeVersion(
    skillId: string,
    version: string,
    site: SkillBinding["site"],
    expectedStatus: "champion" | "challenger"
  ): Promise<ApplicationSkillVersion | undefined> {
    let candidate: unknown;
    try {
      candidate = await this.registry.getVersion(skillId, version);
    } catch {
      return undefined;
    }

    const parsed = ApplicationSkillVersionSchema.safeParse(candidate);
    if (!parsed.success) return undefined;
    if (
      parsed.data.skillId !== skillId
      || parsed.data.version !== version
      || parsed.data.site !== site
      || parsed.data.status !== expectedStatus
    ) {
      return undefined;
    }
    return parsed.data;
  }
}

export function stableSkillBucket(taskId: string, allocationId: string): number {
  const digest = createHash("sha256").update(`${taskId}\0${allocationId}`, "utf8").digest();
  return digest.readUInt32BE(0) % 100;
}

function validInput(input: SkillSelectorInput): boolean {
  return RUNTIME_IDENTIFIER.test(input.taskId)
    && input.taskId.length <= 128
    && SITES.has(input.site)
    && HASH.test(input.pageFingerprintHash);
}

function validAllocation(allocation: SkillPageAllocation, input: SkillSelectorInput): boolean {
  if (
    allocation.site !== input.site
    || allocation.pageFingerprintHash !== input.pageFingerprintHash
    || !RUNTIME_IDENTIFIER.test(allocation.allocationId)
    || allocation.allocationId.length > 128
    || !RUNTIME_IDENTIFIER.test(allocation.skillId)
    || allocation.skillId.length > 128
    || !Number.isInteger(allocation.championPercent)
    || !Number.isInteger(allocation.challengerPercent)
    || allocation.championPercent < 0
    || allocation.challengerPercent < 0
    || allocation.championPercent > 100
    || allocation.challengerPercent > 100
    || allocation.championPercent + allocation.challengerPercent !== 100
  ) {
    return false;
  }
  return allocation.challengerPercent === 0 || allocation.challengerVersion !== undefined;
}

function selectionFromStoredBinding(stored: unknown, input: SkillSelectorInput): SkillSelection {
  const parsed = SkillBindingSchema.safeParse(stored);
  if (
    !parsed.success
    || parsed.data.site !== input.site
    || parsed.data.pageFingerprintHash !== input.pageFingerprintHash
  ) {
    return observeOnly("safe_version_unavailable");
  }
  return { kind: "selected", binding: parsed.data };
}

function observeOnly(reason: "page_unmatched" | "safe_version_unavailable"): SkillSelection {
  return { kind: "observe_only_handoff", reason };
}
