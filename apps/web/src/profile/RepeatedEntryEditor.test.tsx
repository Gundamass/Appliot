import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { RepeatedEntryEditor, type RepeatedEntry } from "./RepeatedEntryEditor.js";

describe("RepeatedEntryEditor", () => {
  it("delegates add, edit and remove actions to the controlled parent", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    const onChange = vi.fn();
    const onRemove = vi.fn();
    function Harness() {
      const [entries, setEntries] = useState<RepeatedEntry[]>([{ index: 1, values: { "awards[1].name": "校级奖学金" } }]);
      return <RepeatedEntryEditor
        section="awards"
        entries={entries}
        onAdd={onAdd}
        onChange={(values) => {
          onChange(values);
          setEntries([{ index: 1, values }]);
        }}
        onRemove={onRemove}
      />;
    }
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "新增获奖经历" }));
    const entry = screen.getByRole("article", { name: "校级奖学金" });
    await user.type(within(entry).getByLabelText("获奖名称"), "一等奖");
    await user.click(within(entry).getByRole("button", { name: "删除获奖经历" }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ "awards[1].name": "校级奖学金一等奖" }));
    expect(onRemove).toHaveBeenCalledWith(1);
    expect(screen.queryByRole("button", { name: "保存获奖经历" })).not.toBeInTheDocument();
  });

  it("keeps project and work fields in recruitment form order", () => {
    const callbacks = { onAdd: vi.fn(), onChange: vi.fn(), onRemove: vi.fn() };
    const { rerender } = render(<RepeatedEntryEditor section="projects" entries={[{ index: 0, values: {} }]} {...callbacks} />);
    const project = screen.getByRole("article", { name: "项目经历 1" });
    expect([...project.querySelectorAll("input, textarea, select")].map((control) => control.getAttribute("aria-label")).slice(0, 6)).toEqual([
      "项目名称", "项目开始时间", "项目结束时间", "项目描述", "技术栈", "项目要点"
    ]);

    rerender(<RepeatedEntryEditor section="work" entries={[{ index: 0, values: {} }]} {...callbacks} />);
    const work = screen.getByRole("article", { name: "实习与工作经历 1" });
    expect([...work.querySelectorAll("input, textarea, select")].map((control) => control.getAttribute("aria-label")).slice(0, 5)).toEqual([
      "单位名称", "职位名称", "工作开始时间", "工作结束时间", "职责和成果"
    ]);
  });
});
