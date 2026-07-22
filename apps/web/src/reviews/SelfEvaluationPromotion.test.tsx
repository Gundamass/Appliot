import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SelfEvaluationReview as Review } from "@resume/contracts";
import { SelfEvaluationReview } from "./SelfEvaluationReview.js";

const approved: Review = {
  taskId: "task-1",
  jobDescription: "React platform role",
  original: "Original summary",
  draft: "Tailored summary",
  reasons: ["Role emphasis"],
  evidence: [],
  unsupportedClaims: [],
  status: "approved",
  base: {
    factId: "self",
    revision: 1,
    original: "Original summary",
    evidence: [{ documentId: "resume", page: 1, text: "Original summary", extraction: "pdf_text" }]
  }
};

describe("SelfEvaluationReview promotion", () => {
  it("offers explicit profile promotion only after task approval", async () => {
    const user = userEvent.setup();
    const promote = vi.fn(async () => approved);
    render(<SelfEvaluationReview draft={approved} onApprove={vi.fn()} onKeepOriginal={vi.fn()} onPromote={promote} />);

    expect(screen.getByText("React platform role")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Promote to profile" }));

    expect(promote).toHaveBeenCalledOnce();
    expect(await screen.findByRole("status")).toHaveTextContent("Promoted to profile");
  });
});
