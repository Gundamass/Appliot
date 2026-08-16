import { describe, expect, it } from "vitest";
import {
  FIELD_DEFINITIONS,
  PROFILE_SECTION_DEFINITIONS,
  profileSectionFor,
  resolveDeterministicSemantic,
  semanticLookupPaths
} from "./field-registry.js";

function definition(semantic: string) {
  return FIELD_DEFINITIONS.find((field) => field.semantic === semantic);
}

describe("字段注册表确定性映射", () => {
  it("为档案字段提供语义化控件和标准选项", () => {
    expect(definition("basics.name")?.profileControl).toBe("text");
    expect(definition("basics.gender")).toMatchObject({
      profileControl: "enum",
      profileOptions: ["男", "女", "其他", "不愿透露"]
    });
    expect(definition("basics.nationality")?.profileControl).toBe("suggestion");
    expect(definition("basics.nationality")?.profileOptions).toContain("中国");
    expect(definition("basics.ethnicity")?.profileOptions).toContain("汉族");
    expect(definition("basics.ethnicity")?.profileOptions).toHaveLength(56);
    expect(definition("basics.politicalStatus")?.profileOptions).toContain("中共党员");
    expect(definition("basics.maritalStatus")?.profileOptions).toContain("未婚");
    expect(definition("preferences.willingToTravel")?.profileControl).toBe("boolean");
    expect(definition("education[].degree")?.profileOptions).toContain("硕士");
    expect(definition("work[].employmentType")?.profileOptions).toContain("实习");
    expect(definition("work[].description")?.profileControl).toBe("textarea");
    expect(definition("awards[].level")?.profileOptions).toContain("国家级");
    expect(definition("campus[].startDate")?.profileControl).toBe("date");
    expect(definition("campus[].endDate")?.profileControl).toBe("date");
    expect(definition("campus[].highlights[0]")?.profileRequired).toBe(false);
  });

  it("注册国内 ATS 通用补充字段并使用正确档案控件", () => {
    expect(definition("basics.avatar")).toMatchObject({
      label: "个人头像",
      profileControl: "file",
      risk: "sensitive"
    });
    expect(definition("education[].isExchange")).toMatchObject({
      profileControl: "boolean",
      profileOptions: ["是", "否"]
    });
    expect(definition("education[].isJointProgram")?.profileControl).toBe("boolean");
    expect(definition("education[].majorCategory")?.profileControl).toBe("text");
    expect(definition("education[].schoolLocation")?.profileControl).toBe("suggestion");
    expect(definition("education[].advisor")?.profileControl).toBe("text");
    expect(definition("education[].isNationalKeyLab")?.profileControl).toBe("boolean");
    expect(definition("education[].laboratory")?.profileControl).toBe("text");
    expect(definition("work[].department")?.profileControl).toBe("text");
    expect(definition("projects[].url")?.profileControl).toBe("text");
    expect(definition("projects[].url")?.profileRequired).toBe(false);
  });

  it("将新增重复经历字段精确映射到当前条目", () => {
    expect(resolveDeterministicSemantic({
      label: "是否交流学习",
      type: "radio",
      entryContext: "education[1]"
    })?.semantic).toBe("education[1].isExchange");
    expect(resolveDeterministicSemantic({
      label: "任职部门",
      type: "text",
      entryContext: "work[2]"
    })?.semantic).toBe("work[2].department");
    expect(resolveDeterministicSemantic({
      label: "项目链接",
      type: "text",
      entryContext: "projects[3]"
    })?.semantic).toBe("projects[3].url");
  });

  it("不把公司专属问题加入长期候选人档案", () => {
    expect(definition("basics.interviewLocation")).toBeUndefined();
    expect(definition("basics.recruitmentSource")).toBeUndefined();
    expect(definition("basics.referralCode")).toBeUndefined();
    expect(definition("basics.oppoRelative")).toBeUndefined();
  });

  it("将常见个人信息别名映射到标准路径", () => {
    expect(resolveDeterministicSemantic({
      label: "个人联系电话",
      type: "text"
    })).toMatchObject({
      semantic: "basics.phone",
      source: "exact_alias",
      confidence: 1
    });
  });

  it("使用当前重复经历上下文实例化教育和工作路径", () => {
    expect(resolveDeterministicSemantic({
      label: "学校名称",
      type: "text",
      entryContext: "education[1]"
    })?.semantic).toBe("education[1].institution");

    expect(resolveDeterministicSemantic({
      label: "职位名称",
      type: "text",
      entryContext: "work[2]"
    })?.semantic).toBe("work[2].position");
  });

  it("将奖项级别绑定到当前获奖经历", () => {
    expect(resolveDeterministicSemantic({
      label: "奖项级别",
      type: "select",
      entryContext: "awards[1]"
    })?.semantic).toBe("awards[1].level");
  });

  it("从标准路径识别稳定的档案栏目", () => {
    expect(profileSectionFor("awards[3].level")).toBe("awards");
    expect(profileSectionFor("identity.idNumber")).toBe("basics");
    expect(PROFILE_SECTION_DEFINITIONS.map((section) => section.id)).toEqual([
      "basics",
      "preferences",
      "education",
      "work",
      "projects",
      "campus",
      "awards",
      "publications",
      "languages",
      "certificates",
      "self"
    ]);
  });

  it("注册可重复的语言能力档案字段", () => {
    expect(PROFILE_SECTION_DEFINITIONS).toContainEqual({ id: "languages", label: "语言能力", repeatable: true });
    expect(FIELD_DEFINITIONS
      .filter((field) => field.sections.includes("languages"))
      .map((field) => field.semantic)).toEqual([
      "languages[].name",
      "languages[].proficiency",
      "languages[].speakingListening",
      "languages[].readingWriting"
    ]);
    expect(definition("languages[].name")?.profileControl).toBe("suggestion");
    expect(definition("languages[].readingWriting")?.profileControl).toBe("suggestion");
    expect(profileSectionFor("languages[0].proficiency")).toBe("languages");
  });

  it("注册全部岗位期望字段并保留旧地点路径读取兼容", () => {
    const expected = [
      "preferences.targetRole",
      "preferences.targetCity",
      "preferences.employmentType",
      "preferences.industry",
      "preferences.workMode",
      "preferences.salary"
    ];

    for (const semantic of expected) {
      expect(definition(semantic)).toMatchObject({ sections: ["preferences"] });
    }
    expect(semanticLookupPaths("preferences.targetCity")).toEqual([
      "preferences.targetCity",
      "preferences.location"
    ]);
  });

  it("拒绝控件类型不兼容的精确别名", () => {
    expect(resolveDeterministicSemantic({
      label: "手机号码",
      type: "file"
    })).toBeUndefined();
  });

  it("不在确定性阶段猜测模糊字段", () => {
    expect(resolveDeterministicSemantic({
      label: "培养方式",
      type: "select",
      entryContext: "education[0]"
    })).toBeUndefined();
  });

  it("没有重复经历上下文时不伪造数组索引", () => {
    expect(resolveDeterministicSemantic({
      label: "学校名称",
      type: "text"
    })).toBeUndefined();
  });

  it("expands indexed semantics with the canonical path first", () => {
    expect(semanticLookupPaths("work[3].position")).toEqual([
      "work[3].position",
      "work[3].title"
    ]);
    expect(semanticLookupPaths("work[3].title")).toEqual([
      "work[3].position",
      "work[3].title"
    ]);
  });
});
