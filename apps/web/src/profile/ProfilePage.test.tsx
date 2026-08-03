import type { JsonValue, ProfileFact } from "@resume/contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProfileApi, SelfEvaluationReviewApi } from "../api/client.js";
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
    listFacts: vi.fn(async () => facts),
    upsert: vi.fn(async (fieldPath, value) => makeFact({ fieldPath, value: value as JsonValue, status: "user_corrected" })),
    getCompleteness: vi.fn(async () => ({ completed: 0, total: 1, sections: [] })),
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
  it("keeps the long-form candidate profile ahead of PDF review when completeness is unavailable", async () => {
    const api = fakeProfileApi([makeFact({ fieldPath: "basics.name", value: "何庆" })]);
    vi.mocked(api.getCompleteness).mockRejectedValueOnce(new Error("completeness unavailable"));
    render(<ProfilePage api={api} embedded />);

    const profileTitle = await screen.findByRole("heading", { name: "完整候选人档案" });
    expect(screen.getByText("档案完整度暂不可用")).toBeVisible();
    expect(screen.getAllByText("待评估").length).toBeGreaterThan(0);
    const uploadTitle = screen.getByRole("heading", { name: "简历资料" });
    expect(profileTitle.compareDocumentPosition(uploadTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows initial loading without an empty-state flash", async () => {
    const pending = deferred<ProfileFact[]>();
    const api = fakeProfileApi();
    vi.mocked(api.listFacts).mockReturnValueOnce(pending.promise);

    render(<ProfilePage api={api} />);

    expect(screen.getByRole("status", { name: "资料加载状态" })).toHaveTextContent("正在加载资料");
    expect(screen.queryByText("还没有可审核的资料")).not.toBeInTheDocument();
    pending.resolve([]);
    expect(await screen.findByText("还没有可审核的资料")).toBeVisible();
  });

  it("shows a retryable load error", async () => {
    const api = fakeProfileApi([makeFact()]);
    vi.mocked(api.listFacts).mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();

    render(<ProfilePage api={api} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("资料加载失败");
    await user.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByText("ada@example.com")).toBeVisible();
    expect(api.listFacts).toHaveBeenCalledTimes(2);
  });

  it("shows a useful empty state after loading", async () => {
    render(<ProfilePage api={fakeProfileApi()} />);
    expect(await screen.findByText("还没有可审核的资料")).toBeVisible();
    expect(screen.getByText("请先选择并上传 PDF 简历")).toBeVisible();
  });

  it("keeps a post-upload read when the pre-upload read resolves later", async () => {
    const initialRead = deferred<ProfileFact[]>();
    const postUploadRead = deferred<ProfileFact[]>();
    const beforeUpload = makeFact({ id: "before-upload", value: "before@example.com" });
    const afterUpload = makeFact({ id: "after-upload", value: "after@example.com" });
    const api = fakeProfileApi();
    vi.mocked(api.listFacts).mockReturnValueOnce(initialRead.promise).mockReturnValueOnce(postUploadRead.promise);
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);

    await user.upload(screen.getByLabelText("选择 PDF 简历"), new File(["%PDF"], "resume.pdf", { type: "application/pdf" }));
    await user.click(screen.getByRole("button", { name: "上传并提取" }));
    await waitFor(() => expect(api.listFacts).toHaveBeenCalledTimes(2));
    postUploadRead.resolve([afterUpload]);
    expect(await screen.findByText("after@example.com")).toBeVisible();

    initialRead.resolve([beforeUpload]);
    await act(async () => { await initialRead.promise; });
    expect(screen.getByText("after@example.com")).toBeVisible();
    expect(screen.queryByText("before@example.com")).not.toBeInTheDocument();
  });

  it("invalidates an old API upload and its finally block when the API prop changes", async () => {
    const oldUpload = deferred<{ documentId: string }>();
    const oldApi = fakeProfileApi();
    vi.mocked(oldApi.upload).mockReturnValueOnce(oldUpload.promise);
    const newFact = makeFact({ id: "new-api", value: "new-api@example.com" });
    const newApi = fakeProfileApi([newFact]);
    const user = userEvent.setup();
    const { rerender } = render(<ProfilePage api={oldApi} />);
    await screen.findByText("还没有可审核的资料");

    await user.upload(screen.getByLabelText("选择 PDF 简历"), new File(["%PDF"], "resume.pdf", { type: "application/pdf" }));
    await user.click(screen.getByRole("button", { name: "上传并提取" }));
    rerender(<ProfilePage api={newApi} />);
    expect(await screen.findByText("new-api@example.com")).toBeVisible();

    oldUpload.resolve({ documentId: "old-document" });
    await act(async () => { await oldUpload.promise; });
    expect(screen.getByText("new-api@example.com")).toBeVisible();
    expect(screen.queryByText(/简历已导入/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传并提取" })).toBeDisabled();
  });
});

describe("fact review", () => {
  it("keeps PDF import and evidence review available when embedded in the candidate workspace", async () => {
    const user = userEvent.setup();
    render(<ProfilePage api={fakeProfileApi([makeFact()])} embedded />);

    expect(await screen.findByLabelText("选择 PDF 简历")).toBeEnabled();
    const row = await screen.findByTestId("fact-fact-email");
    await user.click(within(row).getByRole("button", { name: "查看来源" }));
    expect(screen.getByRole("dialog", { name: "证据映射" })).toBeVisible();
  });

  it("keeps an extracted fact visibly pending until confirmation succeeds", async () => {
    const api = fakeProfileApi([makeFact()]);
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);

    const row = await screen.findByTestId("fact-fact-email");
    expect(within(row).getByText("待确认")).toBeVisible();
    expect(within(row).queryByText("已确认")).not.toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "确认" }));
    expect(await within(row).findByText("已确认")).toBeVisible();
  });

  it("opens an accessible evidence dialog, closes with Escape, and restores focus", async () => {
    const user = userEvent.setup();
    render(<ProfilePage api={fakeProfileApi([makeFact()])} />);
    const sourceButton = await screen.findByRole("button", { name: "查看来源" });

    await user.click(sourceButton);
    const dialog = screen.getByRole("dialog", { name: "证据映射" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("heading", { level: 3, name: "邮箱" })).toBeVisible();
    expect(within(dialog).getByText("文档标识")).toBeVisible();
    expect(within(dialog).getByText("a".repeat(64))).toBeVisible();
    expect(within(dialog).getByText("第 1 页")).toBeVisible();
    expect(within(dialog).getByText("Email: ada@example.com")).toBeVisible();
    expect(within(dialog).getByText("PDF 文本提取")).toBeVisible();
    const preview = within(dialog).getByTitle("原始 PDF 第 1 页");
    expect(preview.getAttribute("src")).toContain(`/api/profile/documents/${"a".repeat(64)}/pages/1/image`);
    expect(within(dialog).getByRole("button", { name: "关闭来源" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "证据映射" })).not.toBeInTheDocument();
    expect(sourceButton).toHaveFocus();
  });

  it("uses an honest document label rather than inventing a filename", async () => {
    const user = userEvent.setup();
    render(<ProfilePage api={fakeProfileApi([makeFact()])} />);
    await user.click(await screen.findByRole("button", { name: "查看来源" }));

    expect(screen.queryByText(/\.pdf/)).not.toBeInTheDocument();
    expect(screen.getByText("文档标识")).toBeVisible();
  });

  it("switches the PDF page and original quote when another evidence item is selected", async () => {
    const user = userEvent.setup();
    const groundingResponse = {
      match: "exact",
      coordinateSpace: 1000,
      boxes: [{ x1: 120, y1: 240, x2: 620, y2: 300 }]
    };
    const fetchGrounding = vi.fn(async () => new Response(JSON.stringify(groundingResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchGrounding);
    render(<ProfilePage api={fakeProfileApi([makeFact({
      evidence: [
        { documentId: "a".repeat(64), page: 1, text: "第一页原文", extraction: "pdf_text" },
        { documentId: "a".repeat(64), page: 2, text: "第二页 OCR 原文", extraction: "ocr" }
      ]
    })])} />);
    await user.click(await screen.findByRole("button", { name: "查看来源" }));
    const dialog = screen.getByRole("dialog", { name: "证据映射" });

    await user.click(within(dialog).getByRole("button", { name: "OCR 识别，第 2 页" }));

    expect(within(dialog).getByText("第二页 OCR 原文")).toBeVisible();
    expect(await within(dialog).findByText("文本位置高亮")).toBeVisible();
    const preview = within(dialog).getByTitle("原始 PDF 第 2 页");
    expect(preview.getAttribute("src")).toContain("/pages/2/image");
    const highlight = within(dialog).getByTestId("evidence-highlight-0");
    expect(highlight).toHaveStyle({ left: "12%", top: "24%", width: "50%", height: "6%" });
    expect(fetchGrounding).toHaveBeenCalledWith(
      expect.stringContaining(`/pages/2/grounding?text=${encodeURIComponent("第二页 OCR 原文")}`),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("renders user evidence as a correction record without a fake document page or original quote", async () => {
    const user = userEvent.setup();
    render(<ProfilePage api={fakeProfileApi([makeFact({
      status: "user_corrected",
      evidence: [{
        documentId: "user",
        page: 1,
        text: 'Corrected value: "new@example.com"',
        extraction: "user"
      }]
    })])} />);
    await user.click(await screen.findByRole("button", { name: "查看来源" }));
    const dialog = screen.getByRole("dialog", { name: "证据映射" });

    expect(within(dialog).getByText("用户更正")).toBeVisible();
    expect(within(dialog).getByRole("heading", { level: 3, name: "更正记录" })).toBeVisible();
    expect(within(dialog).getByText('Corrected value: "new@example.com"')).toBeVisible();
    expect(within(dialog).queryByText("页码")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("第 1 页")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("原文")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("文档标识")).not.toBeInTheDocument();
    expect(within(dialog).queryByTitle(/原始 PDF/)).not.toBeInTheDocument();
  });

  it("keeps controls disabled in flight and reports confirmation failure without false success", async () => {
    const pending = deferred<ProfileFact>();
    const api = fakeProfileApi([makeFact()]);
    vi.mocked(api.confirm).mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);
    const row = await screen.findByTestId("fact-fact-email");

    await user.click(within(row).getByRole("button", { name: "确认" }));
    expect(within(row).getByRole("button", { name: "确认中" })).toBeDisabled();
    expect(within(row).getByRole("button", { name: "修改" })).toBeDisabled();
    pending.reject(new Error("conflict"));

    expect(await within(row).findByRole("alert")).toHaveTextContent("确认失败");
    expect(within(row).getByText("待确认")).toBeVisible();
    expect(within(row).queryByText("已确认")).not.toBeInTheDocument();
  });

  it("serializes mutations globally while a write request is active", async () => {
    const firstPending = deferred<ProfileFact>();
    const first = makeFact({ id: "first", fieldPath: "basics.email", value: "first@example.com" });
    const second = makeFact({ id: "second", fieldPath: "basics.phone", value: "13800000000" });
    const api = fakeProfileApi([first, second]);
    vi.mocked(api.confirm).mockReturnValueOnce(firstPending.promise);
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);
    const firstRow = await screen.findByTestId("fact-first");
    const secondRow = screen.getByTestId("fact-second");

    await user.click(within(firstRow).getByRole("button", { name: "确认" }));

    expect(within(secondRow).getByRole("button", { name: "确认" })).toBeDisabled();
    expect(within(secondRow).getByRole("button", { name: "修改" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "上传并提取" })).toBeDisabled();
    firstPending.reject(new Error("stop"));
    expect(await within(firstRow).findByRole("alert")).toHaveTextContent("确认失败");
  });

  it("guards duplicate confirm calls before React can render disabled state", async () => {
    const pending = deferred<ProfileFact>();
    const api = fakeProfileApi([makeFact()]);
    vi.mocked(api.confirm).mockReturnValue(pending.promise);
    render(<ProfilePage api={api} />);
    const confirmButton = within(await screen.findByTestId("fact-fact-email")).getByRole("button", { name: "确认" });

    act(() => {
      confirmButton.click();
      confirmButton.click();
    });

    expect(api.confirm).toHaveBeenCalledOnce();
    pending.reject(new Error("stop"));
    await screen.findByText("确认失败，请重试");
  });

  it("keeps a newer mutation busy when an older reconciliation settles", async () => {
    const firstReconciliation = deferred<ProfileFact[]>();
    const secondMutation = deferred<ProfileFact>();
    const first = makeFact({ id: "first", fieldPath: "basics.email", value: "first@example.com" });
    const second = makeFact({ id: "second", fieldPath: "basics.phone", value: "13800000000" });
    const firstConfirmed = { ...first, status: "user_confirmed" as const };
    const secondConfirmed = { ...second, status: "user_confirmed" as const };
    const api = fakeProfileApi([first, second]);
    vi.mocked(api.confirm).mockResolvedValueOnce(firstConfirmed).mockReturnValueOnce(secondMutation.promise);
    vi.mocked(api.listFacts).mockResolvedValueOnce([first, second]).mockReturnValueOnce(firstReconciliation.promise)
      .mockResolvedValueOnce([firstConfirmed, secondConfirmed]);
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);
    const firstRow = await screen.findByTestId("fact-first");
    const secondRow = screen.getByTestId("fact-second");

    await user.click(within(firstRow).getByRole("button", { name: "确认" }));
    expect(await within(firstRow).findByText("已确认")).toBeVisible();
    await user.click(within(secondRow).getByRole("button", { name: "确认" }));
    expect(within(secondRow).getByRole("button", { name: "确认中" })).toBeDisabled();

    firstReconciliation.resolve([firstConfirmed, second]);
    await act(async () => { await firstReconciliation.promise; });
    expect(within(secondRow).getByRole("button", { name: "确认中" })).toBeDisabled();

    secondMutation.resolve(secondConfirmed);
    expect(await within(secondRow).findByText("已确认")).toBeVisible();
  });

  it("refreshes active facts after confirmation removes a superseded alternative", async () => {
    const candidate = makeFact({ id: "candidate", value: "new@example.com" });
    const previous = makeFact({ id: "previous", value: "old@example.com", status: "user_confirmed" });
    const confirmed = { ...candidate, status: "user_confirmed" as const };
    const api = fakeProfileApi([candidate, previous]);
    vi.mocked(api.confirm).mockResolvedValueOnce(confirmed);
    vi.mocked(api.listFacts).mockResolvedValueOnce([candidate, previous]).mockResolvedValueOnce([confirmed]);
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);

    const candidateRow = await screen.findByTestId("fact-candidate");
    await user.click(within(candidateRow).getByRole("button", { name: "确认" }));

    expect(await within(candidateRow).findByText("已确认")).toBeVisible();
    expect(screen.queryByText("old@example.com")).not.toBeInTheDocument();
    expect(api.listFacts).toHaveBeenCalledTimes(2);
  });

  it("cancels a string correction without calling the API", async () => {
    const api = fakeProfileApi([makeFact()]);
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);
    const row = await screen.findByTestId("fact-fact-email");

    await user.click(within(row).getByRole("button", { name: "修改" }));
    const input = within(row).getByRole("textbox", { name: "修改 邮箱" });
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, "new@example.com");
    await user.click(within(row).getByRole("button", { name: "取消" }));

    expect(within(row).getByText("ada@example.com")).toBeVisible();
    expect(within(row).getByRole("button", { name: "修改" })).toHaveFocus();
    expect(api.correct).not.toHaveBeenCalled();
  });

  it("saves a correction only after the API succeeds", async () => {
    const pending = deferred<ProfileFact>();
    const original = makeFact();
    const corrected = makeFact({ value: "new@example.com", status: "user_corrected", revision: 2 });
    const api = fakeProfileApi([original]);
    vi.mocked(api.correct).mockReturnValueOnce(pending.promise);
    vi.mocked(api.listFacts).mockResolvedValueOnce([original]).mockResolvedValueOnce([corrected]);
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);
    const row = await screen.findByTestId("fact-fact-email");

    await user.click(within(row).getByRole("button", { name: "修改" }));
    const input = within(row).getByRole("textbox", { name: "修改 邮箱" });
    await user.clear(input);
    await user.type(input, "new@example.com");
    await user.click(within(row).getByRole("button", { name: "保存" }));
    expect(within(row).getByRole("button", { name: "保存中" })).toBeDisabled();
    expect(within(row).getByRole("button", { name: "取消" })).toBeDisabled();
    expect(within(row).getByText("待确认")).toBeVisible();

    pending.resolve(corrected);
    expect(await within(row).findByText("new@example.com")).toBeVisible();
    expect(within(row).getByText("已修改")).toBeVisible();
    await waitFor(() => expect(within(row).getByRole("button", { name: "查看来源" })).toHaveFocus());
  });

  it("guards duplicate correction submits before React can render saving state", async () => {
    const pending = deferred<ProfileFact>();
    const api = fakeProfileApi([makeFact()]);
    vi.mocked(api.correct).mockReturnValue(pending.promise);
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);
    const row = await screen.findByTestId("fact-fact-email");
    await user.click(within(row).getByRole("button", { name: "修改" }));
    const form = within(row).getByRole("textbox", { name: "修改 邮箱" }).closest("form")!;

    act(() => {
      form.requestSubmit();
      form.requestSubmit();
    });

    expect(api.correct).toHaveBeenCalledOnce();
    pending.reject(new Error("stop"));
    await within(row).findByText("保存失败，请重试");
  });

  it("preserves a committed confirmation when reconciliation fails", async () => {
    const original = makeFact();
    const confirmed = makeFact({ status: "user_confirmed" });
    const api = fakeProfileApi([original]);
    vi.mocked(api.confirm).mockResolvedValueOnce(confirmed);
    vi.mocked(api.listFacts).mockResolvedValueOnce([original]).mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);
    const row = await screen.findByTestId("fact-fact-email");

    await user.click(within(row).getByRole("button", { name: "确认" }));

    expect(await within(row).findByText("已确认")).toBeVisible();
    expect(within(row).queryByRole("button", { name: "确认" })).not.toBeInTheDocument();
    expect(await within(row).findByRole("alert")).toHaveTextContent("操作已保存，但资料刷新失败");
  });

  it("moves focus to a stable row control after confirmation succeeds", async () => {
    const api = fakeProfileApi([makeFact()]);
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);
    const row = await screen.findByTestId("fact-fact-email");

    await user.click(within(row).getByRole("button", { name: "确认" }));

    expect(await within(row).findByText("已确认")).toBeVisible();
    expect(within(row).getByRole("button", { name: "查看来源" })).toHaveFocus();
  });

  it.each([
    { id: "text", fieldPath: "basics.email", value: "ada@example.com", role: "textbox", name: "修改 邮箱" },
    { id: "structured", fieldPath: "skills.items", value: ["TypeScript"] as JsonValue, role: "textbox", name: "修改 技能项" },
    { id: "boolean", fieldPath: "preferences.remote", value: true, role: "checkbox", name: "修改 接受远程" }
  ] as const)("focuses the $role editor for $fieldPath", async ({ id, fieldPath, value, role, name }) => {
    const user = userEvent.setup();
    render(<ProfilePage api={fakeProfileApi([makeFact({ id, fieldPath, value })])} />);
    const row = await screen.findByTestId(`fact-${id}`);

    await user.click(within(row).getByRole("button", { name: "修改" }));

    expect(within(row).getByRole(role, { name })).toHaveFocus();
  });

  it("keeps the editor open and original status visible when correction fails", async () => {
    const api = fakeProfileApi([makeFact()]);
    vi.mocked(api.correct).mockRejectedValueOnce(new Error("invalid"));
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);
    const row = await screen.findByTestId("fact-fact-email");

    await user.click(within(row).getByRole("button", { name: "修改" }));
    await user.click(within(row).getByRole("button", { name: "保存" }));

    expect(await within(row).findByRole("alert")).toHaveTextContent("保存失败");
    expect(within(row).getByRole("textbox", { name: "修改 邮箱" })).toBeVisible();
    expect(within(row).getByText("待确认")).toBeVisible();
  });

  it("preserves number and object value types when safely editable", async () => {
    const api = fakeProfileApi([
      makeFact({ id: "years", fieldPath: "work.years", value: 8 }),
      makeFact({ id: "link", fieldPath: "links.portfolio", value: { url: "https://old.example" } })
    ]);
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);

    const numberRow = await screen.findByTestId("fact-years");
    await user.click(within(numberRow).getByRole("button", { name: "修改" }));
    const numberInput = within(numberRow).getByRole("spinbutton", { name: "修改 工作年限" });
    await user.clear(numberInput);
    await user.type(numberInput, "9");
    await user.click(within(numberRow).getByRole("button", { name: "保存" }));
    expect(api.correct).toHaveBeenCalledWith("years", 9);

    const objectRow = screen.getByTestId("fact-link");
    await user.click(within(objectRow).getByRole("button", { name: "修改" }));
    const objectInput = within(objectRow).getByRole("textbox", { name: "修改 作品集" });
    await user.clear(objectInput);
    await user.click(objectInput);
    await user.paste('{"url":"https://new.example"}');
    await user.click(within(objectRow).getByRole("button", { name: "保存" }));
    expect(api.correct).toHaveBeenCalledWith("link", { url: "https://new.example" });
  });

  it("rejects invalid structured JSON before calling the API", async () => {
    const api = fakeProfileApi([makeFact({ id: "skills", fieldPath: "skills.items", value: ["TypeScript"] })]);
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);
    const row = await screen.findByTestId("fact-skills");

    await user.click(within(row).getByRole("button", { name: "修改" }));
    const input = within(row).getByRole("textbox", { name: "修改 技能项" });
    await user.clear(input);
    await user.type(input, "not-json");
    await user.click(within(row).getByRole("button", { name: "保存" }));

    expect(within(row).getByRole("alert")).toHaveTextContent("请输入有效的 JSON");
    expect(api.correct).not.toHaveBeenCalled();
  });

  it("groups categories in stable order and filters by review status", async () => {
    const api = fakeProfileApi([
      makeFact({ id: "misc", fieldPath: "unexpected.note", value: "Other" }),
      makeFact({ id: "skill", fieldPath: "skills.languages", value: ["TypeScript"], status: "user_confirmed" }),
      makeFact({ id: "school", fieldPath: "education.0.school", value: "NJU", status: "user_corrected" })
    ]);
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);

    await screen.findByRole("heading", { level: 2, name: "教育经历" });
    const categoryNames = screen.getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent)
      .filter((heading) => ["教育经历", "技能", "其他"].includes(heading ?? ""));
    expect(categoryNames).toEqual(["教育经历", "技能", "其他"]);
    await user.click(screen.getByRole("button", { name: "待确认 1" }));
    expect(screen.getByText("Other")).toBeVisible();
    expect(screen.queryByText(/TypeScript/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "已确认 1" }));
    expect(screen.getByText(/TypeScript/)).toBeVisible();
    expect(screen.queryByText("Other")).not.toBeInTheDocument();
  });

  it("maps common field-path aliases into all approved Chinese categories", async () => {
    render(<ProfilePage api={fakeProfileApi([
      makeFact({ id: "basic", fieldPath: "basic_info.name", value: "Ada" }),
      makeFact({ id: "education", fieldPath: "education_background[0].school", value: "NJU" }),
      makeFact({ id: "work", fieldPath: "work_experience[0].company", value: "OpenAI" }),
      makeFact({ id: "project", fieldPath: "project_experience[0].name", value: "Assistant" }),
      makeFact({ id: "skill-alias", fieldPath: "technical_skills[0]", value: "TypeScript" }),
      makeFact({ id: "certificate", fieldPath: "certifications[0].name", value: "PMP" }),
      makeFact({ id: "link-alias", fieldPath: "social_links.github", value: "https://github.com/ada" }),
      makeFact({ id: "self", fieldPath: "self_evaluation.summary", value: "Reliable" }),
      makeFact({ id: "preference", fieldPath: "job_preferences.city", value: "上海" }),
      makeFact({ id: "other", fieldPath: "custom.note", value: "Other" })
    ])} />);

    await screen.findByRole("heading", { level: 2, name: "基本信息" });
    const categoryNames = screen.getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent)
      .filter((heading) => ["基本信息", "教育经历", "工作经历", "项目经历", "技能", "证书", "链接", "自我评价", "求职偏好", "其他"].includes(heading ?? ""));
    expect(categoryNames).toEqual(["基本信息", "教育经历", "工作经历", "项目经历", "技能", "证书", "链接", "自我评价", "求职偏好", "其他"]);
  });

  it("uses category and full path context for ambiguous field labels", async () => {
    render(<ProfilePage api={fakeProfileApi([
      makeFact({ id: "project-name", fieldPath: "projects[0].name", value: "Assistant" }),
      makeFact({ id: "project-title", fieldPath: "projects[0].title", value: "Resume Assistant" }),
      makeFact({ id: "certificate-name", fieldPath: "certificates[0].name", value: "PMP" }),
      makeFact({ id: "certificate-title", fieldPath: "certificates[1].title", value: "AWS SAA" }),
      makeFact({ id: "skills-entry", fieldPath: "skills[0]", value: "TypeScript" }),
      makeFact({ id: "education-title", fieldPath: "education[0].title", value: "本科" }),
      makeFact({ id: "work-title", fieldPath: "work_experience[0].title", value: "工程师" }),
      makeFact({ id: "project-description", fieldPath: "projects[0].description", value: "项目介绍" }),
      makeFact({ id: "project-end-date", fieldPath: "projects[0].endDate", value: "2025.06" }),
      makeFact({ id: "unknown-field", fieldPath: "custom.unknownField", value: "自定义内容" })
    ])} />);

    expect(within(await screen.findByTestId("fact-project-name")).getByText("项目名称")).toBeVisible();
    expect(within(screen.getByTestId("fact-project-title")).getByText("项目标题")).toBeVisible();
    expect(within(screen.getByTestId("fact-certificate-name")).getByText("证书名称")).toBeVisible();
    expect(within(screen.getByTestId("fact-certificate-title")).getByText("证书名称")).toBeVisible();
    expect(within(screen.getByTestId("fact-skills-entry")).getByText("技能")).toBeVisible();
    expect(within(screen.getByTestId("fact-education-title")).getByText("学历/学位")).toBeVisible();
    expect(within(screen.getByTestId("fact-work-title")).getByText("职位")).toBeVisible();
    expect(within(screen.getByTestId("fact-project-description")).getByText("项目描述")).toBeVisible();
    expect(within(screen.getByTestId("fact-project-end-date")).getByText("结束时间")).toBeVisible();
    expect(within(screen.getByTestId("fact-unknown-field")).getByText("其他字段")).toBeVisible();
  });

  it("keeps each project and internship as a separate experience entry", async () => {
    render(<ProfilePage api={fakeProfileApi([
      makeFact({ id: "project-0-name", fieldPath: "projects[0].name", value: "简历投递助手" }),
      makeFact({ id: "project-0-start", fieldPath: "projects[0].startDate", value: "2025.01" }),
      makeFact({ id: "project-0-end", fieldPath: "projects[0].endDate", value: "2025.06" }),
      makeFact({ id: "project-0-description", fieldPath: "projects[0].description", value: "自动解析并审核简历" }),
      makeFact({ id: "project-0-keywords", fieldPath: "projects[0].keywords", value: "React, TypeScript" }),
      makeFact({ id: "project-0-highlight", fieldPath: "projects[0].highlights[0]", value: "实现可验证 RAG" }),
      makeFact({ id: "project-1-name", fieldPath: "projects[1].name", value: "社区平台" }),
      makeFact({ id: "project-1-description", fieldPath: "projects[1].description", value: "高并发内容服务" }),
      makeFact({ id: "work-0-company", fieldPath: "work[0].company", value: "大疆" }),
      makeFact({ id: "work-0-position", fieldPath: "work[0].position", value: "Java后端开发" }),
      makeFact({ id: "work-0-type", fieldPath: "work[0].employmentType", value: "internship" }),
      makeFact({ id: "work-0-description", fieldPath: "work[0].summary", value: "负责招聘系统开发" }),
      makeFact({ id: "work-0-highlight", fieldPath: "work[0].highlights[0]", value: "接口耗时降低 80%" }),
      makeFact({ id: "work-1-company", fieldPath: "work[1].company", value: "腾讯" }),
      makeFact({ id: "work-1-title", fieldPath: "work[1].title", value: "研发实习生" }),
      makeFact({ id: "work-1-description", fieldPath: "work[1].description", value: "负责内容平台开发" }),
      makeFact({ id: "education-0-school", fieldPath: "education[0].institution", value: "合肥工业大学" }),
      makeFact({ id: "education-0-major", fieldPath: "education[0].major", value: "计算机技术" }),
      makeFact({ id: "education-0-details", fieldPath: "education[0].details", value: "学院奖学金" }),
      makeFact({ id: "education-1-school", fieldPath: "education[1].institution", value: "武汉商学院" }),
      makeFact({ id: "education-1-major", fieldPath: "education[1].major", value: "软件工程" })
    ])} />);

    const firstProject = await screen.findByTestId("fact-entry-projects-0");
    const secondProject = screen.getByTestId("fact-entry-projects-1");
    expect(within(firstProject).getByRole("heading", { name: "简历投递助手" })).toBeVisible();
    expect(within(firstProject).getByText("自动解析并审核简历")).toBeVisible();
    expect(within(firstProject).queryByText("高并发内容服务")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("fact-project-0-highlight")).getByText("项目要点")).toBeVisible();
    expect(within(screen.getByTestId("fact-project-0-keywords")).getByText("技术栈")).toBeVisible();
    expect(within(firstProject).getAllByTestId(/^fact-/).map((row) => row.dataset.testid)).toEqual([
      "fact-project-0-name", "fact-project-0-start", "fact-project-0-end", "fact-project-0-description", "fact-project-0-keywords", "fact-project-0-highlight"
    ]);
    expect(within(secondProject).getByRole("heading", { name: "社区平台" })).toBeVisible();
    expect(within(secondProject).getByText("高并发内容服务")).toBeVisible();

    const firstWork = screen.getByTestId("fact-entry-work-0");
    const secondWork = screen.getByTestId("fact-entry-work-1");
    expect(within(firstWork).getByRole("heading", { name: "大疆 · Java后端实习" })).toBeVisible();
    expect(within(screen.getByTestId("fact-work-0-type")).getByText("Java后端实习")).toBeVisible();
    expect(within(firstWork).getByText("负责招聘系统开发")).toBeVisible();
    expect(within(screen.getByTestId("fact-work-0-highlight")).getByText("职责和成果")).toBeVisible();
    expect(within(firstWork).queryByText("负责内容平台开发")).not.toBeInTheDocument();
    expect(within(secondWork).getByRole("heading", { name: "腾讯 · 研发实习生" })).toBeVisible();
    expect(within(secondWork).getByText("负责内容平台开发")).toBeVisible();

    const firstEducation = screen.getByTestId("fact-entry-education-0");
    const secondEducation = screen.getByTestId("fact-entry-education-1");
    expect(within(firstEducation).getByRole("heading", { name: "合肥工业大学" })).toBeVisible();
    expect(within(firstEducation).getByText("学院奖学金")).toBeVisible();
    expect(within(firstEducation).queryByText("武汉商学院")).not.toBeInTheDocument();
    expect(within(secondEducation).getByRole("heading", { name: "武汉商学院" })).toBeVisible();
  });

  it("distinguishes confirmed and corrected statuses without a dead superseded filter", async () => {
    render(<ProfilePage api={fakeProfileApi([
      makeFact({ id: "confirmed", status: "user_confirmed" }),
      makeFact({ id: "corrected", fieldPath: "basics.phone", value: "13800000000", status: "user_corrected" })
    ])} />);

    const confirmedRow = await screen.findByTestId("fact-confirmed");
    expect(within(confirmedRow).getByText("已确认")).toBeVisible();
    expect(within(screen.getByTestId("fact-corrected")).getByText("已修改")).toBeVisible();
    expect(screen.queryByRole("button", { name: /已替代/ })).not.toBeInTheDocument();
  });
});

describe("PDF upload", () => {
  it("rejects an obviously invalid selection before calling the API", async () => {
    const api = fakeProfileApi();
    const user = userEvent.setup({ applyAccept: false });
    render(<ProfilePage api={api} />);
    const input = screen.getByLabelText("选择 PDF 简历");

    await user.upload(input, new File(["notes"], "notes.txt", { type: "text/plain" }));

    expect(screen.getByRole("alert")).toHaveTextContent("请选择 PDF 文件");
    expect(api.upload).not.toHaveBeenCalled();
  });

  it("shows filename and progress, then refreshes facts after accepted upload", async () => {
    const upload = deferred<{ documentId: string }>();
    const importedFact = makeFact({ id: "imported", fieldPath: "basics.name", value: "Ada" });
    const api = fakeProfileApi();
    vi.mocked(api.upload).mockReturnValueOnce(upload.promise);
    vi.mocked(api.listFacts).mockResolvedValueOnce([]).mockResolvedValueOnce([importedFact]);
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);
    const file = new File(["%PDF-1.7"], "resume.pdf", { type: "application/pdf" });

    await user.upload(screen.getByLabelText("选择 PDF 简历"), file);
    expect(screen.getByText("resume.pdf")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "上传并提取" }));
    expect(screen.getByRole("progressbar", { name: "正在上传 resume.pdf" })).toBeVisible();
    expect(screen.getByRole("button", { name: "上传中" })).toBeDisabled();
    expect(screen.getByLabelText("选择 PDF 简历")).toBeDisabled();

    await act(async () => upload.resolve({ documentId: "document-1" }));
    expect(await screen.findByText("简历已导入，资料已刷新")).toBeVisible();
    expect(screen.getByText("Ada")).toBeVisible();
    expect(api.listFacts).toHaveBeenCalledTimes(2);
  });

  it("reports upload errors and does not show false success", async () => {
    const api = fakeProfileApi();
    vi.mocked(api.upload).mockRejectedValueOnce(new Error("duplicate"));
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);
    await user.upload(screen.getByLabelText("选择 PDF 简历"), new File(["%PDF"], "resume.pdf", { type: "application/pdf" }));
    await user.click(screen.getByRole("button", { name: "上传并提取" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("上传失败");
    expect(screen.queryByText("简历已导入，资料已刷新")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传并提取" })).toBeEnabled();
  });

  it("keeps an accepted upload accepted when refresh fails and retries only the read", async () => {
    const importedFact = makeFact({ id: "imported", fieldPath: "basics.name", value: "Ada" });
    const api = fakeProfileApi();
    vi.mocked(api.listFacts).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([importedFact]);
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);
    const fileInput = screen.getByLabelText<HTMLInputElement>("选择 PDF 简历");
    await screen.findByText("还没有可审核的资料");

    await user.upload(fileInput, new File(["%PDF"], "resume.pdf", { type: "application/pdf" }));
    await user.click(screen.getByRole("button", { name: "上传并提取" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("简历已导入，但资料刷新失败");
    expect(fileInput.files).toHaveLength(0);
    expect(screen.getByText("未选择文件")).toBeVisible();
    expect(screen.getByRole("button", { name: "上传并提取" })).toBeDisabled();
    expect(api.upload).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "重新加载资料" }));
    expect(await screen.findByText("Ada")).toBeVisible();
    expect(screen.getByText("简历已导入，资料已刷新")).toBeVisible();
    expect(api.upload).toHaveBeenCalledOnce();
    expect(api.listFacts).toHaveBeenCalledTimes(3);
  });

  it("blocks competing refresh and fact mutations while the accepted upload read is pending", async () => {
    const uploadRefresh = deferred<ProfileFact[]>();
    const existingFact = makeFact();
    const importedFact = makeFact({ id: "imported", fieldPath: "basics.name", value: "Ada" });
    const api = fakeProfileApi([existingFact]);
    vi.mocked(api.listFacts).mockResolvedValueOnce([existingFact]).mockReturnValueOnce(uploadRefresh.promise);
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);
    const row = await screen.findByTestId("fact-fact-email");
    const refreshButton = screen.getByRole("button", { name: "刷新资料" });
    const confirmButton = within(row).getByRole("button", { name: "确认" });

    await user.upload(screen.getByLabelText("选择 PDF 简历"), new File(["%PDF"], "resume.pdf", { type: "application/pdf" }));
    await user.click(screen.getByRole("button", { name: "上传并提取" }));
    expect(await screen.findByText("简历已导入，正在刷新资料")).toBeVisible();

    expect(refreshButton).toBeDisabled();
    expect(confirmButton).toBeDisabled();
    expect(within(row).getByRole("button", { name: "修改" })).toBeDisabled();
    expect(screen.getByLabelText("选择 PDF 简历")).toBeDisabled();

    act(() => {
      refreshButton.removeAttribute("disabled");
      confirmButton.removeAttribute("disabled");
      refreshButton.click();
      confirmButton.click();
    });
    expect(api.listFacts).toHaveBeenCalledTimes(2);
    expect(api.confirm).not.toHaveBeenCalled();

    uploadRefresh.resolve([existingFact, importedFact]);
    expect(await screen.findByText("简历已导入，资料已刷新")).toBeVisible();
  });

  it("settles an accepted refresh error after a successful global facts refresh", async () => {
    const importedFact = makeFact({ id: "imported", fieldPath: "basics.name", value: "Ada" });
    const api = fakeProfileApi();
    vi.mocked(api.listFacts).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([importedFact]);
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);
    await screen.findByText("还没有可审核的资料");

    await user.upload(screen.getByLabelText("选择 PDF 简历"), new File(["%PDF"], "resume.pdf", { type: "application/pdf" }));
    await user.click(screen.getByRole("button", { name: "上传并提取" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("简历已导入，但资料刷新失败");

    await user.click(screen.getByRole("button", { name: "刷新资料" }));

    expect(await screen.findByText("Ada")).toBeVisible();
    expect(screen.getByText("简历已导入，资料已刷新")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.upload).toHaveBeenCalledOnce();
    expect(api.listFacts).toHaveBeenCalledTimes(3);
  });

  it("does not leave an accepted upload refreshing after imported facts commit", async () => {
    const uploadRefresh = deferred<ProfileFact[]>();
    const importedFact = makeFact({ id: "imported", fieldPath: "basics.name", value: "Ada" });
    const api = fakeProfileApi();
    vi.mocked(api.listFacts).mockResolvedValueOnce([]).mockReturnValueOnce(uploadRefresh.promise);
    const user = userEvent.setup();
    render(<ProfilePage api={api} />);
    await screen.findByText("还没有可审核的资料");

    await user.upload(screen.getByLabelText("选择 PDF 简历"), new File(["%PDF"], "resume.pdf", { type: "application/pdf" }));
    await user.click(screen.getByRole("button", { name: "上传并提取" }));
    expect(await screen.findByText("简历已导入，正在刷新资料")).toBeVisible();

    uploadRefresh.resolve([importedFact]);

    expect(await screen.findByText("Ada")).toBeVisible();
    expect(screen.getByText("简历已导入，资料已刷新")).toBeVisible();
    expect(screen.queryByText("简历已导入，正在刷新资料")).not.toBeInTheDocument();
  });

  it("rejects a PDF extension when the browser provides no application/pdf MIME", async () => {
    const api = fakeProfileApi();
    const user = userEvent.setup({ applyAccept: false });
    render(<ProfilePage api={api} />);
    const input = screen.getByLabelText<HTMLInputElement>("选择 PDF 简历");

    expect(input).toHaveAttribute("accept", ".pdf");
    await user.upload(input, new File(["%PDF"], "resume.pdf", { type: "" }));

    expect(screen.getByRole("alert")).toHaveTextContent("浏览器未提供 PDF 文件类型");
    expect(api.upload).not.toHaveBeenCalled();
  });
});
