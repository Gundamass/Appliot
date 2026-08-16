import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import { BrowserSessionManager } from "./session-manager.js";
import { installDomRuntime, readDomRuntime } from "./dom-runtime.js";

const sessions: Array<{ manager: BrowserSessionManager; profileDir: string }> = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(async ({ manager, profileDir }) => {
    await manager.stop();
    await rm(profileDir, { recursive: true, force: true });
  }));
});

describe("DOM runtime", () => {
  it("installs idempotently, advances relevant mutations, and ignores unrelated text", async () => {
    const page = await createPage("resume-dom-runtime-");
    await page.setContent(`
      <main>
        <p id="unrelated">Status</p>
        <form id="application"></form>
      </main>
    `);

    await installDomRuntime(page);
    const first = await readDomRuntime(page);
    await installDomRuntime(page);
    expect(await readDomRuntime(page)).toEqual(first);

    await page.locator("#application").evaluate((form) => {
      const input = document.createElement("input");
      input.setAttribute("aria-label", "Email");
      form.append(input);
    });
    await expect.poll(async () => (await readDomRuntime(page)).epoch).toBeGreaterThan(first.epoch);
    const afterRelevantMutation = await readDomRuntime(page);

    await page.locator("#unrelated").evaluate((paragraph) => {
      paragraph.textContent = "Still unrelated";
    });
    await page.waitForTimeout(50);
    expect((await readDomRuntime(page)).epoch).toBe(afterRelevantMutation.epoch);
  });

  it("allocates a new document identity after reload", async () => {
    const page = await createPage("resume-dom-reload-");
    await installDomRuntime(page);
    const first = await readDomRuntime(page);

    await page.reload();

    const reloaded = await readDomRuntime(page);
    expect(reloaded.documentId).not.toBe(first.documentId);
    expect(reloaded.epoch).toBe(0);
  });
});

async function createPage(prefix: string): Promise<Page> {
  const profileDir = await mkdtemp(join(tmpdir(), prefix));
  const manager = new BrowserSessionManager({ profileDir, headless: true });
  await manager.start(Buffer.alloc(32, 1).toString("base64url"));
  sessions.push({ manager, profileDir });
  return (manager as unknown as { page: Page }).page;
}
