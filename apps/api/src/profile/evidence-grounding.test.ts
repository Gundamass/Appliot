import { describe, expect, it } from "vitest";
import { findEvidenceGrounding, parseGroundingBlocks } from "./evidence-grounding.js";

const groundedPage = `
<|ref|>text<|/ref|><|det|>[[22, 50, 130, 67]]<|/det|>
姓名：何庆

<|ref|>text<|/ref|><|det|>[[377, 67, 636, 84]]<|/det|>
邮箱：1940424503@qq.com

<|ref|>text<|/ref|><|det|>[[22, 124, 260, 140], [312, 124, 455, 140]]<|/det|>
合肥工业大学（硕士）（211）
计算机技术专业
`;

describe("evidence grounding", () => {
  it("parses DeepSeek OCR grounding blocks and all of their boxes", () => {
    expect(parseGroundingBlocks(groundedPage)).toEqual([
      { text: "姓名：何庆", boxes: [{ x1: 22, y1: 50, x2: 130, y2: 67 }] },
      { text: "邮箱：1940424503@qq.com", boxes: [{ x1: 377, y1: 67, x2: 636, y2: 84 }] },
      {
        text: "合肥工业大学（硕士）（211）\n计算机技术专业",
        boxes: [
          { x1: 22, y1: 124, x2: 260, y2: 140 },
          { x1: 312, y1: 124, x2: 455, y2: 140 }
        ]
      }
    ]);
  });

  it("returns exact boxes for an evidence quote and honestly falls back to page level", () => {
    expect(findEvidenceGrounding(groundedPage, "邮箱：1940424503@qq.com")).toEqual({
      match: "exact",
      coordinateSpace: 1000,
      boxes: [{ x1: 377, y1: 67, x2: 636, y2: 84 }]
    });
    expect(findEvidenceGrounding(groundedPage, "不存在的证据")).toEqual({
      match: "page",
      coordinateSpace: 1000,
      boxes: []
    });
  });
});
