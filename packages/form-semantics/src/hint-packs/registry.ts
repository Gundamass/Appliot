import { createHash } from "node:crypto";
import type { CertifiedHintPack, FormSnapshot } from "@resume/contracts";
import { djiHintPack } from "./dji-pack.js";
import { mokahrHintPack } from "./mokahr-pack.js";

export const BUILT_IN_HINT_PACKS = [djiHintPack, mokahrHintPack] as const;

export type HintPackResolution =
  | { kind: "certified"; pack: CertifiedHintPack }
  | { kind: "review_only"; reason: "no_certified_pack"; mismatchedPacks: [] }
  | { kind: "review_only"; reason: "fingerprint_mismatch"; mismatchedPacks: Array<{ packId: string; version: string }> };

export interface HintPackRegistry {
  resolve(snapshot: FormSnapshot): HintPackResolution;
  listCertified(): readonly CertifiedHintPack[];
}

export function createHintPackRegistry(input: {
  builtIns: readonly CertifiedHintPack[];
  local: () => readonly CertifiedHintPack[];
  isRetired: (packId: string, version: string) => boolean;
}): HintPackRegistry {
  const builtIns = input.builtIns.map((pack) => deepFreeze(structuredClone(pack)));
  const all = () => [...builtIns, ...input.local().map((pack) => deepFreeze(structuredClone(pack)))]
    .filter((pack) => pack.lifecycleStatus === "certified" && !input.isRetired(pack.packId, pack.version))
    .sort((left, right) => specificity(right) - specificity(left));

  return {
    resolve(snapshot) {
      let url: URL;
      try {
        url = new URL(snapshot.url);
      } catch {
        return { kind: "review_only", reason: "no_certified_pack", mismatchedPacks: [] };
      }

      const text = normalize([
        snapshot.title,
        ...snapshot.fields.map((field) => `${field.sectionHint ?? ""} ${field.label}`),
        ...snapshot.actions.map((action) => `${action.context ?? ""} ${action.text}`)
      ].join(" "));
      const fingerprint = fingerprintSnapshot(snapshot);
      const siteCandidates = all().filter((candidate) => candidate.match.stages.includes(snapshot.stage as "application_form" | "review")
        && candidate.match.sites.some((site) => hostMatches(url.hostname, site.hostSuffix)
          && site.pathPrefixes.some((prefix) => url.pathname.startsWith(prefix)))
        && candidate.match.requiredTextSignals.every((signal) => text.includes(normalize(signal))));
      const pack = siteCandidates.find((candidate) => candidate.match.pageFingerprintHashes.length === 0
        || candidate.match.pageFingerprintHashes.includes(fingerprint));

      if (pack !== undefined) return { kind: "certified", pack };
      return siteCandidates.length > 0
        ? {
          kind: "review_only",
          reason: "fingerprint_mismatch",
          mismatchedPacks: siteCandidates.map(({ packId, version }) => ({ packId, version }))
        }
        : { kind: "review_only", reason: "no_certified_pack", mismatchedPacks: [] };
    },
    listCertified: () => all()
  };
}

export function fingerprintSnapshot(snapshot: FormSnapshot): string {
  const canonical = JSON.stringify({
    stage: snapshot.stage,
    fields: snapshot.fields.map((field) => [normalize(field.label), field.type, field.sectionHint ?? null]),
    actions: snapshot.actions.map((action) => [normalize(action.text), action.class])
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function hostMatches(host: string, suffix: string): boolean {
  const normalizedHost = host.toLowerCase();
  const normalizedSuffix = suffix.toLowerCase();
  return normalizedHost === normalizedSuffix || normalizedHost.endsWith(`.${normalizedSuffix}`);
}

function specificity(pack: CertifiedHintPack): number {
  return Math.max(...pack.match.sites.flatMap((site) => site.pathPrefixes.map((path) => site.hostSuffix.length + path.length)));
}

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") Object.values(value).forEach((item) => deepFreeze(item));
  return Object.freeze(value) as T;
}
