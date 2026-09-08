import {
  ExtractedJobPageSchema,
  FilterPlanSchema,
  JobPostingDraftSchema,
  type ExtractedJobPage,
  type FilterPlan,
  type JobEntryKind,
  type JobExpectationSnapshot,
  type JobPageSnapshot,
  type JobPostingDraft,
  type JobRequirement,
  type JobSource
} from "@resume/contracts";

export interface JobAdapter {
  readonly source: JobSource;
  readonly version: string;
  normalizeEntryUrl?(url: URL): URL | undefined;
  identify(snapshot: JobPageSnapshot): JobEntryKind | "unsupported";
  mapFilters(expectation: JobExpectationSnapshot): FilterPlan;
  extractList(snapshot: JobPageSnapshot): ExtractedJobPage;
  extractDetail(snapshot: JobPageSnapshot): JobPostingDraft;
}

interface SnapshotJobAdapterOptions {
  source: JobSource;
  version: string;
  supportsUrl(url: URL): boolean;
  normalizeEntryUrl?(url: URL): URL | undefined;
  localOnlyReason?(criterion: JobExpectationSnapshot["criteria"][number]): string | undefined;
  filterKeys: Partial<Record<JobExpectationSnapshot["criteria"][number]["kind"], string>>;
}

export function createSnapshotJobAdapter(options: SnapshotJobAdapterOptions): JobAdapter {
  const identify = (snapshot: JobPageSnapshot): JobEntryKind | "unsupported" => {
    if (snapshot.challenge !== undefined || snapshot.boundaries.some((boundary) => boundary.visible && boundary.interactive)) {
      return "unsupported";
    }
    let url: URL;
    try {
      url = new URL(snapshot.url);
    } catch {
      return "unsupported";
    }
    if (!options.supportsUrl(url)) return "unsupported";
    return snapshot.entryHint === "job_list"
      || snapshot.entryHint === "job_detail"
      || snapshot.entryHint === "application_form"
      ? snapshot.entryHint
      : "unsupported";
  };

  const postingFromCard = (
    card: JobPageSnapshot["jobCards"][number],
    description: string
  ): JobPostingDraft => {
    let canonicalUrl: URL;
    try {
      canonicalUrl = new URL(card.canonicalUrl);
    } catch (error) {
      throw new Error("job_adapter_contract_mismatch", { cause: error });
    }
    if (!options.supportsUrl(canonicalUrl)) throw new Error("job_adapter_contract_mismatch");
    return JobPostingDraftSchema.parse({
      source: options.source,
      ...(card.sourceJobId === undefined ? {} : { sourceJobId: card.sourceJobId }),
      canonicalUrl: card.canonicalUrl,
      title: card.title,
      organization: card.organization,
      ...(card.location === undefined ? {} : { location: card.location }),
      description,
      requirements: extractRequirements(description),
      adapterVersion: options.version
    });
  };

  return {
    source: options.source,
    version: options.version,
    ...(options.normalizeEntryUrl === undefined ? {} : { normalizeEntryUrl: options.normalizeEntryUrl }),
    identify,

    mapFilters(expectation) {
      const mapped: FilterPlan["mapped"] = [];
      const localOnly: FilterPlan["localOnly"] = [];
      expectation.criteria.forEach((criterion, criterionIndex) => {
        const localReason = options.localOnlyReason?.(criterion);
        if (localReason !== undefined) {
          localOnly.push({ criterionIndex, reasonCode: localReason });
          return;
        }
        const key = options.filterKeys[criterion.kind];
        if (key === undefined) {
          localOnly.push({ criterionIndex, reasonCode: `unsupported_${criterion.kind}` });
        } else {
          mapped.push({ criterionIndex, key, values: [...criterion.values] });
        }
      });
      return FilterPlanSchema.parse({
        source: options.source,
        adapterVersion: options.version,
        mapped,
        localOnly
      });
    },

    extractList(snapshot) {
      if (identify(snapshot) !== "job_list"
        || (snapshot.pagination.hasNext && snapshot.jobCards.length === 0)) {
        throw new Error("job_adapter_contract_mismatch");
      }
      try {
        return ExtractedJobPageSchema.parse({
          postings: snapshot.jobCards.map((card) => postingFromCard(
            card,
            card.summary?.trim() || card.title
          )),
          ...(snapshot.pagination.nextCursor === undefined
            ? {}
            : { nextCursor: snapshot.pagination.nextCursor }),
          hasNext: snapshot.pagination.hasNext
        });
      } catch (error) {
        throw new Error("job_adapter_contract_mismatch", { cause: error });
      }
    },

    extractDetail(snapshot) {
      if (identify(snapshot) !== "job_detail" || snapshot.jobCards.length !== 1) {
        throw new Error("job_adapter_contract_mismatch");
      }
      const description = snapshot.visibleText.map((text) => text.trim()).filter(Boolean).join("\n");
      if (description.length === 0) throw new Error("job_adapter_contract_mismatch");
      try {
        return postingFromCard(snapshot.jobCards[0]!, description);
      } catch (error) {
        throw new Error("job_adapter_contract_mismatch", { cause: error });
      }
    }
  };
}

function extractRequirements(description: string): JobRequirement[] {
  const requirements: JobRequirement[] = [];
  const seen = new Set<string>();
  const add = (category: JobRequirement["category"], normalizedValue: string, sourceEvidence: string) => {
    const value = normalizedValue.trim();
    const evidence = sourceEvidence.trim().slice(0, 2_000);
    const key = `${category}:${value}`;
    if (value.length === 0 || evidence.length === 0 || seen.has(key)) return;
    seen.add(key);
    requirements.push({
      id: `requirement-${requirements.length + 1}`,
      category,
      normalizedValue: value,
      required: true,
      sourceEvidence: evidence
    });
  };

  for (const line of description.split(/\r?\n|[；;]/u).map((value) => value.trim()).filter(Boolean)) {
    if (/本科|硕士|博士|大专|学历/u.test(line)) add("education", line, line);
    if (/专业/u.test(line)) add("major", line, line);
    const years = line.match(/(\d+(?:\.\d+)?)\s*年/u)?.[1];
    if (years !== undefined) add("experience_years", years, line);
    for (const skill of line.match(/TypeScript|JavaScript|Kotlin|Spring|Python|React|Java|Vue|C\+\+|SQL|Go/giu) ?? []) {
      add("skill", canonicalSkill(skill), line);
    }
  }
  return requirements;
}

function canonicalSkill(skill: string): string {
  const known: Record<string, string> = {
    java: "Java",
    kotlin: "Kotlin",
    spring: "Spring",
    typescript: "TypeScript",
    javascript: "JavaScript",
    react: "React",
    vue: "Vue",
    python: "Python",
    go: "Go",
    "c++": "C++",
    sql: "SQL"
  };
  return known[skill.toLocaleLowerCase()] ?? skill;
}
