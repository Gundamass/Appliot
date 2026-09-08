import { describe, expect, it } from "vitest";
import { extractConversationUrlInput } from "./conversation-url-input.js";

describe("conversation URL input projection", () => {
  it("recovers percent-encoded Chinese prose appended to an identifier parameter", () => {
    const raw = "投递https://wondersharecampus.zhiye.com/form?fromPage=job&jobAdId=1e15df19-c887-41f5-b632-3845af9b5131&shareId=16002765-e0e5-4238-a46a-4f8b717777fc&userId=125079440%E8%BF%99%E4%B8%AA%E9%A1%B5%E9%9D%A2%E5%8F%AF%E4%BB%A5%E6%8A%95%E9%80%92%E5%90%97";

    expect(extractConversationUrlInput(raw)).toEqual({
      rawText: raw,
      url: "https://wondersharecampus.zhiye.com/form?fromPage=job&jobAdId=1e15df19-c887-41f5-b632-3845af9b5131&shareId=16002765-e0e5-4238-a46a-4f8b717777fc&userId=125079440",
      modelText: "投递[URL]这个页面可以投递吗",
      boundary: "recovered_encoded_suffix"
    });
  });

  it("keeps raw Chinese following an ASCII URL in the model-visible text", () => {
    const raw = "请处理https://jobs.example.com/apply/123这个页面";

    expect(extractConversationUrlInput(raw)).toEqual({
      rawText: raw,
      url: "https://jobs.example.com/apply/123",
      modelText: "请处理[URL]这个页面",
      boundary: "explicit"
    });
  });

  it("preserves a legitimate percent-encoded Chinese search parameter", () => {
    const raw = "查看 https://jobs.example.com/search?keyword=%E9%AB%98%E7%BA%A7%E5%89%8D%E7%AB%AF%E5%B7%A5%E7%A8%8B%E5%B8%88";

    expect(extractConversationUrlInput(raw)).toEqual({
      rawText: raw,
      url: "https://jobs.example.com/search?keyword=%E9%AB%98%E7%BA%A7%E5%89%8D%E7%AB%AF%E5%B7%A5%E7%A8%8B%E5%B8%88",
      modelText: "查看 [URL]",
      boundary: "explicit"
    });
  });

  it("preserves a short encoded Chinese identifier value", () => {
    const raw = "填写 https://jobs.example.com/apply?candidateId=abc%E5%BC%A0%E4%B8%89";

    expect(extractConversationUrlInput(raw)).toEqual({
      rawText: raw,
      url: "https://jobs.example.com/apply?candidateId=abc%E5%BC%A0%E4%B8%89",
      modelText: "填写 [URL]",
      boundary: "explicit"
    });
  });

  it("recovers sentence-like encoded prose after an ASCII path", () => {
    const raw = "投递https://jobs.example.com/apply/123%E8%BF%99%E4%B8%AA%E9%A1%B5%E9%9D%A2%E5%8F%AF%E4%BB%A5%E6%8A%95%E9%80%92%E5%90%97";

    expect(extractConversationUrlInput(raw)).toEqual({
      rawText: raw,
      url: "https://jobs.example.com/apply/123",
      modelText: "投递[URL]这个页面可以投递吗",
      boundary: "recovered_encoded_suffix"
    });
  });

  it("rejects messages containing more than one HTTPS URL", () => {
    expect(extractConversationUrlInput(
      "比较 https://jobs.example.com/one 和 https://jobs.example.com/two"
    )).toBeUndefined();
  });

  it.each([",", ";"])("rejects adjacent web URLs separated by %s", (separator) => {
    expect(extractConversationUrlInput(
      `比较 https://jobs.example.com/one${separator}http://jobs.example.com/two`
    )).toBeUndefined();
  });
});
