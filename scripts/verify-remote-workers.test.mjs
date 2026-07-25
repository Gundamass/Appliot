import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runRemoteWorkerVerifier, verifyRemoteWorkers } from "./verify-remote-workers.mjs";

const QWEN_REVISION = "1d8ad4ca9b3dd8059ad90a75d4983776a23d44af";
const OCR_REVISION = "aaa02f3811945a91062062994c5c4a3f4c0af2b0";
const RAW_RESUME_SECRET = "RAW_RESUME_SECRET";
const EMBEDDING_TOKEN = "embedding-token-secret";
const OCR_TOKEN = "ocr-token-secret";
const EMBEDDING_URL = "http://127.0.0.1:18080";
const OCR_URL = "http://127.0.0.1:43121";
const fixturesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../tests/fixtures/resumes");

function environment(overrides = {}) {
  return {
    EMBEDDING_BASE_URL: EMBEDDING_URL,
    EMBEDDING_API_TOKEN: EMBEDDING_TOKEN,
    OCR_BASE_URL: OCR_URL,
    OCR_API_TOKEN: OCR_TOKEN,
    ...overrides
  };
}

async function checkedInFixtures() {
  const embeddingFixturePath = join(fixturesDirectory, "embedding-cases.json");
  const ocrFixturePath = join(fixturesDirectory, "ocr-anchors.json");
  const embedding = JSON.parse(await readFile(embeddingFixturePath, "utf8"));
  const ocr = JSON.parse(await readFile(ocrFixturePath, "utf8"));
  const ocrPages = await Promise.all(ocr.cases.map(async (entry) => ({
    ...entry,
    image: await readFile(join(fixturesDirectory, entry.imagePath))
  })));
  return { embeddingFixturePath, ocrFixturePath, embedding, ocr, ocrPages };
}

function unitVector(index) {
  const vector = Array.from({ length: 4096 }, () => 0);
  vector[index] = 1;
  return vector;
}

function sameBytes(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function workerFetch({ embedding, ocrPages, vectorFor = defaultVectorFor, ocrTextFor } = {}) {
  const calls = [];
  const relevantTexts = new Set(embedding.cases.flatMap((entry) => entry.facts)
    .filter((fact) => fact.relevant).map((fact) => fact.text));
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, body: options.body });
    if (parsed.pathname === "/readyz") {
      return Response.json(parsed.port === "18080"
        ? { status: "ready", model: "Qwen/Qwen3-Embedding-8B", modelRevision: QWEN_REVISION, dimensions: 4096 }
        : { status: "ready", model: "deepseek-ai/DeepSeek-OCR-2", modelRevision: OCR_REVISION });
    }
    if (parsed.pathname === "/v1/embeddings") {
      const { input } = JSON.parse(options.body);
      return Response.json({
        model: "Qwen/Qwen3-Embedding-8B",
        modelRevision: QWEN_REVISION,
        dimensions: 4096,
        data: input.map((text, index) => ({
          index,
          embedding: vectorFor({ text, index, relevant: relevantTexts.has(text), query: text.startsWith("Instruct:") })
        }))
      });
    }
    if (parsed.pathname === "/v1/ocr") {
      const image = Buffer.from(options.body);
      const page = ocrPages.find((entry) => sameBytes(entry.image, image));
      if (!page) throw new Error("unexpected local test image");
      return Response.json({
        text: ocrTextFor?.(page) ?? page.anchors.join("\n"),
        model: "deepseek-ai/DeepSeek-OCR-2",
        modelRevision: OCR_REVISION,
        mode: "document_to_markdown",
        elapsedMs: 1
      });
    }
    throw new Error("unexpected local test request");
  };
  return { calls, fetch };
}

function defaultVectorFor({ index, relevant, query }) {
  if (query || relevant) return unitVector(0);
  return unitVector(index + 1);
}

function assertCode(error, code) {
  assert.equal(error?.code, code);
  assert.equal(error?.message, code);
  return true;
}

test("verifies every checked-in OCR page and sends each matching image once", async () => {
  const fixtures = await checkedInFixtures();
  const worker = workerFetch(fixtures);
  const result = await verifyRemoteWorkers({ env: environment(), fetch: worker.fetch, readFile, ...fixtures });
  assert.deepEqual(result, { embeddingCases: fixtures.embedding.cases.length, ocrCases: 4 });
  const ocrCalls = worker.calls.filter((call) => call.path === "/v1/ocr");
  assert.equal(ocrCalls.length, 4);
  for (const page of fixtures.ocrPages) {
    assert.equal(ocrCalls.filter((call) => sameBytes(Buffer.from(call.body), page.image)).length, 1);
  }
});

test("rejects every omitted mandatory OCR anchor with a fixed safe code", async () => {
  const fixtures = await checkedInFixtures();
  for (const page of fixtures.ocrPages) {
    for (let index = 0; index < page.anchors.length; index += 1) {
      const worker = workerFetch({
        ...fixtures,
        ocrTextFor: (entry) => entry === page ? entry.anchors.filter((_, anchorIndex) => anchorIndex !== index).join("\n") : entry.anchors.join("\n")
      });
      await assert.rejects(
        () => verifyRemoteWorkers({ env: environment(), fetch: worker.fetch, readFile, ...fixtures }),
        (error) => assertCode(error, "VERIFY_OCR_ANCHORS")
      );
    }
  }
});

test("rejects a relevance tie instead of selecting fixture order", async () => {
  const fixtures = await checkedInFixtures();
  const worker = workerFetch({ ...fixtures, vectorFor: () => unitVector(0) });
  await assert.rejects(
    () => verifyRemoteWorkers({ env: environment(), fetch: worker.fetch, readFile, ...fixtures }),
    (error) => assertCode(error, "VERIFY_EMBEDDING_RANKING")
  );
});

test("rejects every invalid remote-worker base URL before fetch", async () => {
  const fixtures = await checkedInFixtures();
  const invalidEmbeddingUrls = [
    "http://localhost:18080", "http://[::1]:18080", "https://127.0.0.1:18080",
    "http://127.0.0.1:18081", "http://user:pass@127.0.0.1:18080",
    "http://127.0.0.1:18080?secret", "http://127.0.0.1:18080#secret", "http://example.test:18080"
  ];
  const invalidOcrUrls = invalidEmbeddingUrls.map((url) => url.replace(/18080/g, "43121"));
  for (const url of invalidEmbeddingUrls) {
    let calls = 0;
    await assert.rejects(
      () => verifyRemoteWorkers({ env: environment({ EMBEDDING_BASE_URL: url }), fetch: async () => { calls += 1; }, readFile, ...fixtures }),
      (error) => assertCode(error, "VERIFY_CONFIG_EMBEDDING_URL")
    );
    assert.equal(calls, 0);
  }
  for (const url of invalidOcrUrls) {
    let calls = 0;
    await assert.rejects(
      () => verifyRemoteWorkers({ env: environment({ OCR_BASE_URL: url }), fetch: async () => { calls += 1; }, readFile, ...fixtures }),
      (error) => assertCode(error, "VERIFY_CONFIG_OCR_URL")
    );
    assert.equal(calls, 0);
  }
});

test("CLI output excludes response data, configured URLs, and tokens", async () => {
  const fixtures = await checkedInFixtures();
  const output = [];
  const worker = workerFetch({ ...fixtures });
  const exitCode = await runRemoteWorkerVerifier({
    verify: () => verifyRemoteWorkers({
      env: environment(),
      fetch: async (url, options) => {
        if (new URL(url).pathname !== "/readyz") return worker.fetch(url, options);
        return Response.json({
          status: "ready", model: RAW_RESUME_SECRET, modelRevision: RAW_RESUME_SECRET, dimensions: 4096
        });
      },
      readFile,
      ...fixtures
    }),
    writeError: (line) => output.push(line),
    writeSuccess: (line) => output.push(line)
  });
  const rendered = output.join("\n");
  assert.equal(exitCode, 1);
  assert.equal(rendered, "Remote worker verification failed: VERIFY_FAILED");
  for (const prohibited of [RAW_RESUME_SECRET, EMBEDDING_TOKEN, OCR_TOKEN, EMBEDDING_URL, OCR_URL]) {
    assert.equal(rendered.includes(prohibited), false);
  }
});

test("checked-in fixtures remain sanitized with non-leading relevant facts", async () => {
  const fixtures = await checkedInFixtures();
  assert.ok(fixtures.embedding.cases.every((entry) => entry.id.startsWith("sanitized-") && entry.facts.length === 3));
  assert.ok(fixtures.embedding.cases.every((entry) => entry.facts.findIndex((fact) => fact.relevant) > 0));
  assert.deepEqual(fixtures.ocr.cases.map((entry) => entry.id), [
    "sanitized-chinese-page",
    "sanitized-english-page",
    "sanitized-scanned-page",
    "sanitized-double-column-page"
  ]);
});
