import { createHash } from "node:crypto";

const REFERENCE_PATTERN = /^ats:sha256:([1-9]\d{0,2}):([a-f0-9]{64})$/u;
const HASH_DOMAIN = "certified-hint-text-v1\0";

export function certifiedTextReference(value: string): string {
  const normalized = normalizeCertifiedText(value);
  const length = [...normalized].length;
  if (length === 0 || length > 999) throw new Error("certified_hint_text_invalid");
  return referenceForNormalized(normalized, length);
}

export function certifiedTextEquals(observed: string, candidate: string): boolean {
  const reference = parseReference(candidate);
  const normalized = normalizeCertifiedText(observed);
  if (reference === undefined) return normalized === normalizeCertifiedText(candidate);
  return [...normalized].length === reference.length
    && referenceForNormalized(normalized, reference.length) === candidate;
}

export function certifiedTextIncludes(observed: string, candidate: string): boolean {
  const reference = parseReference(candidate);
  const normalized = normalizeCertifiedText(observed);
  if (reference === undefined) {
    const plainCandidate = normalizeCertifiedText(candidate);
    return plainCandidate.length > 0 && normalized.includes(plainCandidate);
  }

  const characters = [...normalized];
  if (reference.length > characters.length) return false;
  for (let index = 0; index <= characters.length - reference.length; index += 1) {
    const slice = characters.slice(index, index + reference.length).join("");
    if (referenceForNormalized(slice, reference.length) === candidate) return true;
  }
  return false;
}

function parseReference(value: string): { length: number } | undefined {
  const match = REFERENCE_PATTERN.exec(value);
  return match === null ? undefined : { length: Number(match[1]) };
}

function referenceForNormalized(normalized: string, length: number): string {
  const digest = createHash("sha256").update(`${HASH_DOMAIN}${normalized}`).digest("hex");
  return `ats:sha256:${length}:${digest}`;
}

function normalizeCertifiedText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "").trim().toLowerCase();
}
