import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { verifyRemoteWorkers } from "./verify-remote-workers.mjs";

const QWEN_REVISION = "1d8ad4ca9b3dd8059ad90a75d4983776a23d44af";
const OCR_REVISION = "aaa02f3811945a91062062994c5c4a3f4c0af2b0";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+oN7QAAAAAElFTkSuQmCC", "base64");

function environment() {
  return {
    EMBEDDING_BASE_URL: "http://127.0.0.1:18080",
    EMBEDDING_API_TOKEN: "embedding-test-token",
    OCR_BASE_URL: "http://127.0.0.1:43121",
    OCR_API_TOKEN: "ocr-test-token"
  };
}

async function fixtures() {
  const root = await mkdtemp(join(tmpdir(), "remote-worker-verifier-"));
  const embeddingFixturePath = join(root, "embedding-cases.json");
  const ocrFixturePath = join(root, "ocr-anchors.json");
  const imagePath = join(root, "page.png");
  await writeFile(imagePath, PNG);
  await writeFile(embeddingFixturePath, JSON.stringify({
    schemaVersion: 1,
    cases: [{
      id: "sanitized-chinese-relevance",
      query: "候选人是否有 Go 后端经验？",
      facts: [
        { id: "relevant", text: "测试候选人使用 Go 构建合成服务。", relevant: true },
        { id: "unrelated-one", text: "测试候选人喜欢摄影。", relevant: false },
        { id: "unrelated-two", text: "测试候选人学习法语。", relevant: false }
      ]
    }]
  }));
  await writeFile(ocrFixturePath, JSON.stringify({
    schemaVersion: 1,
    cases: [{
      id: "sanitized-page",
      imagePath: "page.png",
      contentType: "image/png",
      anchors: ["Synthetic Anchor"]
    }]
  }));
  return { embeddingFixturePath, ocrFixturePath };
}

function unitVector(index) {
  const vector = Array.from({ length: 4096 }, () => 0);
  vector[index] = 1;
  return vector;
}

function workerFetch() {
  return async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === "/readyz") {
      const embedding = new URL(url).port === "18080";
      return Response.json(embedding
        ? { status: "ready", model: "Qwen/Qwen3-Embedding-8B", modelRevision: QWEN_REVISION, dimensions: 4096 }
        : { status: "ready", model: "deepseek-ai/DeepSeek-OCR-2", modelRevision: OCR_REVISION });
    }
    if (path === "/v1/embeddings") {
      const { input } = JSON.parse(options.body);
      const data = input.map((text, index) => ({
        index,
        embedding: unitVector(text.includes("Go") || text.startsWith("Instruct:") ? 0 : index + 1)
      }));
      return Response.json({
        model: "Qwen/Qwen3-Embedding-8B", modelRevision: QWEN_REVISION, dimensions: 4096, data
      });
    }
    if (path === "/v1/ocr") {
      return Response.json({
        text: "Synthetic Anchor", model: "deepseek-ai/DeepSeek-OCR-2", modelRevision: OCR_REVISION,
        mode: "document_to_markdown", elapsedMs: 1
      });
    }
    throw new Error("Unexpected test request.");
  };
}

test("verifies pinned identities, 4096-dimensional unit embeddings, Chinese ranking, and OCR anchors", async () => {
  const paths = await fixtures();
  const result = await verifyRemoteWorkers({
    env: environment(),
    fetch: workerFetch(),
    readFile,
    ...paths
  });
  assert.deepEqual(result, { embeddingCases: 1, ocrCases: 1 });
});

test("rejects invalid vectors before reporting success", async () => {
  const paths = await fixtures();
  const fetch = workerFetch();
  await assert.rejects(() => verifyRemoteWorkers({
    env: environment(),
    fetch: async (url, options) => {
      const response = await fetch(url, options);
      if (new URL(url).pathname !== "/v1/embeddings") return response;
      const body = await response.json();
      body.data[0].embedding[0] = Number.NaN;
      return Response.json(body);
    },
    readFile,
    ...paths
  }), /embedding vectors/);
});

test("reports missing variables by name without exposing values", async () => {
  const paths = await fixtures();
  const env = environment();
  env.EMBEDDING_API_TOKEN = "very-secret-token";
  delete env.OCR_API_TOKEN;
  await assert.rejects(() => verifyRemoteWorkers({ env, fetch: workerFetch(), readFile, ...paths }), (error) => {
    assert.match(error.message, /OCR_API_TOKEN/);
    assert.doesNotMatch(error.message, /very-secret-token/);
    return true;
  });
});

test("rejects a pinned worker that is not ready", async () => {
  const paths = await fixtures();
  const fetch = workerFetch();
  await assert.rejects(() => verifyRemoteWorkers({
    env: environment(),
    fetch: async (url, options) => {
      const response = await fetch(url, options);
      if (new URL(url).pathname !== "/readyz") return response;
      const body = await response.json();
      body.status = "starting";
      return Response.json(body);
    },
    readFile,
    ...paths
  }), /readiness state/);
});

test("checked-in fixtures remain sanitized and contain all required page categories", async () => {
  const fixturesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../tests/fixtures/resumes");
  const embedding = JSON.parse(await readFile(join(fixturesDirectory, "embedding-cases.json"), "utf8"));
  const ocr = JSON.parse(await readFile(join(fixturesDirectory, "ocr-anchors.json"), "utf8"));
  assert.ok(embedding.cases.every((entry) => entry.id.startsWith("sanitized-") && entry.facts.length === 3));
  assert.deepEqual(ocr.cases.map((entry) => entry.id), [
    "sanitized-chinese-page",
    "sanitized-english-page",
    "sanitized-scanned-page",
    "sanitized-double-column-page"
  ]);
  await Promise.all(ocr.cases.map(async (entry) => {
    const image = await readFile(join(fixturesDirectory, entry.imagePath));
    assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }));
});
