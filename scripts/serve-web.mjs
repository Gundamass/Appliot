import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"]
]);

function assertLoopbackHost(host) {
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("Web host must use a loopback listener.");
  }
}

function parseApiOrigin(value) {
  const origin = new URL(value);
  if (origin.protocol !== "http:" || (origin.hostname !== "127.0.0.1" && origin.hostname !== "localhost" && origin.hostname !== "[::1]")) {
    throw new Error("API origin must use loopback HTTP.");
  }
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("API origin must be a bare loopback origin.");
  }
  return origin;
}

function safeStaticPath(distRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || decoded.split(/[\\/]/u).includes("..")) return undefined;
  const candidate = resolve(distRoot, `.${decoded}`);
  const child = relative(distRoot, candidate);
  if (child.startsWith(`..${sep}`) || child === ".." || isAbsolute(child)) return undefined;
  return candidate;
}

function hasTraversalSegment(rawUrl) {
  const rawPath = rawUrl.split("?", 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return true;
  }
  return decoded.includes("\0") || decoded.split(/[\\/]/u).includes("..");
}

function sendFile(response, path) {
  response.writeHead(200, {
    "content-type": CONTENT_TYPES.get(extname(path).toLowerCase()) ?? "application/octet-stream",
    "cache-control": path.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
    "x-content-type-options": "nosniff"
  });
  createReadStream(path).pipe(response);
}

function proxyRequest(request, response, apiOrigin) {
  const upstream = new URL(request.url ?? "/", apiOrigin);
  const headers = { ...request.headers, host: apiOrigin.host };
  delete headers.connection;
  const upstreamRequest = httpRequest(upstream, {
    method: request.method,
    headers
  }, (upstreamResponse) => {
    const responseHeaders = { ...upstreamResponse.headers };
    delete responseHeaders.connection;
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    response.flushHeaders();
    upstreamResponse.pipe(response);
  });
  upstreamRequest.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end("API unavailable");
  });
  request.pipe(upstreamRequest);
}

export function createWebServer({ distRoot, apiOrigin, host = "127.0.0.1", port = 5173 }) {
  assertLoopbackHost(host);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Web port is invalid.");
  const root = resolve(distRoot);
  const origin = parseApiOrigin(apiOrigin);

  return createServer((request, response) => {
    if (hasTraversalSegment(request.url ?? "/")) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Invalid path");
      return;
    }
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname === "/api" || requestUrl.pathname.startsWith("/api/")) {
      proxyRequest(request, response, origin);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" });
      response.end();
      return;
    }
    const candidate = safeStaticPath(root, requestUrl.pathname);
    if (candidate === undefined) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Invalid path");
      return;
    }
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      sendFile(response, candidate);
      return;
    }
    const indexPath = resolve(root, "index.html");
    if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      response.end("Web build unavailable");
      return;
    }
    sendFile(response, indexPath);
  });
}

async function main() {
  const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const distRoot = process.env.WEB_DIST_ROOT ? resolve(process.env.WEB_DIST_ROOT) : resolve(projectRoot, "apps/web/dist");
  const apiOrigin = process.env.WEB_API_ORIGIN ?? "http://127.0.0.1:43120";
  const host = process.env.WEB_HOST ?? "127.0.0.1";
  const port = Number(process.env.WEB_PORT ?? "5173");
  const server = createWebServer({ distRoot, apiOrigin, host, port });
  const close = () => server.close((error) => process.exit(error ? 1 : 0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  server.listen(port, host, () => process.stdout.write(`Appliot web listening on http://${host}:${port}\n`));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
