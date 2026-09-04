import { defineConfig } from "@playwright/test";

export function browserLaunchOptions(executablePath: string | undefined) {
  return executablePath
    ? { launchOptions: { executablePath } }
    : {};
}

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
    ...browserLaunchOptions(process.env.RESUME_BROWSER_EXECUTABLE)
  }
});
