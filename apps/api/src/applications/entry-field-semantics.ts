import type { FormField } from "@resume/contracts";

type EntryKind = "awards" | "education" | "projects" | "work";

interface EntryState {
  awards: number;
  education: number;
  projects: number;
  work: number;
  active: EntryKind | undefined;
}

const PROJECT_FIELDS: Array<[RegExp, string]> = [
  [/项目名称|项目名|project\s*name/i, "name"],
  [/项目描述|项目简介|project\s*description/i, "description"],
  [/技术栈|开发工具|tech(?:nology)?\s*stack/i, "technologies"],
  [/项目要点|项目成果|项目职责|项目亮点|project\s*(?:highlights?|achievements?)/i, "highlights[0]"],
  [/开始时间|项目开始|start\s*date/i, "startDate"],
  [/结束时间|项目结束|end\s*date/i, "endDate"]
];

const WORK_FIELDS: Array<[RegExp, string]> = [
  [/公司|单位|company/i, "company"],
  [/职位|岗位|职务|position|title/i, "position"],
  [/工作类型|用工类型|实习类型|employment\s*type/i, "employmentType"],
  [/职责和成果|工作描述|工作职责|responsibilit|summary/i, "description"],
  [/开始时间|入职时间|start\s*date/i, "startDate"],
  [/结束时间|离职时间|end\s*date/i, "endDate"]
];

const EDUCATION_FIELDS: Array<[RegExp, string]> = [
  [/学校|院校|毕业院校|institution|school/i, "institution"],
  [/专业|major/i, "major"],
  [/学历|学位|degree/i, "degree"],
  [/教育描述|教育经历描述|education\s*details/i, "description"],
  [/开始时间|入学时间|start\s*date/i, "startDate"],
  [/结束时间|毕业时间|end\s*date/i, "endDate"]
];

const AWARD_FIELDS: Array<[RegExp, string]> = [
  [/赛事名称|比赛名称|获奖名称|奖项名称|获奖项目|competition\s*name|award\s*name/i, "name"],
  [/赛事时间|比赛时间|获奖时间|奖项时间|获奖日期|award\s*date/i, "date"],
  [/奖项级别|获奖级别|荣誉级别|奖项等级|award\s*level/i, "level"],
  [/赛事描述|比赛描述|获奖描述|奖项描述|award\s*description/i, "description"]
];

const CONTEXT_ONLY_FIELDS: Record<EntryKind, RegExp> = {
  awards: /颁奖机构|授予机构|获奖名次|获奖排名|起止时间/i,
  education: /培养方式|培养类别|培养类型|招生方式|学历类型|学习形式|教育类型|院系|学院|绩点|gpa|排名|最高学历/i,
  projects: /担任角色|项目角色|职责角色/i,
  work: /工作地点|实习地点/i
};

export function deriveEntrySemanticHints(fields: FormField[]): FormField[] {
  const state: EntryState = { awards: -1, education: -1, projects: -1, work: -1, active: undefined };
  return fields.map((field) => {
    const semanticHint = entrySemanticHint(field.label, state);
    return { ...field, ...(semanticHint === undefined ? {} : { semanticHint }) };
  });
}

function entrySemanticHint(label: string, state: EntryState): string | undefined {
  const normalized = label.trim();
  const projectStart = matches(PROJECT_FIELDS[0]![0], normalized);
  const workStart = matches(WORK_FIELDS[0]![0], normalized);
  const educationStart = matches(EDUCATION_FIELDS[0]![0], normalized);
  const awardStart = matches(AWARD_FIELDS[0]![0], normalized);

  if (awardStart) {
    state.awards += 1;
    state.active = "awards";
  } else if (projectStart) {
    state.projects += 1;
    state.active = "projects";
  } else if (workStart) {
    state.work += 1;
    state.active = "work";
  } else if (educationStart) {
    state.education += 1;
    state.active = "education";
  }

  const active = state.active;
  if (active === undefined) return undefined;
  const field = fieldFor(active, normalized);
  if (state[active] < 0) return undefined;
  if (active === "awards") {
    return field !== undefined || matches(CONTEXT_ONLY_FIELDS.awards, normalized)
      ? `awards[${state.awards}]`
      : undefined;
  }
  if (field === undefined) {
    return matches(CONTEXT_ONLY_FIELDS[active], normalized)
      ? `${active}[${state[active]}]`
      : undefined;
  }
  return `${active}[${state[active]}].${field}`;
}

function fieldFor(kind: EntryKind, label: string): string | undefined {
  const fields = kind === "awards"
    ? AWARD_FIELDS
    : kind === "projects"
      ? PROJECT_FIELDS
      : kind === "work"
        ? WORK_FIELDS
        : EDUCATION_FIELDS;
  return fields.find(([pattern]) => matches(pattern, label))?.[1];
}

function matches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}
