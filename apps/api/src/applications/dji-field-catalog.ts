import type { FormField, FormSnapshot } from "@resume/contracts";

export interface DjiCatalogMatch {
  semantic: string;
  source: "dji_catalog";
  optionAliases?: Record<string, string>;
}

interface CatalogEntry {
  label: string;
  semantic: string;
  types: readonly FormField["type"][];
}

const CATALOG: readonly CatalogEntry[] = [
  { label: "姓名", semantic: "basics.name", types: ["text"] },
  { label: "手机号码", semantic: "basics.phone", types: ["text"] },
  { label: "毕业院校", semantic: "education[0].institution", types: ["text"] },
  { label: "项目名称", semantic: "projects[0].name", types: ["text"] },
  { label: "获奖级别", semantic: "awards[0].level", types: ["select", "radio"] }
];

export function isDjiApplicationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "apply.careers.dji.com"
      || (parsed.hostname === "app.mokahr.com" && /\/campus-recruitment\/dji\//u.test(parsed.pathname));
  } catch {
    return false;
  }
}

export function annotateDjiFields(snapshot: FormSnapshot): FormSnapshot {
  if (!isDjiApplicationUrl(snapshot.url)) return snapshot;
  return {
    ...snapshot,
    fields: snapshot.fields.map((field) => {
      const match = matchDjiField(field);
      return match === undefined ? field : { ...field, semanticHint: match.semantic };
    })
  };
}

export function matchDjiField(field: FormField): DjiCatalogMatch | undefined {
  const entry = CATALOG.find((candidate) => candidate.label === normalize(field.label)
    && candidate.types.includes(field.type));
  return entry === undefined ? undefined : { semantic: entry.semantic, source: "dji_catalog" };
}

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "").trim();
}
