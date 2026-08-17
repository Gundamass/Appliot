import type { CertifiedHintProvenance, FormField, FormSnapshot } from "@resume/contracts";
import { applyCertifiedHintPack, djiHintPack } from "@resume/form-semantics";

export interface DjiCatalogMatch {
  semantic: string;
  source: "certified_hint";
  provenance: CertifiedHintProvenance;
  optionAliases?: Record<string, string>;
}

export function isDjiApplicationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return djiHintPack.match.sites.some((site) => hostMatches(parsed.hostname, site.hostSuffix)
      && site.pathPrefixes.some((prefix) => parsed.pathname.startsWith(prefix)));
  } catch {
    return false;
  }
}

export function annotateDjiFields(snapshot: FormSnapshot): FormSnapshot {
  return isDjiApplicationUrl(snapshot.url) ? applyCertifiedHintPack(snapshot, djiHintPack) : snapshot;
}

export function matchDjiField(field: FormField): DjiCatalogMatch | undefined {
  const annotated = applyCertifiedHintPack(fieldSnapshot(field), djiHintPack).fields[0];
  if (annotated?.semanticSource !== "certified_hint"
    || annotated.semanticHint === undefined
    || annotated.semanticProvenance === undefined) {
    return undefined;
  }
  return {
    semantic: annotated.semanticHint,
    source: annotated.semanticSource,
    provenance: annotated.semanticProvenance
  };
}

function fieldSnapshot(field: FormField): FormSnapshot {
  return {
    id: "dji-catalog-match-snapshot",
    taskId: "dji-catalog-match-task",
    url: "https://apply.careers.dji.com/",
    title: "DJI catalog compatibility wrapper",
    stage: "application_form",
    frameRef: { documentId: field.nodeRef.documentId, kind: "main" },
    mutationEpoch: field.nodeRef.observedAt,
    fields: [field],
    actions: [],
    errors: []
  };
}

function hostMatches(host: string, suffix: string): boolean {
  const normalizedHost = host.toLowerCase();
  const normalizedSuffix = suffix.toLowerCase();
  return normalizedHost === normalizedSuffix || normalizedHost.endsWith(`.${normalizedSuffix}`);
}
