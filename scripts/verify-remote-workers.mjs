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

class VerificationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "VerificationError";
  }
}

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
  for (const fixture of embeddingFixture.cases) await verifyEmbeddingCase(config.embedding, fixture, fetch);
  for (const fixture of ocrFixture.cases) await verifyOcrCase(config.ocr, fixture, ocrFixturePath, readFile, fetch);

  return { embeddingCases: embeddingFixture.cases.length, ocrCases: ocrFixture.cases.length };
}

export async function runRemoteWorkerVerifier({
  verify = verifyRemoteWorkers,
  writeError = (line) => console.error(line),
  writeSuccess = (line) => console.log(line)
} = {}) {
  try {
    await verify();
    writeSuccess("Remote worker verification passed.");
    return 0;
  } catch {
    writeError("Remote worker verification failed: VERIFY_FAILED");
    return 1;
  }
}

function loadConfig(env) {
  return {
    embedding: {
      baseUrl: requiredBaseUrl(env.EMBEDDING_BASE_URL, "http://127.0.0.1:18080", "VERIFY_CONFIG_EMBEDDING_URL"),
      token: requiredValue(env.EMBEDDING_API_TOKEN, "VERIFY_CONFIG_EMBEDDING_TOKEN")
    },
    ocr: {
      baseUrl: requiredBaseUrl(env.OCR_BASE_URL, "http://127.0.0.1:43121", "VERIFY_CONFIG_OCR_URL"),
      token: requiredValue(env.OCR_API_TOKEN, "VERIFY_CONFIG_OCR_TOKEN")
    }
  };
}

function requiredValue(value, code) {
  if (typeof value !== "string" || value.trim() === "") fail(code);
  return value;
}

function requiredBaseUrl(value, expected, code) {
  if (typeof value !== "string") fail(code);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(code);
  }
  if (
    parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.port !== new URL(expected).port
    || parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/"
    || parsed.search !== "" || parsed.hash !== "" || (value !== expected && value !== `${expected}/`)
  ) {
    fail(code);
  }
  return expected;
}

async function readFixture(path, readFile, kind) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail(kind === "embedding" ? "VERIFY_EMBEDDING_FIXTURE" : "VERIFY_OCR_FIXTURE");
  }
  if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    fail(kind === "embedding" ? "VERIFY_EMBEDDING_FIXTURE" : "VERIFY_OCR_FIXTURE");
  }
  for (const entry of parsed.cases) validateFixtureEntry(entry, kind);
  return parsed;
}

function validateFixtureEntry(entry, kind) {
  const code = kind === "embedding" ? "VERIFY_EMBEDDING_FIXTURE" : "VERIFY_OCR_FIXTURE";
  if (!entry || typeof entry.id !== "string" || !entry.id.startsWith("sanitized-")) fail(code);
  if (kind === "embedding") {
    if (typeof entry.query !== "string" || !Array.isArray(entry.facts) || entry.facts.length !== 3) fail(code);
    if (
      entry.facts.filter((fact) => fact?.relevant === true).length !== 1
      || entry.facts.filter((fact) => fact?.relevant === false).length !== 2
      || entry.facts.some((fact) => typeof fact?.text !== "string" || fact.text.trim() === "")
    ) fail(code);
    return;
  }
  if (
    typeof entry.imagePath !== "string" || entry.imagePath.includes("..") || entry.imagePath.startsWith("/")
    || entry.contentType !== "image/png" || !Array.isArray(entry.anchors) || entry.anchors.length === 0
    || entry.anchors.some((anchor) => typeof anchor !== "string" || anchor.trim() === "")
  ) fail(code);
}

async function verifyEmbeddingHealth(config, fetch) {
  const payload = await requestJson(`${config.baseUrl}/readyz`, { headers: authorization(config.token) }, fetch, "VERIFY_EMBEDDING_READY");
  if (!isRecord(payload) || payload.status !== "ready" || payload.model !== QWEN_MODEL || payload.modelRevision !== QWEN_REVISION || payload.dimensions !== EMBEDDING_DIMENSIONS) {
    fail("VERIFY_EMBEDDING_READY");
  }
}

async function verifyOcrHealth(config, fetch) {
  const payload = await requestJson(`${config.baseUrl}/readyz`, { headers: authorization(config.token) }, fetch, "VERIFY_OCR_READY");
  if (!isRecord(payload) || payload.status !== "ready" || payload.model !== OCR_MODEL || payload.modelRevision !== OCR_REVISION) {
    fail("VERIFY_OCR_READY");
  }
}

async function verifyEmbeddingCase(config, fixture, fetch) {
  const inputs = [...fixture.facts.map((fact) => fact.text), `Instruct: Retrieve verified resume facts relevant to completing a job application field.\nQuery: ${fixture.query}`];
  const payload = await requestJson(`${config.baseUrl}/v1/embeddings`, {
    method: "POST", headers: { ...authorization(config.token), "Content-Type": "application/json" },
    body: JSON.stringify({ model: QWEN_MODEL, input: inputs })
  }, fetch, "VERIFY_EMBEDDING_RESPONSE");
  if (
    !isRecord(payload) || payload.model !== QWEN_MODEL || payload.modelRevision !== QWEN_REVISION
    || payload.dimensions !== EMBEDDING_DIMENSIONS || !Array.isArray(payload.data) || payload.data.length !== inputs.length
    || !payload.data.every((entry) => isRecord(entry) && isFiniteUnitVector(entry.embedding))
  ) fail("VERIFY_EMBEDDING_RESPONSE");

  const entries = [...payload.data].sort((left, right) => left.index - right.index);
  if (entries.some((entry, index) => entry.index !== index)) fail("VERIFY_EMBEDDING_RESPONSE");
  const query = entries.at(-1).embedding;
  const relevantIndex = fixture.facts.findIndex((fact) => fact.relevant);
  const relevantScore = dotProduct(query, entries[relevantIndex].embedding);
  if (!fixture.facts.every((fact, index) => fact.relevant || relevantScore > dotProduct(query, entries[index].embedding))) {
    fail("VERIFY_EMBEDDING_RANKING");
  }
}

async function verifyOcrCase(config, fixture, fixturePath, readFile, fetch) {
  let image;
  try {
    image = await readFile(resolve(dirname(fixturePath), fixture.imagePath));
  } catch {
    fail("VERIFY_OCR_FIXTURE_IMAGE");
  }
  if (!(image instanceof Uint8Array) || image.length === 0) fail("VERIFY_OCR_FIXTURE_IMAGE");
  const payload = await requestJson(`${config.baseUrl}/v1/ocr`, {
    method: "POST", headers: { ...authorization(config.token), "Content-Type": fixture.contentType }, body: image
  }, fetch, "VERIFY_OCR_RESPONSE");
  if (
    !isRecord(payload) || payload.model !== OCR_MODEL || payload.modelRevision !== OCR_REVISION
    || typeof payload.text !== "string"
  ) fail("VERIFY_OCR_RESPONSE");
  if (!fixture.anchors.every((anchor) => payload.text.includes(anchor))) fail("VERIFY_OCR_ANCHORS");
}

function authorization(token) {
  return { Authorization: `Bearer ${token}` };
}

async function requestJson(url, options, fetch, code) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetch(url, { ...options, signal: controller.signal });
    } catch {
      fail(code);
    }
    if (!response?.ok) fail(code);
    try {
      return await response.json();
    } catch {
      fail(code);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteUnitVector(vector) {
  return Array.isArray(vector) && vector.length === EMBEDDING_DIMENSIONS && vector.every(Number.isFinite)
    && Math.abs(Math.sqrt(vector.reduce((sum, value) => sum + value ** 2, 0)) - 1) <= 1e-3;
}

function dotProduct(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function fail(code) {
  throw new VerificationError(code);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const exitCode = await runRemoteWorkerVerifier();
  if (exitCode !== 0) process.exitCode = exitCode;
}
