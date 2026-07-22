import type { JsonValue, ProfileFact } from "@resume/contracts";
import { act, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProfileApi } from "../api/client.js";
import { ProfilePage } from "./ProfilePage.js";

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

describe("ProfilePage loading states", () => {
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
});

describe("fact review", () => {
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
    const dialog = screen.getByRole("dialog", { name: "提取来源" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByText("文档标识")).toBeVisible();
    expect(within(dialog).getByText("a".repeat(64))).toBeVisible();
    expect(within(dialog).getByText("第 1 页")).toBeVisible();
    expect(within(dialog).getByText("Email: ada@example.com")).toBeVisible();
    expect(within(dialog).getByText("PDF 文本提取")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "关闭来源" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "提取来源" })).not.toBeInTheDocument();
    expect(sourceButton).toHaveFocus();
  });

  it("uses an honest document label rather than inventing a filename", async () => {
    const user = userEvent.setup();
    render(<ProfilePage api={fakeProfileApi([makeFact()])} />);
    await user.click(await screen.findByRole("button", { name: "查看来源" }));

    expect(screen.queryByText(/\.pdf/)).not.toBeInTheDocument();
    expect(screen.getByText("文档标识")).toBeVisible();
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
    await user.clear(input);
    await user.type(input, "new@example.com");
    await user.click(within(row).getByRole("button", { name: "取消" }));

    expect(within(row).getByText("ada@example.com")).toBeVisible();
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

  it("distinguishes confirmed, corrected, and superseded statuses", async () => {
    render(<ProfilePage api={fakeProfileApi([
      makeFact({ id: "confirmed", status: "user_confirmed" }),
      makeFact({ id: "corrected", fieldPath: "basics.phone", value: "13800000000", status: "user_corrected" }),
      makeFact({ id: "old", fieldPath: "basics.city", value: "Old city", status: "superseded" })
    ])} />);

    const confirmedRow = await screen.findByTestId("fact-confirmed");
    expect(within(confirmedRow).getByText("已确认")).toBeVisible();
    expect(within(screen.getByTestId("fact-corrected")).getByText("已修改")).toBeVisible();
    expect(within(screen.getByTestId("fact-old")).getByText("已被替代")).toBeVisible();
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
});
