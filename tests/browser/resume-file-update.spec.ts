import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ProfileImportUnavailableError } from "../../apps/api/src/profile/import-service.js";
import { createPdf } from "../fixtures/create-pdf.js";
import { createFullStackWebHarness } from "./test-harness.js";

test("仅更新简历文件时保留已有档案事实和版本", async ({ page }) => {
  const harness = await createFullStackWebHarness();
  try {
    await fetch(`${harness.apiOrigin}/api/profile/facts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fieldPath: "basics.name", value: "原有姓名" })
    });
    const originalPdf = await createPdf(["Original resume"]);
    await uploadCurrent(harness.apiOrigin, originalPdf, "old-resume.pdf");
    const beforeFacts = rows(harness, "SELECT * FROM profile_facts ORDER BY id");
    const beforeRevision = harness.profileRepository.currentRevision();

    const updatedPdf = await createPdf(["Updated resume file only"]);
    const updatedPath = join(harness.temporaryRoot, "new-resume.pdf");
    await writeFile(updatedPath, updatedPdf);

    await page.goto(`${harness.webBaseUrl}/?view=profile`);
    await page.getByRole("button", { name: "简历解析", exact: true }).click();
    const panel = page.getByRole("region", { name: "简历更新" });
    await panel.getByLabel("选择 PDF 简历").setInputFiles(updatedPath);
    await panel.getByRole("button", { name: "仅更新简历" }).click();

    await expect(panel.getByRole("status")).toContainText("已有档案资料未改变");
    await expect(panel.getByText("new-resume.pdf")).toBeVisible();
    expect(rows(harness, "SELECT * FROM profile_facts ORDER BY id")).toEqual(beforeFacts);
    expect(harness.profileRepository.currentRevision()).toBe(beforeRevision);
    expect(rows(harness, "SELECT filename, import_status, is_current FROM documents ORDER BY created_at")).toEqual([
      { filename: "old-resume.pdf", import_status: "retained", is_current: 0 },
      { filename: "new-resume.pdf", import_status: "retained", is_current: 1 }
    ]);
  } finally {
    await harness.close();
  }
});

test("解析失败后保留当前文件并可原地重试", async ({ page }) => {
  let extractionCalls = 0;
  const harness = await createFullStackWebHarness({
    async extractPdf(bytes) {
      extractionCalls += 1;
      if (extractionCalls === 1) throw new ProfileImportUnavailableError("fixture unavailable");
      return {
        fingerprint: createHash("sha256").update(bytes).digest("hex"),
        pages: [{ page: 1, text: "Retry Candidate", source: "pdf_text" }]
      };
    },
    async extractFacts(document) {
      return [{
        id: "retry-name",
        fieldPath: "basics.name",
        value: "Retry Candidate",
        status: "extracted",
        confidence: 1,
        scope: "profile",
        evidence: [{ documentId: document.fingerprint, page: 1, text: "Retry Candidate", extraction: "pdf_text" }],
        revision: 1
      }];
    }
  });
  try {
    const pdf = await createPdf(["Retry Candidate"]);
    const pdfPath = join(harness.temporaryRoot, "retry-resume.pdf");
    await writeFile(pdfPath, pdf);

    await page.goto(`${harness.webBaseUrl}/?view=profile`);
    await page.getByRole("button", { name: "简历解析", exact: true }).click();
    const panel = page.getByRole("region", { name: "简历更新" });
    await panel.getByLabel("选择 PDF 简历").setInputFiles(pdfPath);
    await panel.getByRole("button", { name: "更新并解析" }).click();

    await expect(panel.getByRole("alert")).toContainText("简历解析失败");
    await expect(panel.getByText("解析失败，可重试")).toBeVisible();
    expect(rows(harness, "SELECT filename, import_status, is_current FROM documents")).toEqual([
      { filename: "retry-resume.pdf", import_status: "failed", is_current: 1 }
    ]);

    await panel.getByRole("button", { name: "重新解析" }).click();
    await expect(panel.getByRole("status")).toContainText("简历已解析");
    await expect(panel.getByText("已解析", { exact: true })).toBeVisible();
    expect(extractionCalls).toBe(2);
    expect(rows(harness, "SELECT filename, import_status, is_current FROM documents")).toEqual([
      { filename: "retry-resume.pdf", import_status: "completed", is_current: 1 }
    ]);
    expect(harness.profileRepository.listActive()).toEqual([
      expect.objectContaining({ fieldPath: "basics.name", value: "Retry Candidate" })
    ]);
  } finally {
    await harness.close();
  }
});

async function uploadCurrent(apiOrigin: string, bytes: Uint8Array, filename: string): Promise<void> {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(bytes)], { type: "application/pdf" }), filename);
  const response = await fetch(`${apiOrigin}/api/profile/documents/current`, { method: "POST", body: form });
  expect(response.status).toBe(201);
}

function rows(
  harness: Awaited<ReturnType<typeof createFullStackWebHarness>>,
  sql: string
): unknown[] {
  return harness.database.prepare(sql).all();
}
