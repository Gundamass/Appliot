import { describe, expect, it } from "vitest";
import { DocumentResponseSchema, ErrorResponseSchema } from "./http.js";

describe("HTTP response contracts", () => {
  it("accepts the strict Task 5 document response", () => {
    expect(DocumentResponseSchema.parse({
      documentId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      fingerprint: "a".repeat(64)
    })).toEqual({
      documentId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      fingerprint: "a".repeat(64)
    });
    expect(DocumentResponseSchema.safeParse({
      documentId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      fingerprint: "a".repeat(64),
      filename: "resume.pdf"
    }).success).toBe(false);
  });

  it("accepts only a non-empty strict API error envelope", () => {
    expect(ErrorResponseSchema.parse({ error: "Invalid request" })).toEqual({ error: "Invalid request" });
    expect(ErrorResponseSchema.parse({ error: "Invalid request", code: "invalid_request" }))
      .toEqual({ error: "Invalid request", code: "invalid_request" });
    expect(ErrorResponseSchema.safeParse({ error: "", detail: "extra" }).success).toBe(false);
  });
});
