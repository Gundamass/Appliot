import { fireEvent, render, screen, within } from "@testing-library/react";
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
    expect([...project.querySelectorAll("input, textarea, select")].map((control) => control.getAttribute("aria-label"))).toEqual([
      "项目名称", "项目角色", "项目开始时间", "项目结束时间", "技术栈", "项目链接", "项目描述", "项目要点"
    ]);

    rerender(<RepeatedEntryEditor section="work" entries={[{ index: 0, values: {} }]} {...callbacks} />);
    const work = screen.getByRole("article", { name: "实习与工作经历 1" });
    expect([...work.querySelectorAll("input, textarea, select")].map((control) => control.getAttribute("aria-label")).slice(0, 5)).toEqual([
      "单位名称", "职位名称", "工作开始时间", "工作结束时间", "职责和成果"
    ]);
  });

  it("按项目时间倒序展示且保持原始持久化索引", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RepeatedEntryEditor
      section="projects"
      entries={[
        { index: 0, values: { "projects[0].name": "无时间项目" } },
        { index: 1, values: { "projects[1].name": "旧项目", "projects[1].startDate": "2024-09" } },
        { index: 2, values: { "projects[2].name": "最新结束", "projects[2].startDate": "2025/03", "projects[2].endDate": "2025/12" } },
        { index: 3, values: { "projects[3].name": "较早结束", "projects[3].startDate": "2025-03", "projects[3].endDate": "2025-06" } },
        { index: 4, values: { "projects[4].name": "另一个无时间项目" } }
      ]}
      onAdd={vi.fn()}
      onChange={onChange}
      onRemove={vi.fn()}
    />);

    expect(screen.getAllByRole("article").map((entry) => entry.getAttribute("aria-label"))).toEqual([
      "最新结束", "较早结束", "旧项目", "无时间项目", "另一个无时间项目"
    ]);
    fireEvent.change(within(screen.getByRole("article", { name: "最新结束" })).getByLabelText("项目角色"), {
      target: { value: "后端开发" }
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ "projects[2].role": "后端开发" }));
  });

  it("让项目长文本字段占满整行", () => {
    render(<RepeatedEntryEditor section="projects" entries={[{ index: 0, values: {} }]} onAdd={vi.fn()} onChange={vi.fn()} onRemove={vi.fn()} />);
    const project = screen.getByRole("article", { name: "项目经历 1" });
    for (const label of ["技术栈", "项目链接", "项目描述", "项目要点"]) {
      expect(within(project).getByLabelText(label).closest("label")).toHaveClass("profile-field-wide");
    }
    for (const label of ["项目名称", "项目角色", "项目开始时间", "项目结束时间"]) {
      expect(within(project).getByLabelText(label).closest("label")).not.toHaveClass("profile-field-wide");
    }
  });
});
