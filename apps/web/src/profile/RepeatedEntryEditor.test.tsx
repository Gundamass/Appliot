import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RepeatedEntryEditor } from "./RepeatedEntryEditor.js";

describe("RepeatedEntryEditor", () => {
  it("adds the smallest unused entry index and saves only changed fields", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => undefined);
    render(<RepeatedEntryEditor
      section="awards"
      entries={[{ index: 1, values: { "awards[1].name": "校级奖学金" } }]}
      onSave={onSave}
    />);

    await user.click(screen.getByRole("button", { name: "新增获奖经历" }));
    const newEntry = screen.getByRole("article", { name: "获奖经历 1" });
    await user.type(within(newEntry).getByLabelText("获奖名称"), "国家奖学金");
    await user.click(within(newEntry).getByRole("button", { name: "保存获奖经历" }));

    expect(onSave).toHaveBeenCalledWith("awards[0]", expect.objectContaining({ "awards[0].name": "国家奖学金" }));
  });
});
