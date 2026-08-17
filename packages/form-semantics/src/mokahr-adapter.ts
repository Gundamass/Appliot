import type { FormSnapshot, PageSectionHint } from "@resume/contracts";
import { MOKAHR_SECTIONS, mokahrHintPack } from "./hint-packs/mokahr-pack.js";
import { BUILT_IN_HINT_PACKS } from "./hint-packs/registry.js";
import { classifyRepeatedActions } from "./hint-packs/runtime.js";

export type MokahrSection =
  | "education"
  | "work"
  | "internship"
  | "work_combined"
  | "projects"
  | "awards"
  | "laboratory"
  | "languages";

export interface MokahrObservedAction {
  id: string;
  text: string;
  nearbyText: string;
}

export interface MokahrObservedField {
  id: string;
  label: string;
}

export interface MokahrAddAction {
  actionId: string;
  section: MokahrSection;
}

export interface MokahrPageSignal {
  url: string;
  pageText?: string;
}

const wrapperNodeRef = {
  documentId: "document-mokahr-wrapper",
  nodeId: "node-mokahr-wrapper-0001",
  observedAt: 0
};

const PAGE_SECTION_SIGNALS: Array<{ section: PageSectionHint; aliases: readonly string[] }> = [
  { section: "work_combined", aliases: sectionAliases("work_combined") },
  { section: "internship", aliases: sectionAliases("internship") },
  { section: "work", aliases: sectionAliases("work") },
  { section: "education", aliases: sectionAliases("education") },
  { section: "projects", aliases: sectionAliases("projects") },
  { section: "awards", aliases: sectionAliases("awards") },
  { section: "languages", aliases: sectionAliases("languages") },
  { section: "basics", aliases: ["基本信息", "个人信息"] },
  { section: "preferences", aliases: ["求职意向", "应聘意向"] },
  { section: "campus", aliases: ["在校实践", "校园经历", ...sectionAliases("laboratory")] },
  { section: "publications", aliases: ["论文", "发表成果"] },
  { section: "certificates", aliases: ["证书", "资格证"] },
  { section: "self", aliases: ["自我评价", "个人总结"] }
];

export function sectionHintForText(value: string | undefined): PageSectionHint | undefined {
  const text = normalized(value);
  return PAGE_SECTION_SIGNALS.find(({ aliases }) => aliases.some((alias) => text.includes(normalized(alias))))?.section;
}

export function isMokahrPage(signal: MokahrPageSignal): boolean {
  try {
    const url = new URL(signal.url);
    if (BUILT_IN_HINT_PACKS.some((pack) => pack.match.sites.some((site) =>
      hostMatches(url.hostname, site.hostSuffix) && site.pathPrefixes.some((prefix) => url.pathname.startsWith(prefix))
    ))) {
      return true;
    }
  } catch {
    // Compatibility fallback below still recognizes a safe, text-only Moka signal.
  }

  const pageText = normalized(signal.pageText);
  return /moka|mokahr/iu.test(pageText)
    && MOKAHR_SECTIONS.some(({ headingAliases }) => headingAliases.some((alias) => pageText.includes(normalized(alias))));
}

export function classifyMokahrAddActions(actions: MokahrObservedAction[]): MokahrAddAction[] {
  return classifyRepeatedActions(observedActionSnapshot(actions), mokahrHintPack);
}

export function sortMokahrEntryFields(section: MokahrSection, fields: MokahrObservedField[]): MokahrObservedField[] {
  const fieldOrderAliases = MOKAHR_SECTIONS.find((candidate) => candidate.section === section)?.fieldOrderAliases ?? [];
  return fields.map((field, index) => ({ field, index })).sort((left, right) => {
    const rankDifference = fieldRank(fieldOrderAliases, left.field.label) - fieldRank(fieldOrderAliases, right.field.label);
    return rankDifference || left.index - right.index;
  }).map(({ field }) => field);
}

function observedActionSnapshot(actions: MokahrObservedAction[]): FormSnapshot {
  return {
    id: "mokahr-wrapper-snapshot",
    taskId: "mokahr-wrapper-task",
    url: "https://app.mokahr.com/",
    title: "Mokahr compatibility wrapper",
    stage: "application_form",
    frameRef: { documentId: wrapperNodeRef.documentId, kind: "main" },
    mutationEpoch: wrapperNodeRef.observedAt,
    fields: [],
    actions: actions.map((action) => ({
      id: action.id,
      text: action.text,
      class: "safe_edit",
      ...(action.nearbyText === "" ? {} : { context: action.nearbyText }),
      nodeRef: wrapperNodeRef
    })),
    errors: []
  };
}

function sectionAliases(section: MokahrSection): readonly string[] {
  return MOKAHR_SECTIONS.find((candidate) => candidate.section === section)?.headingAliases ?? [];
}

function fieldRank(fieldOrderAliases: readonly (readonly string[])[], label: string): number {
  const normalizedLabel = normalized(label);
  const index = fieldOrderAliases.findIndex((aliases) => aliases.some((alias) => normalizedLabel.includes(normalized(alias))));
  return index < 0 ? fieldOrderAliases.length : index;
}

function hostMatches(host: string, suffix: string): boolean {
  const normalizedHost = host.toLowerCase();
  const normalizedSuffix = suffix.toLowerCase();
  return normalizedHost === normalizedSuffix || normalizedHost.endsWith(`.${normalizedSuffix}`);
}

function normalized(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}
