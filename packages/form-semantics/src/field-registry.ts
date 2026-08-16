import type { FormField } from "@resume/contracts";

export type SemanticFieldType = FormField["type"];
export type ProfileFieldControl = "text" | "textarea" | "date" | "enum" | "boolean" | "suggestion" | "file";
export type FieldSection =
  | "basics"
  | "preferences"
  | "education"
  | "work"
  | "projects"
  | "campus"
  | "awards"
  | "publications"
  | "languages"
  | "certificates"
  | "self";

export interface FieldDefinition {
  semantic: string;
  label: string;
  aliases: readonly string[];
  legacySemantics?: readonly string[];
  types: readonly SemanticFieldType[];
  sections: readonly FieldSection[];
  risk: "normal" | "sensitive" | "commitment";
  description: string;
  profileControl?: ProfileFieldControl;
  profileOptions?: readonly string[];
  profileRequired?: boolean;
}

export interface ProfileSectionDefinition {
  id: FieldSection;
  label: string;
  repeatable: boolean;
}

export interface SemanticFieldInput {
  label: string;
  type: SemanticFieldType;
  semanticHint?: string;
  entryContext?: string;
}

export interface FieldSemanticMatch {
  semantic: string;
  definition: FieldDefinition;
  source: "exact_alias";
  confidence: 1;
}

export const PROFILE_SECTION_DEFINITIONS: readonly ProfileSectionDefinition[] = [
  { id: "basics", label: "基本信息", repeatable: false },
  { id: "preferences", label: "求职偏好", repeatable: false },
  { id: "education", label: "教育经历", repeatable: true },
  { id: "work", label: "实习与工作", repeatable: true },
  { id: "projects", label: "项目经历", repeatable: true },
  { id: "campus", label: "在校实践", repeatable: true },
  { id: "awards", label: "获奖经历", repeatable: true },
  { id: "publications", label: "论文与专著", repeatable: true },
  { id: "languages", label: "语言能力", repeatable: true },
  { id: "certificates", label: "证书", repeatable: true },
  { id: "self", label: "自我评价", repeatable: false }
] as const;

const TEXT_TYPES = ["text", "textarea"] as const;
const TEXT_SELECT_TYPES = ["text", "select", "radio"] as const;
const DATE_TYPES = ["date", "text", "select"] as const;

const RAW_FIELD_DEFINITIONS = [
  definition("basics.name", "姓名", ["中文姓名", "真实姓名"], TEXT_TYPES, ["basics"], "候选人的中文姓名", "sensitive"),
  definition("basics.englishName", "英文名", ["英文姓名", "english name"], TEXT_TYPES, ["basics"], "候选人的英文姓名"),
  definition("basics.email", "邮箱", ["电子邮箱", "邮箱地址", "联系邮箱", "e-mail", "email"], TEXT_TYPES, ["basics"], "候选人的联系邮箱", "sensitive"),
  definition("basics.phone", "手机号码", ["手机", "手机号", "联系电话", "个人联系电话", "移动电话", "mobile", "phone"], TEXT_TYPES, ["basics"], "候选人的手机和联系电话", "sensitive"),
  definition("basics.wechat", "微信号", ["微信", "wechat"], TEXT_TYPES, ["basics"], "候选人的微信账号", "sensitive"),
  definition("basics.qq", "QQ", ["qq号", "qq号码"], TEXT_TYPES, ["basics"], "候选人的 QQ 账号", "sensitive"),
  definition("basics.gender", "性别", ["gender"], ["select", "radio", "text"], ["basics"], "候选人的性别", "sensitive"),
  definition("basics.birthDate", "出生日期", ["生日", "出生年月", "date of birth"], DATE_TYPES, ["basics"], "候选人的出生日期", "sensitive"),
  definition("basics.nationality", "国籍", ["国家或地区", "nationality"], TEXT_SELECT_TYPES, ["basics"], "候选人的国籍", "sensitive"),
  definition("basics.ethnicity", "民族", ["ethnicity"], TEXT_SELECT_TYPES, ["basics"], "候选人的民族", "sensitive"),
  definition("basics.politicalStatus", "政治面貌", ["政治身份"], TEXT_SELECT_TYPES, ["basics"], "候选人的政治面貌", "sensitive"),
  definition("basics.maritalStatus", "婚姻状况", ["婚姻状态"], TEXT_SELECT_TYPES, ["basics"], "候选人的婚姻状况", "sensitive"),
  definition("basics.currentLocation", "现居住地", ["现居地", "当前所在地", "居住城市"], TEXT_SELECT_TYPES, ["basics"], "候选人当前居住城市", "sensitive"),
  definition("basics.hukouLocation", "户籍所在地", ["户口所在地", "户籍地"], TEXT_SELECT_TYPES, ["basics"], "候选人的户籍所在地", "sensitive"),
  definition("basics.avatar", "个人头像", ["头像", "个人照片", "证件照"], ["file"], ["basics"], "候选人的个人头像", "sensitive"),
  definition("identity.idType", "证件类型", ["证件类别"], ["select", "radio", "text"], ["basics"], "身份凭证类型", "sensitive"),
  definition("identity.idNumber", "证件号码", ["身份证号", "身份证号码"], TEXT_TYPES, ["basics"], "身份凭证号码", "sensitive"),

  definition("preferences.targetRole", "期望职位", ["意向岗位", "求职岗位", "目标岗位"], TEXT_SELECT_TYPES, ["preferences"], "候选人的目标职位"),
  definition("preferences.targetCity", "期望工作地点", ["意向城市", "目标城市", "工作城市"], TEXT_SELECT_TYPES, ["preferences"], "候选人的目标工作城市", "normal", ["preferences.location"]),
  definition("preferences.employmentType", "期望工作性质", ["工作性质", "求职类型"], TEXT_SELECT_TYPES, ["preferences"], "全职、实习等期望工作性质"),
  definition("preferences.industry", "期望行业", ["目标行业", "意向行业"], TEXT_SELECT_TYPES, ["preferences"], "候选人的目标行业"),
  definition("preferences.workMode", "期望办公方式", ["办公方式", "工作方式"], TEXT_SELECT_TYPES, ["preferences"], "现场、混合或远程办公偏好"),
  definition("preferences.salary", "期望薪资", ["薪资期望", "期望月薪"], TEXT_TYPES, ["preferences"], "候选人的薪资范围"),
  definition("preferences.availability", "到岗时间", ["最快到岗时间", "可入职时间"], DATE_TYPES, ["preferences"], "候选人可以开始工作的时间", "commitment"),
  definition("preferences.willingToRelocate", "是否接受异地工作", ["是否接受调动", "是否接受调剂"], ["select", "radio", "checkbox"], ["preferences"], "是否接受异地、调动或岗位调剂", "commitment"),
  definition("preferences.willingToTravel", "是否接受出差", ["能否出差", "出差意愿"], ["select", "radio", "checkbox"], ["preferences"], "是否接受工作出差", "commitment"),

  repeated("education[].institution", "学校名称", ["学校", "院校", "毕业院校", "就读院校", "institution", "school"], TEXT_TYPES, "education", "教育经历中的学校或院校", ["education[].school"]),
  repeated("education[].degree", "学历", ["学位", "最高学历", "degree"], TEXT_SELECT_TYPES, "education", "教育经历的学历或学位"),
  repeated("education[].degreeType", "学历类型", ["学习形式", "教育类型"], TEXT_SELECT_TYPES, "education", "全日制、非全日制等学历类型"),
  repeated("education[].enrollmentType", "培养类别", ["培养类型", "招生方式"], TEXT_SELECT_TYPES, "education", "统招、定向、委培等培养方式"),
  repeated("education[].major", "专业名称", ["专业", "所学专业", "major"], TEXT_TYPES, "education", "教育经历的专业"),
  repeated("education[].majorCategory", "专业类别", ["学科类别", "专业大类"], TEXT_SELECT_TYPES, "education", "教育经历的专业类别"),
  repeated("education[].department", "院系名称", ["学院", "院系", "department"], TEXT_TYPES, "education", "教育经历所在学院或院系"),
  repeated("education[].schoolLocation", "学校所在地", ["院校所在地"], TEXT_SELECT_TYPES, "education", "学校所在地区"),
  repeated("education[].startDate", "入学时间", ["教育开始时间", "就读开始时间"], DATE_TYPES, "education", "教育经历开始日期"),
  repeated("education[].endDate", "毕业时间", ["教育结束时间", "就读结束时间"], DATE_TYPES, "education", "教育经历结束日期"),
  repeated("education[].isHighest", "是否为最高学历", ["最高学历标识"], ["select", "radio", "checkbox"], "education", "当前教育经历是否为最高学历"),
  repeated("education[].isExchange", "是否交流学习", ["交流学习", "是否交换学习"], ["select", "radio", "checkbox"], "education", "该教育经历是否为交流学习"),
  repeated("education[].isJointProgram", "是否联合办学", ["联合办学", "是否联合培养"], ["select", "radio", "checkbox"], "education", "该教育经历是否为联合办学"),
  repeated("education[].gpa", "GPA", ["绩点", "平均绩点"], TEXT_TYPES, "education", "教育经历的平均绩点"),
  repeated("education[].rank", "成绩排名", ["专业排名", "班级排名"], TEXT_SELECT_TYPES, "education", "教育经历的成绩或专业排名"),
  repeated("education[].advisor", "导师姓名", ["导师", "指导教师"], TEXT_TYPES, "education", "教育经历中的导师姓名"),
  repeated("education[].isNationalKeyLab", "是否国家重点实验室", ["国家重点实验室"], ["select", "radio", "checkbox"], "education", "所在实验室是否为国家重点实验室"),
  repeated("education[].laboratory", "所在实验室", ["实验室名称"], TEXT_TYPES, "education", "教育经历中的实验室"),
  repeated("education[].description", "教育经历描述", ["在校经历", "教育描述"], ["textarea", "text"], "education", "教育经历的原文描述"),

  repeated("work[].company", "单位名称", ["公司", "公司名称", "实习单位", "工作单位", "company"], TEXT_TYPES, "work", "工作或实习经历中的单位"),
  repeated("work[].position", "职位名称", ["职位", "岗位", "岗位名称", "职务", "position", "title"], TEXT_TYPES, "work", "工作或实习经历中的职位", ["work[].title"]),
  repeated("work[].department", "任职部门", ["所在部门", "所属部门"], TEXT_TYPES, "work", "工作或实习所在部门"),
  repeated("work[].employmentType", "用工类型", ["工作类型", "实习类型", "employment type"], TEXT_SELECT_TYPES, "work", "实习、全职等用工类型"),
  repeated("work[].startDate", "工作开始时间", ["入职时间", "实习开始时间"], DATE_TYPES, "work", "工作或实习经历开始日期"),
  repeated("work[].endDate", "工作结束时间", ["离职时间", "实习结束时间"], DATE_TYPES, "work", "工作或实习经历结束日期"),
  repeated("work[].description", "职责和成果", ["工作职责", "实习内容", "工作描述"], ["textarea", "text"], "work", "工作或实习职责和成果原文"),

  repeated("projects[].name", "项目名称", ["项目名", "project name"], TEXT_TYPES, "projects", "项目经历的名称"),
  repeated("projects[].role", "项目角色", ["担任角色", "职责角色"], TEXT_TYPES, "projects", "候选人在项目中的角色"),
  repeated("projects[].startDate", "项目开始时间", ["项目起始时间"], DATE_TYPES, "projects", "项目开始日期"),
  repeated("projects[].endDate", "项目结束时间", ["项目截止时间"], DATE_TYPES, "projects", "项目结束日期"),
  repeated("projects[].description", "项目描述", ["项目简介", "实践概述", "project description"], ["textarea", "text"], "projects", "项目经历的原文描述"),
  repeated("projects[].technologies", "技术栈", ["开发工具", "项目技术"], TEXT_TYPES, "projects", "项目使用的技术和工具"),
  repeated("projects[].url", "项目链接", ["项目地址", "项目网址", "代码仓库", "project url"], TEXT_TYPES, "projects", "项目演示、主页或代码仓库链接"),
  repeated("projects[].highlights[0]", "项目要点", ["项目成果", "项目亮点", "项目职责"], ["textarea", "text"], "projects", "项目经历中的原文要点"),

  repeated("campus[].name", "实践名称", ["在校实践名称", "活动名称"], TEXT_TYPES, "campus", "在校实践或活动名称"),
  repeated("campus[].role", "实践角色", ["担任角色", "活动角色"], TEXT_TYPES, "campus", "在校实践中担任的角色"),
  repeated("campus[].startDate", "实践开始时间", ["活动开始时间", "实践起始时间"], DATE_TYPES, "campus", "在校实践或活动开始日期"),
  repeated("campus[].endDate", "实践结束时间", ["活动结束时间", "实践截止时间"], DATE_TYPES, "campus", "在校实践或活动结束日期"),
  repeated("campus[].description", "实践描述", ["实践概述", "活动描述"], ["textarea", "text"], "campus", "在校实践的原文描述"),
  repeated("campus[].highlights[0]", "实践成果", ["实践亮点", "活动成果"], ["textarea", "text"], "campus", "在校实践中的原文成果"),

  repeated("awards[].name", "获奖名称", ["奖项名称", "获奖项目"], TEXT_TYPES, "awards", "奖项或荣誉名称"),
  repeated("awards[].date", "获奖时间", ["奖项时间"], DATE_TYPES, "awards", "获得奖项的日期"),
  repeated("awards[].level", "奖项级别", ["获奖级别", "荣誉级别", "奖项等级"], TEXT_SELECT_TYPES, "awards", "国家级、省级、市级、校级、院级或其他奖项级别"),
  repeated("awards[].description", "获奖描述", ["奖项描述"], ["textarea", "text"], "awards", "奖项的原文说明"),

  repeated("publications[].title", "论文名称", ["论文题目", "专著名称"], TEXT_TYPES, "publications", "论文或专著名称"),
  repeated("publications[].type", "成果类型", ["论文类型", "出版物类型"], TEXT_SELECT_TYPES, "publications", "论文、专著或其他成果类型"),
  repeated("publications[].publisher", "发表或出版方", ["期刊名称", "出版社", "发表机构"], TEXT_TYPES, "publications", "论文或专著的发表或出版方"),
  repeated("publications[].date", "发表时间", ["出版时间"], DATE_TYPES, "publications", "论文或专著发表日期"),
  repeated("publications[].authors", "作者", ["论文作者", "作者列表"], TEXT_TYPES, "publications", "论文或专著作者信息"),
  repeated("publications[].url", "成果链接", ["论文链接", "出版物链接"], TEXT_TYPES, "publications", "论文或专著的链接"),
  repeated("publications[].description", "成果描述", ["论文描述", "专著描述"], ["textarea", "text"], "publications", "论文或专著的原文说明"),

  repeated("languages[].name", "语言名称", ["语种", "外语名称", "language"], TEXT_SELECT_TYPES, "languages", "候选人掌握的语言名称"),
  repeated("languages[].proficiency", "掌握程度", ["语言水平", "熟练程度", "proficiency"], TEXT_SELECT_TYPES, "languages", "候选人对该语言的综合掌握程度"),
  repeated("languages[].speakingListening", "听说能力", ["口语能力", "听力能力", "听说水平"], TEXT_SELECT_TYPES, "languages", "候选人对该语言的听说能力"),
  repeated("languages[].readingWriting", "读写能力", ["阅读能力", "写作能力", "读写水平"], TEXT_SELECT_TYPES, "languages", "候选人对该语言的读写能力"),

  repeated("certificates[].name", "证书名称", ["资格证书", "认证名称"], TEXT_TYPES, "certificates", "证书或资格认证名称"),
  repeated("certificates[].issuer", "颁发机构", ["发证机构"], TEXT_TYPES, "certificates", "证书颁发机构"),
  repeated("certificates[].date", "获得时间", ["证书时间", "取得时间"], DATE_TYPES, "certificates", "获得证书的日期"),
  repeated("certificates[].description", "证书描述", ["认证描述"], ["textarea", "text"], "certificates", "证书或认证的原文说明"),

  definition("selfEvaluation", "自我评价", ["个人评价", "个人总结", "self evaluation"], ["textarea", "text"], ["self"], "候选人的自我评价原文")
] as const;

const GENDER_OPTIONS = ["男", "女", "其他", "不愿透露"] as const;
const NATIONALITY_OPTIONS = ["中国", "美国", "加拿大", "英国", "法国", "德国", "澳大利亚", "新加坡", "日本", "韩国", "其他"] as const;
const POLITICAL_STATUS_OPTIONS = ["中共党员", "中共预备党员", "共青团员", "群众", "民主党派成员", "无党派人士", "其他"] as const;
const MARITAL_STATUS_OPTIONS = ["未婚", "已婚", "离异", "丧偶", "其他", "不愿透露"] as const;
const ID_TYPE_OPTIONS = ["居民身份证", "护照", "港澳居民来往内地通行证", "台湾居民来往大陆通行证", "其他"] as const;
const DEGREE_OPTIONS = ["高中及以下", "大专", "本科", "硕士", "博士", "其他"] as const;
const DEGREE_TYPE_OPTIONS = ["全日制", "非全日制", "其他"] as const;
const ENROLLMENT_TYPE_OPTIONS = ["统招", "定向", "委培", "自筹", "其他"] as const;
const EMPLOYMENT_TYPE_OPTIONS = ["实习", "全职", "兼职", "劳务", "其他"] as const;
const AWARD_LEVEL_OPTIONS = ["国家级", "省级", "市级", "校级", "院级", "其他"] as const;
const ETHNICITY_OPTIONS = [
  "汉族", "蒙古族", "回族", "藏族", "维吾尔族", "苗族", "彝族", "壮族", "布依族", "朝鲜族", "满族", "侗族", "瑶族", "白族", "土家族", "哈尼族", "哈萨克族", "傣族", "黎族", "傈僳族", "佤族", "畲族", "高山族", "拉祜族", "水族", "东乡族", "纳西族", "景颇族", "柯尔克孜族", "土族", "达斡尔族", "仫佬族", "羌族", "布朗族", "撒拉族", "毛南族", "仡佬族", "锡伯族", "阿昌族", "普米族", "塔吉克族", "怒族", "乌孜别克族", "俄罗斯族", "鄂温克族", "德昂族", "保安族", "裕固族", "京族", "塔塔尔族", "独龙族", "鄂伦春族", "赫哲族", "门巴族", "珞巴族", "基诺族"
] as const;

const PROFILE_FIELD_METADATA: Readonly<Record<string, {
  control: ProfileFieldControl;
  options?: readonly string[];
  required?: boolean;
}>> = {
  "basics.avatar": { control: "file", required: false },
  "basics.gender": { control: "enum", options: GENDER_OPTIONS },
  "basics.nationality": { control: "suggestion", options: NATIONALITY_OPTIONS },
  "basics.ethnicity": { control: "enum", options: ETHNICITY_OPTIONS },
  "basics.politicalStatus": { control: "enum", options: POLITICAL_STATUS_OPTIONS },
  "basics.maritalStatus": { control: "enum", options: MARITAL_STATUS_OPTIONS },
  "basics.currentLocation": { control: "suggestion" },
  "basics.hukouLocation": { control: "suggestion" },
  "identity.idType": { control: "enum", options: ID_TYPE_OPTIONS },
  "preferences.targetRole": { control: "suggestion" },
  "preferences.targetCity": { control: "suggestion" },
  "preferences.employmentType": { control: "enum", options: EMPLOYMENT_TYPE_OPTIONS },
  "preferences.industry": { control: "suggestion" },
  "preferences.workMode": { control: "suggestion" },
  "preferences.salary": { control: "text" },
  "preferences.willingToRelocate": { control: "boolean", options: ["是", "否"] },
  "preferences.willingToTravel": { control: "boolean", options: ["是", "否"] },
  "education[].degree": { control: "enum", options: DEGREE_OPTIONS },
  "education[].degreeType": { control: "enum", options: DEGREE_TYPE_OPTIONS },
  "education[].enrollmentType": { control: "enum", options: ENROLLMENT_TYPE_OPTIONS },
  "education[].isHighest": { control: "boolean", options: ["是", "否"] },
  "education[].isExchange": { control: "boolean", options: ["是", "否"] },
  "education[].isJointProgram": { control: "boolean", options: ["是", "否"] },
  "education[].isNationalKeyLab": { control: "boolean", options: ["是", "否"] },
  "education[].schoolLocation": { control: "suggestion" },
  "work[].employmentType": { control: "enum", options: EMPLOYMENT_TYPE_OPTIONS },
  "awards[].level": { control: "enum", options: AWARD_LEVEL_OPTIONS },
  "languages[].name": { control: "suggestion" },
  "languages[].proficiency": { control: "suggestion" },
  "languages[].speakingListening": { control: "suggestion" },
  "languages[].readingWriting": { control: "suggestion" },
  "projects[].url": { control: "text", required: false },
  "campus[].highlights[0]": { control: "textarea", required: false }
};

export const FIELD_DEFINITIONS: readonly FieldDefinition[] = RAW_FIELD_DEFINITIONS.map((field) => ({
  ...field,
  profileControl: PROFILE_FIELD_METADATA[field.semantic]?.control ?? defaultProfileControl(field.types),
  profileRequired: PROFILE_FIELD_METADATA[field.semantic]?.required ?? true,
  ...(PROFILE_FIELD_METADATA[field.semantic]?.options === undefined
    ? {}
    : { profileOptions: PROFILE_FIELD_METADATA[field.semantic]!.options })
}));

const COMMON_ATS_ALIASES: Readonly<Record<string, string>> = {
  "legalname": "basics.name",
  "fullname": "basics.name",
  "phonenumber": "basics.phone",
  "mobilenumber": "basics.phone",
  "whereareyoucurrentlylocated": "basics.currentLocation",
  "currentlocation": "basics.currentLocation",
  "whencanyoustartanewrole": "preferences.availability",
  "earlieststartdate": "preferences.availability",
  "areyouwillingtorelocate": "preferences.willingToRelocate",
  "willingtorelocate": "preferences.willingToRelocate"
};

export function resolveDeterministicSemantic(input: SemanticFieldInput): FieldSemanticMatch | undefined {
  const hinted = input.semanticHint === undefined
    ? undefined
    : FIELD_DEFINITIONS.find((candidate) => matchesSemantic(candidate, input.semanticHint!));
  const commonAliasSemantic = COMMON_ATS_ALIASES[normalize(input.label)];
  const commonAlias = commonAliasSemantic === undefined
    ? undefined
    : FIELD_DEFINITIONS.find((candidate) => candidate.semantic === commonAliasSemantic);
  const definition = hinted ?? commonAlias ?? FIELD_DEFINITIONS.find((candidate) =>
    [candidate.label, ...candidate.aliases].some((alias) => normalize(alias) === normalize(input.label))
  );
  if (!definition || !definition.types.includes(input.type)) return undefined;
  const semantic = materializeSemantic(definition.semantic, input.entryContext ?? contextFromHint(input.semanticHint));
  if (semantic === undefined) return undefined;
  return { semantic, definition, source: "exact_alias", confidence: 1 };
}

export function profileSectionFor(fieldPath: string): FieldSection | undefined {
  return FIELD_DEFINITIONS.find((candidate) => matchesSemantic(candidate, fieldPath))?.sections[0];
}

export function semanticLookupPaths(semantic: string): string[] {
  const requested = semantic.trim();
  const definition = FIELD_DEFINITIONS.find((candidate) => matchesSemantic(candidate, requested));
  if (!definition) return [requested];

  const entryContext = contextFromHint(requested);
  const canonical = materializeSemantic(definition.semantic, entryContext);
  const legacy = (definition.legacySemantics ?? [])
    .map((template) => materializeSemantic(template, entryContext))
    .filter((path): path is string => path !== undefined);

  return [...new Set([canonical, requested, ...legacy].filter((path): path is string => path !== undefined))];
}

export function fieldDefinitionText(definition: FieldDefinition): string {
  return [
    `标准字段：${definition.semantic}`,
    `名称：${definition.label}`,
    `别名：${definition.aliases.join("、")}`,
    `栏目：${definition.sections.join("、")}`,
    `说明：${definition.description}`
  ].join("\n");
}

function definition(
  semantic: string,
  label: string,
  aliases: readonly string[],
  types: readonly SemanticFieldType[],
  sections: readonly FieldSection[],
  description: string,
  risk: FieldDefinition["risk"] = "normal",
  legacySemantics: readonly string[] = []
): Omit<FieldDefinition, "profileControl" | "profileOptions"> {
  return {
    semantic,
    label,
    aliases,
    types,
    sections,
    risk,
    description,
    ...(legacySemantics.length === 0 ? {} : { legacySemantics })
  };
}

function repeated(
  semantic: string,
  label: string,
  aliases: readonly string[],
  types: readonly SemanticFieldType[],
  section: FieldSection,
  description: string,
  legacySemantics: readonly string[] = []
): Omit<FieldDefinition, "profileControl" | "profileOptions"> {
  return { semantic, label, aliases, legacySemantics, types, sections: [section], risk: "normal", description };
}

function defaultProfileControl(types: readonly SemanticFieldType[]): ProfileFieldControl {
  if (types[0] === "textarea") return "textarea";
  if (types[0] === "date") return "date";
  return "text";
}

function matchesSemantic(definition: FieldDefinition, semantic: string): boolean {
  return [definition.semantic, ...(definition.legacySemantics ?? [])]
    .some((candidate) => semanticPattern(candidate).test(semantic));
}

function semanticPattern(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\[\\]", "\\[\\d+\\]");
  return new RegExp(`^${escaped}$`, "u");
}

function contextFromHint(hint: string | undefined): string | undefined {
  return hint?.match(/^(education|work|projects|campus|awards|publications|languages|certificates)\[\d+\]/u)?.[0];
}

function materializeSemantic(template: string, entryContext: string | undefined): string | undefined {
  if (!template.includes("[]")) return template;
  const root = template.slice(0, template.indexOf("[]"));
  if (!entryContext || !new RegExp(`^${root}\\[\\d+\\]$`, "u").test(entryContext)) return undefined;
  return template.replace(`${root}[]`, entryContext);
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s:：*＊?？]/gu, "").trim();
}

const LEGACY_EXTRACTION_FIELD_PATH_TEMPLATES = [
  "basics.address",
  "basics.location",
  "education[].school",
  "education[].details",
  "work[].title",
  "work[].location",
  "work[].highlights[0]",
  "projects[].technologies",
  "projects[].highlights[0]",
  "skills[]",
  "certificates[].credentialId",
  "certificates[].url",
  "links.website",
  "links.github",
  "links.linkedin",
  "links.portfolio",
  "self.summary",
  "preferences.salary"
] as const;

export function listExtractableFieldPathTemplates(): readonly string[] {
  return [...new Set([
    ...FIELD_DEFINITIONS
      .filter((definition) => definition.profileControl !== "file")
      .map((definition) => definition.semantic),
    ...LEGACY_EXTRACTION_FIELD_PATH_TEMPLATES
  ])];
}

export function isAllowedExtractedFieldPath(path: string): boolean {
  if (typeof path !== "string" || path.trim() === "") return false;
  return listExtractableFieldPathTemplates().some((template) => {
    const escaped = template
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("\\[\\]", "\\[(?:0|[1-9]\\d*)\\]");
    return new RegExp(`^${escaped}$`, "u").test(path);
  });
}
