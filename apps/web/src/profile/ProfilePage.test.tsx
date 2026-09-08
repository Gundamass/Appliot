import type { JsonValue, ProfileFact } from "@resume/contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileApiError, type ProfileApi, type SelfEvaluationReviewApi } from "../api/client.js";
import { ProfilePage } from "./ProfilePage.js";

afterEach(() => vi.unstubAllGlobals());

function makeFact(overrides: Partial<ProfileFact> = {}): ProfileFact {
  return {
    id: "fact-email",
    fieldPath: "basics.email",
    value: "ada@example.com",
    status: "extracted",
    confidence: 0.91,
    scope: "profile",
    evidence: [{
      documentId: "a".repeat(64),
      page: 1,
      text: "Email: ada@example.com",
      extraction: "pdf_text"
    }],
    revision: 1,
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeProfileApi(initialFacts: ProfileFact[] = []) {
  let facts = initialFacts;
  const api: ProfileApi = {
      upload: vi.fn(async () => ({ documentId: "document-1" })),
      updateCurrentDocument: vi.fn(),
      parseCurrentDocument: vi.fn(),
      getCurrentDocument: vi.fn(async () => undefined),
      uploadAvatar: vi.fn(async () => ({ fileId: "avatars/avatar-1.webp" })),
    listFacts: vi.fn(async () => facts),
    upsert: vi.fn(async (fieldPath, value) => makeFact({ fieldPath, value: value as JsonValue, status: "user_corrected" })),
    remove: vi.fn(async () => undefined),
    getCompleteness: vi.fn(async () => ({ completed: 0, total: 1, sections: [] })),
    getLatestDocument: vi.fn(async () => undefined),
    confirm: vi.fn(async (factId) => {
      const updated = { ...facts.find((fact) => fact.id === factId)!, status: "user_confirmed" as const };
      facts = facts.map((fact) => fact.id === factId ? updated : fact);
      return updated;
    }),
    correct: vi.fn(async (factId, value) => {
      const updated = {
        ...facts.find((fact) => fact.id === factId)!,
        value: value as JsonValue,
        status: "user_corrected" as const,
        revision: 2
      };
      facts = facts.map((fact) => fact.id === factId ? updated : fact);
      return updated;
    })
  };
  return api;
}

describe("global profile summary", () => {
  it("keeps summary information readable and focuses the first missing field", async () => {
    const user = userEvent.setup();
    const api = fakeProfileApi([makeFact({ fieldPath: "basics.name", value: "何庆" })]);
    vi.mocked(api.getCompleteness).mockResolvedValue({
      completed: 1,
      total: 2,
      sections: [
        { id: "basics", label: "基本信息", completed: 1, total: 1, missing: [] },
        { id: "preferences", label: "求职偏好", completed: 0, total: 1, missing: ["preferences.targetCity"] }
      ]
    });

    render(<ProfilePage api={api} />);

    const summary = await screen.findByRole("region", { name: "档案全局信息" });
    expect(within(summary).getByText("何庆")).toBeVisible();
    expect(within(summary).getByText("1 项待补全")).toBeVisible();
    await user.click(within(summary).getByRole("button", { name: "补全资料" }));

    expect(await screen.findByLabelText("期望工作地点")).toHaveFocus();
    expect(screen.queryByRole("button", { name: "查看来源" })).not.toBeInTheDocument();
  });

  it("loads the latest resume and opens a single global parser", async () => {
    const user = userEvent.setup();
    const api = fakeProfileApi([makeFact({ fieldPath: "basics.name", value: "何庆" })]);
    vi.mocked(api.getLatestDocument).mockResolvedValue({
      documentId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      filename: "何庆-简历.pdf",
      importedAt: "2026-08-04T06:32:00.000Z",
      extractedFactCount: 46
    });
    vi.mocked(api.getCurrentDocument).mockResolvedValue({
      documentId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      filename: "何庆-简历.pdf",
      importedAt: "2026-08-04T06:32:00.000Z",
      extractedFactCount: 46,
      importStatus: "completed"
    });

    render(<ProfilePage api={api} />);

    expect(await screen.findAllByText("何庆-简历.pdf")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "简历解析" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "收起简历更新" }));
    expect(screen.queryByRole("heading", { name: "简历更新" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "简历解析" }));
    expect(screen.getByRole("heading", { name: "简历更新" })).toBeVisible();
    expect(api.getLatestDocument).toHaveBeenCalledTimes(1);
  });

  it("saves candidate drafts only from the global save action", async () => {
    const user = userEvent.setup();
    const api = fakeProfileApi([makeFact({ fieldPath: "basics.name", value: "何庆" })]);
    render(<ProfilePage api={api} />);

    const name = await screen.findByLabelText("姓名");
    await waitFor(() => expect(name).toHaveValue("何庆"));
    await user.clear(name);
    await user.type(name, "何清");

    expect(api.upsert).not.toHaveBeenCalled();
    expect(screen.getByText("有未保存的更改")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "保存档案" }));
    expect(api.upsert).toHaveBeenCalledWith("basics.name", "何清");
  });

  it("shows when saved profile data cannot be refreshed", async () => {
    const user = userEvent.setup();
    const api = fakeProfileApi([makeFact({ fieldPath: "basics.name", value: "何庆" })]);
    vi.mocked(api.listFacts)
      .mockResolvedValueOnce([makeFact({ fieldPath: "basics.name", value: "何庆" })])
      .mockRejectedValueOnce(new Error("refresh unavailable"));
    render(<ProfilePage api={api} />);

    const name = await screen.findByLabelText("姓名");
    await user.clear(name);
    await user.type(name, "何清");
    await user.click(screen.getByRole("button", { name: "保存档案" }));

    expect(await screen.findByText("档案已保存，但资料刷新失败")).toBeVisible();
  });

  it("keeps profile editing free of field review and evidence controls", async () => {
    render(<ProfilePage api={fakeProfileApi([makeFact({ fieldPath: "basics.name", value: "何庆" })])} />);

    await screen.findByRole("heading", { name: "完整候选人档案" });
    expect(screen.queryByRole("heading", { name: "资料审核" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "按状态筛选" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看来源" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "修改" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "字段证据" })).not.toBeInTheDocument();
  });
});

function fakeReviewApi(): SelfEvaluationReviewApi {
  const review = {
    jobDescription: "React role",
    taskId: "task-1", original: "原始自我评价", draft: "岗位微调稿", reasons: ["强调 React"], evidence: [], unsupportedClaims: [], status: "needs_review" as const,
    base: { factId: "self", revision: 1, original: "原始自我评价", evidence: [{ documentId: "resume", page: 1, text: "原始自我评价", extraction: "pdf_text" as const }] }
  };
  return { create: vi.fn(), get: vi.fn(async () => review), approve: vi.fn(async () => ({ ...review, status: "approved" as const })), promote: vi.fn(async () => ({ ...review, status: "approved" as const })) };
}

function reviewFor(taskId: string) {
  return {
    jobDescription: `${taskId} role`,
    taskId, original: `${taskId} 原始自我评价`, draft: `${taskId} 岗位微调稿`, reasons: ["强调 React"], evidence: [], unsupportedClaims: [], status: "needs_review" as const,
    base: { factId: "self", revision: 1, original: `${taskId} 原始自我评价`, evidence: [{ documentId: "resume", page: 1, text: "原始自我评价", extraction: "pdf_text" as const }] }
  };
}

describe("application navigation", () => {
  it("opens the new application workflow from the profile header", async () => {
    const user = userEvent.setup();
    const onStartApplication = vi.fn();
    render(<ProfilePage api={fakeProfileApi()} onStartApplication={onStartApplication} />);

    await user.click(screen.getByRole("button", { name: "新建投递" }));

    expect(onStartApplication).toHaveBeenCalledOnce();
  });
});

describe("self-evaluation review view", () => {
  it("loads a selected task review and applies explicit keep-original approval", async () => {
    const user = userEvent.setup();
    const reviewApi = fakeReviewApi();
    render(<ProfilePage api={fakeProfileApi()} reviewApi={reviewApi} />);

    await user.click(screen.getByRole("button", { name: "自我评价审核" }));
    await user.clear(screen.getByLabelText("任务 ID"));
    await user.type(screen.getByLabelText("任务 ID"), "task-1");
    await user.click(screen.getByRole("button", { name: "加载审核" }));
    expect(await screen.findByRole("heading", { name: "岗位微调稿" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "继续使用原文" }));
    expect(reviewApi.approve).toHaveBeenCalledWith("task-1", undefined, true);
    expect(screen.getByRole("status")).toHaveTextContent("已继续使用原文");
    expect(screen.getByRole("status")).toHaveFocus();
    expect(screen.queryByRole("button", { name: "继续使用原文" })).not.toBeInTheDocument();
  });

  it("clears the loaded review when the editable task input changes", async () => {
    const user = userEvent.setup();
    const reviewApi = fakeReviewApi();
    render(<ProfilePage api={fakeProfileApi()} reviewApi={reviewApi} />);

    await user.click(screen.getByRole("button", { name: "自我评价审核" }));
    await user.clear(screen.getByLabelText("任务 ID"));
    await user.type(screen.getByLabelText("任务 ID"), "task-1");
    await user.click(screen.getByRole("button", { name: "加载审核" }));
    await screen.findByRole("heading", { name: "岗位微调稿" });
    await user.clear(screen.getByLabelText("任务 ID"));
    await user.type(screen.getByLabelText("任务 ID"), "task-2");
    expect(screen.queryByRole("button", { name: "继续使用原文" })).not.toBeInTheDocument();
    expect(reviewApi.approve).not.toHaveBeenCalled();
  });

  it("renders only the newest task when A and B loads resolve out of order", async () => {
    const user = userEvent.setup();
    const taskA = deferred<ReturnType<typeof reviewFor>>();
    const taskB = deferred<ReturnType<typeof reviewFor>>();
    const reviewApi: SelfEvaluationReviewApi = { create: vi.fn(), get: vi.fn((taskId) => taskId === "A" ? taskA.promise : taskB.promise), approve: vi.fn(), promote: vi.fn() };
    render(<ProfilePage api={fakeProfileApi()} reviewApi={reviewApi} />);

    await user.click(screen.getByRole("button", { name: "自我评价审核" }));
    await user.clear(screen.getByLabelText("任务 ID"));
    await user.type(screen.getByLabelText("任务 ID"), "A");
    await user.click(screen.getByRole("button", { name: "加载审核" }));
    const taskInput = screen.getByLabelText("任务 ID");
    await user.clear(taskInput);
    await user.type(screen.getByLabelText("任务 ID"), "B");
    await user.click(screen.getByRole("button", { name: "加载审核" }));
    await act(async () => taskB.resolve(reviewFor("B")));
    expect(await screen.findByText("B 岗位微调稿")).toBeVisible();
    await act(async () => taskA.resolve(reviewFor("A")));

    expect(screen.getByText("B 岗位微调稿")).toBeVisible();
    expect(screen.queryByText("A 岗位微调稿")).not.toBeInTheDocument();
  });

  it("rejects a review response for the wrong task without rendering it", async () => {
    const user = userEvent.setup();
    const reviewApi: SelfEvaluationReviewApi = { create: vi.fn(), get: vi.fn(async () => reviewFor("other")), approve: vi.fn(), promote: vi.fn() };
    render(<ProfilePage api={fakeProfileApi()} reviewApi={reviewApi} />);

    await user.click(screen.getByRole("button", { name: "自我评价审核" }));
    await user.click(screen.getByRole("button", { name: "加载审核" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("审核加载失败");
    expect(screen.queryByText("other 岗位微调稿")).not.toBeInTheDocument();
  });

  it("ignores late review loads after the API consumer is replaced or unmounted", async () => {
    const user = userEvent.setup();
    const pending = deferred<ReturnType<typeof reviewFor>>();
    const firstApi: SelfEvaluationReviewApi = { create: vi.fn(), get: vi.fn(() => pending.promise), approve: vi.fn(), promote: vi.fn() };
    const { rerender, unmount } = render(<ProfilePage api={fakeProfileApi()} reviewApi={firstApi} />);

    await user.click(screen.getByRole("button", { name: "自我评价审核" }));
    await user.click(screen.getByRole("button", { name: "加载审核" }));
    rerender(<ProfilePage api={fakeProfileApi()} reviewApi={fakeReviewApi()} />);
    unmount();
    await act(async () => pending.resolve(reviewFor("task-1")));

    expect(firstApi.get).toHaveBeenCalledOnce();
  });
});

describe("ProfilePage loading states", () => {
  it("ignores stale completeness after the profile API changes", async () => {
    const oldCompleteness = deferred<Awaited<ReturnType<ProfileApi["getCompleteness"]>>>();
    const firstApi = fakeProfileApi([makeFact({ fieldPath: "basics.name", value: "旧候选人" })]);
    const secondApi = fakeProfileApi([makeFact({ fieldPath: "basics.name", value: "新候选人" })]);
    vi.mocked(firstApi.getCompleteness).mockReturnValueOnce(oldCompleteness.promise);
    vi.mocked(secondApi.getCompleteness).mockResolvedValueOnce({
      completed: 1,
      total: 2,
      sections: [{ id: "basics", label: "基本信息", completed: 1, total: 2, missing: ["basics.email"] }]
    });
    const { rerender } = render(<ProfilePage api={firstApi} embedded />);

    rerender(<ProfilePage api={secondApi} embedded />);
    expect((await screen.findAllByText("50%")).length).toBeGreaterThan(0);
    await act(async () => oldCompleteness.resolve({
      completed: 2,
      total: 2,
      sections: [{ id: "basics", label: "基本信息", completed: 2, total: 2, missing: [] }]
    }));

    expect(screen.getAllByText("50%").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("100%")).toHaveLength(0);
  });

  it("keeps the global parser ahead of the long-form profile when completeness is unavailable", async () => {
    const api = fakeProfileApi([makeFact({ fieldPath: "basics.name", value: "何庆" })]);
    vi.mocked(api.getCompleteness).mockRejectedValueOnce(new Error("completeness unavailable"));
    render(<ProfilePage api={api} embedded />);

    const profileTitle = await screen.findByRole("heading", { name: "完整候选人档案" });
    expect(screen.getByText("档案完整度暂不可用")).toBeVisible();
    expect(screen.queryByText("待评估")).not.toBeInTheDocument();
    expect(screen.getAllByText("未统计").length).toBeGreaterThan(0);
    const parserTitle = screen.getByRole("heading", { name: "简历更新" });
    expect(parserTitle.compareDocumentPosition(profileTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows initial loading without an empty-state flash", async () => {
    const pending = deferred<ProfileFact[]>();
    const api = fakeProfileApi();
    vi.mocked(api.listFacts).mockReturnValueOnce(pending.promise);

    render(<ProfilePage api={api} />);

    expect(screen.getByRole("status", { name: "资料加载状态" })).toHaveTextContent("正在加载资料");
    expect(screen.queryByRole("heading", { name: "完整候选人档案" })).not.toBeInTheDocument();
    pending.resolve([]);
    expect(await screen.findByRole("heading", { name: "完整候选人档案" })).toBeVisible();
  });

  it("shows a retryable load error", async () => {
    const api = fakeProfileApi([makeFact()]);
    vi.mocked(api.listFacts).mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();

    render(<ProfilePage api={api} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("资料加载失败");
    await user.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByLabelText("邮箱")).toHaveValue("ada@example.com");
    expect(api.listFacts).toHaveBeenCalledTimes(2);
  });

  it("shows a useful empty state after loading", async () => {
    render(<ProfilePage api={fakeProfileApi()} />);
    expect(await screen.findByRole("heading", { name: "完整候选人档案" })).toBeVisible();
    expect(screen.getByLabelText("姓名")).toHaveValue("");
  });

  it("keeps a post-upload read when the pre-upload read resolves later", async () => {
    const initialRead = deferred<ProfileFact[]>();
    const postUploadRead = deferred<ProfileFact[]>();
    const beforeUpload = makeFact({ id: "before-upload", value: "before@example.com" });
    const afterUpload = makeFact({ id: "after-upload", value: "after@example.com" });
    const api = fakeProfileApi();
    vi.mocked(api.listFacts).mockReturnValueOnce(initialRead.promise).mockReturnValueOnce(postUploadRead.promise);
    vi.mocked(api.updateCurrentDocument).mockResolvedValue({
      documentId: "0f8fad5b-d9cb-469f-a165-70867728950e", filename: "resume.pdf",
      importedAt: "2026-09-08T08:00:00.000Z", extractedFactCount: 0, importStatus: "retained"
    });
    vi.mocked(api.parseCurrentDocument).mockResolvedValue({
      documentId: "0f8fad5b-d9cb-469f-a165-70867728950e", filename: "resume.pdf",
      importedAt: "2026-09-08T08:00:00.000Z", extractedFactCount: 1, importStatus: "completed"
    });
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);

    await user.upload(screen.getByLabelText("选择 PDF 简历"), new File(["%PDF"], "resume.pdf", { type: "application/pdf" }));
    await user.click(screen.getByRole("button", { name: "更新并解析" }));
    await waitFor(() => expect(api.listFacts).toHaveBeenCalledTimes(2));
    postUploadRead.resolve([afterUpload]);
    await waitFor(() => expect(screen.getByLabelText("邮箱")).toHaveValue("after@example.com"));

    initialRead.resolve([beforeUpload]);
    await act(async () => { await initialRead.promise; });
    expect(screen.getByLabelText("邮箱")).toHaveValue("after@example.com");
    expect(screen.queryByText("before@example.com")).not.toBeInTheDocument();
  });

  it("invalidates an old API upload and its finally block when the API prop changes", async () => {
    const oldUpload = deferred<Awaited<ReturnType<ProfileApi["updateCurrentDocument"]>>>();
    const oldApi = fakeProfileApi();
    vi.mocked(oldApi.updateCurrentDocument).mockReturnValueOnce(oldUpload.promise);
    const newFact = makeFact({ id: "new-api", value: "new-api@example.com" });
    const newApi = fakeProfileApi([newFact]);
    const user = userEvent.setup();
    const { rerender } = render(<ProfilePage api={oldApi} />);
    await screen.findByRole("heading", { name: "完整候选人档案" });

    await user.upload(screen.getByLabelText("选择 PDF 简历"), new File(["%PDF"], "resume.pdf", { type: "application/pdf" }));
    await user.click(screen.getByRole("button", { name: "仅更新简历" }));
    rerender(<ProfilePage api={newApi} />);
    expect(await screen.findByLabelText("邮箱")).toHaveValue("new-api@example.com");

    oldUpload.resolve({
      documentId: "0f8fad5b-d9cb-469f-a165-70867728950e", filename: "resume.pdf",
      importedAt: "2026-09-08T08:00:00.000Z", extractedFactCount: 0, importStatus: "retained"
    });
    await act(async () => { await oldUpload.promise; });
    expect(screen.getByLabelText("邮箱")).toHaveValue("new-api@example.com");
    expect(screen.queryByText(/当前简历已更新/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "仅更新简历" })).toBeDisabled();
  });

  it("ignores an old latest-document response after the profile API changes", async () => {
    const oldDocument = deferred<Awaited<ReturnType<ProfileApi["getLatestDocument"]>>>();
    const oldApi = fakeProfileApi();
    vi.mocked(oldApi.getLatestDocument).mockReturnValueOnce(oldDocument.promise);
    const newApi = fakeProfileApi();
    vi.mocked(newApi.getLatestDocument).mockResolvedValueOnce({
      documentId: "new-document",
      filename: "新简历.pdf",
      importedAt: "2026-08-04T08:00:00.000Z",
      extractedFactCount: 52
    });
    const { rerender } = render(<ProfilePage api={oldApi} />);

    rerender(<ProfilePage api={newApi} />);
    expect((await screen.findAllByText("新简历.pdf")).length).toBeGreaterThan(0);
    oldDocument.resolve({
      documentId: "old-document",
      filename: "旧简历.pdf",
      importedAt: "2026-08-04T07:00:00.000Z",
      extractedFactCount: 40
    });
    await act(async () => { await oldDocument.promise; });

    expect(screen.queryByText("旧简历.pdf")).not.toBeInTheDocument();
  });
});


describe("current resume lifecycle", () => {
  const retained = {
    documentId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    filename: "resume.pdf",
    importedAt: "2026-09-08T08:00:00.000Z",
    extractedFactCount: 0,
    importStatus: "retained" as const
  };

  it("updates the resume file without parsing or reloading profile facts", async () => {
    const api = fakeProfileApi();
    vi.mocked(api.updateCurrentDocument).mockResolvedValue(retained);
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);
    await screen.findByRole("heading", { name: "完整候选人档案" });
    const initialFactReads = vi.mocked(api.listFacts).mock.calls.length;
    const initialCompletenessReads = vi.mocked(api.getCompleteness).mock.calls.length;

    await user.upload(screen.getByLabelText("选择 PDF 简历"), new File(["%PDF"], "resume.pdf", { type: "application/pdf" }));
    await user.click(screen.getByRole("button", { name: "仅更新简历" }));

    expect(await screen.findByText("当前简历已更新，已有档案资料未改变")).toBeVisible();
    expect(api.updateCurrentDocument).toHaveBeenCalledOnce();
    expect(api.parseCurrentDocument).not.toHaveBeenCalled();
    expect(api.listFacts).toHaveBeenCalledTimes(initialFactReads);
    expect(api.getCompleteness).toHaveBeenCalledTimes(initialCompletenessReads);
    expect(screen.getByLabelText<HTMLInputElement>("选择 PDF 简历").files).toHaveLength(0);
  });

  it("updates and parses before reloading profile data", async () => {
    const completed = { ...retained, extractedFactCount: 3, importStatus: "completed" as const };
    const api = fakeProfileApi();
    vi.mocked(api.updateCurrentDocument).mockResolvedValue(retained);
    vi.mocked(api.parseCurrentDocument).mockResolvedValue(completed);
    vi.mocked(api.getCurrentDocument).mockResolvedValue(completed);
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);
    await screen.findByRole("heading", { name: "完整候选人档案" });

    await user.upload(screen.getByLabelText("选择 PDF 简历"), new File(["%PDF"], "resume.pdf", { type: "application/pdf" }));
    await user.click(screen.getByRole("button", { name: "更新并解析" }));

    expect(await screen.findByText("简历已解析，档案资料已更新")).toBeVisible();
    expect(api.updateCurrentDocument).toHaveBeenCalledOnce();
    expect(api.parseCurrentDocument).toHaveBeenCalledWith(retained.documentId);
    expect(api.listFacts).toHaveBeenCalledTimes(2);
    expect(api.getCompleteness).toHaveBeenCalledTimes(2);
    expect(api.getCurrentDocument).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed current document visible and retries parsing without another upload", async () => {
    const failed = { ...retained, importStatus: "failed" as const };
    const completed = { ...retained, extractedFactCount: 2, importStatus: "completed" as const };
    const api = fakeProfileApi();
    vi.mocked(api.updateCurrentDocument).mockResolvedValue(retained);
    vi.mocked(api.parseCurrentDocument).mockRejectedValueOnce(new Error("parser offline")).mockResolvedValueOnce(completed);
    vi.mocked(api.getCurrentDocument).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);
    await screen.findByRole("heading", { name: "完整候选人档案" });

    await user.upload(screen.getByLabelText("选择 PDF 简历"), new File(["%PDF"], "resume.pdf", { type: "application/pdf" }));
    await user.click(screen.getByRole("button", { name: "更新并解析" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("简历解析失败");
    expect(screen.getByText("resume.pdf")).toBeVisible();
    expect(screen.getByText("解析失败，可重试")).toBeVisible();

    vi.mocked(api.getCurrentDocument).mockResolvedValue(completed);
    await user.click(screen.getByRole("button", { name: "重新解析" }));
    expect(await screen.findByText("简历已解析，档案资料已更新")).toBeVisible();
    expect(api.updateCurrentDocument).toHaveBeenCalledOnce();
    expect(api.parseCurrentDocument).toHaveBeenCalledTimes(2);
    expect(api.parseCurrentDocument).toHaveBeenLastCalledWith(failed.documentId);
  });

  it.each([
    [new File(["notes"], "notes.txt", { type: "text/plain" }), "请选择 PDF 文件"],
    [new File(["%PDF"], "resume.pdf", { type: "" }), "浏览器未提供 PDF 文件类型"]
  ])("rejects an invalid resume selection without replacing the current file", async (file, message) => {
    const api = fakeProfileApi();
    const user = userEvent.setup({ applyAccept: false });
    render(<ProfilePage api={api} />);
    await user.upload(screen.getByLabelText("选择 PDF 简历"), file);
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(api.updateCurrentDocument).not.toHaveBeenCalled();
  });
});
