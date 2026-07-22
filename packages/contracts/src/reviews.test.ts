import { describe, expect, it } from "vitest";
import { CreateSelfEvaluationReviewBodySchema, SelfEvaluationReviewSchema } from "./reviews.js";

describe("self-evaluation review contracts", () => {
  it("requires durable job provenance without accepting a caller-generated draft", () => {
    expect(CreateSelfEvaluationReviewBodySchema.parse({ jobDescription: "React platform role" })).toEqual({
      jobDescription: "React platform role"
    });
    expect(CreateSelfEvaluationReviewBodySchema.safeParse({
      jobDescription: "React platform role",
      draft: { draft: "caller output", reasons: ["caller"], claims: [] }
    }).success).toBe(false);

    const review = SelfEvaluationReviewSchema.parse({
      taskId: "task-1",
      jobDescription: "React platform role",
      original: "Original",
      draft: "Tailored",
      reasons: ["React emphasis"],
      evidence: [],
      unsupportedClaims: [],
      status: "needs_review",
      base: {
        factId: "self",
        revision: 1,
        original: "Original",
        evidence: [{ documentId: "resume", page: 1, text: "Original", extraction: "pdf_text" }]
      }
    });
    expect(review.jobDescription).toBe("React platform role");
  });
});
