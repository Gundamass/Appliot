import { writeFileSync } from "node:fs";
import { join } from "node:path";

const configuredProfileDir = process.env.RESUME_BROWSER_PROFILE_DIR;
if (!configuredProfileDir) {
  throw new Error("缺少测试 profile 目录");
}
const profileDir: string = configuredProfileDir;

function record(value: string): void {
  writeFileSync(join(profileDir, "worker-exit.txt"), value, "utf8");
}

process.on("SIGTERM", () => {
  record("terminated");
  process.exit(0);
});

process.on("disconnect", () => {
  record("terminated");
  process.exit(0);
});

process.on("message", (message: unknown) => {
  if (!process.send || typeof message !== "object" || message === null || !("requestId" in message)) {
    return;
  }
  process.send({
    requestId: message.requestId,
    response: {
      type: "worker_error",
      code: "STARTUP_FAILED",
      message: "测试启动失败"
    }
  });
  setTimeout(() => {
    record("self-exited");
    process.exit(0);
  }, 500);
});
