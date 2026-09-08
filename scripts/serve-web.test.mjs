import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWebServer } from "./serve-web.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function rawRequest(origin, path) {
  const url = new URL(origin);
  return await new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: url.hostname, port: url.port, path, method: "GET" }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end();
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "appliot-web-host-"));
  const distRoot = join(root, "dist");
  const assets = join(distRoot, "assets");
  await mkdir(assets, { recursive: true });
  await writeFile(join(distRoot, "index.html"), "<!doctype html><title>Appliot</title><main>profile workspace</main>");
  await writeFile(join(assets, "app.js"), "globalThis.APPLIOT = true;");
  await writeFile(join(root, "outside.txt"), "outside");

  const apiRequests = [];
  const streamingResponses = [];
  const api = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    apiRequests.push({ method: request.method, url: request.url, body });
    if (request.url === "/api/rejected") {
      response.writeHead(422, { "content-type": "application/json", "x-api-result": "rejected" });
      response.end(JSON.stringify({ error: "invalid" }));
      return;
    }
    if (request.url === "/api/events") {
      streamingResponses.push(response);
      response.writeHead(200, {
        "cache-control": "no-cache",
        "content-type": "text/event-stream; charset=utf-8"
      });
      response.flushHeaders();
      return;
    }
    response.writeHead(200, { "content-type": "application/json", "x-api-result": "ok" });
    response.end(JSON.stringify({ method: request.method, url: request.url, body }));
  });
  const apiOrigin = await listen(api);
  const web = createWebServer({ distRoot, apiOrigin, host: "127.0.0.1", port: 0 });
  const webOrigin = await listen(web);

  return {
    root,
    apiRequests,
    api,
    web,
    webOrigin,
    async dispose() {
      for (const response of streamingResponses) response.end();
      await Promise.all([close(web), close(api)]);
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("serves the production index and falls back for SPA routes", async () => {
  const context = await fixture();
  try {
    for (const path of ["/", "/applications/task-1"]) {
      const response = await fetch(`${context.webOrigin}${path}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /^text\/html/u);
      assert.match(await response.text(), /profile workspace/u);
    }
  } finally {
    await context.dispose();
  }
});

test("serves static assets with a stable content type", async () => {
  const context = await fixture();
  try {
    const response = await fetch(`${context.webOrigin}/assets/app.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /javascript/u);
    assert.equal(await response.text(), "globalThis.APPLIOT = true;");
  } finally {
    await context.dispose();
  }
});

test("does not serve files outside the configured dist root", async () => {
  const context = await fixture();
  try {
    for (const path of ["/../outside.txt", "/%2e%2e/outside.txt", "/assets/%2e%2e/outside.txt"]) {
      const response = await rawRequest(context.webOrigin, path);
      assert.ok(response.status === 400 || response.status === 404);
      assert.notEqual(response.body, "outside");
    }
  } finally {
    await context.dispose();
  }
});

test("proxies API methods, bodies, status codes and headers without rewriting", async () => {
  const context = await fixture();
  try {
    const accepted = await fetch(`${context.webOrigin}/api/profile/facts?active=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "Java" })
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("x-api-result"), "ok");
    assert.deepEqual(await accepted.json(), {
      method: "POST",
      url: "/api/profile/facts?active=true",
      body: JSON.stringify({ value: "Java" })
    });

    const rejected = await fetch(`${context.webOrigin}/api/rejected`);
    assert.equal(rejected.status, 422);
    assert.equal(rejected.headers.get("x-api-result"), "rejected");
    assert.deepEqual(await rejected.json(), { error: "invalid" });
    assert.equal(context.apiRequests.length, 2);
  } finally {
    await context.dispose();
  }
});

test("flushes streaming API headers through the production proxy", async () => {
  const context = await fixture();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(`${context.webOrigin}/api/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await context.dispose();
  }
});

test("rejects non-loopback listeners and API origins", async () => {
  assert.throws(() => createWebServer({ distRoot: ".", apiOrigin: "http://127.0.0.1:43120", host: "0.0.0.0", port: 5173 }));
  assert.throws(() => createWebServer({ distRoot: ".", apiOrigin: "https://example.com", host: "127.0.0.1", port: 5173 }));
});
