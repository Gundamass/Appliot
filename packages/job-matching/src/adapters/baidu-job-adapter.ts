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
  type JobRequirement
} from "@resume/contracts";
import type { JobAdapter } from "./types.js";

const BAIDU_HOST = "talent.baidu.com";
const BAIDU_VERSION = "baidu-job-v1";
const BAIDU_CAMPUS_PATH = /^\/jobs\/(?:list|detail(?:\/|$))/u;

export const baiduJobAdapter: JobAdapter = {
  source: "baidu",
  version: BAIDU_VERSION,

  identify(snapshot): JobEntryKind | "unsupported" {
    if (snapshot.challenge !== undefined
      || snapshot.boundaries.some((boundary) => boundary.visible && boundary.interactive)) {
      return "unsupported";
    }
    let url: URL;
    try {
      url = new URL(snapshot.url);
    } catch {
      return "unsupported";
    }
    if (!isBaiduCampusUrl(url)) return "unsupported";
    return snapshot.entryHint === "job_list"
      || snapshot.entryHint === "job_detail"
      || snapshot.entryHint === "application_form"
      ? snapshot.entryHint
      : "unsupported";
  },

  mapFilters(expectation: JobExpectationSnapshot): FilterPlan {
    const mapped: FilterPlan["mapped"] = [];
    const localOnly: FilterPlan["localOnly"] = [];
    const filterKeys: Partial<Record<JobExpectationSnapshot["criteria"][number]["kind"], string>> = {
      target_role: "postType",
      location: "workPlace",
      employment_type: "projectType"
    };

    expectation.criteria.forEach((criterion, criterionIndex) => {
      const key = filterKeys[criterion.kind];
      if (key === undefined) {
        localOnly.push({ criterionIndex, reasonCode: `unsupported_${criterion.kind}` });
      } else {
        mapped.push({ criterionIndex, key, values: [...criterion.values] });
      }
    });

    return FilterPlanSchema.parse({
      source: "baidu",
      adapterVersion: BAIDU_VERSION,
      mapped,
      localOnly
    });
  },

  extractList(snapshot): ExtractedJobPage {
    if (this.identify(snapshot) !== "job_list"
      || (snapshot.pagination.hasNext && snapshot.jobCards.length === 0)) {
      throw new Error("job_adapter_contract_mismatch");
    }
    try {
      return ExtractedJobPageSchema.parse({
        postings: snapshot.jobCards.map((card) => postingFromCard(
          card,
          card.summary?.trim() || card.title,
          employmentTypeFromSnapshot(snapshot, card)
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

  extractDetail(snapshot): JobPostingDraft {
    if (this.identify(snapshot) !== "job_detail" || snapshot.jobCards.length !== 1) {
      throw new Error("job_adapter_contract_mismatch");
    }
    const description = snapshot.visibleText
      .map((value) => value.trim())
      .filter(Boolean)
      .join("\n");
    if (description.length === 0) throw new Error("job_adapter_contract_mismatch");
    try {
      return postingFromCard(
        snapshot.jobCards[0]!,
        description,
        employmentTypeFromSnapshot(snapshot, snapshot.jobCards[0]!)
      );
    } catch (error) {
      throw new Error("job_adapter_contract_mismatch", { cause: error });
    }
  }
};

function isBaiduCampusUrl(url: URL): boolean {
  if (url.protocol !== "https:" || url.hostname !== BAIDU_HOST || !BAIDU_CAMPUS_PATH.test(url.pathname)) {
    return false;
  }
  if (url.pathname === "/jobs/list") {
    const recruitType = url.searchParams.get("recruitType");
    const projectType = url.searchParams.get("projectType");
    return (recruitType === null || recruitType === "GRADUATE")
      && (projectType === null || ["1", "3", "4"].includes(projectType));
  }
  if (url.pathname.startsWith("/jobs/detail/")) {
    const recruitType = url.searchParams.get("recruitType");
    const pathType = url.pathname.split("/").filter(Boolean)[2];
    const projectType = url.searchParams.get("projectType");
    return (pathType === undefined || pathType === "GRADUATE")
      && (recruitType === null || recruitType === "GRADUATE")
      && (pathType === "GRADUATE" || recruitType === "GRADUATE" || projectType === null || ["1", "3", "4"].includes(projectType));
  }
  const recruitType = url.searchParams.get("recruitType");
  return recruitType === "GRADUATE";
}

function postingFromCard(
  card: JobPageSnapshot["jobCards"][number],
  description: string,
  employmentType: string | undefined
): JobPostingDraft {
  let canonicalUrl: URL;
  try {
    canonicalUrl = new URL(card.canonicalUrl);
  } catch (error) {
    throw new Error("job_adapter_contract_mismatch", { cause: error });
  }
  if (!isBaiduCampusUrl(canonicalUrl) || description.trim().length === 0) {
    throw new Error("job_adapter_contract_mismatch");
  }
  return JobPostingDraftSchema.parse({
    source: "baidu",
    ...(card.sourceJobId === undefined ? {} : { sourceJobId: card.sourceJobId }),
    canonicalUrl: card.canonicalUrl,
    title: card.title,
    organization: card.organization,
    ...(card.location === undefined ? {} : { location: card.location }),
    ...(employmentType === undefined ? {} : { employmentType }),
    description,
    requirements: extractRequirements(description, employmentType),
    adapterVersion: BAIDU_VERSION
  });
}

function employmentTypeFromSnapshot(
  snapshot: JobPageSnapshot,
  card: JobPageSnapshot["jobCards"][number]
): string | undefined {
  if (card.employmentType !== undefined && card.employmentType.trim() !== "") {
    return card.employmentType.trim();
  }
  const filter = snapshot.filterState.find((candidate) =>
    ["projectType", "project_type", "recruitType", "recruit_type"].includes(candidate.key)
  );
  if (filter?.values[0] !== undefined) return filter.values[0];
  const text = snapshot.visibleText.join("\n");
  const match = text.match(/(?:项目类型|招聘类型)\s*[:：]\s*([^\n]+)/u);
  return match?.[1]?.trim() || undefined;
}

function extractRequirements(description: string, employmentType: string | undefined): JobRequirement[] {
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

  if (employmentType !== undefined) add("employment_type", employmentType, `项目类型：${employmentType}`);
  for (const line of description.split(/\r?\n|[；;]/u).map((value) => value.trim()).filter(Boolean)) {
    if (/本科|硕士|博士|大专|学历/u.test(line)) add("education", line, line);
    if (/专业/u.test(line)) add("major", line, line);
    const years = line.match(/(\d+(?:\.\d+)?)\s*年/u)?.[1];
    if (years !== undefined) add("experience_years", years, line);
    for (const skill of line.match(/TypeScript|JavaScript|Kotlin|Spring|Python|React|Java|Vue|C\+\+|SQL|Go|LangChain|LlamaIndex|AutoGen|CrewAI/giu) ?? []) {
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
    langchain: "LangChain",
    llamaindex: "LlamaIndex",
    autogen: "AutoGen",
    crewai: "CrewAI",
    go: "Go",
    "c++": "C++",
    sql: "SQL"
  };
  return known[skill.toLocaleLowerCase()] ?? skill;
}
