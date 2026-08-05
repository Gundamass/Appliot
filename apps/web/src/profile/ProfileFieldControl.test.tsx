import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FieldDefinition } from "@resume/form-semantics/field-registry";
import { ProfileFieldControl } from "./ProfileFieldControl.js";

const BASE_FIELD: FieldDefinition = {
  semantic: "basics.gender",
  label: "性别",
  aliases: [],
  types: ["select"],
  sections: ["basics"],
  risk: "sensitive",
  description: "候选人的性别"
};

describe("ProfileFieldControl", () => {
  it("保留不在新标准选项中的历史值", () => {
    render(<ProfileFieldControl
      field={{ ...BASE_FIELD, profileControl: "enum", profileOptions: ["男", "女"] }}
      value="未说明"
      disabled={false}
      onChange={() => undefined}
      onControl={() => undefined}
    />);

    expect(screen.getByRole("option", { name: "未说明" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "性别" })).toHaveValue("未说明");
  });

  it("建议输入允许填写标准列表之外的内容", () => {
    const onChange = vi.fn();
    render(<ProfileFieldControl
      field={{ ...BASE_FIELD, semantic: "basics.nationality", label: "国籍", profileControl: "suggestion", profileOptions: ["中国"] }}
      value=""
      disabled={false}
      onChange={onChange}
      onControl={() => undefined}
    />);

    fireEvent.change(screen.getByRole("combobox", { name: "国籍" }), { target: { value: "冰岛" } });
    expect(onChange).toHaveBeenCalledWith("冰岛");
  });
});
