import type { ProfileCompleteness, ProfileFact } from "@resume/contracts";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProfileApi } from "../api/client.js";
import { CandidateProfileCenter } from "./CandidateProfileCenter.js";

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

const emptyCompleteness: ProfileCompleteness = {
  completed: 0,
  total: 1,
  sections: [{ id: "awards", label: "获奖经历", completed: 0, total: 1, missing: ["awards[].name"] }]
};

function api(): ProfileApi {
  return {
    upload: vi.fn(),
    listFacts: vi.fn(async () => []),
    upsert: vi.fn(async (fieldPath, value) => fact(fieldPath, value, "user_corrected")),
    getCompleteness: vi.fn(async () => complete),
    confirm: vi.fn(),
    correct: vi.fn()
  };
}

describe("CandidateProfileCenter", () => {
  it("shows a missing preference where it can be added to the long form", () => {
    render(<CandidateProfileCenter api={api()} facts={[fact("basics.name", "陈同学")]} completeness={incompletePreferences} onFactsChanged={vi.fn()} />);

    expect(screen.getByLabelText("期望工作地点")).toHaveValue("");
    expect(screen.getByText("缺失，可减少追问")).toBeVisible();
  });

  it("creates a separate award record with level and description", async () => {
    const user = userEvent.setup();
    const profileApi = api();
    render(<CandidateProfileCenter api={profileApi} facts={[]} completeness={emptyCompleteness} onFactsChanged={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "新增获奖经历" }));
    await user.type(screen.getByLabelText("获奖名称"), "国家奖学金");
    await user.selectOptions(screen.getByLabelText("奖项级别"), "国家级");
    await user.click(screen.getByRole("button", { name: "保存获奖经历" }));

    expect(profileApi.upsert).toHaveBeenCalledWith("awards[0].name", "国家奖学金");
    expect(profileApi.upsert).toHaveBeenCalledWith("awards[0].level", "国家级");
  });

  it("keeps project highlights and work responsibilities as user-authored fields", () => {
    render(<CandidateProfileCenter api={api()} facts={[
      fact("projects[0].name", "缓存服务"),
      fact("projects[0].highlights[0]", "负责缓存设计与压测"),
      fact("work[0].description", "负责接口开发与联调")
    ]} completeness={complete} onFactsChanged={vi.fn()} />);

    expect(screen.getByLabelText("项目要点")).toHaveValue("负责缓存设计与压测");
    expect(screen.getByLabelText("职责和成果")).toHaveValue("负责接口开发与联调");
    expect(screen.queryByRole("button", { name: /生成项目要点/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /生成实习描述/ })).not.toBeInTheDocument();
  });
});
