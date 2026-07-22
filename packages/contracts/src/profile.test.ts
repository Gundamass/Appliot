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

  it("rejects a profile-scoped fact with a taskId", () => {
    const result = ProfileFactSchema.safeParse({
      id: "fact-injected",
      fieldPath: "basics.email",
      value: "injected@example.com",
      status: "user_confirmed",
      confidence: 1,
      scope: "profile",
      taskId: "task-forged",
      evidence: [{ documentId: "user", page: 1, text: "injected@example.com", extraction: "user" }],
      revision: 1
    });

    expect(result.success).toBe(false);
  });

  it("accepts JSON scalar, array, and object values", () => {
    for (const value of ["text", 1, true, null, ["TypeScript", 5], { city: "Shanghai", remote: true }]) {
      expect(ProfileFactSchema.safeParse({
        id: "fact-json",
        fieldPath: "preferences.value",
        value,
        status: "extracted",
        confidence: 0.9,
        scope: "profile",
        evidence: [{ documentId: "resume.pdf", page: 1, text: "value", extraction: "pdf_text" }],
        revision: 1
      }).success).toBe(true);
    }
  });

  it("rejects values that are not JSON", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, cyclic]) {
      expect(ProfileFactSchema.safeParse({
        id: "fact-invalid-json",
        fieldPath: "preferences.value",
        value,
        status: "extracted",
        confidence: 0.9,
        scope: "profile",
        evidence: [{ documentId: "resume.pdf", page: 1, text: "value", extraction: "pdf_text" }],
        revision: 1
      }).success).toBe(false);
    }
  });

  it("rejects sparse arrays and values with custom toJSON methods", () => {
    const sparse = ["present", , "later"];
    const customToJson = { city: "Shanghai", toJSON: () => "not persisted" };
    for (const value of [sparse, customToJson]) {
      expect(ProfileFactSchema.safeParse({
        id: "fact-non-plain-json",
        fieldPath: "preferences.value",
        value,
        status: "extracted",
        confidence: 0.9,
        scope: "profile",
        evidence: [{ documentId: "resume.pdf", page: 1, text: "value", extraction: "pdf_text" }],
        revision: 1
      }).success).toBe(false);
    }
  });
});
