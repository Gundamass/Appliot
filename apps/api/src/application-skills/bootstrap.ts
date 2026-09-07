import { createHash } from "node:crypto";
import type { ApplicationFieldSemantic, ApplicationSkillContent, ApplicationSkillVersion } from "@resume/contracts";
import { canonicalSkillContentHash, type SkillRegistry } from "./skill-registry.js";

type BootstrapRegistry = Pick<SkillRegistry, "createVersion">;

const CREATED_AT = "2026-09-06T00:00:00.000Z";

export function bootstrapApplicationSkills(registry: BootstrapRegistry): void {
  for (const skill of bootstrapSkills()) registry.createVersion(skill);
}

function bootstrapSkills(): ApplicationSkillVersion[] {
  return [
    makeSkill({
      skillId: "moka-application",
      site: "moka",
      allowedDomains: ["app.mokahr.com"],
      routes: ["/social-recruitment", "/campus_apply"],
      requiredTexts: ["申请职位", "个人信息"],
      fields: [
        field("basics.name", "candidate-name", "姓名"),
        field("basics.email", "candidate-email", "邮箱"),
        field("basics.phone", "candidate-phone", "手机号码")
      ],
      fill: true
    }),
    makeSkill({
      skillId: "dji-application",
      site: "dji",
      allowedDomains: ["apply.careers.dji.com", "app.mokahr.com"],
      routes: ["/campus-recruitment/dji"],
      requiredTexts: ["申请职位", "个人信息"],
      fields: [
        field("basics.name", "candidate-name", "姓名"),
        field("basics.phone", "candidate-phone", "手机号码"),
        field("education[].institution", "education-institution", "毕业院校")
      ],
      fill: true
    }),
    makeSkill({
      skillId: "baidu-application",
      site: "baidu",
      allowedDomains: ["talent.baidu.com"],
      routes: ["/jobs/detail/GRADUATE"],
      requiredTexts: ["申请职位"],
      fields: [field("basics.name", "candidate-name", "姓名")],
      fill: false
    })
  ];
}

interface SkillSeed {
  readonly skillId: string;
  readonly site: ApplicationSkillVersion["site"];
  readonly allowedDomains: string[];
  readonly routes: string[];
  readonly requiredTexts: string[];
  readonly fields: ApplicationSkillContent["fields"];
  readonly fill: boolean;
}

function makeSkill(seed: SkillSeed): ApplicationSkillVersion {
  const semantics = seed.fields.map((entry) => entry.semantic);
  const capabilities: ApplicationSkillContent["capabilities"] = seed.fill
    ? ["observe", "fill_empty_fields", "readback", "full_page_audit"]
    : ["observe", "readback", "full_page_audit"];
  const actions: ApplicationSkillContent["workflow"][number]["actions"] = [
    { capability: "observe" },
    ...(seed.fill ? [{ capability: "fill_empty_fields" as const, semantics }] : []),
    { capability: "readback", semantics },
    { capability: "full_page_audit" }
  ];
  const content: ApplicationSkillContent = {
    capabilities,
    pageVariants: [{
      id: "application-form",
      match: {
        routePatterns: seed.routes,
        requiredTexts: seed.requiredTexts,
        requiredFields: semantics
      },
      workflowEntry: "verify-application-form"
    }],
    fields: seed.fields,
    workflow: [{
      id: "verify-application-form",
      actions,
      success: seed.fill
        ? ["page_observed", "writes_read_back", "audit_clean"]
        : ["page_observed", "audit_clean"],
      next: "continue_or_wait"
    }],
    recovery: { maxRetries: 2, actions: ["reobserve", "refresh-node-ref"] }
  };
  return {
    skillId: seed.skillId,
    version: "1.0.0",
    schemaVersion: 1,
    contentHash: canonicalSkillContentHash(content),
    site: seed.site,
    allowedDomains: seed.allowedDomains,
    pageFingerprintRule: {
      ruleId: `${seed.site}-application-form`,
      ruleHash: createHash("sha256").update(`${seed.site}:application-form:v1`, "utf8").digest("hex")
    },
    status: "champion",
    content,
    createdBy: { kind: "system_migration", actorId: "application-skill-bootstrap" },
    createdAt: CREATED_AT
  };
}

function field(
  semantic: ApplicationFieldSemantic,
  key: string,
  text: string
): ApplicationSkillContent["fields"][number] {
  return {
    semantic,
    controlTypes: ["text"],
    locatorHints: [{ key, by: "label", text }]
  };
}
