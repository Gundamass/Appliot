import type { Locator, Page } from "playwright-core";

const SEARCH_OPTION_WAIT_MS = 4_000;
const SEARCH_OPTION_SAMPLE_MS = 100;
const SEARCH_OPTION_SETTLE_MS = 200;
const CUSTOM_COMMIT_WAIT_MS = 2_000;
const CUSTOM_OPTION_SELECTOR = '[role="option"]:visible, [data-option]:visible, [class*="option"]:visible, [class*="Select-menu-item"]:visible, [class*="Select-item"]:visible, [class*="Menu-content-item"]:visible';
const DOM_CUSTOM_OPTION_SELECTOR = '[role="option"], [data-option], [class*="option"], [class*="Select-menu-item"], [class*="Select-item"], [class*="Menu-content-item"]';
const DOM_CUSTOM_POPUP_SELECTOR = '[role="listbox"], [class*="Select-menu"], [class*="Menu-content"]';
const OPTION_SCOPE_ATTRIBUTE = "data-resume-option-scope";
const CHOICE_SCOPE_ATTRIBUTE = "data-resume-choice-scope";
let optionScopeSequence = 0;
let choiceScopeSequence = 0;

export interface ControlTarget {
  readonly page: Page;
  evaluate<R>(pageFunction: (element: Element) => R | Promise<R>): Promise<R>;
  evaluate<R, A>(
    pageFunction: (element: Element, arg: A) => R | Promise<R>,
    arg: A
  ): Promise<R>;
  click(options?: { force?: boolean }): Promise<void>;
  fill(value: string): Promise<void>;
  press(key: string): Promise<void>;
  getAttribute(name: string): Promise<string | null>;
}

export interface CustomSelectResult {
  selectedValue: string;
  recovered: boolean;
}

export async function selectCustomControl(locator: ControlTarget, expected: string): Promise<CustomSelectResult> {
  await locator.click();
  const optionScope = await associatedOptions(locator);
  try {
    const options = optionScope.options;
    const searchMode = await locator.evaluate((element) => {
      if (!(element instanceof HTMLInputElement)) return "none";
      if (element.getAttribute("role")?.toLocaleLowerCase() === "combobox"
        || element.hasAttribute("aria-autocomplete")) return "aria";
      return element.closest('[class*="Select-container"]') === null ? "none" : "mokahr";
    });
    const initialMatch = matchOption(await logicalOptions(options), expected);
    const searchable = searchMode === "aria"
      || (searchMode === "mokahr" && initialMatch.status === "not_found");
    if (searchable) {
      await locator.fill(expected);
    }
    const match = searchable
      ? await waitForSearchOption(locator, options, expected)
      : initialMatch;
    if (match.status === "ambiguous") {
      await locator.press("Escape").catch(() => undefined);
      throw new Error("custom_option_ambiguous");
    }
    if (match.status === "not_found") {
      await locator.press("Escape").catch(() => undefined);
      throw new Error("custom_option_not_found");
    }
    const selectedValue = normalizeText(match.text);
    const selectedOption = options.nth(match.index);
    await selectedOption.click();
    if (searchable) {
      await waitForSelectionCommit(locator, selectedOption);
    }
    const readback = await customControlReadback(locator);
    if (normalizeOption(readback) !== normalizeOption(selectedValue)) {
      throw new Error("custom_readback_mismatch");
    }
    return { selectedValue, recovered: selectedValue !== expected };
  } finally {
    await optionScope.cleanup();
  }
}

async function waitForSelectionCommit(locator: ControlTarget, selectedOption: Locator): Promise<void> {
  const deadline = Date.now() + CUSTOM_COMMIT_WAIT_MS;
  while (Date.now() < deadline) {
    const expanded = await locator.getAttribute("aria-expanded").catch(() => null);
    const optionStillVisible = await selectedOption.isVisible().catch(() => false);
    if (expanded === "false" || !optionStillVisible) return;
    await locator.page.waitForTimeout(50);
  }
  throw new Error("custom_selection_not_committed");
}

async function customControlReadback(locator: ControlTarget): Promise<string> {
  return normalizeText(await locator.evaluate((element) => {
    if (!(element instanceof HTMLInputElement)) return element.textContent ?? "";
    const displayValue = element.closest('[class*="Select-container"]')
      ?.querySelector('[class*="Input-display-value"]')?.textContent?.trim();
    if (displayValue) return displayValue;
    if (element.value.trim() !== "") return element.value;
    return element.closest("label")?.textContent ?? "";
  }));
}

async function associatedOptions(locator: ControlTarget): Promise<{ options: Locator; cleanup: () => Promise<void> }> {
  const token = String(++optionScopeSequence);
  const associatedCount = await locator.evaluate((element, scope) => {
    const ids = [element.getAttribute("aria-controls"), element.getAttribute("aria-owns")]
      .filter((value): value is string => value !== null)
      .flatMap((value) => value.split(/\s+/u))
      .filter(Boolean);
    let count = 0;
    for (const id of new Set(ids)) {
      const popup = document.getElementById(id);
      if (popup === null) continue;
      popup.setAttribute(scope.attribute, scope.token);
      count += 1;
    }
    if (count > 0) return count;

    const visible = (candidate: Element) => {
      const style = getComputedStyle(candidate);
      return candidate.getClientRects().length > 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && style.visibility !== "collapse";
    };
    let ancestor = element.parentElement;
    while (ancestor !== null && ancestor !== document.body) {
      if ([...ancestor.querySelectorAll(scope.optionSelector)].some(visible)) {
        ancestor.setAttribute(scope.attribute, scope.token);
        return 1;
      }
      ancestor = ancestor.parentElement;
    }
    const controlRect = element.getBoundingClientRect();
    const popups = [...document.querySelectorAll(scope.popupSelector)]
      .filter(visible)
      .filter((popup) => popup.querySelector(scope.optionSelector) !== null);
    if (popups.length === 0) return count;
    const distance = (popup: Element) => {
      const rect = popup.getBoundingClientRect();
      const horizontal = rect.left > controlRect.right
        ? rect.left - controlRect.right
        : controlRect.left > rect.right ? controlRect.left - rect.right : 0;
      const vertical = rect.top > controlRect.bottom
        ? rect.top - controlRect.bottom
        : controlRect.top > rect.bottom ? controlRect.top - rect.bottom : 0;
      return Math.hypot(horizontal, vertical);
    };
    const ranked = popups.map((popup) => ({ popup, distance: distance(popup) }))
      .sort((left, right) => left.distance - right.distance);
    if (ranked.length > 1 && Math.abs(ranked[0]!.distance - ranked[1]!.distance) < 1) return count;
    ranked[0]!.popup.setAttribute(scope.attribute, scope.token);
    return 1;
  }, {
    attribute: OPTION_SCOPE_ATTRIBUTE,
    optionSelector: DOM_CUSTOM_OPTION_SELECTOR,
    popupSelector: DOM_CUSTOM_POPUP_SELECTOR,
    token
  });
  const page = locator.page;
  const scope = page.locator(`[${OPTION_SCOPE_ATTRIBUTE}="${token}"]`);
  return {
    options: associatedCount > 0 ? scope.locator(CUSTOM_OPTION_SELECTOR) : page.locator(CUSTOM_OPTION_SELECTOR),
    cleanup: async () => {
      if (associatedCount === 0) return;
      await scope.evaluateAll((elements, attribute) => {
        for (const element of elements) element.removeAttribute(attribute);
      }, OPTION_SCOPE_ATTRIBUTE).catch(() => undefined);
    }
  };
}

type OptionMatch =
  | { status: "matched"; index: number; text: string; exact: boolean }
  | { status: "ambiguous" }
  | { status: "not_found" };

async function waitForSearchOption(locator: ControlTarget, options: Locator, expected: string): Promise<OptionMatch> {
  const deadline = Date.now() + SEARCH_OPTION_WAIT_MS;
  let candidate: OptionMatch = { status: "not_found" };
  let candidateSince = 0;
  let candidateSignature = "";
  while (Date.now() < deadline) {
    candidate = matchOption(await logicalOptions(options), expected);
    if (candidate.status === "ambiguous" || (candidate.status === "matched" && candidate.exact)) return candidate;
    if (candidate.status === "matched") {
      const signature = `${candidate.index}:${normalizeOption(candidate.text)}`;
      if (signature !== candidateSignature) {
        candidateSignature = signature;
        candidateSince = Date.now();
      } else if (Date.now() - candidateSince >= SEARCH_OPTION_SETTLE_MS) {
        return candidate;
      }
    } else {
      candidateSignature = "";
      candidateSince = 0;
    }
    await locator.page.waitForTimeout(SEARCH_OPTION_SAMPLE_MS);
  }
  return candidate;
}

interface LogicalOption {
  index: number;
  text: string;
}

async function logicalOptions(options: Locator): Promise<LogicalOption[]> {
  return options.evaluateAll((elements) => {
    const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
    const candidates = elements.map((element, index) => ({
      element,
      index,
      text: element.textContent ?? "",
      normalized: normalize(element.textContent ?? "")
    }));
    return candidates
      .filter((candidate) => !candidates.some((ancestor) =>
        ancestor.element !== candidate.element
        && ancestor.normalized === candidate.normalized
        && ancestor.element.contains(candidate.element)))
      .map(({ index, text }) => ({ index, text }));
  });
}

function matchOption(options: LogicalOption[], expected: string): OptionMatch {
  const expectedNormalized = normalizeOption(expected);
  const normalized = options.map(({ index, text }) => ({ index, text, value: normalizeOption(text) }));
  const exact = normalized.filter((option) => option.value === expectedNormalized);
  if (exact.length > 1) return { status: "ambiguous" };
  if (exact[0]) return { status: "matched", index: exact[0].index, text: exact[0].text, exact: true };

  const annotated = normalized.filter((option) => option.value.startsWith(expectedNormalized)
    && isAnnotationSeparator(option.value.slice(expectedNormalized.length)));
  if (annotated.length > 1) return { status: "ambiguous" };
  if (annotated[0]) {
    return { status: "matched", index: annotated[0].index, text: annotated[0].text, exact: false };
  }
  const percentile = percentileBucket(normalized, expectedNormalized);
  if (percentile) return percentile;
  return { status: "not_found" };
}

function percentileBucket(
  options: Array<{ index: number; text: string; value: string }>,
  expected: string
): OptionMatch | undefined {
  const expectedMatch = /^前(\d{1,3})%$/u.exec(expected);
  if (!expectedMatch) return undefined;
  const expectedPercentile = Number(expectedMatch[1]);
  if (expectedPercentile < 0 || expectedPercentile > 100) return undefined;
  const buckets = options.flatMap((option) => {
    const match = /^前(\d{1,3})%$/u.exec(option.value);
    if (!match) return [];
    const percentile = Number(match[1]);
    return percentile >= expectedPercentile && percentile <= 100
      ? [{ ...option, percentile }]
      : [];
  });
  if (buckets.length === 0) return undefined;
  const smallest = Math.min(...buckets.map((option) => option.percentile));
  const matches = buckets.filter((option) => option.percentile === smallest);
  if (matches.length > 1) return { status: "ambiguous" };
  const match = matches[0]!;
  return { status: "matched", index: match.index, text: match.text, exact: false };
}

function isAnnotationSeparator(suffix: string): boolean {
  return /^[\s([{（【<·:：,，/|-]/u.test(suffix);
}

export async function selectChoiceGroup(locator: ControlTarget, expected: string): Promise<string> {
  const token = String(++choiceScopeSequence);
  const scope = await locator.evaluate((element, input) => {
    const nativeRadio = element instanceof HTMLInputElement && element.type === "radio";
    let choices: Element[];
    if (nativeRadio) {
      const fieldset = element.closest("fieldset");
      if (fieldset !== null) {
        choices = [...fieldset.querySelectorAll('input[type="radio"]')];
      } else if (element.name !== "") {
        choices = [...document.querySelectorAll('input[type="radio"]')]
          .filter((candidate) => candidate instanceof HTMLInputElement && candidate.name === element.name);
      } else {
        choices = [...document.querySelectorAll('input[type="radio"]')];
      }
    } else {
      choices = [...element.querySelectorAll('[role="radio"]')];
    }
    for (const choice of choices) choice.setAttribute(input.attribute, input.token);
    return { nativeRadio, count: choices.length };
  }, { attribute: CHOICE_SCOPE_ATTRIBUTE, token });
  const choices = locator.page.locator(`[${CHOICE_SCOPE_ATTRIBUTE}="${token}"]`);

  try {
    if (scope.count === 0) throw new Error("choice_option_not_found");
    const matches: Array<{ index: number; text: string }> = [];
    for (let index = 0; index < await choices.count(); index += 1) {
      const choice = choices.nth(index);
      const text = await choice.evaluate((element) => {
        if (element instanceof HTMLInputElement) {
          return [...element.labels ?? []].map((label) => label.textContent ?? "").join(" ")
            || element.getAttribute("aria-label")
            || element.value;
        }
        return element.getAttribute("aria-label") || element.textContent || element.getAttribute("data-value") || "";
      });
      const normalized = normalizeText(text);
      if (normalizeChoice(normalized) === normalizeChoice(expected)) matches.push({ index, text: normalized });
    }
    if (matches.length === 0) throw new Error("choice_option_not_found");
    if (matches.length > 1) throw new Error("choice_option_ambiguous");

    const selected = choices.nth(matches[0]!.index);
    if (scope.nativeRadio) await selected.check();
    else await selected.click();
    return matches[0]!.text;
  } finally {
    await choices.evaluateAll((elements, attribute) => {
      for (const element of elements) element.removeAttribute(attribute);
    }, CHOICE_SCOPE_ATTRIBUTE).catch(() => undefined);
  }
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function normalizeOption(value: string): string {
  const normalized = normalizeText(value).replace(/[年月日]$/u, "");
  return /^\d{1,2}$/u.test(normalized) ? String(Number(normalized)) : normalized;
}

function normalizeChoice(value: string): string {
  const normalized = normalizeText(value).toLocaleLowerCase();
  if (["true", "yes", "y", "是", "同意", "接受"].includes(normalized)) return "true";
  if (["false", "no", "n", "否", "不同意", "不接受"].includes(normalized)) return "false";
  return normalized;
}
