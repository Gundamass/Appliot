import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CertifiedHintPack, FormSnapshot } from "@resume/contracts";
import { djiHintPack } from "./dji-pack.js";
import { mokahrHintPack } from "./mokahr-pack.js";
import { applyCertifiedHintPack, classifyRepeatedActions } from "./runtime.js";

const nodeRef = {
  documentId: "document-fixture-00000001",
  nodeId: "node-fixture-000000000001",
  observedAt: 7
};

describe("certified hint-pack runtime", () => {
  it("annotates DJI fields with generic certified provenance", () => {
    const result = applyCertifiedHintPack(snapshot("https://apply.careers.dji.com/campus", [{
      label: "毕业院校",
      sectionHint: "education"
    }]), djiHintPack);

    expect(result.fields[0]).toMatchObject({
      semanticHint: "education[0].institution",
      semanticSource: "certified_hint",
      semanticProvenance: {
        packId: "dji-campus",
        packVersion: "1.0.0",
        certification: "certified",
        confidence: 1
      }
    });
  });

  it("does not annotate incompatible sections or non-certified packs", () => {
    const wrongSection = applyCertifiedHintPack(snapshot("https://apply.careers.dji.com/campus", [{
      label: "毕业院校",
      sectionHint: "work"
    }]), djiHintPack);
    const candidate = { ...djiHintPack, lifecycleStatus: "candidate" } as unknown as CertifiedHintPack;
    const candidateResult = applyCertifiedHintPack(snapshot("https://apply.careers.dji.com/campus", [{
      label: "毕业院校",
      sectionHint: "education"
    }]), candidate);

    expect(wrongSection.fields[0]?.semanticSource).toBeUndefined();
    expect(candidateResult.fields[0]?.semanticSource).toBeUndefined();
  });

  it("classifies only certified repeated-entry actions with a matching section heading", () => {
    const result = classifyRepeatedActions({
      ...snapshot("https://app.mokahr.com/apply", []),
      actions: [
        { id: "add-education", text: "添加", class: "safe_edit", context: "教育经历", nodeRef },
        { id: "add-laboratory", text: "新增", class: "safe_edit", context: "实验室经历", nodeRef },
        { id: "submit", text: "提交", class: "terminal_submit", context: "教育经历", nodeRef }
      ]
    }, mokahrHintPack);

    expect(result).toEqual([
      { actionId: "add-education", section: "education" },
      { actionId: "add-laboratory", section: "laboratory" }
    ]);
  });

  it("matches opaque local-pack references for arbitrary labels, headings, and action verbs", () => {
    const pack: CertifiedHintPack = {
      ...djiHintPack,
      packId: "referenced-local",
      match: { ...djiHintPack.match, requiredTextSignals: [], pageFingerprintHashes: [] },
      sectionRules: [{
        section: "work",
        headingAliases: [textReference("Employment History")],
        fieldOrderAliases: [
          [textReference("Work Authorization")],
          [textReference("Preferred First Name")]
        ]
      }],
      fieldRules: [{
        ruleId: "work-authorization",
        profilePath: "basics.name",
        labelAliases: [textReference("Work Authorization")],
        sections: ["work"],
        controlTypes: ["text"],
        confidence: 1
      }],
      actionRules: [{
        kind: "add_repeated_entry",
        verbs: [textReference("Add another employment")],
        sections: ["work"]
      }]
    };
    const observed = {
      ...snapshot("https://jobs.example.test/apply", [{
        label: "Preferred First Name",
        sectionHint: "work"
      }, {
        label: "Work Authorization",
        sectionHint: "work"
      }]),
      actions: [{
        id: "add-employment",
        text: "Add another employment",
        class: "safe_edit" as const,
        context: "Employment History",
        nodeRef
      }]
    };

    const applied = applyCertifiedHintPack(observed, pack);
    expect(applied.fields.map(({ label }) => label)).toEqual([
      "Work Authorization",
      "Preferred First Name"
    ]);
    expect(applied.fields[0]).toMatchObject({
      semanticHint: "basics.name",
      semanticSource: "certified_hint"
    });
    expect(classifyRepeatedActions(observed, pack)).toEqual([
      { actionId: "add-employment", section: "work" }
    ]);
  });

  it("orders fields with plaintext aliases for source-controlled packs", () => {
    const pack: CertifiedHintPack = {
      ...djiHintPack,
      sectionRules: [{
        section: "work",
        headingAliases: ["Employment History"],
        fieldOrderAliases: [["Work Authorization"], ["Preferred First Name"]]
      }],
      fieldRules: [],
      actionRules: []
    };
    const observed = snapshot("https://jobs.example.test/apply", [{
      label: "Preferred First Name",
      sectionHint: "work"
    }, {
      label: "Work Authorization",
      sectionHint: "work"
    }]);

    expect(applyCertifiedHintPack(observed, pack).fields.map(({ label }) => label)).toEqual([
      "Work Authorization",
      "Preferred First Name"
    ]);
  });

  it.each([
    ["plaintext", (value: string) => value],
    ["ATS-reference", textReference]
  ] as const)("orders %s laboratory fields normalized to the campus snapshot section", (_kind, alias) => {
    const pack: CertifiedHintPack = {
      ...djiHintPack,
      sectionRules: [{
        section: "laboratory",
        headingAliases: [alias("实验室经历")],
        fieldOrderAliases: [[alias("实验室名称")], [alias("开始时间")]]
      }],
      fieldRules: [],
      actionRules: []
    };
    const observed = snapshot("https://jobs.example.test/apply", [{
      label: "开始时间",
      sectionHint: "campus"
    }, {
      label: "实验室名称",
      sectionHint: "campus"
    }]);

    expect(applyCertifiedHintPack(observed, pack).fields.map(({ label }) => label)).toEqual([
      "实验室名称",
      "开始时间"
    ]);
  });
});

function textReference(value: string): string {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, "").trim().toLocaleLowerCase();
  const length = [...normalized].length;
  const digest = createHash("sha256").update(`certified-hint-text-v1\0${normalized}`).digest("hex");
  return `ats:sha256:${length}:${digest}`;
}

function snapshot(
  url: string,
  fields: Array<{ label: string; sectionHint: "campus" | "education" | "work" }>
): FormSnapshot {
  return {
    id: "snapshot-runtime",
    taskId: "task-runtime",
    url,
    title: "Certified pack fixture",
    stage: "application_form",
    frameRef: { documentId: nodeRef.documentId, kind: "main" },
    mutationEpoch: nodeRef.observedAt,
    fields: fields.map((field, index) => ({
      id: `field-${index}`,
      label: field.label,
      type: "text" as const,
      required: false,
      options: [],
      currentValue: "",
      sectionHint: field.sectionHint,
      nodeRef
    })),
    actions: [],
    errors: []
  };
}
