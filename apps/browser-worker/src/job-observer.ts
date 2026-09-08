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
  const isBaiduHost = (hostname) => hostname === "talent.baidu.com";
  const isDjiApplyHost = (hostname) => hostname === "apply.careers.dji.com";
  const currentUrl = canonical(location.href);
  const isDjiPortal = (() => {
    try {
      const current = new URL(location.href);
      return isDjiApplyHost(current.hostname)
        && /^\/(?:campus|social)-recruitment\/[^/]+\/[^/]+(?:\/|$)/u.test(current.pathname);
    } catch {
      return false;
    }
  })();
  const isDjiJobUrl = (value) => {
    try {
      const parsed = new URL(value, location.href);
      return isDjiPortal
        && isDjiApplyHost(parsed.hostname)
        && parsed.pathname === location.pathname
        && /#\/job\/[^/?#]+/u.test(parsed.hash);
    } catch {
      return false;
    }
  };
  const isDjiJobDetail = isDjiPortal && (() => {
    try { return /#\/job\/[^/?#]+/u.test(new URL(location.href).hash); } catch { return false; }
  })();
  const isBaiduCampus = (() => {
    try {
      const current = new URL(location.href);
      if (!isBaiduHost(current.hostname) || !/^\/jobs\/(?:list|detail(?:\/|$))/u.test(current.pathname)) return false;
      const recruitType = current.searchParams.get("recruitType");
      const pathType = current.pathname.split("/").filter(Boolean)[2];
      return (recruitType === null || recruitType === "GRADUATE")
        && (pathType === undefined || pathType === "GRADUATE");
    } catch {
      return false;
    }
  })();
  const baiduInitialData = (() => {
    if (!isBaiduCampus || typeof window === "undefined") return null;
    const candidate = window.__INITIAL_DATA__;
    return candidate && typeof candidate === "object" ? candidate : null;
  })();
  const baiduListData = baiduInitialData && typeof baiduInitialData.listData === "object"
    ? baiduInitialData.listData
    : null;
  const baiduDetailData = baiduInitialData && typeof baiduInitialData.detailData === "object"
    ? baiduInitialData.detailData
    : null;
  const baiduDetailPost = baiduDetailData && typeof baiduDetailData.postInfo === "object"
    ? baiduDetailData.postInfo
    : null;
  const baiduDetailUrl = (post) => {
    const postId = normalized(post?.postId);
    if (!postId) return "";
    const recruitType = normalized(post?.recruitType || baiduListData?.recruitType || location.search.match(/[?&]recruitType=([^&]+)/u)?.[1] || "GRADUATE");
    const target = new URL("/jobs/detail/" + encodeURIComponent(recruitType) + "/" + encodeURIComponent(postId), location.origin);
    const projectType = normalized(post?.projectTypeCode || location.search.match(/[?&]projectType=([^&]+)/u)?.[1]);
    if (projectType) target.searchParams.set("projectType", projectType);
    target.searchParams.set("recruitType", recruitType);
    return target.href;
  };
  const baiduPostSummary = (post) => normalized([
    post?.serviceCondition ? "任职要求：" + post.serviceCondition : "",
    post?.workContent ? "工作内容：" + post.workContent : ""
  ].filter(Boolean).join("\n")).slice(0, 2000);
  const baiduCard = (post, detail = false) => {
    const canonicalUrl = detail ? currentUrl : baiduDetailUrl(post);
    const title = normalized(post?.name);
    if (!canonicalUrl || !title) return undefined;
    return {
      sourceJobId: normalized(post?.jobId || post?.postId) || undefined,
      canonicalUrl,
      title,
      organization: normalized(post?.orgName) || "百度",
      location: normalized(post?.workPlace) || undefined,
      employmentType: normalized(post?.projectType) || undefined,
      summary: baiduPostSummary(post) || undefined
    };
  };
  const baiduListCards = isBaiduCampus && Array.isArray(baiduListData?.listDetailData)
    ? baiduListData.listDetailData.map((post) => baiduCard(post)).filter(Boolean).slice(0, 2000)
    : [];
  const baiduDetailCards = isBaiduCampus && baiduDetailPost && /^\/jobs\/detail\//u.test(location.pathname)
    ? [baiduCard(baiduDetailPost, true)].filter(Boolean)
    : [];
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
  const domVisibleText = [...document.querySelectorAll("h1, h2, h3, [role=heading], main p, main li")]
    .filter(visible).map(text).filter(Boolean).slice(0, 500);
  const baiduVisibleText = baiduDetailPost
    ? [
        normalized(baiduDetailPost.name),
        normalized(baiduDetailPost.orgName) || "百度",
        normalized(baiduDetailPost.workPlace),
        normalized(baiduDetailPost.projectType) ? "项目类型：" + normalized(baiduDetailPost.projectType) : "",
        normalized(baiduDetailPost.serviceCondition),
        normalized(baiduDetailPost.workContent)
      ].filter(Boolean).map((value) => value.slice(0, 2000))
    : baiduListCards.flatMap((card) => [card.title, card.location, card.employmentType]).filter(Boolean);
  const visibleText = [...domVisibleText, ...baiduVisibleText].filter(Boolean).slice(0, 500);
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
  const djiPortalCards = isDjiPortal && !isDjiJobDetail
    ? [...document.querySelectorAll("a[href]")].flatMap((anchor) => {
      const canonicalUrl = canonical(anchor.getAttribute("href") ?? "");
      if (!isDjiJobUrl(canonicalUrl)) return [];
      const card = anchor.closest("[class*=card]") ?? anchor;
      const title = text(anchor.querySelector("[class*=title], h2, h3, [role=heading]"));
      const locationValue = [...card.querySelectorAll("[class*=body-secondary], [class*=location], [class*=city], [class*=hiddenContent], .no-adaptive-tooltip")]
        .map(text)
        .filter((value) => value.length > 0 && value.length <= 80 && /·|市$|省$|区$/u.test(value))
        .sort((left, right) => left.length - right.length)[0];
      const summary = text(card.querySelector("[class*=short-description], [class*=job-description], [class*=description]"));
      const sourceJobId = canonicalUrl.match(/#\/job\/([^/?#]+)/u)?.[1];
      if (!title || !sourceJobId) return [];
      return [{
        sourceJobId,
        canonicalUrl,
        title,
        organization: "DJI",
        ...(locationValue === undefined ? {} : { location: locationValue }),
        ...(summary === "" ? {} : { summary })
      }];
    }).slice(0, 2000)
    : [];
  const djiPortalDetailCards = isDjiJobDetail
    ? (() => {
      const title = text(document.querySelector("h1, [class*=title], [role=heading]"));
      const description = text(document.querySelector("[class*=job-description], [class*=description]"));
      const sourceJobId = new URL(location.href).hash.match(/#\/job\/([^/?#]+)/u)?.[1];
      if (!title || !sourceJobId) return [];
      return [{
        sourceJobId,
        canonicalUrl: currentUrl,
        title,
        organization: "DJI",
        ...(description === "" ? {} : { summary: description })
      }];
    })()
    : [];
  const jobCards = baiduDetailCards.length > 0
    ? baiduDetailCards
    : baiduListCards.length > 0
      ? baiduListCards
      : djiPortalDetailCards.length > 0
        ? djiPortalDetailCards
        : djiPortalCards.length > 0
          ? djiPortalCards
          : campusCards.length > 0 ? campusCards : genericCards;
  const campusDetailContainer = isCampusApply
    ? document.querySelector("[data-job-description], [class*=job-description], [class*=position-detail], [class*=job-detail]")
    : null;
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
  const genericFilterState = [...document.querySelectorAll("[data-resume-filter-key], [data-filter-key]")]
    .flatMap((container) => {
      const key = normalized(container.getAttribute("data-resume-filter-key") || container.getAttribute("data-filter-key"));
      if (!key) return [];
      const selected = [...container.querySelectorAll("option:checked, input:checked, [aria-selected=true], [aria-checked=true], [data-selected=true]")]
        .map((element) => normalized(element.getAttribute("data-value") || element.getAttribute("value") || element.textContent))
        .filter(Boolean).slice(0, 50);
      return [{ key, values: [...new Set(selected)] }];
    }).slice(0, 100);
  const baiduFilterOptions = baiduListData
    ? {
        postType: baiduListData.postList,
        workPlace: baiduListData.workPlaceList,
        projectType: baiduListData.recruitType === "INTERN"
          ? baiduListData.internProjectList
          : baiduListData.graduateProjectList
      }
    : {};
  const baiduFilterLabel = (key, value) => {
    const decoded = decodeURIComponent(value);
    const options = Array.isArray(baiduFilterOptions[key]) ? baiduFilterOptions[key] : [];
    const option = options.find((candidate) => normalized(candidate?.value) === normalized(decoded));
    return normalized(option?.label) || decoded;
  };
  const baiduFilterState = isBaiduCampus && baiduListData
    ? [
        ["postType", location.search.match(/[?&]postType=([^&]+)/u)?.[1]],
        ["workPlace", location.search.match(/[?&]workPlace=([^&]+)/u)?.[1]],
        ["projectType", location.search.match(/[?&]projectType=([^&]+)/u)?.[1]]
      ].flatMap(([key, value]) => value ? [{ key, values: [baiduFilterLabel(key, value)] }] : [])
    : [];
  const djiFilterState = isDjiPortal
    ? [
        [...document.querySelectorAll("input")]
          .find((input) => input.getAttribute("placeholder") === "搜索职位关键词")?.value,
        [...document.querySelectorAll("label")]
          .filter((label) => visible(label)
            && label.querySelector("input[type=checkbox]:checked") !== null)
          .map((label) => {
            const nested = [...label.querySelectorAll("[class*=hiddenContent], .no-adaptive-tooltip")]
              .map((element) => normalized(element.textContent))
              .filter(Boolean);
            return nested[0] ?? normalized(label.textContent);
          })
          .filter(Boolean)
      ].flatMap((value, index) => {
        if (index === 0) return value ? [{ key: "keyword", values: [normalized(value)] }] : [];
        const values = Array.isArray(value) ? [...new Set(value)] : [];
        return values.length > 0
          ? [{ key: "work_location", values: values.slice(0, 50) }]
          : [];
      })
    : [];
  const filterState = [...genericFilterState, ...baiduFilterState, ...djiFilterState].slice(0, 100);
  const explicitEntry = normalized(document.body.getAttribute("data-resume-entry") || document.documentElement.getAttribute("data-resume-entry"));
  const hasApplicationForm = Boolean(document.querySelector("form input[type=file], form [name*=resume i], form [name*=candidate i]"));
  const loginText = normalized(document.title + " " + visibleText.slice(0, 20).join(" "));
  const entryHint = ["job_list", "job_detail", "application_form"].includes(explicitEntry)
    ? explicitEntry
    : /登录|sign\s*in|log\s*in/iu.test(loginText) ? "login"
    : hasApplicationForm ? "application_form"
    : baiduDetailCards.length > 0 ? "job_detail"
    : isBaiduCampus && /^\/jobs\/list$/u.test(location.pathname) ? "job_list"
    : djiPortalDetailCards.length > 0 ? "job_detail"
    : djiPortalCards.length > 0 ? "job_list"
    : jobCards.length > 0 ? "job_list"
    : campusDetailCard.length > 0 ? "job_detail"
    : document.querySelector("[data-job-description], [class*=job-description], [class*=position-detail]") ? "job_detail"
    : "unknown";
  const parsedUrl = new URL(location.href);
  const currentFromUrl = Number(parsedUrl.searchParams.get("page") ?? parsedUrl.searchParams.get("pageNum"));
  const baiduNext = isBaiduCampus
    ? [...document.querySelectorAll(".brick-pagination button")]
      .filter((element) => visible(element) && !element.matches(":disabled, [aria-disabled=true]"))
      .at(-1)
    : null;
  const next = baiduNext
    ?? document.querySelector("[data-resume-next-cursor], a[rel=next], button[data-next-page]")
    ?? [...document.querySelectorAll("a, button")].find((element) => visible(element)
      && /下一页|next/iu.test(normalized((element.getAttribute("aria-label") ?? "") + " " + text(element)))
      && !element.matches(":disabled, [aria-disabled=true]"));
  const nextCursor = normalized(next?.getAttribute("data-resume-next-cursor") || next?.getAttribute("href"));
  const baiduPageNumber = Number(baiduListData?.pageNum);
  const baiduPageSize = Number(baiduListData?.pageSize);
  const baiduTotal = Number(baiduListData?.total);
  const baiduHasNext = Number.isInteger(baiduPageNumber) && baiduPageNumber > 0
    && Number.isInteger(baiduPageSize) && baiduPageSize > 0
    && Number.isFinite(baiduTotal) && baiduPageNumber * baiduPageSize < baiduTotal;
  const pagination = {
    kind: isBaiduCampus && Number.isInteger(baiduPageNumber) && baiduPageNumber > 0 ? "page"
      : Number.isInteger(currentFromUrl) && currentFromUrl >= 0 ? "page" : nextCursor ? "cursor" : "none",
    ...(isBaiduCampus && Number.isInteger(baiduPageNumber) && baiduPageNumber > 0
      ? { current: baiduPageNumber }
      : Number.isInteger(currentFromUrl) && currentFromUrl >= 0 ? { current: currentFromUrl } : {}),
    hasNext: isBaiduCampus && Array.isArray(baiduListData?.listDetailData)
      ? baiduHasNext
      : Boolean(next && !next.matches(":disabled, [aria-disabled=true]")),
    ...(isBaiduCampus && baiduHasNext
      ? { nextCursor: String(baiduPageNumber + 1) }
      : nextCursor ? { nextCursor: nextCursor.slice(0, 1024) } : {})
  };
  return { entryHint, visibleText, jobCards, filterState, pagination };
})()`;

const APPLY_FILTERS_SCRIPT = String.raw`async (mapped) => {
  const normalized = (value) => (value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const escape = (value) => CSS.escape(value);
  const current = new URL(location.href);
  if (current.hostname === "talent.baidu.com") {
    const headings = {
      postType: ["职位类别", "职位类型"],
      workPlace: ["职位地点", "工作地点"],
      projectType: ["校园招聘", "项目类型"]
    };
    const visible = (element) => {
      const style = getComputedStyle(element);
      return element.getClientRects().length > 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && style.opacity !== "0";
    };
    const findContainer = (key) => {
      const wantedHeadings = headings[key] ?? [];
      const heading = [...document.querySelectorAll("div, span, h2, h3")].find((element) =>
        visible(element) && wantedHeadings.includes(normalized(element.textContent))
          && [...element.parentElement?.querySelectorAll("input") ?? []].length > 0);
      return heading?.parentElement;
    };
    const findLabel = (container, value) => [...container.querySelectorAll("label")].find((candidate) => {
      const labelText = normalized(candidate.textContent);
      return labelText === value || labelText.includes(value);
    });
    const revealLocationLabel = async (value) => {
      let container = findContainer("workPlace");
      if (!container) return undefined;
      let label = findLabel(container, value);
      if (label) return label;
      const more = [...container.querySelectorAll("button, [role=button], div, span")]
        .find((element) => visible(element) && normalized(element.textContent) === "更多");
      if (!(more instanceof HTMLElement)) return undefined;
      more.click();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        container = findContainer("workPlace");
        if (!container) continue;
        label = findLabel(container, value);
        if (label) return label;
      }
      return undefined;
    };
    for (const filter of mapped) {
      const container = findContainer(filter.key);
      if (!container) throw new Error("job_filter_control_missing:" + filter.key);
      const wanted = new Set(filter.values.map(normalized));
      for (const value of wanted) {
        const label = findLabel(container, value)
          ?? (filter.key === "workPlace" ? await revealLocationLabel(value) : undefined);
        if (!label) throw new Error("job_filter_value_missing:" + filter.key);
        const input = label.querySelector("input");
        if (!(input instanceof HTMLInputElement) || !input.checked) label.click();
      }
    }
    return;
  }
  if (current.hostname === "apply.careers.dji.com"
    && /^\/(?:campus|social)-recruitment\/[^/]+\/[^/]+(?:\/|$)/u.test(current.pathname)) {
    const visible = (element) => {
      const style = getComputedStyle(element);
      return element.getClientRects().length > 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && style.opacity !== "0";
    };
    const setInputValue = (input, value) => {
      const prototype = Object.getPrototypeOf(input);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor?.set) descriptor.set.call(input, value);
      else input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.focus();
      input.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Enter",
        key: "Enter",
        keyCode: 13,
        which: 13
      }));
      input.dispatchEvent(new KeyboardEvent("keyup", {
        bubbles: true,
        code: "Enter",
        key: "Enter",
        keyCode: 13,
        which: 13
      }));
    };
    const labelValue = (label) => {
      const nested = [...label.querySelectorAll("[class*=hiddenContent], .no-adaptive-tooltip")]
        .map((element) => normalized(element.textContent))
        .filter(Boolean);
      return nested[0] ?? normalized(label.textContent);
    };
    const locationLabels = [...document.querySelectorAll("label")]
      .filter((label) => visible(label) && label.querySelector("input[type=checkbox]") !== null);
    for (const filter of mapped) {
      if (filter.key === "keyword") {
        const input = [...document.querySelectorAll("input")]
          .find((candidate) => candidate.getAttribute("placeholder") === "搜索职位关键词");
        if (!(input instanceof HTMLInputElement)) throw new Error("job_filter_control_missing:keyword");
        setInputValue(input, filter.values.join(" "));
        continue;
      }
      if (filter.key === "work_location") {
        const wanted = new Set(filter.values.map(normalized));
        for (const label of locationLabels) {
          const input = label.querySelector("input[type=checkbox]");
          const currentLabelValue = labelValue(label);
          if (!(input instanceof HTMLInputElement) || !currentLabelValue) continue;
          const shouldBeChecked = [...wanted].some((value) => currentLabelValue === value || currentLabelValue.includes(value));
          if (input.checked !== shouldBeChecked) label.click();
        }
        for (const value of wanted) {
          if (!locationLabels.some((label) => {
            const currentLabelValue = labelValue(label);
            return currentLabelValue === value || currentLabelValue.includes(value);
          })) throw new Error("job_filter_value_missing:work_location");
        }
        continue;
      }
      throw new Error("job_filter_control_missing:" + filter.key);
    }
    return;
  }
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
  const current = new URL(location.href);
  if (current.hostname === "talent.baidu.com") {
    const buttons = [...document.querySelectorAll(".brick-pagination button")]
      .filter((element) => !element.matches(":disabled, [aria-disabled=true]"));
    const target = cursor === undefined
      ? buttons.at(-1)
      : buttons.find((element) => normalized(element.textContent) === normalized(cursor));
    if (!(target instanceof HTMLElement)) throw new Error("job_next_page_unavailable");
    target.click();
    return;
  }
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
  private baiduSnapshotUrl: string | undefined;
  private baiduSnapshotOwnerId: string | undefined;
  private baiduEntryUrl: string | undefined;

  constructor(
    private readonly page: Page,
    private readonly challengeDetector: ChallengeDetector
  ) {}

  async observe(ownerId: string): Promise<JobPageSnapshot> {
    if (this.baiduSnapshotUrl !== undefined) {
      if (this.baiduSnapshotOwnerId !== ownerId) throw new Error("job_snapshot_owner_mismatch");
      return this.readBaiduSnapshot(ownerId, this.baiduSnapshotUrl);
    }
    if (isBaiduUrl(this.page.url())) this.baiduEntryUrl = this.page.url();
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
    if (plan.source === "baidu") {
      const entryUrl = this.baiduEntryUrl ?? (isBaiduUrl(this.page.url()) ? this.page.url() : undefined);
      if (entryUrl === undefined) throw new Error("job_filter_navigation_target_invalid");
      const targetUrl = createBaiduFilterUrl(entryUrl, plan.mapped);
      this.baiduSnapshotUrl = targetUrl;
      this.baiduSnapshotOwnerId = ownerId;
      return this.readBaiduSnapshot(ownerId, targetUrl);
    } else {
      await this.page.evaluate(invokeBrowserScript(APPLY_FILTERS_SCRIPT, plan.mapped));
    }
    await this.page.waitForTimeout(400);
    return this.observe(ownerId);
  }

  private async readBaiduSnapshot(ownerId: string, targetUrl: string): Promise<JobPageSnapshot> {
    const target = new URL(targetUrl);
    const pageSize = 10;
    const pageNum = numberValue(target.searchParams.get("pageNum"), 1);
    const form = new URLSearchParams();
    form.set("recruitType", target.searchParams.get("recruitType") || "GRADUATE");
    appendBaiduFilterValue(form, "workPlace", target.searchParams.get("workPlace"));
    form.set("pageSize", String(pageSize));
    form.set("keyWord", target.searchParams.get("keyWord") || "");
    appendBaiduFilterValue(form, "postType", target.searchParams.get("postType"));
    form.set("curPage", String(pageNum));
    const projectType = target.searchParams.get("projectType");
    if (projectType && projectType !== "1") form.set("projectType", projectType);
    const response = await fetch(`${target.origin}/httservice/getPostListNew`, {
      method: "POST",
      body: form.toString(),
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=utf-8",
        referer: this.baiduEntryUrl ?? `${target.origin}/jobs/list?projectType=1&recruitType=GRADUATE`
      }
    });
    if (!response.ok) throw new Error(`job_filter_request_failed:${response.status}`);
    const payload = asRecord(await response.json());
    const data = asRecord(payload?.data);
    if (payload?.status !== "ok" || !data || !Array.isArray(data.list) || !isBaiduTotal(data.total)) {
      throw new Error("job_filter_response_invalid");
    }
    if (parseBaiduPageCursor(String(data.pageNum)) !== pageNum) throw new Error("job_page_readback_mismatch");
    return createBaiduSnapshot(ownerId, targetUrl, data, pageNum, pageSize);
  }

  async advance(ownerId: string, cursor?: string): Promise<JobPageSnapshot> {
    if (this.baiduSnapshotUrl !== undefined) {
      if (this.baiduSnapshotOwnerId !== ownerId) throw new Error("job_snapshot_owner_mismatch");
      const target = new URL(this.baiduSnapshotUrl);
      const nextPage = cursor === undefined
        ? numberValue(target.searchParams.get("pageNum"), 1) + 1
        : parseBaiduPageCursor(cursor);
      if (nextPage === undefined) throw new Error("job_next_page_unavailable");
      target.searchParams.set("pageNum", String(nextPage));
      this.baiduSnapshotUrl = target.href;
      return this.readBaiduSnapshot(ownerId, target.href);
    }
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

function createBaiduSnapshot(
  ownerId: string,
  targetUrl: string,
  data: Record<string, unknown>,
  pageNum: number,
  pageSize: number
): JobPageSnapshot {
  const parsedUrl = new URL(targetUrl);
  const recruitType = parsedUrl.searchParams.get("recruitType") || "GRADUATE";
  const projectTypeCode = parsedUrl.searchParams.get("projectType") || "1";
  const rawJobs = data.list as unknown[];
  const filterState = baiduFilterStateFromUrl(parsedUrl);
  const jobCards = rawJobs.map((candidate) => {
    const job = asRecord(candidate);
    if (!job) throw new Error("job_filter_response_invalid");
    const postId = textValue(job.postId);
    const title = textValue(job.name);
    if (!postId || !title) throw new Error("job_filter_response_invalid");
    verifyBaiduFilterReadback(parsedUrl, job);
    const detailUrl = new URL(`/jobs/detail/${encodeURIComponent(recruitType)}/${encodeURIComponent(postId)}`, parsedUrl.origin);
    if (projectTypeCode) detailUrl.searchParams.set("projectType", projectTypeCode);
    detailUrl.searchParams.set("recruitType", recruitType);
    const sourceJobId = textValue(job.jobId) || postId;
    const location = textValue(job.workPlace);
    const employmentType = textValue(job.projectType);
    const organization = textValue(job.orgName) || "百度";
    const summary = [
      textValue(job.serviceCondition) ? `任职要求：${textValue(job.serviceCondition)}` : "",
      textValue(job.workContent) ? `工作内容：${textValue(job.workContent)}` : ""
    ].filter(Boolean).join("\n").slice(0, 2000);
    return {
      sourceJobId,
      canonicalUrl: detailUrl.href,
      title,
      organization,
      ...(location ? { location } : {}),
      ...(employmentType ? { employmentType } : {}),
      ...(summary ? { summary } : {})
    };
  }).slice(0, 2000);
  const total = numberValue(data.total, jobCards.length);
  const hasNext = pageNum * pageSize < total;
  return JobPageSnapshotSchema.parse({
    id: randomUUID(),
    ownerId,
    url: targetUrl,
    title: "百度校园招聘",
    capturedAt: new Date().toISOString(),
    entryHint: "job_list",
    visibleText: jobCards.flatMap((job) => [job.title, job.location, job.employmentType]).filter(Boolean).slice(0, 500),
    jobCards,
    filterState,
    pagination: {
      kind: "page",
      current: pageNum,
      hasNext,
      ...(hasNext ? { nextCursor: String(pageNum + 1) } : {})
    },
    boundaries: []
  });
}

const BAIDU_FILTER_CODES: Record<string, Record<string, string>> = {
  postType: {
    技术: "1",
    产品: "2",
    政企: "13",
    销售: "14",
    综合: "15"
  },
  workPlace: {
    北京市: "1100",
    上海市: "3100",
    深圳市: "4403",
    广州市: "4401",
    杭州市: "3301",
    成都市: "5101",
    南京市: "3201",
    苏州市: "3205",
    郑州市: "4101",
    大连市: "2102",
    保定市: "1306",
    全国: "9000"
  }
};

function createBaiduFilterUrl(entryUrl: string, mapped: FilterPlan["mapped"]): string {
  const target = new URL(entryUrl);
  for (const filter of mapped) {
    const codes = filter.values.map((value) => BAIDU_FILTER_CODES[filter.key]?.[value]);
    if (codes.some((code) => code === undefined)) throw new Error(`job_filter_value_missing:${filter.key}`);
    target.searchParams.set(filter.key, codes.join(","));
  }
  target.searchParams.delete("pageNum");
  return target.href;
}

function appendBaiduFilterValue(form: URLSearchParams, key: string, rawValues: string | null): void {
  const values = rawValues?.split(",").filter(Boolean) ?? [];
  if (key === "workPlace" && values.includes("9000")) return;
  if (values.length > 0) form.set(key, values.join(","));
}

function parseBaiduPageCursor(value: string): number | undefined {
  if (!/^[1-9]\d*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isBaiduTotal(value: unknown): boolean {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0;
}

function baiduFilterStateFromUrl(url: URL): JobPageSnapshot["filterState"] {
  return ["postType", "workPlace"].flatMap((key) => {
    const rawValues = url.searchParams.get(key)?.split(",").filter(Boolean) ?? [];
    if (rawValues.length === 0) return [];
    const labels = rawValues.map((code) => baiduFilterLabel(key, code));
    if (labels.some((label) => label === undefined)) throw new Error(`job_filter_readback_mismatch:${key}`);
    return [{ key, values: labels as string[] }];
  });
}

function verifyBaiduFilterReadback(url: URL, job: Record<string, unknown>): void {
  const postTypes = url.searchParams.get("postType")?.split(",").filter(Boolean)
    .map((code) => baiduFilterLabel("postType", code)) ?? [];
  if (postTypes.length > 0 && !postTypes.includes(textValue(job.postType))) {
    throw new Error("job_filter_readback_mismatch:postType");
  }
  const locations = url.searchParams.get("workPlace")?.split(",").filter((code) => code !== "9000")
    .map((code) => baiduFilterLabel("workPlace", code)) ?? [];
  const jobLocation = textValue(job.workPlace);
  if (locations.length > 0 && !locations.some((location) => location !== undefined && jobLocation.includes(location))) {
    throw new Error("job_filter_readback_mismatch:workPlace");
  }
}

function baiduFilterLabel(key: string, code: string): string | undefined {
  return Object.entries(BAIDU_FILTER_CODES[key] ?? {}).find(([, candidate]) => candidate === code)?.[0];
}

function isBaiduUrl(value: string): boolean {
  try {
    return new URL(value).hostname === "talent.baidu.com";
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).normalize("NFKC").replace(/\s+/gu, " ").trim()
    : "";
}

function numberValue(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
