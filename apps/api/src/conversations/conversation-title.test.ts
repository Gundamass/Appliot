import { describe, expect, it } from "vitest";
import { conversationTitleFromFirstMessage } from "./conversation-title.js";

describe("conversation title", () => {
  it.each([
    ["  帮我   投递百度校园招聘  ", "帮我 投递百度校园招聘"],
    ["find   DJI graduate roles", "find DJI graduate ro"],
    ["😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀", "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀"]
  ])("normalizes and truncates %s", (input, expected) => {
    expect(conversationTitleFromFirstMessage(input)).toBe(expected);
  });
});
