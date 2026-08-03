import { defineConfig } from "@playwright/test";

const systemBrowser = process.env.RESUME_BROWSER_EXECUTABLE
  ?? (process.platform === "win32"
    ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
    : undefined);

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  outputDir: "playwright-artifacts",
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    ...(systemBrowser ? { launchOptions: { executablePath: systemBrowser } } : {})
  }
});
