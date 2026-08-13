export type MokahrSection = "education" | "work" | "projects" | "awards" | "laboratory";

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

const SECTION_SIGNALS: Array<{ section: MokahrSection; patterns: RegExp[] }> = [
  { section: "education", patterns: [/教育经历/i, /教育背景/i, /教育信息/i] },
  { section: "work", patterns: [/工作经历/i, /实习经历/i, /工作\s*\/\s*实习经历/i, /工作或实习经历/i] },
  { section: "projects", patterns: [/项目经历/i, /项目经验/i, /项目背景/i] },
  { section: "awards", patterns: [/获奖经历/i, /获奖信息/i, /赛事经历/i, /竞赛经历/i, /奖项经历/i] },
  { section: "laboratory", patterns: [/实验室经历/i, /科研经历/i, /研究经历/i] }
];

const FIELD_ORDER: Record<MokahrSection, RegExp[]> = {
  education: [/学校|院校|毕业院校/i, /学历/i, /专业/i, /开始时间|入学时间/i, /结束时间|毕业时间/i, /成绩|GPA/i, /描述|说明/i],
  work: [/公司|单位/i, /职位|岗位|职务/i, /工作类型|用工类型|实习类型/i, /开始时间/i, /结束时间/i, /地点|所在地/i, /职责/i, /成果|业绩|成就/i],
  projects: [/项目名称|项目名/i, /开始时间/i, /结束时间/i, /项目描述|项目简介|描述/i, /技术栈|技术|开发工具/i, /项目要点|项目成果|项目职责|职责|亮点/i],
  awards: [/获奖名称|奖项名称|赛事名称|比赛名称/i, /获奖时间|奖项时间|赛事时间/i, /奖项级别|获奖级别/i, /获奖描述|奖项描述|赛事描述/i],
  laboratory: [/实验室名称|科研名称|研究方向/i, /开始时间/i, /结束时间/i, /描述|成果|职责/i]
};

export function isMokahrPage(signal: MokahrPageSignal): boolean {
  const url = signal.url.toLowerCase();
  if (url.includes("mokahr.com") || url.includes("careers.dji.com") || url.includes("apply.careers.dji.com")) {
    return true;
  }
  const pageText = normalized(signal.pageText);
  return /moka|mokahr/i.test(pageText) && SECTION_SIGNALS.some(({ patterns }) => patterns.some((pattern) => pattern.test(pageText)));
}

export function classifyMokahrAddActions(actions: MokahrObservedAction[]): MokahrAddAction[] {
  return actions.flatMap((action) => {
    if (!isAddAction(action.text)) return [];
    const section = sectionFor(normalized(`${action.nearbyText} ${action.text}`));
    return section ? [{ actionId: action.id, section }] : [];
  });
}

export function sortMokahrEntryFields(section: MokahrSection, fields: MokahrObservedField[]): MokahrObservedField[] {
  const patterns = FIELD_ORDER[section];
  return fields.map((field, index) => ({ field, index })).sort((left, right) => {
    const rankDifference = fieldRank(patterns, left.field.label) - fieldRank(patterns, right.field.label);
    return rankDifference || left.index - right.index;
  }).map(({ field }) => field);
}

function isAddAction(value: string): boolean {
  return /(^|\s)(添加|新增)(\s|$)/.test(normalized(value));
}

function sectionFor(value: string): MokahrSection | undefined {
  return SECTION_SIGNALS.find(({ patterns }) => patterns.some((pattern) => pattern.test(value)))?.section;
}

function fieldRank(patterns: RegExp[], label: string): number {
  const index = patterns.findIndex((pattern) => pattern.test(normalized(label)));
  return index < 0 ? patterns.length : index;
}

function normalized(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}
