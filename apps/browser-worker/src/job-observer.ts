import { randomUUID } from "node:crypto";
import {
  JobPageSnapshotSchema,
  type FilterPlan,
  type JobPageSnapshot
} from "@resume/contracts";
import type { Page } from "playwright-core";
import type { ChallengeDetector } from "./challenge-detector.js";

const JOB_OBSERVATION_SCRIPT = String.raw`(() => {
  const normalized = (value) => (value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const visible = (element) => {
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0
      && style.display !== "none"
      && style.visibility !== "hidden"
      && style.visibility !== "collapse"
      && style.opacity !== "0";
  };
  const text = (element) => normalized(element?.textContent).slice(0, 2000);
  const canonical = (value) => {
    try { return new URL(value, location.href).href; } catch { return ""; }
  };
  const isMokahrHost = (hostname) => hostname === "mokahr.com" || hostname.endsWith(".mokahr.com");
  const isCampusApply = (() => {
    try {
      const current = new URL(location.href);
      return isMokahrHost(current.hostname)
        && /^\/campus_apply\/[^/]+\/[^/]+/u.test(current.pathname);
    } catch {
      return false;
    }
  })();
  const isMokahrUrl = (value) => {
    try { return isMokahrHost(new URL(value, location.href).hostname); } catch { return false; }
  };
  const isCampusJobUrl = (value) => {
    try {
      const parsed = new URL(value, location.href);
      return isMokahrHost(parsed.hostname)
        && /^\/campus_apply\/[^/]+\/[^/]+/u.test(parsed.pathname)
        && /#\/jobs\/[^/?#]+/u.test(parsed.hash);
    } catch {
      return false;
    }
  };
  const visibleText = [...document.querySelectorAll("h1, h2, h3, [role=heading], main p, main li")]
    .filter(visible).map(text).filter(Boolean).slice(0, 500);
  const cardSelector = "[data-resume-job-card], [data-job-id], .job-card, [class*=job-card], [class*=position-card], li[class*=job]";
  const campusCardSelector = [
    "[data-job-id]", "[data-position-id]", "[data-recruitment-id]", "[data-job-card]",
    "[class*=job-item]", "[class*=position-item]", "[class*=recruit-item]", "[class*=post-item]"
  ].join(",");
  const seen = new Set();
  const extractCard = (card, requireCampusUrl) => {
    if (!visible(card) || card.parentElement?.closest(cardSelector)) return [];
    const link = card.matches("a[href]") ? card : card.querySelector("a[href]");
    const dataUrl = card.getAttribute("data-detail-url")
      || card.getAttribute("data-job-url")
      || card.getAttribute("data-url")
      || card.getAttribute("data-href");
    const titleElement = card.querySelector("[data-job-title], [data-position-title], [class*=title], [class*=name], h2, h3, [role=heading]") ?? link;
    const title = text(titleElement);
    const url = canonical(link?.getAttribute("href") ?? dataUrl ?? "");
    if (!title || !url || requireCampusUrl && (!isMokahrUrl(url) || !isCampusJobUrl(url)) || seen.has(url)) return [];
    seen.add(url);
    const organization = text(card.querySelector("[data-organization], [data-company], [class*=company], [class*=organization]"))
      || normalized(card.getAttribute("data-organization")) || "Unknown";
    const locationText = text(card.querySelector("[data-location], [data-city], [class*=location], [class*=city]"));
    const summary = text(card.querySelector("[data-summary], [class*=summary], [class*=description]"));
    return [{
      sourceJobId: normalized(card.getAttribute("data-job-id") || card.getAttribute("data-position-id") || card.getAttribute("data-recruitment-id")) || undefined,
      canonicalUrl: url,
      title,
      organization,
      location: locationText || undefined,
      summary: summary || undefined
    }];
  };
  const campusCards = isCampusApply
    ? [...document.querySelectorAll(campusCardSelector)].flatMap((card) => {
      if (!visible(card) || card.parentElement?.closest(campusCardSelector)) return [];
      return extractCard(card, true);
    }).slice(0, 2000)
    : [];
  const genericCards = [...document.querySelectorAll(cardSelector)].flatMap((card) => extractCard(card, false)).slice(0, 2000);
  const jobCards = campusCards.length > 0 ? campusCards : genericCards;
  const campusDetailContainer = isCampusApply
    ? document.querySelector("[data-job-description], [class*=job-description], [class*=position-detail], [class*=job-detail]")
    : null;
  const currentUrl = canonical(location.href);
  const detailId = currentUrl.match(/#\/jobs\/([^/?#]+)/u)?.[1] ?? "";
  const campusDetailCard = campusDetailContainer && detailId && isCampusJobUrl(currentUrl)
    ? [{
      sourceJobId: detailId,
      canonicalUrl: currentUrl,
      title: text(document.querySelector("main h1, h1, [data-job-title], [class*=position-title], [class*=job-title]")),
      organization: text(document.querySelector("[data-organization], [data-company], [class*=company], [class*=organization]")) || "Unknown",
      location: text(document.querySelector("[data-location], [data-city], [class*=location], [class*=city]")) || undefined,
      summary: text(campusDetailContainer) || undefined
    }].filter((card) => card.title)
    : [];
  const filterState = [...document.querySelectorAll("[data-resume-filter-key], [data-filter-key]")]
    .flatMap((container) => {
      const key = normalized(container.getAttribute("data-resume-filter-key") || container.getAttribute("data-filter-key"));
      if (!key) return [];
      const selected = [...container.querySelectorAll("option:checked, input:checked, [aria-selected=true], [aria-checked=true], [data-selected=true]")]
        .map((element) => normalized(element.getAttribute("data-value") || element.getAttribute("value") || element.textContent))
        .filter(Boolean).slice(0, 50);
      return [{ key, values: [...new Set(selected)] }];
    }).slice(0, 100);
  const explicitEntry = normalized(document.body.getAttribute("data-resume-entry") || document.documentElement.getAttribute("data-resume-entry"));
  const hasApplicationForm = Boolean(document.querySelector("form input[type=file], form [name*=resume i], form [name*=candidate i]"));
  const loginText = normalized(document.title + " " + visibleText.slice(0, 20).join(" "));
  const entryHint = ["job_list", "job_detail", "application_form"].includes(explicitEntry)
    ? explicitEntry
    : /登录|sign\s*in|log\s*in/iu.test(loginText) ? "login"
    : hasApplicationForm ? "application_form"
    : jobCards.length > 0 ? "job_list"
    : campusDetailCard.length > 0 ? "job_detail"
    : document.querySelector("[data-job-description], [class*=job-description], [class*=position-detail]") ? "job_detail"
    : "unknown";
  const currentFromUrl = Number(new URL(location.href).searchParams.get("page"));
  const next = document.querySelector("[data-resume-next-cursor], a[rel=next], button[data-next-page]")
    ?? [...document.querySelectorAll("a, button")].find((element) => visible(element)
      && /下一页|next/iu.test(normalized((element.getAttribute("aria-label") ?? "") + " " + text(element)))
      && !element.matches(":disabled, [aria-disabled=true]"));
  const nextCursor = normalized(next?.getAttribute("data-resume-next-cursor") || next?.getAttribute("href"));
  const pagination = {
    kind: Number.isInteger(currentFromUrl) && currentFromUrl >= 0 ? "page" : nextCursor ? "cursor" : "none",
    ...(Number.isInteger(currentFromUrl) && currentFromUrl >= 0 ? { current: currentFromUrl } : {}),
    hasNext: Boolean(next && !next.matches(":disabled, [aria-disabled=true]")),
    ...(nextCursor ? { nextCursor: nextCursor.slice(0, 1024) } : {})
  };
  return { entryHint, visibleText, jobCards, filterState, pagination };
})()`;

const APPLY_FILTERS_SCRIPT = String.raw`(mapped) => {
  const normalized = (value) => (value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const escape = (value) => CSS.escape(value);
  for (const filter of mapped) {
    const container = document.querySelector('[data-resume-filter-key="' + escape(filter.key) + '"], [data-filter-key="' + escape(filter.key) + '"]');
    if (!container) throw new Error("job_filter_control_missing:" + filter.key);
    for (const control of container.querySelectorAll("select, input")) {
      if (control instanceof HTMLSelectElement) {
        const wanted = new Set(filter.values.map(normalized));
        if (control.multiple) {
          for (const option of control.options) option.selected = wanted.has(normalized(option.value || option.textContent));
        } else {
          const option = [...control.options].find((candidate) => wanted.has(normalized(candidate.value || candidate.textContent)));
          if (!option) throw new Error("job_filter_value_missing:" + filter.key);
          control.value = option.value;
        }
        control.dispatchEvent(new Event("change", { bubbles: true }));
        continue;
      }
      if (control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)) {
        const label = normalized(control.value || control.labels?.[0]?.textContent);
        const checked = filter.values.map(normalized).includes(label);
        if (control.checked !== checked) control.click();
      }
    }
  }
}`;

const ADVANCE_PAGE_SCRIPT = String.raw`(cursor) => {
  const normalized = (value) => (value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const escape = (value) => CSS.escape(value);
  const explicit = cursor
    ? document.querySelector('[data-resume-next-cursor="' + escape(cursor) + '"]')
    : undefined;
  const accessible = [...document.querySelectorAll("a, button")].find((element) =>
    !element.matches(":disabled, [aria-disabled=true]")
      && /下一页|next/iu.test(normalized((element.getAttribute("aria-label") ?? "") + " " + element.textContent))
  );
  const target = explicit
    ?? document.querySelector("a[rel=next], [data-resume-next-cursor], button[data-next-page]")
    ?? accessible;
  if (!(target instanceof HTMLElement) || target.matches(":disabled, [aria-disabled=true]")) {
    throw new Error("job_next_page_unavailable");
  }
  target.click();
}`;

export class JobObserver {
  constructor(
    private readonly page: Page,
    private readonly challengeDetector: ChallengeDetector
  ) {}

  async observe(ownerId: string): Promise<JobPageSnapshot> {
    const [raw, inspection, title] = await Promise.all([
      this.page.evaluate(JOB_OBSERVATION_SCRIPT),
      this.challengeDetector.inspect(),
      this.page.title()
    ]);
    return JobPageSnapshotSchema.parse({
      id: randomUUID(),
      ownerId,
      url: this.page.url(),
      title,
      capturedAt: new Date().toISOString(),
      ...(raw as object),
      boundaries: inspection.boundaries,
      ...(inspection.challenge ? { challenge: inspection.challenge } : {})
    });
  }

  async applyFilters(ownerId: string, plan: FilterPlan): Promise<JobPageSnapshot> {
    await this.page.evaluate(invokeBrowserScript(APPLY_FILTERS_SCRIPT, plan.mapped));
    await this.page.waitForTimeout(100);
    return this.observe(ownerId);
  }

  async advance(ownerId: string, cursor?: string): Promise<JobPageSnapshot> {
    await this.page.evaluate(invokeBrowserScript(ADVANCE_PAGE_SCRIPT, cursor));
    await this.page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await this.page.waitForTimeout(100);
    return this.observe(ownerId);
  }
}

function invokeBrowserScript(script: string, argument: unknown): string {
  const serialized = (JSON.stringify(argument) ?? "undefined")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
  return `(${script})(${serialized})`;
}
