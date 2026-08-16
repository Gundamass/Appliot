import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { selectChoiceGroup } from "./control-adapters.js";
import { installDomRuntime, readDomRuntime } from "./dom-runtime.js";
import { PreparedNode } from "./node-registry.js";
import { BrowserSessionManager } from "./session-manager.js";

const sessions: Array<{ manager: BrowserSessionManager; profileDir: string }> = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(async ({ manager, profileDir }) => {
    await manager.stop();
    await rm(profileDir, { recursive: true, force: true });
  }));
});

describe("control adapters", () => {
  it("selects a native radio option from a captured prepared handle", async () => {
    const page = await createPage();
    await page.setContent(`<fieldset>
      <legend>Consent</legend>
      <label><input id="yes" type="radio" name="consent"> Yes</label>
      <label><input id="no" type="radio" name="consent"> No</label>
    </fieldset>`);
    await installDomRuntime(page);
    const runtime = await readDomRuntime(page);
    const handle = await page.locator("#yes").elementHandle();
    if (handle === null) throw new Error("test control missing");
    const nodeId = await handle.evaluate((element) =>
      (window as unknown as {
        __resumeDomRuntime: { nodeId(target: Element): string };
      }).__resumeDomRuntime.nodeId(element));
    const prepared = new PreparedNode(page, handle, {
      documentId: runtime.documentId,
      nodeId,
      observedAt: runtime.epoch
    }, "field");

    await expect(selectChoiceGroup(prepared, "No")).resolves.toBe("No");
    expect(await page.locator("#no").isChecked()).toBe(true);
    await handle.dispose();
  });
});

async function createPage(): Promise<Page> {
  const profileDir = await mkdtemp(join(tmpdir(), "resume-control-adapter-"));
  const manager = new BrowserSessionManager({ profileDir, headless: true });
  await manager.start(Buffer.alloc(32, 1).toString("base64url"));
  sessions.push({ manager, profileDir });
  return (manager as unknown as { page: Page }).page;
}
