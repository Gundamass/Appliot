import { describe, expect, it } from "vitest";
import { ProfileFactSchema } from "./profile.js";

describe("ProfileFactSchema", () => {
  it("rejects an extracted fact without source evidence", () => {
    const result = ProfileFactSchema.safeParse({
      id: "fact-1",
      fieldPath: "basics.email",
      value: "me@example.com",
      status: "extracted",
      confidence: 0.9,
      scope: "profile",
      revision: 1
    });
    expect(result.success).toBe(false);
  });

  it("rejects an application-scoped fact without taskId", () => {
    const result = ProfileFactSchema.safeParse({
      id: "fact-2",
      fieldPath: "workAuthorization",
      value: "authorized",
      status: "extracted",
      confidence: 0.9,
      scope: "application",
      evidence: [{
        documentId: "resume.pdf",
        page: 1,
        text: "Authorized to work",
        extraction: "pdf_text"
      }],
      revision: 1
    });
    expect(result.success).toBe(false);
  });
});
