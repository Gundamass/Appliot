import { describe, expect, it } from "vitest";
import {
  PROFILE_SECTION_DEFINITIONS,
  profileSectionFor,
  resolveDeterministicSemantic,
  semanticLookupPaths
} from "./field-registry.js";

describe("字段注册表确定性映射", () => {
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
      "certificates",
      "self"
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
