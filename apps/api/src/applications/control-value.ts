const CANONICAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;

export function isCanonicalDateSemantic(semantic: string): boolean {
  return /(?:^|\.)(?:startDate|endDate|birthDate|date)(?:\.(?:year|month|day))?$/u.test(semantic);
}

export function projectDateComponent(label: string, semantic: string, value: unknown): unknown {
  if (!isCanonicalDateSemantic(semantic) || typeof value !== "string" || !CANONICAL_DATE.test(value)) {
    return value;
  }
  const normalizedLabel = label.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (/(?:year|[年])/iu.test(semantic) || /(?:^|\s)[年]/u.test(normalizedLabel)) return value.slice(0, 4);
  if (/(?:month|[月])/iu.test(semantic) || /(?:^|\s)[月]/u.test(normalizedLabel)) return value.slice(5, 7);
  if (/(?:day|[日号])/iu.test(semantic) || /(?:^|\s)[日号]/u.test(normalizedLabel)) return value.slice(8, 10);
  return value;
}

export function matchControlOption(value: unknown, options: readonly string[]): string | undefined {
  if (typeof value !== "string") return undefined;
  const expected = normalizeOption(value);
  if (expected === "") return undefined;
  const exact = options.find((option) => option.trim() === value.trim());
  if (exact !== undefined) return exact;
  if (CANONICAL_DATE.test(value) && !options.some((option) => CANONICAL_DATE.test(option.trim()))) return undefined;
  return options.find((option) => normalizeOption(option) === expected);
}

function normalizeOption(value: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/[年月日号]$/u, "");
  if (/^\d{1,2}$/u.test(normalized)) return String(Number(normalized));
  return normalized;
}
