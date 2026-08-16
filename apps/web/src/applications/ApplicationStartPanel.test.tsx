import type { ApplicationTask, ProfileCompleteness } from "@resume/contracts";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApplicationApi } from "./api.js";
import { ApplicationStartPanel } from "./ApplicationStartPanel.js";

const task: ApplicationTask = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "示例投递",
  applicationUrl: "https://career.example.com/jobs/1",
  state: "observing_page",
  commands: [],
  recoveryCommands: [],
  questions: [],
  taskAnswers: []
};

const missingPreferences: ProfileCompleteness = {
  completed: 1,
  total: 2,
  sections: [
    { id: "basics", label: "基本信息", completed: 1, total: 1, missing: [] },
    { id: "preferences", label: "求职偏好", completed: 0, total: 1, missing: ["preferences.targetCity"] }
  ]
};

const complete: ProfileCompleteness = { completed: 1, total: 1, sections: [{ id: "basics", label: "基本信息", completed: 1, total: 1, missing: [] }] };

function api(): Pick<ApplicationApi, "create"> {
  return { create: vi.fn(async () => task) };
}

describe("ApplicationStartPanel", () => {
  it("prefills a redirected application URL without creating a task", () => {
    const create = vi.fn();

    render(<ApplicationStartPanel
      profileCompleteness={complete}
      applicationApi={{ create }}
      initialApplicationUrl="https://jobs.example/apply"
      onTaskCreated={vi.fn()}
    />);

    expect(screen.getByLabelText("投递官网链接")).toHaveValue("https://jobs.example/apply");
    expect(create).not.toHaveBeenCalled();
  });

  it("shows relevant missing profile fields before creating a task", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    render(<ApplicationStartPanel profileCompleteness={missingPreferences} applicationApi={api()} onTaskCreated={vi.fn()} onViewChange={onViewChange} />);

    expect(screen.getByText("期望工作地点")).toBeVisible();
    expect(screen.queryByText(/自动申请|最终提交/u)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "补全档案" }));
    expect(onViewChange).toHaveBeenCalledWith("profile");
  });

  it("creates one task and navigates to its real-time task page", async () => {
    const user = userEvent.setup();
    const applicationApi = api();
    const onTaskCreated = vi.fn();
    render(<ApplicationStartPanel profileCompleteness={complete} applicationApi={applicationApi} onTaskCreated={onTaskCreated} />);

    await user.type(screen.getByLabelText("投递官网链接"), task.applicationUrl);
    await user.clear(screen.getByLabelText("任务名称"));
    await user.type(screen.getByLabelText("任务名称"), task.name!);
    await user.click(screen.getByRole("button", { name: "开始识别并填写" }));

    expect(applicationApi.create).toHaveBeenCalledWith({ name: task.name, applicationUrl: task.applicationUrl });
    expect(onTaskCreated).toHaveBeenCalledWith(task.id);
  });

  it("suggests a task name from the URL without overwriting a manual name", async () => {
    const user = userEvent.setup();
    render(<ApplicationStartPanel profileCompleteness={complete} applicationApi={api()} onTaskCreated={vi.fn()} />);

    await user.type(screen.getByLabelText("投递官网链接"), "https://apply.careers.dji.com/campus-recruitment/dji/143359");
    expect(screen.getByLabelText("任务名称")).toHaveValue("大疆校招投递");

    await user.clear(screen.getByLabelText("任务名称"));
    await user.type(screen.getByLabelText("任务名称"), "大疆 Java 后端");
    await user.clear(screen.getByLabelText("投递官网链接"));
    await user.type(screen.getByLabelText("投递官网链接"), "https://jobs.example.com/apply/1");

    expect(screen.getByLabelText("任务名称")).toHaveValue("大疆 Java 后端");
  });

  it("shows a Chinese validation error when the task name is blank", async () => {
    const user = userEvent.setup();
    render(<ApplicationStartPanel profileCompleteness={complete} applicationApi={api()} onTaskCreated={vi.fn()} />);

    await user.type(screen.getByLabelText("投递官网链接"), task.applicationUrl);
    await user.clear(screen.getByLabelText("任务名称"));
    await user.click(screen.getByRole("button", { name: "开始识别并填写" }));

    expect(screen.getByRole("alert")).toHaveTextContent("请输入 1–80 个字符的任务名称");
  });
});
