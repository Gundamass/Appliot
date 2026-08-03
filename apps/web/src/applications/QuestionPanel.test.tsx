import type { ApplicationQuestion } from "@resume/contracts";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { QuestionPanel } from "./QuestionPanel.js";

const questions: ApplicationQuestion[] = [
  {
    id: "available-date",
    fieldId: "available-date",
    fieldPath: "preferences.availableDate",
    label: "可入职时间",
    text: "请确认可入职时间",
    pageText: "可入职时间",
    interpretation: "系统识别为到岗日期",
    missingInformation: "缺少本次投递的可入职日期",
    scope: "application",
    inputType: "date",
    options: [],
    required: true
  },
  {
    id: "travel",
    fieldId: "travel",
    fieldPath: "preferences.travel",
    label: "接受出差",
    text: "是否接受出差",
    pageText: "是否接受出差",
    interpretation: "系统识别为出差意愿",
    missingInformation: "缺少本次投递的出差意愿",
    scope: "application",
    inputType: "checkbox",
    options: [],
    required: false
  }
];

it("一次提交当前页面的全部回答，并默认限定为本次投递", async () => {
  const user = userEvent.setup();
  const submit = vi.fn();
  render(<QuestionPanel questions={questions} busy={false} onSubmit={submit} />);

  expect(screen.getByText("系统识别为到岗日期")).toBeVisible();
  expect(screen.getByText("缺少本次投递的可入职日期")).toBeVisible();

  await user.type(screen.getByLabelText("可入职时间"), "2026-08-15");
  await user.click(screen.getByLabelText("接受出差"));
  await user.click(screen.getByRole("button", { name: "继续填写" }));

  expect(submit).toHaveBeenCalledWith({
    answers: [
      { id: "available-date", value: "2026-08-15", scope: "application" },
      { id: "travel", value: true, scope: "application" }
    ],
    promoteFieldPaths: []
  });
});

it("只有明确勾选时才请求保存为长期资料", async () => {
  const user = userEvent.setup();
  const submit = vi.fn();
  render(<QuestionPanel questions={questions.slice(0, 1)} busy={false} onSubmit={submit} />);

  await user.type(screen.getByLabelText("可入职时间"), "2026-08-15");
  await user.click(screen.getByRole("checkbox", { name: "将“可入职时间”保存为长期资料" }));
  await user.click(screen.getByRole("button", { name: "继续填写" }));

  expect(submit).toHaveBeenCalledWith(expect.objectContaining({
    promoteFieldPaths: ["preferences.availableDate"]
  }));
});

it("等价的服务端投影刷新不会清空尚未提交的回答", async () => {
  const user = userEvent.setup();
  const submit = vi.fn();
  const view = render(<QuestionPanel questions={questions} busy={false} onSubmit={submit} />);
  await user.type(screen.getByLabelText("可入职时间"), "2026-08-15");

  view.rerender(<QuestionPanel questions={questions.map((question) => ({ ...question }))} busy={false} onSubmit={submit} />);

  expect(screen.getByLabelText("可入职时间")).toHaveValue("2026-08-15");
});

it("问题上下文变化时清空不再适用的旧回答", async () => {
  const user = userEvent.setup();
  const submit = vi.fn();
  const view = render(<QuestionPanel questions={questions.slice(0, 1)} busy={false} onSubmit={submit} />);
  await user.type(screen.getByLabelText("可入职时间"), "2026-08-15");

  view.rerender(<QuestionPanel questions={[{
    ...questions[0]!,
    text: "请填写最早可到岗日期",
    pageText: "最早可到岗日期",
    interpretation: "系统识别为新的到岗日期要求",
    missingInformation: "缺少最早可到岗日期"
  }]} busy={false} onSubmit={submit} />);

  expect(screen.getByLabelText("可入职时间")).toHaveValue("");
});
