import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RagApi } from "../api/client.js";
import { RagWorkspace } from "./RagWorkspace.js";

describe("RagWorkspace", () => {
  it("shows planning, decision, question and evidence, then applies a task correction", async () => {
    const request = { taskId: "task-1", fieldId: "city", semantic: "preferences.city", label: "Preferred city", type: "text" as const };
    const inspection = {
      request,
      plan: { semantic: "preferences.city", requestType: "text" as const, requiredSources: ["application" as const, "profile" as const], needsJobDescription: false, autoFillEligible: true, risk: "none" as const, validators: [], strategy: ["exact" as const, "keyword" as const], valid: true },
      decision: { fieldId: "city", status: "needs_question" as const, evidence: [{ documentId: "resume", page: 2, text: "上海", extraction: "pdf_text" as const }], confidence: 0.4, question: "本次投递应使用哪个城市？", validators: [] }
    };
    const api: RagApi = {
      resolve: vi.fn(async () => inspection),
      answer: vi.fn(async (answer): ReturnType<RagApi["answer"]> => ({
        correction: { id: "answer", fieldPath: answer.semantic, value: answer.value, status: "user_confirmed", confidence: 1, scope: "application", taskId: answer.taskId, evidence: [{ documentId: "user", page: 1, text: "深圳", extraction: "user" }], revision: 1 },
        inspection: { ...inspection, decision: { ...inspection.decision, status: "verified_auto" as const, value: "深圳", confidence: 1, question: undefined } }
      }))
    };
    const user = userEvent.setup();
    render(<RagWorkspace api={api} />);

    await user.click(screen.getByRole("button", { name: "解析字段" }));
    expect(await screen.findByText("需要追问")).toBeVisible();
    expect(screen.getByText("精确匹配、关键词检索")).toBeVisible();
    expect(screen.getByText("本次投递应使用哪个城市？")).toBeVisible();
    expect(screen.getByText("上海")).toBeVisible();

    await user.clear(screen.getByLabelText("修正值"));
    await user.type(screen.getByLabelText("修正值"), "深圳");
    await user.click(screen.getByRole("button", { name: "仅保存到本次任务" }));

    expect(api.answer).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1", value: "深圳" }));
    expect(await screen.findByText("已自动验证")).toBeVisible();
  });

  it("shows embedding degradation while keeping keyword field resolution available", async () => {
    const api: RagApi = { resolve: vi.fn(), answer: vi.fn() };
    render(<RagWorkspace api={api} embeddingStatus={{ id: "embedding", state: "unavailable", code: "offline" }} />);

    expect(screen.getByText("语义检索 离线")).toBeVisible();
    expect(screen.getByRole("button", { name: "解析字段" })).toBeEnabled();
  });
});
