import type { FormSnapshot } from "@resume/contracts";
import { describe, expect, it } from "vitest";
import { sanitizeAdapterObservation } from "./observation-sanitizer.js";

const nodeRef = {
  documentId: "document-secret-00000001",
  nodeId: "node-secret-000000000001",
  observedAt: 7
};
const syntheticPhone = ["138", "0013", "8000"].join("");

function snapshot(overrides: Partial<FormSnapshot> = {}): FormSnapshot {
  return {
    id: "snapshot-secret",
    taskId: "task-secret",
    url: "https://jobs.example.test/apply/987?token=secret#private",
    title: "Alice Example application",
    stage: "application_form",
    frameRef: { documentId: nodeRef.documentId, kind: "main" },
    mutationEpoch: nodeRef.observedAt,
    boundaries: [{ kind: "iframe", visible: true, interactive: true, reasonCode: "visible_iframe" }],
    fields: [{
      id: "field-secret",
      label: `Contact ${syntheticPhone} user@example.com`,
      type: "text",
      required: true,
      options: ["Option one", "Option two"],
      currentValue: "Alice Example",
      sectionHint: "basics",
      nodeRef
    }],
    actions: [{
      id: "action-secret",
      text: "Continue",
      class: "intermediate_navigation",
      context: "secret action context",
      nodeRef
    }],
    errors: ["secret validation error"],
    ...overrides
  };
}

describe("sanitizeAdapterObservation", () => {
  it("removes values, node references, URL query data, and common PII", () => {
    const safe = sanitizeAdapterObservation(snapshot(), [
      "work[0].title",
      "basics.name",
      "basics.name",
      "not a profile path"
    ]);
    const serialized = JSON.stringify(safe);

    for (const forbidden of [
      "Alice Example",
      syntheticPhone,
      "user@example.com",
      "secret",
      "document-secret",
      "node-secret",
      "snapshot-secret",
      "task-secret",
      "Option one"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(safe.origin).toBe("https://jobs.example.test");
    expect(safe.pathShape).not.toMatch(/[?#]/u);
    expect(safe.pathShape).not.toContain("987");
    expect(safe.fields).toEqual([{
      observedFieldId: "field-1",
      label: "Contact [redacted-phone] [redacted-email]",
      type: "text",
      required: true,
      optionCount: 2,
      section: "basics"
    }]);
    expect(safe.actions).toEqual([{
      observedActionId: "action-1",
      text: "Continue",
      actionClass: "intermediate_navigation"
    }]);
    expect(safe.boundaries).toEqual([{ kind: "iframe", blocked: true }]);
    expect(safe.profilePaths).toEqual(["basics.name", "work[0].title"]);
  });

  it("uses a stable fingerprint for the same structural page", () => {
    const first = sanitizeAdapterObservation(snapshot(), ["basics.name"]);
    const second = sanitizeAdapterObservation(snapshot({
      id: "snapshot-other",
      taskId: "task-other",
      url: "https://jobs.example.test/apply/456?another=private",
      fields: [{
        ...snapshot().fields[0]!,
        currentValue: "Different candidate value",
        nodeRef: { ...nodeRef, documentId: "document-other-00000002", nodeId: "node-other-000000000002" }
      }],
      actions: [{
        ...snapshot().actions[0]!,
        nodeRef: { ...nodeRef, documentId: "document-other-00000002", nodeId: "node-other-000000000002" }
      }]
    }), ["basics.name"]);

    expect(first.pageFingerprintHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.pageFingerprintHash).toBe(first.pageFingerprintHash);
  });

  it("redacts credential-shaped text from an untrusted page label", () => {
    const safe = sanitizeAdapterObservation(snapshot({
      fields: [{
        ...snapshot().fields[0]!,
        label: ["Authorization:", "Bearer", "secret-token-value"].join(" ")
      }]
    }), ["basics.name"]);

    expect(JSON.stringify(safe)).not.toContain("secret-token-value");
  });
});
