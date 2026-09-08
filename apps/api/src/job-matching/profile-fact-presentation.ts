import type { JobRequirement, ProfileFact } from "@resume/contracts";

const PROFILE_FACT_LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^education\[\d+\]\.degree$/u, "学历"],
  [/^education\[\d+\]\.major$/u, "专业"],
  [/^skills\[\d+\](?:\.name)?$/u, "技能"],
  [/^(?:work|internship)\[\d+\]\.description$/u, "工作经历"]
];

const REQUIREMENT_LABELS: Readonly<Record<JobRequirement["category"], string>> = {
  skill: "技能",
  responsibility: "工作职责",
  project: "项目经验",
  education: "学历",
  major: "专业",
  experience_years: "工作年限",
  location: "工作地点",
  employment_type: "用工类型",
  industry: "行业",
  work_mode: "工作方式",
  salary: "薪资",
  other: "任职"
};

const DISPLAY_VALUE_LIMIT = 120;

export function presentProfileFact(fact: ProfileFact): { label: string; value: string } {
  return {
    label: PROFILE_FACT_LABELS.find(([pattern]) => pattern.test(fact.fieldPath))?.[1] ?? "已确认资料",
    value: boundedDisplayValue(fact.value, DISPLAY_VALUE_LIMIT)
  };
}

export function presentMatchEvidence(requirement: JobRequirement, fact: ProfileFact): string {
  const presented = presentProfileFact(fact);
  return `你的${presented.label}“${presented.value}”符合岗位${REQUIREMENT_LABELS[requirement.category]}要求。`;
}

function boundedDisplayValue(value: ProfileFact["value"], limit: number): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const normalized = serialized.replace(/\s+/gu, " ").trim();
  const characters = [...normalized];
  return characters.length <= limit
    ? normalized
    : `${characters.slice(0, limit - 1).join("")}…`;
}
