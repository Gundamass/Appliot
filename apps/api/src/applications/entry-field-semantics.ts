import type { FormField } from "@resume/contracts";

type EntryKind = "awards" | "education" | "projects" | "work";
type ExperienceSection = "work" | "internship" | "work_combined";

export interface EntrySemanticOptions {
  experienceIndexesBySection?: Partial<Record<ExperienceSection, readonly number[]>>;
}

interface EntryState {
  awards: number;
  education: number;
  projects: number;
  work: number;
  genericDateComponents: Record<EntryKind, number>;
  experiencePageIndexes: Record<ExperienceSection, number>;
  experienceProfileIndexes: Partial<Record<ExperienceSection, number>>;
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
  [/是否有实验室经历|有无实验室经历|laboratory\s*experience/i, "hasLaboratory"],
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

export function deriveEntrySemanticHints(fields: FormField[], options: EntrySemanticOptions = {}): FormField[] {
  const state: EntryState = {
    awards: -1,
    education: -1,
    projects: -1,
    work: -1,
    genericDateComponents: { awards: 0, education: 0, projects: 0, work: 0 },
    experiencePageIndexes: { work: -1, internship: -1, work_combined: -1 },
    experienceProfileIndexes: {},
    active: undefined
  };
  return fields.map((field) => {
    const existingContext = entryContext(field.semanticHint);
    if (existingContext !== undefined) {
      const cataloguedEntryStart = (field.semanticSource === "dji_catalog" || field.semanticSource === "certified_hint")
        && fieldFor(existingContext.kind, field.label.trim()) === entryStartField(existingContext.kind);
      const index = cataloguedEntryStart
        ? Math.max(existingContext.index, state[existingContext.kind] + 1)
        : existingContext.index;
      state[existingContext.kind] = index;
      state.active = existingContext.kind;
      if (cataloguedEntryStart) state.genericDateComponents[existingContext.kind] = 0;
      if (field.semanticHint !== existingContext.path && !cataloguedEntryStart) return field;
      const semanticHint = semanticWithinEntry(existingContext.kind, index, field.label);
      return { ...field, ...(semanticHint === undefined ? {} : { semanticHint }) };
    }
    const semanticHint = entrySemanticHint(field, state, options);
    return { ...field, ...(semanticHint === undefined ? {} : { semanticHint }) };
  });
}

function entryStartField(kind: EntryKind): string {
  return kind === "education" ? "institution"
    : kind === "work" ? "company"
      : "name";
}

function entryContext(hint: string | undefined): { kind: EntryKind; index: number; path: string } | undefined {
  const match = hint?.match(/^(awards|education|projects|work)\[(\d+)\]/u);
  if (!match) return undefined;
  return { kind: match[1] as EntryKind, index: Number(match[2]), path: match[0] };
}

function semanticWithinEntry(kind: EntryKind, index: number, label: string): string | undefined {
  const normalized = label.trim();
  const field = fieldFor(kind, normalized);
  if (field === undefined) return undefined;
  if (kind !== "awards" || field !== "date") return `${kind}[${index}].${field}`;
  const component = dateComponentForLabel(normalized);
  return `awards[${index}].date${component === undefined ? "" : `.${component}`}`;
}

function entrySemanticHint(fieldCandidate: FormField, state: EntryState, options: EntrySemanticOptions): string | undefined {
  const normalized = fieldCandidate.label.trim();
  const projectStart = matches(PROJECT_FIELDS[0]![0], normalized);
  const workStart = matches(WORK_FIELDS[0]![0], normalized);
  const educationStart = matches(EDUCATION_FIELDS[0]![0], normalized);
  const awardStart = matches(AWARD_FIELDS[0]![0], normalized);

  if (awardStart) {
    state.awards += 1;
    state.active = "awards";
    state.genericDateComponents.awards = 0;
  } else if (projectStart) {
    state.projects += 1;
    state.active = "projects";
    state.genericDateComponents.projects = 0;
  } else if (workStart) {
    const section = experienceSectionFor(fieldCandidate);
    if (section === undefined) {
      state.work += 1;
    } else {
      const pageIndex = state.experiencePageIndexes[section] + 1;
      state.experiencePageIndexes[section] = pageIndex;
      const configuredProfileIndexes = options.experienceIndexesBySection?.[section];
      const profileIndex = configuredProfileIndexes === undefined
        ? pageIndex
        : configuredProfileIndexes[pageIndex];
      if (profileIndex === undefined) {
        delete state.experienceProfileIndexes[section];
        state.work = -1;
      } else {
        state.experienceProfileIndexes[section] = profileIndex;
        state.work = profileIndex;
      }
    }
    state.active = "work";
    state.genericDateComponents.work = 0;
  } else if (educationStart) {
    state.education += 1;
    state.active = "education";
    state.genericDateComponents.education = 0;
  }

  const active = state.active;
  if (active === undefined) return undefined;
  const field = fieldFor(active, normalized);
  if (state[active] < 0) return undefined;
  if (active === "awards") {
    if (field !== undefined) {
      if (field !== "date") return `awards[${state.awards}].${field}`;
      const component = dateComponentForLabel(normalized);
      return `awards[${state.awards}].date${component === undefined ? "" : `.${component}`}`;
    }
    if (!matches(CONTEXT_ONLY_FIELDS.awards, normalized)) return undefined;
    const component = dateComponentForLabel(normalized);
    return /起止时间/u.test(normalized) && component !== undefined
      ? `awards[${state.awards}].date.${component}`
      : `awards[${state.awards}]`;
  }

  const experienceSection = experienceSectionFor(fieldCandidate);
  if (experienceSection !== undefined && state.experienceProfileIndexes[experienceSection] !== undefined) {
    state.work = state.experienceProfileIndexes[experienceSection]!;
    state.active = "work";
  }
  if (/起止时间/u.test(normalized)) {
    const component = dateComponentForLabel(normalized);
    if (component === "year" || component === "month") {
      const position = state.genericDateComponents[active];
      state.genericDateComponents[active] += 1;
      const dateField = position < 2 ? "startDate" : "endDate";
      return `${active}[${state[active]}].${dateField}.${component}`;
    }
  }
  if (field === undefined) {
    return matches(CONTEXT_ONLY_FIELDS[active], normalized)
      ? `${active}[${state[active]}]`
      : undefined;
  }
  return `${active}[${state[active]}].${field}`;
}

function experienceSectionFor(field: FormField): ExperienceSection | undefined {
  return field.sectionHint === "work" || field.sectionHint === "internship" || field.sectionHint === "work_combined"
    ? field.sectionHint
    : undefined;
}

function dateComponentForLabel(label: string): "year" | "month" | "day" | undefined {
  if (/[年]/u.test(label)) return "year";
  if (/[月]/u.test(label)) return "month";
  if (/[日号]/u.test(label)) return "day";
  return undefined;
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
