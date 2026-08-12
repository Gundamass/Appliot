import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
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
  it("uses an image file control without exposing a local path", async () => {
    const onChange = vi.fn();
    const onFile = vi.fn(async () => "avatar-0f8fad5b-d9cb-469f-a165-70867728950e.webp");
    render(<ProfileFieldControl
      field={{ ...BASE_FIELD, semantic: "basics.avatar", label: "头像", profileControl: "file" }}
      value=""
      disabled={false}
      onChange={onChange}
      onFile={onFile}
      onControl={() => undefined}
    />);

    const input = screen.getByLabelText("头像");
    expect(input).toHaveAttribute("type", "file");
    const file = new File(["image"], "avatar.webp", { type: "image/webp" });
    await userEvent.upload(input, file);

    expect(onFile).toHaveBeenCalledWith(file);
    expect(onChange).toHaveBeenCalledWith("avatar-0f8fad5b-d9cb-469f-a165-70867728950e.webp");
    expect(onChange).not.toHaveBeenCalledWith(expect.stringContaining("fakepath"));
  });

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
