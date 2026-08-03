import { BrowserSessionManager } from "./session-manager.js";
import { startIpcServer } from "./ipc-server.js";
import { createUploadDirectoryResolver } from "./file-resolver.js";

const profileDir = process.env.RESUME_BROWSER_PROFILE_DIR;
if (!profileDir) {
  throw new Error("缺少 RESUME_BROWSER_PROFILE_DIR");
}

startIpcServer(new BrowserSessionManager({
  profileDir,
  headless: process.env.RESUME_BROWSER_HEADLESS === "true",
  ...(process.env.RESUME_BROWSER_EXECUTABLE
    ? { executablePath: process.env.RESUME_BROWSER_EXECUTABLE }
    : {}),
  ...(process.env.RESUME_BROWSER_UPLOAD_DIR
    ? { fileResolver: createUploadDirectoryResolver(process.env.RESUME_BROWSER_UPLOAD_DIR) }
    : {})
}));
