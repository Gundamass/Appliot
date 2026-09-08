import type { ProfileCompleteness, ProfileFact } from "@resume/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ProfileApi } from "../api/client.js";
import { CandidateProfileCenter, type CandidateProfileCenterHandle } from "./CandidateProfileCenter.js";

function fact(fieldPath: string, value: unknown, status: ProfileFact["status"] = "user_confirmed"): ProfileFact {
  return {
    id: `fact-${fieldPath}`,
    fieldPath,
    value: value as ProfileFact["value"],
    status,
    confidence: 1,
    scope: "profile",
    evidence: [{ documentId: "user", page: 1, text: String(value), extraction: "user" }],
    revision: 1
  };
}

const complete: ProfileCompleteness = {
  completed: 1,
  total: 1,
  sections: [{ id: "basics", label: "基本信息", completed: 1, total: 1, missing: [] }]
};

const incompletePreferences: ProfileCompleteness = {
  completed: 1,
  total: 2,
  sections: [
    { id: "basics", label: "基本信息", completed: 1, total: 1, missing: [] },
    { id: "preferences", label: "求职偏好", completed: 0, total: 1, missing: ["preferences.targetCity"] }
  ]
};

const incompleteProject: ProfileCompleteness = {
  completed: 1,
  total: 2,
  sections: [
    { id: "basics", label: "基本信息", completed: 1, total: 1, missing: [] },
    { id: "projects", label: "项目经历", completed: 0, total: 1, missing: ["projects[0].name"] }
  ]
};

const incompleteCampusDates: ProfileCompleteness = {
  completed: 6,
  total: 10,
  sections: [{
    id: "campus",
    label: "在校实践",
    completed: 6,
    total: 10,
    missing: [
      "campus[0].startDate",
      "campus[0].endDate",
      "campus[1].startDate",
      "campus[1].endDate"
    ]
  }]
};

const emptyCompleteness: ProfileCompleteness = {
  completed: 0,
  total: 1,
  sections: [{ id: "awards", label: "获奖经历", completed: 0, total: 1, missing: ["awards[].name"] }]
};

function api(): ProfileApi {
  return {
    upload: vi.fn(),
    updateCurrentDocument: vi.fn(),
    parseCurrentDocument: vi.fn(),
    getCurrentDocument: vi.fn(async () => undefined),
    uploadAvatar: vi.fn(async () => ({ fileId: "avatar-0f8fad5b-d9cb-469f-a165-70867728950e.webp" })),
    listFacts: vi.fn(async () => []),
    upsert: vi.fn(async (fieldPath, value) => fact(fieldPath, value, "user_corrected")),
    remove: vi.fn(async () => undefined),
    getCompleteness: vi.fn(async () => complete),
    getLatestDocument: vi.fn(async () => undefined),
    confirm: vi.fn(),
    correct: vi.fn()
  };
}

describe("CandidateProfileCenter", () => {
  it("explains when campus completion suggestions are all missing dates", async () => {
    const user = userEvent.setup();
    render(<CandidateProfileCenter
      api={api()}
      facts={[
        fact("campus[0].name", "创E社团招新"),
        fact("campus[0].description", "2022-10 至 2022-11 手写描述"),
        fact("campus[1].name", "新枫读书节")
      ]}
      completeness={incompleteCampusDates}
      onFactsChanged={vi.fn()}
    />);

    await user.click(screen.getByRole("button", { name: /在校实践/ }));
    expect(screen.getByText("4 项时间信息待补全")).toBeVisible();
    expect(within(screen.getByRole("article", { name: "创E社团招新" })).getByLabelText("实践描述"))
      .toHaveValue("2022-10 至 2022-11 手写描述");
  });

  it("uploads an avatar as an opaque draft and saves it only with the whole profile", async () => {
    const user = userEvent.setup();
    const profileApi = api();
    const ref = createRef<CandidateProfileCenterHandle>();
    render(<CandidateProfileCenter ref={ref} api={profileApi} facts={[]} completeness={emptyCompleteness} onFactsChanged={vi.fn()} />);

    await user.upload(screen.getByLabelText("个人头像"), new File(["image"], "avatar.webp", { type: "image/webp" }));

    expect(profileApi.uploadAvatar).toHaveBeenCalledTimes(1);
    expect(profileApi.upsert).not.toHaveBeenCalled();
    await ref.current?.save();
    expect(profileApi.upsert).toHaveBeenCalledWith("basics.avatar", "avatar-0f8fad5b-d9cb-469f-a165-70867728950e.webp");
  });

  it("moves focus to the first missing field when the completion action is requested", async () => {
    const ref = createRef<CandidateProfileCenterHandle>();
    render(<CandidateProfileCenter ref={ref} api={api()} facts={[fact("basics.name", "陈同学")]} completeness={incompletePreferences} onFactsChanged={vi.fn()} />);

    ref.current?.focusFirstMissing();

    const missingField = await screen.findByLabelText("期望工作地点");
    await waitFor(() => expect(missingField).toHaveFocus());
  });

  it("moves focus to a missing field inside an existing repeated entry", async () => {
    const ref = createRef<CandidateProfileCenterHandle>();
    render(<CandidateProfileCenter
      ref={ref}
      api={api()}
      facts={[fact("projects[0].description", "负责后端服务") ]}
      completeness={incompleteProject}
      onFactsChanged={vi.fn()}
    />);

    ref.current?.focusFirstMissing();

    const missingField = await screen.findByLabelText("项目名称");
    await waitFor(() => expect(missingField).toHaveFocus());
  });

  it("keeps scalar edits as drafts until the profile is saved", async () => {
    const user = userEvent.setup();
    const profileApi = api();
    const ref = createRef<CandidateProfileCenterHandle>();
    const onSaveStateChange = vi.fn();
    render(<CandidateProfileCenter ref={ref} api={profileApi} facts={[fact("basics.name", "陈同学")]} completeness={complete} onFactsChanged={vi.fn()} onSaveStateChange={onSaveStateChange} />);

    const name = screen.getByLabelText("姓名");
    await user.clear(name);
    await user.type(name, "陈晨");

    expect(profileApi.upsert).not.toHaveBeenCalled();
    expect(onSaveStateChange).toHaveBeenLastCalledWith("dirty");

    await ref.current?.save();

    expect(profileApi.upsert).toHaveBeenCalledWith("basics.name", "陈晨");
  });

  it("keeps failed drafts editable and retries the unified save", async () => {
    const user = userEvent.setup();
    const profileApi = api();
    const ref = createRef<CandidateProfileCenterHandle>();
    const onFactsChanged = vi.fn();
    const onSaveStateChange = vi.fn();
    vi.mocked(profileApi.upsert)
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(fact("basics.name", "陈晨", "user_corrected"));
    render(<CandidateProfileCenter ref={ref} api={profileApi} facts={[fact("basics.name", "陈同学")]} completeness={complete} onFactsChanged={onFactsChanged} onSaveStateChange={onSaveStateChange} />);

    const name = screen.getByLabelText("姓名");
    await user.clear(name);
    await user.type(name, "陈晨");
    await ref.current?.save();

    expect(await screen.findByRole("alert")).toHaveTextContent("档案保存失败，请重试");
    expect(name).toHaveValue("陈晨");
    expect(onSaveStateChange).toHaveBeenLastCalledWith("dirty");
    expect(onFactsChanged).not.toHaveBeenCalled();

    await ref.current?.save();

    await waitFor(() => expect(onSaveStateChange).toHaveBeenLastCalledWith("saved"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(profileApi.upsert).toHaveBeenCalledTimes(2);
    expect(profileApi.upsert).toHaveBeenLastCalledWith("basics.name", "陈晨");
    expect(onFactsChanged).toHaveBeenCalledTimes(1);
  });

  it("retries only fields that failed during a partially successful save", async () => {
    const user = userEvent.setup();
    const profileApi = api();
    const ref = createRef<CandidateProfileCenterHandle>();
    let emailAttempts = 0;
    vi.mocked(profileApi.upsert).mockImplementation(async (fieldPath, value) => {
      if (fieldPath === "basics.email" && emailAttempts++ === 0) throw new Error("email write failed");
      return fact(fieldPath, value, "user_corrected");
    });
    render(<CandidateProfileCenter ref={ref} api={profileApi} facts={[
      fact("basics.name", "陈同学"),
      fact("basics.email", "old@example.com")
    ]} completeness={complete} onFactsChanged={vi.fn()} />);

    await user.clear(screen.getByLabelText("姓名"));
    await user.type(screen.getByLabelText("姓名"), "陈晨");
    await user.clear(screen.getByLabelText("邮箱"));
    await user.type(screen.getByLabelText("邮箱"), "chen@example.com");
    await ref.current?.save();

    expect(await screen.findByRole("alert")).toHaveTextContent("部分内容保存失败，请重试");
    await ref.current?.save();

    expect(vi.mocked(profileApi.upsert).mock.calls.filter(([path]) => path === "basics.name")).toHaveLength(1);
    expect(vi.mocked(profileApi.upsert).mock.calls.filter(([path]) => path === "basics.email")).toHaveLength(2);
  });

  it("preserves drafts while switching profile sections", async () => {
    const user = userEvent.setup();
    render(<CandidateProfileCenter api={api()} facts={[fact("basics.name", "陈同学")]} completeness={incompletePreferences} onFactsChanged={vi.fn()} />);

    const name = screen.getByLabelText("姓名");
    await user.clear(name);
    await user.type(name, "陈晨");
    await user.click(screen.getByRole("button", { name: /求职偏好/ }));
    await user.click(screen.getByRole("button", { name: /基本信息/ }));

    expect(screen.getByLabelText("姓名")).toHaveValue("陈晨");
  });

  it("shows a missing preference where it can be added to the long form", async () => {
    const user = userEvent.setup();
    render(<CandidateProfileCenter api={api()} facts={[fact("basics.name", "陈同学")]} completeness={incompletePreferences} onFactsChanged={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /求职偏好/ }));
    expect(screen.getByLabelText("期望工作地点")).toHaveValue("");
    expect(screen.getByText("缺失，可减少追问")).toBeVisible();
  });

  it("creates a separate award record with level and description", async () => {
    const user = userEvent.setup();
    const profileApi = api();
    const ref = createRef<CandidateProfileCenterHandle>();
    render(<CandidateProfileCenter ref={ref} api={profileApi} facts={[]} completeness={emptyCompleteness} onFactsChanged={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /获奖经历/ }));
    await user.click(screen.getByRole("button", { name: "新增获奖经历" }));
    await user.type(screen.getByLabelText("获奖名称"), "国家奖学金");
    await user.selectOptions(screen.getByLabelText("奖项级别"), "国家级");
    await ref.current?.save();

    expect(profileApi.upsert).toHaveBeenCalledWith("awards[0].name", "国家奖学金");
    expect(profileApi.upsert).toHaveBeenCalledWith("awards[0].level", "国家级");
  });

  it("removes a persisted repeated entry instead of saving empty active facts", async () => {
    const user = userEvent.setup();
    const profileApi = api();
    const ref = createRef<CandidateProfileCenterHandle>();
    render(<CandidateProfileCenter ref={ref} api={profileApi} facts={[
      fact("awards[0].name", "国家奖学金"),
      fact("awards[0].level", "国家级")
    ]} completeness={complete} onFactsChanged={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /获奖经历/ }));
    await user.click(screen.getByRole("button", { name: "删除获奖经历" }));
    await ref.current?.save();

    expect(profileApi.remove).toHaveBeenCalledWith([
      "awards[0].name",
      "awards[0].date",
      "awards[0].level",
      "awards[0].description"
    ]);
    expect(profileApi.upsert).not.toHaveBeenCalledWith(expect.stringMatching(/^awards\[0\]\./u), "");
  });

  it("keeps project highlights and work responsibilities as user-authored fields", async () => {
    const user = userEvent.setup();
    render(<CandidateProfileCenter api={api()} facts={[
      fact("projects[0].name", "缓存服务"),
      fact("projects[0].highlights[0]", "负责缓存设计与压测"),
      fact("work[0].description", "负责接口开发与联调")
    ]} completeness={complete} onFactsChanged={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /项目经历/ }));
    expect(screen.getByLabelText("项目要点")).toHaveValue("负责缓存设计与压测");
    await user.click(screen.getByRole("button", { name: /实习与工作/ }));
    expect(screen.getByLabelText("职责和成果")).toHaveValue("负责接口开发与联调");
    expect(screen.queryByRole("button", { name: /生成项目要点/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /生成实习描述/ })).not.toBeInTheDocument();
  });

  it("在候选人档案中编辑并保存语言能力", async () => {
    const user = userEvent.setup();
    const profileApi = api();
    const ref = createRef<CandidateProfileCenterHandle>();
    render(<CandidateProfileCenter
      ref={ref}
      api={profileApi}
      facts={[
        fact("languages[0].name", "英语"),
        fact("languages[0].proficiency", "熟练")
      ]}
      completeness={{
        completed: 2,
        total: 4,
        sections: [{
          id: "languages",
          label: "语言能力",
          completed: 2,
          total: 4,
          missing: ["languages[0].speakingListening", "languages[0].readingWriting"]
        }]
      }}
      onFactsChanged={vi.fn()}
    />);

    await user.click(screen.getByRole("button", { name: /语言能力/ }));
    await user.type(screen.getByLabelText("听说能力"), "熟练");
    await user.type(screen.getByLabelText("读写能力"), "熟练");
    await ref.current?.save();

    expect(profileApi.upsert).toHaveBeenCalledWith("languages[0].speakingListening", "熟练");
    expect(profileApi.upsert).toHaveBeenCalledWith("languages[0].readingWriting", "熟练");
  });

  it("保存新增教育、部门和可选项目链接字段", async () => {
    const user = userEvent.setup();
    const profileApi = api();
    const ref = createRef<CandidateProfileCenterHandle>();
    render(<CandidateProfileCenter ref={ref} api={profileApi} facts={[
      fact("education[0].institution", "合肥工业大学"),
      fact("work[0].company", "示例公司"),
      fact("projects[0].name", "简历投递助手")
    ]} completeness={complete} onFactsChanged={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /教育经历/ }));
    await user.selectOptions(screen.getByLabelText("是否交流学习"), "否");
    await user.type(screen.getByLabelText("导师姓名"), "张老师");
    await user.click(screen.getByRole("button", { name: /实习与工作/ }));
    await user.type(screen.getByLabelText("任职部门"), "研发部");
    await user.click(screen.getByRole("button", { name: /项目经历/ }));
    await user.type(screen.getByLabelText("项目链接"), "https://example.com/project");
    await ref.current?.save();

    expect(profileApi.upsert).toHaveBeenCalledWith("education[0].isExchange", "否");
    expect(profileApi.upsert).toHaveBeenCalledWith("education[0].advisor", "张老师");
    expect(profileApi.upsert).toHaveBeenCalledWith("work[0].department", "研发部");
    expect(profileApi.upsert).toHaveBeenCalledWith("projects[0].url", "https://example.com/project");
  });

  it("removes field-level save, confirmation and source controls", () => {
    render(<CandidateProfileCenter api={api()} facts={[fact("basics.name", "陈同学")]} completeness={complete} onFactsChanged={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "保存姓名" })).not.toBeInTheDocument();
    expect(screen.queryByText("已确认")).not.toBeInTheDocument();
    expect(screen.queryByText("查看来源")).not.toBeInTheDocument();
  });
});
