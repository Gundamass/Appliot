import { describe, expect, it } from "vitest";
import { matchControlOption, projectDateComponent } from "./control-value.js";

describe("application control values", () => {
  it("projects a canonical date into the requested component", () => {
    expect(projectDateComponent("开始时间 年", "work[0].startDate", "2026-04-12")).toBe("2026");
    expect(projectDateComponent("开始时间 月", "work[0].startDate", "2026-04-12")).toBe("04");
    expect(projectDateComponent("开始时间 日", "work[0].startDate", "2026-04-12")).toBe("12");
    expect(projectDateComponent("开始时间", "work[0].startDate", "2026-04-12")).toBe("2026-04-12");
  });

  it("matches padded and unpadded month options without accepting a full date", () => {
    expect(matchControlOption("04", ["1", "2", "4", "5"])).toBe("4");
    expect(matchControlOption("04", ["03", "04", "05"])).toBe("04");
    expect(matchControlOption("2026-04-12", ["2026", "2027"])).toBeUndefined();
  });

  it("projects award date values when the semantic already names a component", () => {
    expect(projectDateComponent("\u8d5b\u4e8b\u65f6\u95f4 \u5e74", "awards[0].date.year", "2025-03-01")).toBe("2025");
    expect(projectDateComponent("\u8d5b\u4e8b\u65f6\u95f4 \u6708", "awards[0].date.month", "2025-03-01")).toBe("03");
  });
});
