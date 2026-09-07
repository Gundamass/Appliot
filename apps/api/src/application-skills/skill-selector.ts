import { createHash } from "node:crypto";
import {
  ApplicationFieldSemanticSchema,
  ApplicationSkillVersionSchema,
  SkillBindingSchema,
  type ApplicationFieldSemantic,
  type ApplicationSkillVersion,
  type FormSnapshot,
  type SkillBinding
} from "@resume/contracts";
import { SkillInterpreter, type NormalizedSkillPageObservation } from "./skill-interpreter.js";

export interface SkillSelectorInput {
  readonly taskId: string;
  readonly taskCreatedAt?: string;
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
  readonly updatedAt: string;
}

export interface SkillRegistrySelectionPort {
  getPageAllocation(input: {
    readonly site: SkillBinding["site"];
    readonly pageFingerprintHash: string;
  }): Promise<SkillPageAllocation | undefined> | SkillPageAllocation | undefined;
  getVersion(skillId: string, version: string): Promise<unknown> | unknown;
}

export interface SkillBindingStorePort {
  get(taskId: string): Promise<unknown>;
  /** Atomically inserts a binding or returns the binding already stored for taskId. */
  putIfAbsent(taskId: string, binding: SkillBinding): Promise<unknown>;
}

export interface ApplicationSkillRuntimeRegistryPort extends SkillRegistrySelectionPort {
  getChampionForSite(site: SkillBinding["site"]): Promise<unknown> | unknown;
  bindPage(binding: SkillBinding): Promise<void> | void;
  setAllocation(input: SkillPageAllocation & { updatedAt: string }): Promise<void> | void;
}

export interface ApplicationSkillRuntime {
  resolve(input: {
    runId: string;
    taskId: string;
    snapshot: FormSnapshot;
    binding?: SkillBinding;
  }): Promise<
    | {
        kind: "selected";
        binding: SkillBinding;
        pageVariantId: string;
        allocation: "champion" | "challenger";
        directives: ReturnType<SkillInterpreter["compileDirectives"]>;
      }
    | { kind: "observe_only_handoff"; reason: "page_unmatched" | "safe_version_unavailable" }
    | { kind: "not_applicable" }
  >;
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

    let selected = champion;
    if (shouldSelectChallenger(input, allocation) && allocation.challengerVersion !== undefined) {
      const challenger = await this.safeVersion(
        allocation.skillId,
        allocation.challengerVersion,
        allocation.site,
        "challenger"
      );
      if (challenger !== undefined) selected = challenger;
    }

    const bindingResult = SkillBindingSchema.safeParse({
      skillId: allocation.skillId,
      version: selected.version,
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

export function createApplicationSkillRuntime(options: {
  registry: ApplicationSkillRuntimeRegistryPort;
  bindingStoreFor(runId: string): SkillBindingStorePort;
  interpreter?: SkillInterpreter;
  now?: () => string;
}): ApplicationSkillRuntime {
  const interpreter = options.interpreter ?? new SkillInterpreter();
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async resolve(input) {
      const observation = skillObservation(input.snapshot);
      const store = options.bindingStoreFor(input.runId);

      if (input.binding !== undefined) {
        const pinned = await new SkillSelector(options.registry, store).selectForTask({
          taskId: input.taskId,
          site: input.binding.site,
          pageFingerprintHash: input.binding.pageFingerprintHash
        });
        if (pinned.kind !== "selected" || !sameBinding(pinned.binding, input.binding)) {
          return observeOnly("safe_version_unavailable");
        }
        const version = await options.registry.getVersion(input.binding.skillId, input.binding.version);
        return compileSelection(interpreter, observation, version, input.binding);
      }

      const site = siteForObservation(observation);
      if (site === undefined) return { kind: "not_applicable" };

      const championValue = await options.registry.getChampionForSite(site);
      const champion = ApplicationSkillVersionSchema.safeParse(championValue);
      if (!champion.success || champion.data.status !== "champion") {
        return observeOnly("safe_version_unavailable");
      }
      const match = interpreter.matchPage(observation, champion.data);
      if (match.kind !== "matched") return observeOnly("page_unmatched");
      const directives = interpreter.compileDirectives(match, observedSemantics(observation));
      if (hasAmbiguousResolvableSemantic(observation, directives)) {
        return observeOnly("safe_version_unavailable");
      }

      let existingAllocation: SkillPageAllocation | undefined;
      try {
        existingAllocation = await options.registry.getPageAllocation({
          site,
          pageFingerprintHash: match.fingerprintHash
        });
      } catch {
        return observeOnly("safe_version_unavailable");
      }
      const allocationId = existingAllocation?.allocationId
        ?? `allocation-${site}-${match.fingerprintHash.slice(0, 24)}`;
      const candidate = SkillBindingSchema.parse({
        skillId: champion.data.skillId,
        version: champion.data.version,
        site,
        pageFingerprintHash: match.fingerprintHash,
        allocationId
      });
      if (existingAllocation === undefined) {
        try {
          await options.registry.bindPage(candidate);
          await options.registry.setAllocation({
            allocationId: candidate.allocationId,
            skillId: candidate.skillId,
            site: candidate.site,
            pageFingerprintHash: candidate.pageFingerprintHash,
            championVersion: champion.data.version,
            championPercent: 100,
            challengerPercent: 0,
            updatedAt: now()
          });
        } catch {
          return observeOnly("safe_version_unavailable");
        }
      }

      const selected = await new SkillSelector(options.registry, store).selectForTask({
        taskId: input.taskId,
        site,
        pageFingerprintHash: match.fingerprintHash
      });
      if (selected.kind !== "selected") return selected;
      if (!samePageAllocation(selected.binding, candidate)) return observeOnly("safe_version_unavailable");
      const selectedVersion = await options.registry.getVersion(selected.binding.skillId, selected.binding.version);
      return compileSelection(interpreter, observation, selectedVersion, selected.binding);
    }
  };
}

function validInput(input: SkillSelectorInput): boolean {
  return RUNTIME_IDENTIFIER.test(input.taskId)
    && input.taskId.length <= 128
    && SITES.has(input.site)
    && HASH.test(input.pageFingerprintHash)
    && (input.taskCreatedAt === undefined || !Number.isNaN(Date.parse(input.taskCreatedAt)));
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
    || Number.isNaN(Date.parse(allocation.updatedAt))
  ) {
    return false;
  }
  return allocation.challengerPercent === 0 || allocation.challengerVersion !== undefined;
}

function shouldSelectChallenger(input: SkillSelectorInput, allocation: SkillPageAllocation): boolean {
  if (allocation.challengerVersion === undefined || allocation.challengerPercent === 0) return false;
  if (input.taskCreatedAt !== undefined
    && Date.parse(input.taskCreatedAt) < Date.parse(allocation.updatedAt)) return false;
  const allocationSalt = allocation.allocationId;
  const digest = createHash("sha256")
    .update(`${input.site}${input.pageFingerprintHash}${input.taskId}${allocationSalt}`, "utf8")
    .digest();
  return digest.readUInt32BE(0) % 1_000 < allocation.challengerPercent * 10;
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

function observeOnly(
  reason: "page_unmatched" | "safe_version_unavailable"
): Extract<SkillSelection, { kind: "observe_only_handoff" }> {
  return { kind: "observe_only_handoff", reason };
}

function compileSelection(
  interpreter: SkillInterpreter,
  observation: NormalizedSkillPageObservation,
  version: unknown,
  binding: SkillBinding
): Awaited<ReturnType<ApplicationSkillRuntime["resolve"]>> {
  const parsedVersion = ApplicationSkillVersionSchema.safeParse(version);
  if (!parsedVersion.success
    || parsedVersion.data.skillId !== binding.skillId
    || parsedVersion.data.version !== binding.version
    || (parsedVersion.data.status !== "champion" && parsedVersion.data.status !== "challenger")) {
    return observeOnly("safe_version_unavailable");
  }
  const match = interpreter.matchPage(observation, version);
  if (match.kind !== "matched") return observeOnly("page_unmatched");
  const directives = interpreter.compileDirectives(match, observedSemantics(observation));
  if (hasAmbiguousResolvableSemantic(observation, directives)) {
    return observeOnly("safe_version_unavailable");
  }
  return {
    kind: "selected",
    binding,
    pageVariantId: match.pageVariantId,
    allocation: parsedVersion.data.status,
    directives
  };
}

function skillObservation(snapshot: FormSnapshot): NormalizedSkillPageObservation {
  const url = new URL(snapshot.url);
  const fields: Array<{ semantic: ApplicationFieldSemantic; empty: boolean }> = [];
  for (const field of snapshot.fields) {
    const semantic = ApplicationFieldSemanticSchema.safeParse(semanticTemplate(field.semanticHint));
    if (!semantic.success) continue;
    fields.push({ semantic: semantic.data, empty: !hasValue(field.currentValue) });
  }
  return {
    origin: url.origin,
    route: url.pathname,
    landmarks: [
      snapshot.title,
      ...snapshot.fields.map((field) => field.label),
      ...snapshot.actions.map((action) => action.text)
    ],
    fields,
    availableCapabilities: ["observe", "fill_empty_fields", "readback", "full_page_audit"],
    challengePresent: snapshot.challenge !== undefined
  };
}

function hasAmbiguousResolvableSemantic(
  observation: NormalizedSkillPageObservation,
  directives: ReturnType<SkillInterpreter["compileDirectives"]>
): boolean {
  return directives.some((directive) => directive.kind === "resolve-field"
    && observation.fields.filter((field) => field.semantic === directive.semantic).length !== 1);
}

function semanticTemplate(value: unknown): unknown {
  return typeof value === "string"
    ? value.replace(/^([a-z]+)\[\d+\]/u, "$1[]")
    : value;
}

function siteForObservation(observation: NormalizedSkillPageObservation): SkillBinding["site"] | undefined {
  const hostname = new URL(observation.origin).hostname.toLowerCase();
  if (hostname === "talent.baidu.com") return "baidu";
  if (hostname === "apply.careers.dji.com") return "dji";
  if (hostname === "app.mokahr.com") return /(?:^|\/)dji(?:\/|$)/iu.test(observation.route) ? "dji" : "moka";
  return undefined;
}

function observedSemantics(observation: NormalizedSkillPageObservation): ApplicationFieldSemantic[] {
  return [...new Set(observation.fields.map((field) => field.semantic))];
}

function hasValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== false;
}

function sameBinding(left: SkillBinding, right: SkillBinding): boolean {
  return left.skillId === right.skillId
    && left.version === right.version
    && left.site === right.site
    && left.pageFingerprintHash === right.pageFingerprintHash
    && left.allocationId === right.allocationId;
}

function samePageAllocation(left: SkillBinding, right: SkillBinding): boolean {
  return left.skillId === right.skillId
    && left.site === right.site
    && left.pageFingerprintHash === right.pageFingerprintHash
    && left.allocationId === right.allocationId;
}
