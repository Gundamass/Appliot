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

test("uses Playwright's matching browser unless an executable is explicit", () => {
  expect(browserLaunchOptions(undefined)).toEqual({});
  expect(browserLaunchOptions("C:\\browsers\\approved.exe")).toEqual({
    launchOptions: { executablePath: "C:\\browsers\\approved.exe" }
  });
});
