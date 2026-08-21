import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FormSnapshot, NodeRef } from "@resume/contracts";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { installDomRuntime, readDomRuntime } from "./dom-runtime.js";
import { NodeRegistry, PreparedNode } from "./node-registry.js";
import { BrowserSessionManager } from "./session-manager.js";

const sessions: Array<{ manager: BrowserSessionManager; profileDir: string }> = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(async ({ manager, profileDir }) => {
    await manager.stop();
    await rm(profileDir, { recursive: true, force: true });
  }));
});

describe("NodeRegistry", () => {
  it("rejects an old epoch after a control is inserted before the captured node", async () => {
    const page = await createPage("resume-node-insert-");
    await page.setContent(`<form><input id="target" aria-label="Target" value="kept"></form>`);
    await installDomRuntime(page);
    const ref = await nodeRef(page, "#target");
    const registry = await NodeRegistry.capture(snapshot(ref), page, {
      fields: [page.locator("#target")],
      actions: []
    });

    await page.locator("#target").evaluate((target) => {
      const inserted = document.createElement("input");
      inserted.id = "inserted";
      inserted.setAttribute("aria-label", "Inserted");
      target.before(inserted);
    });
    await expect.poll(async () => (await readDomRuntime(page)).epoch).toBeGreaterThan(ref.observedAt);

    await expect(registry.prepare(ref, ref.observedAt, "field"))
      .rejects.toMatchObject({ code: "stale_node_ref" });
    expect(await page.locator("#target").inputValue()).toBe("kept");
    expect(await page.locator("#inserted").inputValue()).toBe("");
    await registry.release();
  });

  it("never binds an identical replacement at the same DOM index", async () => {
    const page = await createPage("resume-node-replace-");
    await page.setContent(`<form><input id="target" aria-label="Target" value="original"></form>`);
    await installDomRuntime(page);
    const ref = await nodeRef(page, "#target");
    const registry = await NodeRegistry.capture(snapshot(ref), page, {
      fields: [page.locator("#target")],
      actions: []
    });

    await page.locator("#target").evaluate((target) => {
      const replacement = document.createElement("input");
      replacement.id = "target";
      replacement.setAttribute("aria-label", "Target");
      target.replaceWith(replacement);
    });

    await expect(registry.prepare(ref, ref.observedAt, "field"))
      .rejects.toMatchObject({ code: "stale_node_ref" });
    expect(await page.locator("#target").inputValue()).toBe("");
    await registry.release();
  });

  it("reports a captured control whose role changes", async () => {
    const page = await createPage("resume-node-role-");
    await page.setContent(`<form><input id="target" aria-label="Target"></form>`);
    await installDomRuntime(page);
    const ref = await nodeRef(page, "#target");
    const registry = await NodeRegistry.capture(snapshot(ref), page, {
      fields: [page.locator("#target")],
      actions: []
    });

    await page.locator("#target").evaluate((target) => target.setAttribute("type", "submit"));

    await expect(registry.prepare(ref, ref.observedAt, "field"))
      .rejects.toMatchObject({ code: "node_role_changed" });
    await registry.release();
  });

  it("waits for a local stable window and reads through the captured handle", async () => {
    const page = await createPage("resume-node-readback-");
    await page.setContent(`<form><input id="target" aria-label="Target" value="original"></form>`);
    await installDomRuntime(page);
    const ref = await nodeRef(page, "#target");
    const registry = await NodeRegistry.capture(snapshot(ref), page, {
      fields: [page.locator("#target")],
      actions: []
    });
    const prepared = await registry.prepare(ref, ref.observedAt, "field");

    await prepared.fill("kept");
    await prepared.waitForStableWindow(20, 200, () => true);
    expect(await prepared.readValue()).toBe("kept");

    await page.locator("#target").evaluate((target) => target.remove());
    await expect(prepared.readValue()).rejects.toMatchObject({ code: "stale_node_ref" });
    await registry.release();
  });

  it("returns control_unstable when every stability read observes a mutation", async () => {
    const prepared = continuouslyMutatingNode();

    await expect(prepared.waitForStableWindow(30, 100, () => true))
      .rejects.toMatchObject({ code: "control_unstable" });
  });

  it("returns execution_invalidated before waiting", async () => {
    const page = await createPage("resume-node-unstable-");
    await page.setContent(`<form><input id="target" aria-label="Target"></form>`);
    await installDomRuntime(page);
    const ref = await nodeRef(page, "#target");
    const registry = await NodeRegistry.capture(snapshot(ref), page, {
      fields: [page.locator("#target")],
      actions: []
    });
    const prepared = await registry.prepare(ref, ref.observedAt, "field");

    await expect(prepared.waitForStableWindow(30, 100, () => false))
      .rejects.toMatchObject({ code: "execution_invalidated" });
    await registry.release();
  });
});

function snapshot(ref: NodeRef): FormSnapshot {
  return {
    id: "snapshot-1",
    taskId: "task-1",
    url: "https://example.test/apply",
    title: "Application",
    stage: "application_form",
    frameRef: { documentId: ref.documentId, kind: "main" },
    mutationEpoch: ref.observedAt,
    fields: [{
      id: "field-target",
      label: "Target",
      type: "text",
      required: false,
      options: [],
      currentValue: "",
      nodeRef: ref
    }],
    actions: [],
    errors: []
  };
}

async function nodeRef(page: Page, selector: string): Promise<NodeRef> {
  const runtime = await readDomRuntime(page);
  const nodeId = await page.locator(selector).evaluate((element) =>
    (window as unknown as {
      __resumeDomRuntime: { nodeId(target: Element): string };
    }).__resumeDomRuntime.nodeId(element));
  return { documentId: runtime.documentId, nodeId, observedAt: runtime.epoch };
}

async function createPage(prefix: string): Promise<Page> {
  const profileDir = await mkdtemp(join(tmpdir(), prefix));
  const manager = new BrowserSessionManager({ profileDir, headless: true });
  await manager.start(Buffer.alloc(32, 1).toString("base64url"));
  sessions.push({ manager, profileDir });
  return (manager as unknown as { page: Page }).page;
}

function continuouslyMutatingNode(): PreparedNode {
  const ref: NodeRef = { documentId: "document-1", nodeId: "node-1", observedAt: 0 };
  return new PreparedNode(
    {
      waitForTimeout: async (milliseconds: number) => new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(milliseconds, 5));
      })
    } as Page,
    {
      evaluate: async () => ({
        connected: true,
        documentId: ref.documentId,
        nodeId: ref.nodeId,
        roleMatches: true,
        lastRelevantMutationAt: Date.now(),
        value: undefined
      })
    } as never,
    ref,
    "field"
  );
}
