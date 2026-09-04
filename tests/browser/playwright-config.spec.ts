import { expect, test } from "@playwright/test";
import config, { browserLaunchOptions } from "../../playwright.config.js";

test("stores Playwright artifacts outside the API test-results directory", () => {
  expect(config.outputDir).toBe("playwright-artifacts");
});

test("retains browser diagnostics for failed application flows", () => {
  expect(config.use).toMatchObject({
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure"
  });
});

test("prefers an explicit executable and otherwise uses an installed Playwright Chromium", () => {
  const playwrightExecutable = "C:\\playwright\\chromium.exe";
  const pathExists = (candidate: string) => candidate === playwrightExecutable;

  expect(browserLaunchOptions(undefined, playwrightExecutable, pathExists)).toEqual({
    launchOptions: { executablePath: playwrightExecutable }
  });
  expect(browserLaunchOptions("C:\\browsers\\approved.exe", playwrightExecutable, pathExists)).toEqual({
    launchOptions: { executablePath: "C:\\browsers\\approved.exe" }
  });
  expect(browserLaunchOptions(undefined, playwrightExecutable, () => false)).toEqual({});
});
