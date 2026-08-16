import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyHttpStatus,
  classifyPageChallenge
} from "./challenge-detector.js";
import { BrowserSessionManager } from "./session-manager.js";

describe("challenge classification", () => {
  it("maps only blocking main-document HTTP statuses", () => {
    expect(classifyHttpStatus(403)).toBe("access_denied");
    expect(classifyHttpStatus(429)).toBe("rate_limited");
    expect(classifyHttpStatus(200)).toBeUndefined();
  });

  it("classifies finite Moka and DJI page signals", () => {
    expect(classifyPageChallenge({
      url: "https://app.mokahr.com/apply/123",
      title: "Application",
      accessibleNames: ["\u8bf7\u5b8c\u6210\u9a8c\u8bc1\u7801"]
    })).toEqual({ kind: "captcha", reasonCode: "moka_captcha_accessible_name" });
    expect(classifyPageChallenge({
      url: "https://apply.careers.dji.com/device-verification",
      title: "\u8bbe\u5907\u9a8c\u8bc1",
      accessibleNames: []
    })).toEqual({ kind: "device_verification", reasonCode: "dji_device_verification_title" });
    expect(classifyPageChallenge({
      url: "https://careers.dji.com/risk-control",
      title: "Application",
      accessibleNames: []
    })).toEqual({ kind: "risk_control", reasonCode: "dji_risk_control_path" });
  });

  it("does not trust arbitrary challenge-like text on unknown sites", () => {
    expect(classifyPageChallenge({
      url: "https://jobs.example.test/apply",
      title: "captcha",
      accessibleNames: ["captcha"]
    })).toBeUndefined();
  });
});

describe("DOM boundary inspection", () => {
  it("reports bounded boundary metadata without traversable details", async () => {
    await withPage(`<!doctype html><title>Apply</title>
      <style>
        iframe, open-control, open-static, closed-control { display:block; width:120px; height:40px; }
      </style>
      <iframe title="interactive frame" srcdoc="<button>Continue</button>"></iframe>
      <iframe title="noninteractive frame" style="pointer-events:none" srcdoc="<p>Static</p>"></iframe>
      <iframe title="analytics" style="display:none" srcdoc="<p>Hidden</p>"></iframe>
      <open-control></open-control>
      <open-static></open-static>
      <closed-control role="button" tabindex="0"></closed-control>
      <script>
        customElements.define('open-control', class extends HTMLElement {
          connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<input aria-label="Name">'; }
        });
        customElements.define('open-static', class extends HTMLElement {
          connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<span>Static</span>'; }
        });
        customElements.define('closed-control', class extends HTMLElement {
          connectedCallback() { this.attachShadow({ mode: 'closed' }).innerHTML = '<button>Continue</button>'; }
        });
      </script>`, async (snapshot) => {
      expect(snapshot.boundaries).toEqual([
        { kind: "iframe", visible: true, interactive: true, reasonCode: "visible_interactive_iframe" },
        { kind: "iframe", visible: true, interactive: false, reasonCode: "visible_noninteractive_iframe" },
        { kind: "iframe", visible: false, interactive: false, reasonCode: "hidden_iframe" },
        { kind: "shadow_root", visible: true, interactive: true, reasonCode: "interactive_shadow_root" },
        { kind: "shadow_root", visible: true, interactive: false, reasonCode: "noninteractive_shadow_root" },
        { kind: "closed_shadow_host", visible: true, interactive: true, reasonCode: "interactive_closed_shadow_host" }
      ]);
      expect(snapshot.challenge?.kind).toBe("unsupported_iframe");
      for (const boundary of snapshot.boundaries ?? []) {
        expect(Object.keys(boundary).sort()).toEqual(["interactive", "kind", "reasonCode", "visible"]);
      }
    });
  }, 30_000);
});

async function withPage(
  html: string,
  assertion: (snapshot: Awaited<ReturnType<BrowserSessionManager["observe"]>>) => Promise<void> | void
): Promise<void> {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(html);
  });
  const profileDir = await mkdtemp(join(tmpdir(), "resume-challenge-detector-"));
  const session = new BrowserSessionManager({ profileDir, headless: true });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    await session.start(Buffer.alloc(32, 1).toString("base64url"));
    await session.open("task-challenge", `http://127.0.0.1:${address.port}/apply`);
    await assertion(await session.observe("task-challenge"));
  } finally {
    await session.stop();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(profileDir, { recursive: true, force: true });
  }
}
