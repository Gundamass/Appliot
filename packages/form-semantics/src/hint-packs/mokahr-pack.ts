import { CertifiedHintPackSchema, type CertifiedHintPack } from "@resume/contracts";

export const MOKAHR_SECTIONS = [
  {
    section: "education",
    headingAliases: ["教育经历", "教育背景", "教育信息"],
    fieldOrderAliases: [
      ["学校", "院校", "毕业院校"],
      ["学历"],
      ["专业"],
      ["开始时间", "入学时间"],
      ["结束时间", "毕业时间"],
      ["成绩", "GPA"],
      ["描述", "说明"]
    ]
  },
  {
    section: "work_combined",
    headingAliases: [
      "工作/实习经历",
      "工作／实习经历",
      "工作或实习经历",
      "实习/工作经历",
      "实习／工作经历",
      "实习或工作经历"
    ],
    fieldOrderAliases: [
      ["公司", "单位"],
      ["职位", "岗位", "职务"],
      ["工作类型", "用工类型", "实习类型"],
      ["开始时间"],
      ["结束时间"],
      ["地点", "所在地"],
      ["职责"],
      ["成果", "业绩", "成就"]
    ]
  },
  {
    section: "internship",
    headingAliases: ["实习经历"],
    fieldOrderAliases: [
      ["公司", "单位"],
      ["职位", "岗位", "职务"],
      ["实习类型", "用工类型"],
      ["开始时间"],
      ["结束时间"],
      ["地点", "所在地"],
      ["职责"],
      ["成果", "业绩", "成就"]
    ]
  },
  {
    section: "work",
    headingAliases: ["正式工作经历", "工作经历"],
    fieldOrderAliases: [
      ["公司", "单位"],
      ["职位", "岗位", "职务"],
      ["工作类型", "用工类型", "实习类型"],
      ["开始时间"],
      ["结束时间"],
      ["地点", "所在地"],
      ["职责"],
      ["成果", "业绩", "成就"]
    ]
  },
  {
    section: "projects",
    headingAliases: ["项目经历", "项目经验", "项目背景"],
    fieldOrderAliases: [
      ["项目名称", "项目名"],
      ["开始时间"],
      ["结束时间"],
      ["项目描述", "项目简介", "描述"],
      ["技术栈", "技术", "开发工具"],
      ["项目要点", "项目成果", "项目职责", "职责", "亮点"]
    ]
  },
  {
    section: "awards",
    headingAliases: ["获奖经历", "获奖信息", "赛事经历", "竞赛经历", "奖项经历"],
    fieldOrderAliases: [
      ["获奖名称", "奖项名称", "赛事名称", "比赛名称"],
      ["获奖时间", "奖项时间", "赛事时间"],
      ["奖项级别", "获奖级别"],
      ["获奖描述", "奖项描述", "赛事描述"]
    ]
  },
  {
    section: "laboratory",
    headingAliases: ["实验室经历", "科研经历", "研究经历"],
    fieldOrderAliases: [
      ["实验室名称", "科研名称", "研究方向"],
      ["开始时间"],
      ["结束时间"],
      ["描述", "成果", "职责"]
    ]
  },
  {
    section: "languages",
    headingAliases: ["语言能力", "外语能力"],
    fieldOrderAliases: [
      ["语种", "语言"],
      ["等级", "水平"],
      ["证书", "考试"],
      ["分数", "成绩"]
    ]
  }
] as const;

export const MOKAHR_ACTION_RULES = [{
  kind: "add_repeated_entry",
  verbs: ["添加", "新增"],
  sections: ["education", "work", "internship", "work_combined", "projects", "awards", "laboratory", "languages"]
}] as const;

export const mokahrHintPack: CertifiedHintPack = CertifiedHintPackSchema.parse({
  schemaVersion: 1,
  packId: "mokahr-cn",
  version: "1.0.0",
  match: {
    sites: [{ hostSuffix: "mokahr.com", pathPrefixes: ["/"] }],
    stages: ["application_form", "review"],
    requiredTextSignals: [],
    pageFingerprintHashes: []
  },
  sectionRules: MOKAHR_SECTIONS,
  fieldRules: [],
  actionRules: MOKAHR_ACTION_RULES,
  fixtures: [{ fixtureId: "mokahr-basic", expectedProfilePaths: ["education[0].institution"] }],
  lifecycleStatus: "certified",
  certifiedAt: "2026-08-17T00:00:00.000Z",
  provenance: {
    proposalId: "source-controlled-mokahr-proposal",
    replayReportIds: ["source-controlled-mokahr-replay"],
    humanReviewId: "source-controlled-mokahr-human-review"
  }
});
