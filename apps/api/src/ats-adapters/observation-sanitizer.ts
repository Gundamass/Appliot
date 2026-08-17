import { createHash } from "node:crypto";
import type { FormSnapshot } from "@resume/contracts";

const MAX_FIELDS = 500;
const MAX_ACTIONS = 200;
const MAX_TEXT_LENGTH = 120;
const PROFILE_PATH_PATTERN = /^[a-z][a-zA-Z0-9]*(?:\[\d+\])?(?:\.[a-z][a-zA-Z0-9]*)*$/u;
const SAFE_PATH_SEGMENTS = new Set([
  "apply",
  "application",
  "applications",
  "career",
  "careers",
  "candidate",
  "candidates",
  "campus",
  "form",
  "job",
  "jobs",
  "login",
  "portal",
  "position",
  "positions",
  "recruit",
  "recruitment",
  "review"
]);

export interface SanitizedAdapterObservation {
  schemaVersion: 1;
  origin: string;
  pathShape: string;
  stage: FormSnapshot["stage"];
  pageFingerprintHash: string;
  fields: Array<{
    observedFieldId: string;
    label: string;
    type: FormSnapshot["fields"][number]["type"];
    required: boolean;
    optionCount: number;
    section?: FormSnapshot["fields"][number]["sectionHint"];
  }>;
  actions: Array<{
    observedActionId: string;
    text: string;
    actionClass: FormSnapshot["actions"][number]["class"];
  }>;
  boundaries: Array<{ kind: string; blocked: boolean }>;
  profilePaths: string[];
}

export function sanitizeAdapterObservation(
  snapshot: FormSnapshot,
  profilePaths: readonly string[]
): SanitizedAdapterObservation {
  const url = new URL(snapshot.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("adapter_observation_url_unsupported");
  }

  const pathShape = shapePath(url.pathname);
  const fields = snapshot.fields.slice(0, MAX_FIELDS).map((field, index) => ({
    observedFieldId: `field-${index + 1}`,
    label: sanitizeText(field.label),
    type: field.type,
    required: field.required,
    optionCount: field.options.length,
    ...(field.sectionHint === undefined ? {} : { section: field.sectionHint })
  }));
  const actions = snapshot.actions.slice(0, MAX_ACTIONS).map((action, index) => ({
    observedActionId: `action-${index + 1}`,
    text: sanitizeText(action.text),
    actionClass: action.class
  }));
  const boundaries = (snapshot.boundaries ?? []).map((boundary) => ({
    kind: boundary.kind,
    blocked: boundary.visible || boundary.interactive
  }));
  const safeProfilePaths = [...new Set(profilePaths.filter((path) => PROFILE_PATH_PATTERN.test(path)))].sort().slice(0, MAX_FIELDS);
  const canonical = JSON.stringify({
    origin: url.origin.toLowerCase(),
    pathShape,
    stage: snapshot.stage,
    fields,
    actions,
    boundaries
  });

  return {
    schemaVersion: 1,
    origin: url.origin,
    pathShape,
    stage: snapshot.stage,
    pageFingerprintHash: createHash("sha256").update(canonical, "utf8").digest("hex"),
    fields,
    actions,
    boundaries,
    profilePaths: safeProfilePaths
  };
}

function shapePath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean).map((segment) => {
    const normalized = segment.normalize("NFKC").toLowerCase();
    if (SAFE_PATH_SEGMENTS.has(normalized)) return normalized;
    if (/^(?:\d+|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu.test(normalized)) return ":id";
    return ":segment";
  });
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function sanitizeText(value: string): string {
  return value.normalize("NFKC")
    .replace(/https?:\/\/[^\s]+/giu, "[redacted-url]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, "[redacted-email]")
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/gu, "[redacted-phone]")
    .replace(/(?<!\d)\d{17}[\dXx](?!\d)/gu, "[redacted-id]")
    .replace(/\b(?:proxy[\s_/-]*)?authorization(?:\s*[:=]\s*|\s+)(?:basic|bearer|digest|negotiate|ntlm)\s+[^\s,;]+/giu, "[redacted-credential]")
    .replace(/\b(?:api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|client[\s_-]*secret|password|cookie|session)\s*(?:[:=]\s*|\s+)[^\s,;]+/giu, "[redacted-secret]")
    .replace(/\b(?:sk_(?:live|test)|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+\b/gu, "[redacted-secret]")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}
