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
      decision: { fieldId: "city", status: "needs_question" as const, evidence: [{ documentId: "resume", page: 2, text: "Shanghai", extraction: "pdf_text" as const }], confidence: 0.4, question: "Which city should this task use?", validators: [] }
    };
    const api: RagApi = {
      resolve: vi.fn(async () => inspection),
      answer: vi.fn(async (answer): ReturnType<RagApi["answer"]> => ({
        correction: { id: "answer", fieldPath: answer.semantic, value: answer.value, status: "user_confirmed", confidence: 1, scope: "application", taskId: answer.taskId, evidence: [{ documentId: "user", page: 1, text: "Shenzhen", extraction: "user" }], revision: 1 },
        inspection: { ...inspection, decision: { ...inspection.decision, status: "verified_auto" as const, value: "Shenzhen", confidence: 1, question: undefined } }
      }))
    };
    const user = userEvent.setup();
    render(<RagWorkspace api={api} />);

    await user.click(screen.getByRole("button", { name: "Resolve field" }));
    expect(await screen.findByText("needs_question")).toBeVisible();
    expect(screen.getByText("exact, keyword")).toBeVisible();
    expect(screen.getByText("Which city should this task use?")).toBeVisible();
    expect(screen.getByText("Shanghai")).toBeVisible();

    await user.clear(screen.getByLabelText("Correction"));
    await user.type(screen.getByLabelText("Correction"), "Shenzhen");
    await user.click(screen.getByRole("button", { name: "Save for this task" }));

    expect(api.answer).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1", value: "Shenzhen" }));
    expect(await screen.findByText("verified_auto")).toBeVisible();
  });

  it("shows embedding degradation while keeping keyword field resolution available", async () => {
    const api: RagApi = { resolve: vi.fn(), answer: vi.fn() };
    render(<RagWorkspace api={api} embeddingStatus={{ id: "embedding", state: "unavailable", code: "offline" }} />);

    expect(screen.getByText("语义检索 离线")).toBeVisible();
    expect(screen.getByRole("button", { name: "Resolve field" })).toBeEnabled();
  });
});
