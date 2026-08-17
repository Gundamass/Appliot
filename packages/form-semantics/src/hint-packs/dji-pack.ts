import { CertifiedHintPackSchema, type CertifiedHintPack } from "@resume/contracts";
import { MOKAHR_ACTION_RULES, MOKAHR_SECTIONS } from "./mokahr-pack.js";

export const DJI_FIELD_RULES = [
  {
    ruleId: "name",
    profilePath: "basics.name",
    labelAliases: ["姓名"],
    sections: ["basics"],
    controlTypes: ["text"],
    confidence: 1
  },
  {
    ruleId: "phone",
    profilePath: "basics.phone",
    labelAliases: ["手机号码"],
    sections: ["basics"],
    controlTypes: ["text"],
    confidence: 1
  },
  {
    ruleId: "school",
    profilePath: "education[0].institution",
    labelAliases: ["毕业院校"],
    sections: ["education"],
    controlTypes: ["text"],
    confidence: 1
  },
  {
    ruleId: "project",
    profilePath: "projects[0].name",
    labelAliases: ["项目名称"],
    sections: ["projects"],
    controlTypes: ["text"],
    confidence: 1
  },
  {
    ruleId: "award-level",
    profilePath: "awards[0].level",
    labelAliases: ["获奖级别"],
    sections: ["awards"],
    controlTypes: ["select", "radio"],
    confidence: 1
  }
] as const;

export const djiHintPack: CertifiedHintPack = CertifiedHintPackSchema.parse({
  schemaVersion: 1,
  packId: "dji-campus",
  version: "1.0.0",
  match: {
    sites: [
      { hostSuffix: "apply.careers.dji.com", pathPrefixes: ["/"] },
      { hostSuffix: "careers.dji.com", pathPrefixes: ["/"] },
      { hostSuffix: "app.mokahr.com", pathPrefixes: ["/campus-recruitment/dji/"] }
    ],
    stages: ["application_form", "review"],
    requiredTextSignals: [],
    pageFingerprintHashes: []
  },
  sectionRules: MOKAHR_SECTIONS,
  fieldRules: DJI_FIELD_RULES,
  actionRules: MOKAHR_ACTION_RULES,
  fixtures: [{
    fixtureId: "dji-basic",
    expectedProfilePaths: [
      "basics.name",
      "basics.phone",
      "education[0].institution",
      "projects[0].name",
      "awards[0].level"
    ]
  }],
  lifecycleStatus: "certified",
  certifiedAt: "2026-08-17T00:00:00.000Z",
  provenance: {
    proposalId: "source-controlled-dji-proposal",
    replayReportIds: ["source-controlled-dji-replay"],
    humanReviewId: "source-controlled-dji-human-review"
  }
});
