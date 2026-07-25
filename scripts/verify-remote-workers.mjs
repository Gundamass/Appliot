import assert from "node:assert/strict";
import { readFile as readFileFromDisk } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const QWEN_MODEL = "Qwen/Qwen3-Embedding-8B";
const QWEN_REVISION = "1d8ad4ca9b3dd8059ad90a75d4983776a23d44af";
const OCR_MODEL = "deepseek-ai/DeepSeek-OCR-2";
const OCR_REVISION = "aaa02f3811945a91062062994c5c4a3f4c0af2b0";
const EMBEDDING_DIMENSIONS = 4096;
const REQUEST_TIMEOUT_MS = 180_000;

const fixtureUrl = new URL("../tests/fixtures/resumes/", import.meta.url);

export async function verifyRemoteWorkers({
  env = process.env,
  fetch = globalThis.fetch,
  readFile = readFileFromDisk,
  embeddingFixturePath = fileURLToPath(new URL("embedding-cases.json", fixtureUrl)),
  ocrFixturePath = fileURLToPath(new URL("ocr-anchors.json", fixtureUrl))
} = {}) {
  const config = loadConfig(env);
  const embeddingFixture = await readFixture(embeddingFixturePath, readFile, "embedding");
  const ocrFixture = await readFixture(ocrFixturePath, readFile, "ocr");

  await verifyEmbeddingHealth(config.embedding, fetch);
  await verifyOcrHealth(config.ocr, fetch);

  for (const fixture of embeddingFixture.cases) {
    await verifyEmbeddingCase(config.embedding, fixture, fetch);
  }

  for (const fixture of ocrFixture.cases) {
    await verifyOcrCase(config.ocr, fixture, ocrFixturePath, readFile, fetch);
  }

  return { embeddingCases: embeddingFixture.cases.length, ocrCases: ocrFixture.cases.length };
}

function loadConfig(env) {
  return {
    embedding: {
      baseUrl: requiredUrl(env.EMBEDDING_BASE_URL, "EMBEDDING_BASE_URL"),
      token: requiredValue(env.EMBEDDING_API_TOKEN, "EMBEDDING_API_TOKEN")
    },
    ocr: {
      baseUrl: requiredUrl(env.OCR_BASE_URL, "OCR_BASE_URL"),
      token: requiredValue(env.OCR_API_TOKEN, "OCR_API_TOKEN")
    }
  };
}

function requiredValue(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Missing required environment variable: ${name}.`);
  return value;
}

function requiredUrl(value, name) {
  const url = requiredValue(value, name);
  try {
    const parsed = new URL(url);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
      throw new Error("invalid");
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    throw new Error(`Invalid required environment variable: ${name}.`);
  }
}

async function readFixture(path, readFile, kind) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Unable to read ${kind} fixture.`);
  }
  if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error(`Invalid ${kind} fixture.`);
  }
  for (const entry of parsed.cases) validateFixtureEntry(entry, kind);
  return parsed;
}

function validateFixtureEntry(entry, kind) {
  if (!entry || typeof entry.id !== "string" || !entry.id.startsWith("sanitized-")) {
    throw new Error(`Invalid ${kind} fixture.`);
  }
  if (kind === "embedding") {
    if (typeof entry.query !== "string" || !Array.isArray(entry.facts) || entry.facts.length !== 3) {
      throw new Error("Invalid embedding fixture.");
    }
    const relevantFacts = entry.facts.filter((fact) => fact?.relevant === true);
    if (relevantFacts.length !== 1 || entry.facts.some((fact) => typeof fact?.text !== "string" || fact.text.trim() === "")) {
      throw new Error("Invalid embedding fixture.");
    }
    return;
  }
  if (
    typeof entry.imagePath !== "string" || entry.imagePath.includes("..") || entry.imagePath.startsWith("/")
    || entry.contentType !== "image/png" || !Array.isArray(entry.anchors) || entry.anchors.length === 0
    || entry.anchors.some((anchor) => typeof anchor !== "string" || anchor.trim() === "")
  ) {
    throw new Error("Invalid ocr fixture.");
  }
}

async function verifyEmbeddingHealth(config, fetch) {
  const embedding = await requestJson(`${config.baseUrl}/readyz`, {
    headers: authorization(config.token)
  }, fetch, "embedding readiness");
  assert.equal(embedding.status, "ready", "embedding readiness state");
  assert.equal(embedding.model, QWEN_MODEL, "embedding model identity");
  assert.equal(embedding.modelRevision, QWEN_REVISION, "embedding model revision");
  assert.equal(embedding.dimensions, EMBEDDING_DIMENSIONS, "embedding dimensions");
}

async function verifyOcrHealth(config, fetch) {
  const ocr = await requestJson(`${config.baseUrl}/readyz`, {
    headers: authorization(config.token)
  }, fetch, "ocr readiness");
  assert.equal(ocr.status, "ready", "ocr readiness state");
  assert.equal(ocr.model, OCR_MODEL, "ocr model identity");
  assert.equal(ocr.modelRevision, OCR_REVISION, "ocr model revision");
}

async function verifyEmbeddingCase(config, fixture, fetch) {
  const inputs = [...fixture.facts.map((fact) => fact.text), `Instruct: Retrieve verified resume facts relevant to completing a job application field.\nQuery: ${fixture.query}`];
  const embedding = await requestJson(`${config.baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: { ...authorization(config.token), "Content-Type": "application/json" },
    body: JSON.stringify({ model: QWEN_MODEL, input: inputs })
  }, fetch, "embedding request");
  assert.equal(embedding.model, QWEN_MODEL, "embedding response model identity");
  assert.equal(embedding.modelRevision, QWEN_REVISION, "embedding response model revision");
  assert.equal(embedding.dimensions, EMBEDDING_DIMENSIONS, "embedding response dimensions");
  assert.ok(Array.isArray(embedding.data) && embedding.data.length === inputs.length, "embedding response count");
  assert.ok(embedding.data.every(({ embedding: vector }) => isFiniteUnitVector(vector)), "embedding vectors must be finite 4096-dimensional unit vectors");

  const vectors = [...embedding.data].sort((left, right) => left.index - right.index).map((entry, index) => {
    assert.equal(entry.index, index, "embedding response indexes");
    return entry.embedding;
  });
  const query = vectors.at(-1);
  const scores = vectors.slice(0, -1).map((vector, index) => ({ index, score: dotProduct(query, vector) }));
  const highest = scores.reduce((best, current) => current.score > best.score ? current : best);
  assert.equal(fixture.facts[highest.index].relevant, true, "Chinese relevance ranking");
}

async function verifyOcrCase(config, fixture, fixturePath, readFile, fetch) {
  let image;
  try {
    image = await readFile(resolve(dirname(fixturePath), fixture.imagePath));
  } catch {
    throw new Error("Unable to read sanitized OCR fixture image.");
  }
  if (!(image instanceof Uint8Array) || image.length === 0) throw new Error("Invalid OCR fixture image.");
  const ocr = await requestJson(`${config.baseUrl}/v1/ocr`, {
    method: "POST",
    headers: { ...authorization(config.token), "Content-Type": fixture.contentType },
    body: image
  }, fetch, "ocr request");
  assert.equal(ocr.model, OCR_MODEL, "ocr response model identity");
  assert.equal(ocr.modelRevision, OCR_REVISION, "ocr response model revision");
  assert.ok(typeof ocr.text === "string", "ocr response text");
  assert.ok(fixture.anchors.every((anchor) => ocr.text.includes(anchor)), "OCR mandatory anchors");
}

function authorization(token) {
  return { Authorization: `Bearer ${token}` };
}

async function requestJson(url, options, fetch, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetch(url, { ...options, signal: controller.signal });
    } catch {
      throw new Error(`${label} failed.`);
    }
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
    try {
      return await response.json();
    } catch {
      throw new Error(`${label} returned invalid JSON.`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function isFiniteUnitVector(vector) {
  return Array.isArray(vector)
    && vector.length === EMBEDDING_DIMENSIONS
    && vector.every(Number.isFinite)
    && Math.abs(Math.sqrt(vector.reduce((sum, value) => sum + value ** 2, 0)) - 1) <= 1e-3;
}

function dotProduct(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyRemoteWorkers().then((result) => {
    console.log(`Remote worker verification passed: ${result.embeddingCases} embedding cases, ${result.ocrCases} OCR cases.`);
  }).catch((error) => {
    console.error(`Remote worker verification failed: ${error instanceof Error ? error.message : "unexpected error"}`);
    process.exitCode = 1;
  });
}
