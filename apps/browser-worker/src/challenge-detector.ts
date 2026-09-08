import type {
  ChallengeDiagnostic,
  ChallengeKind,
  DomBoundary
} from "@resume/contracts";
import type { Page, Response } from "playwright-core";

const MAX_BOUNDARIES = 50;
const MAX_ACCESSIBLE_NAMES = 50;
const MAX_SIGNAL_LENGTH = 256;

const CHALLENGE_INSPECTION_SCRIPT = String.raw`(() => {
  const normalized = (value) => (value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const visible = (element) => {
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0
      && style.display !== "none"
      && style.visibility !== "hidden"
      && style.visibility !== "collapse"
      && style.opacity !== "0";
  };
  const hostInteractive = (element) => {
    const role = normalized(element.getAttribute("role")).toLocaleLowerCase();
    const tabindex = element.getAttribute("tabindex");
    return !element.hasAttribute("inert")
      && element.getAttribute("aria-hidden")?.toLocaleLowerCase() !== "true"
      && getComputedStyle(element).pointerEvents !== "none"
      && (role === "button" || role === "link" || role === "textbox" || role === "combobox"
        || tabindex !== null && Number(tabindex) >= 0);
  };
  const interactiveSelector = "input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), a[href], [role=button], [role=link], [role=textbox], [role=combobox], [tabindex]";
  const boundaries = [];
  for (const frame of document.querySelectorAll("iframe")) {
    const style = getComputedStyle(frame);
    const source = frame.getAttribute("src")?.trim() ?? "";
    const isDecorativeMeasurementFrame = (source === "" || source === "about:blank")
      && style.position === "absolute"
      && style.zIndex === "-1"
      && !frame.hasAttribute("title")
      && !frame.hasAttribute("aria-label")
      && !frame.hasAttribute("tabindex");
    const isVisible = visible(frame) && !isDecorativeMeasurementFrame;
    boundaries.push({
      kind: "iframe",
      visible: isVisible,
      interactive: isVisible
        && !frame.hasAttribute("inert")
        && frame.getAttribute("aria-hidden")?.toLocaleLowerCase() !== "true"
        && getComputedStyle(frame).pointerEvents !== "none"
    });
  }
  for (const host of document.querySelectorAll("*")) {
    if (boundaries.length >= ${MAX_BOUNDARIES}) break;
    const isVisible = visible(host);
    if (host.shadowRoot) {
      boundaries.push({
        kind: "shadow_root",
        visible: isVisible,
        interactive: isVisible && host.shadowRoot.querySelector(interactiveSelector) !== null
      });
      continue;
    }
    if (host.tagName.includes("-") && isVisible && hostInteractive(host)) {
      boundaries.push({ kind: "closed_shadow_host", visible: true, interactive: true });
    }
  }
  const accessibleNames = [...document.querySelectorAll(
    "[role=alert], [role=heading], h1, h2, button, [aria-label]"
  )].map((element) => normalized(
    element.getAttribute("aria-label") || element.textContent
  )).filter(Boolean).slice(0, ${MAX_ACCESSIBLE_NAMES})
    .map((value) => value.slice(0, ${MAX_SIGNAL_LENGTH}));
  return { boundaries: boundaries.slice(0, ${MAX_BOUNDARIES}), accessibleNames };
})()`;

interface PageChallengeSignals {
  url: string;
  title: string;
  accessibleNames: string[];
}

interface ClassifiedPageChallenge {
  kind: ChallengeKind;
  reasonCode: string;
}

interface RawBoundary {
  kind: "iframe" | "shadow_root" | "closed_shadow_host";
  visible: boolean;
  interactive: boolean;
}

interface RawInspection {
  boundaries: RawBoundary[];
  accessibleNames: string[];
}

export interface ChallengeInspection {
  boundaries: DomBoundary[];
  challenge?: ChallengeDiagnostic;
}

export function classifyHttpStatus(status: number): ChallengeKind | undefined {
  if (status === 403) return "access_denied";
  if (status === 429) return "rate_limited";
  return undefined;
}

export function classifyPageChallenge(signals: PageChallengeSignals): ClassifiedPageChallenge | undefined {
  let parsed: URL;
  try {
    parsed = new URL(signals.url);
  } catch {
    return undefined;
  }

  const host = parsed.hostname.toLocaleLowerCase();
  const path = parsed.pathname.normalize("NFKC").toLocaleLowerCase();
  const title = normalize(signals.title);
  const names = signals.accessibleNames.map(normalize).filter(Boolean);
  const isMoka = host === "mokahr.com" || host.endsWith(".mokahr.com")
    || host === "moka.com" || host.endsWith(".moka.com");
  const isDji = host === "careers.dji.com" || host.endsWith(".careers.dji.com");
  if (!isMoka && !isDji) return undefined;

  const prefix = isDji ? "dji" : "moka";
  if (/captcha|verify-code|verification-code/u.test(path)) {
    return { kind: "captcha", reasonCode: `${prefix}_captcha_path` };
  }
  if (/captcha|\u9a8c\u8bc1\u7801|\u4eba\u673a\u9a8c\u8bc1/iu.test(title)) {
    return { kind: "captcha", reasonCode: `${prefix}_captcha_title` };
  }
  if (names.some((name) => /captcha|\u9a8c\u8bc1\u7801|\u4eba\u673a\u9a8c\u8bc1/iu.test(name))) {
    return { kind: "captcha", reasonCode: `${prefix}_captcha_accessible_name` };
  }
  if (/device verification|\u8bbe\u5907\u9a8c\u8bc1/iu.test(title)) {
    return { kind: "device_verification", reasonCode: `${prefix}_device_verification_title` };
  }
  if (/device-verification|device-verify/u.test(path)) {
    return { kind: "device_verification", reasonCode: `${prefix}_device_verification_path` };
  }
  if (names.some((name) => /device verification|\u8bbe\u5907\u9a8c\u8bc1/iu.test(name))) {
    return { kind: "device_verification", reasonCode: `${prefix}_device_verification_accessible_name` };
  }
  if (/risk-control|security-verification/u.test(path)) {
    return { kind: "risk_control", reasonCode: `${prefix}_risk_control_path` };
  }
  if (/risk control|security verification|\u98ce\u9669\u63a7\u5236|\u5b89\u5168\u9a8c\u8bc1/iu.test(title)) {
    return { kind: "risk_control", reasonCode: `${prefix}_risk_control_title` };
  }
  if (names.some((name) => /risk control|security verification|\u98ce\u9669\u63a7\u5236|\u5b89\u5168\u9a8c\u8bc1/iu.test(name))) {
    return { kind: "risk_control", reasonCode: `${prefix}_risk_control_accessible_name` };
  }
  if (/access-denied|forbidden/u.test(path)
    || /access denied|forbidden|\u62d2\u7edd\u8bbf\u95ee/iu.test(title)) {
    return { kind: "access_denied", reasonCode: `${prefix}_access_denied_page` };
  }
  return undefined;
}

export class ChallengeDetector {
  private page: Page | undefined;
  private latestMainDocumentStatus: number | undefined;
  private readonly onResponse = (response: Response): void => {
    const page = this.page;
    if (!page) return;
    const request = response.request();
    if (request.isNavigationRequest() && response.frame() === page.mainFrame()) {
      this.latestMainDocumentStatus = response.status();
    }
  };

  start(page: Page): void {
    this.dispose();
    this.page = page;
    page.on("response", this.onResponse);
  }

  async inspect(): Promise<ChallengeInspection> {
    const page = this.page;
    if (!page) throw new Error("challenge_detector_not_started");
    const raw = await page.evaluate<RawInspection>(CHALLENGE_INSPECTION_SCRIPT);
    const boundaries = raw.boundaries.slice(0, MAX_BOUNDARIES).map(toDomBoundary);
    const httpKind = this.latestMainDocumentStatus === undefined
      ? undefined
      : classifyHttpStatus(this.latestMainDocumentStatus);
    const pageChallenge = classifyPageChallenge({
      url: page.url(),
      title: await page.title(),
      accessibleNames: raw.accessibleNames
        .slice(0, MAX_ACCESSIBLE_NAMES)
        .map((value) => value.slice(0, MAX_SIGNAL_LENGTH))
    });
    const boundaryChallenge = challengeForBoundaries(boundaries);
    const classified = httpKind
      ? { kind: httpKind, reasonCode: `main_document_http_${this.latestMainDocumentStatus}` }
      : pageChallenge ?? boundaryChallenge;
    return {
      boundaries,
      ...(classified ? {
        challenge: {
          ...classified,
          detectedAt: new Date().toISOString()
        }
      } : {})
    };
  }

  dispose(): void {
    this.page?.off("response", this.onResponse);
    this.page = undefined;
    this.latestMainDocumentStatus = undefined;
  }
}

function toDomBoundary(boundary: RawBoundary): DomBoundary {
  const reasonCode = boundary.kind === "iframe"
    ? boundary.visible
      ? boundary.interactive ? "visible_interactive_iframe" : "visible_noninteractive_iframe"
      : "hidden_iframe"
    : boundary.kind === "shadow_root"
      ? boundary.interactive ? "interactive_shadow_root" : "noninteractive_shadow_root"
      : "interactive_closed_shadow_host";
  return { ...boundary, reasonCode };
}

function challengeForBoundaries(boundaries: DomBoundary[]): ClassifiedPageChallenge | undefined {
  if (boundaries.some((boundary) => boundary.kind === "iframe" && boundary.visible)) {
    return { kind: "unsupported_iframe", reasonCode: "visible_iframe_boundary" };
  }
  if (boundaries.some((boundary) => boundary.kind !== "iframe" && boundary.visible && boundary.interactive)) {
    return { kind: "unsupported_shadow_dom", reasonCode: "interactive_shadow_boundary" };
  }
  return undefined;
}

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}
