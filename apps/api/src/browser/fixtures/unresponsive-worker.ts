import { writeFileSync } from "node:fs";
import { join } from "node:path";

const profileDir = process.env.RESUME_BROWSER_PROFILE_DIR;
if (!profileDir) {
  throw new Error("缺少测试 profile 目录");
}

function recordExit(): void {
  writeFileSync(join(profileDir!, "worker-exit.txt"), "terminated", "utf8");
}

process.on("SIGTERM", () => {
  recordExit();
  process.exit(0);
});

process.on("disconnect", () => {
  recordExit();
  process.exit(0);
});

process.on("message", (message: unknown) => {
  if (!process.send || typeof message !== "object" || message === null || !("requestId" in message) || !("request" in message)) {
    return;
  }

  const { requestId, request } = message as { requestId: string; request: { type?: string } };
  if (request.type === "handshake") {
    process.send({ requestId, response: { type: "ready" } });
  }
  // Intentionally ignore shutdown to exercise the client's forced termination path.
});
