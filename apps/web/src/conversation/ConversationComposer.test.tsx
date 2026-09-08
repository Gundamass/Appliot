import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConversationComposer, insertPastedWebUrl } from "./ConversationComposer.js";

describe("ConversationComposer", () => {
  it("adds one space after a pasted web URL and preserves the selection", () => {
    expect(insertPastedWebUrl(
      "请填写这里",
      "https://jobs.example.com/apply/123",
      3,
      5
    )).toEqual({
      value: "请填写https://jobs.example.com/apply/123 ",
      caret: "请填写https://jobs.example.com/apply/123 ".length
    });
  });

  it("leaves ordinary or mixed clipboard text to native paste", () => {
    expect(insertPastedWebUrl("", "普通文字", 0, 0)).toBeUndefined();
    expect(insertPastedWebUrl("", "网址 https://jobs.example.com", 0, 0)).toBeUndefined();
    expect(insertPastedWebUrl("", "mailto:user@example.com", 0, 0)).toBeUndefined();
  });

  it("does not override native paste when the URL would exceed the message limit", () => {
    expect(insertPastedWebUrl("前".repeat(490), "https://example.com", 490, 490)).toBeUndefined();
  });

  it("submits the separated URL and following prose", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ConversationComposer sending={false} onSend={onSend} />);
    const input = screen.getByRole("textbox", { name: "输入消息" });

    fireEvent.paste(input, {
      clipboardData: {
        getData: () => "https://jobs.example.com/apply/123"
      }
    });
    await user.type(input, "这个页面帮我填写");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(onSend).toHaveBeenCalledWith(
      "https://jobs.example.com/apply/123 这个页面帮我填写"
    );
  });
});
