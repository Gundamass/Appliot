import { normalizeForm, type RawFormObservation } from "@resume/form-semantics";
import type { FormSnapshot } from "@resume/contracts";
import type { Page } from "playwright-core";
import type { PageStructure } from "./activity-monitor.js";
import { DomRegistry } from "./dom-registry.js";
import { opaqueId } from "./opaque-id.js";

const EMPTY_PAGE_SAMPLE_MS = 100;
const EMPTY_PAGE_WAIT_CAP_MS = 5_000;
const MAX_FIELD_OPTIONS = 100;

const BROWSER_OBSERVATION_SCRIPT = String.raw`(() => {
  const normalized = (value) => (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  const visible = (element) => {
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0
      && style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse"
      && style.pointerEvents !== "none" && style.opacity !== "0"
      && (typeof element.checkVisibility !== "function" || element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  };
  const internal = (element) => Boolean(element.closest("[hidden], [inert], [aria-hidden=true], [data-resume-internal], [data-internal]"));
  const unavailable = (element) => element.matches(":disabled") || element.readOnly
    || (element.getAttribute("aria-disabled") ?? "").toLocaleLowerCase() === "true";
  const resumableHiddenFile = (element) => element instanceof HTMLInputElement
    && element.type === "file"
    && /简历|resume|cv/iu.test(normalized(element.closest(".ant-upload-wrapper, .ant-upload, [class*='upload']")?.textContent));
  const formItem = (element) => {
    let ancestor = element.parentElement;
    while (ancestor && ancestor !== document.body) {
      const standardLabel = ancestor.querySelector(":scope > .ant-form-item-label label, :scope > .form-item-label label");
      const mokahrTitle = ancestor.querySelector(":scope > [class*='title-']");
      const mokahrControl = ancestor.querySelector(":scope > [class*='ctrl-']");
      if (standardLabel || (mokahrTitle && mokahrControl?.contains(element))) return ancestor;
      ancestor = ancestor.parentElement;
    }
    return null;
  };
  const required = (element, labelText) => element.required
    || (element.getAttribute("aria-required") ?? "").toLocaleLowerCase() === "true"
    || (element.getAttribute("data-required") ?? "").toLocaleLowerCase() === "true"
    || Boolean(element.closest(".ant-form-item-required, .form-item-required, [class*='required']"))
    || Boolean(formItem(element)?.querySelector("label.ant-form-item-required, label[class*='required'], [class*='required-asterisk'], [aria-required=true], [data-required=true]"))
    || /(?:^|\s)[*＊](?:\s|$)/u.test(labelText);
  const formItemLabel = (element) => normalized(formItem(element)
    ?.querySelector(":scope > .ant-form-item-label label, :scope > .form-item-label label, :scope > [class*='title-']")?.textContent);
  const actionContext = (element) => {
    const actionText = normalized(element instanceof HTMLInputElement ? element.value : element.textContent);
    const explicitContainer = element.closest("[data-action-context]");
    const explicit = normalized(explicitContainer?.getAttribute("data-action-context"));
    if (explicit) return explicit + actionText;
    const sectionPattern = /教育经历|教育背景|工作经历|实习经历|项目经历|项目经验/u;
    let ancestor = element.parentElement;
    while (ancestor && ancestor !== document.body) {
      const directHeading = normalized(ancestor.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > legend, :scope > [role=heading]")?.textContent);
      const directBlockTitle = normalized(ancestor.querySelector(":scope > [class*='blockTitle']")?.textContent);
      const directSection = (directHeading || directBlockTitle).match(sectionPattern)?.[0];
      if (directSection) return directSection + actionText;
      const sections = new Set([...ancestor.querySelectorAll("h1, h2, h3, h4, legend, [role=heading]")]
        .map((heading) => normalized(heading.textContent).match(sectionPattern)?.[0])
        .filter(Boolean));
      if (sections.size === 1) return [...sections][0] + actionText;
      ancestor = ancestor.parentElement;
    }
    return "";
  };
  let fieldIndex = 0;
  const fields = [...document.querySelectorAll("input:not([type=hidden]), textarea, select, [role=combobox]")]
    .flatMap((element, registryIndex) => {
    if (unavailable(element) || (!visible(element) && !resumableHiddenFile(element)) || internal(element)) return [];
    const index = fieldIndex++;
    const tag = element.tagName.toLocaleLowerCase();
    const roleCombobox = element.getAttribute("role")?.toLocaleLowerCase() === "combobox";
    const textBackedSelect = element instanceof HTMLInputElement
      && Boolean(element.closest("[class*='Select-container']"));
    const customSelect = roleCombobox || textBackedSelect;
    const customDisplayValue = textBackedSelect
      ? normalized(element.closest("[class*='Select-container']")?.querySelector("[class*='Input-display-value']")?.textContent)
      : "";
    const selectPlaceholder = textBackedSelect ? normalized(element.getAttribute("placeholder")) : "";
    const inferredDateUnit = textBackedSelect && selectPlaceholder === ""
      ? /^\d{4}$/u.test(customDisplayValue)
        ? "年"
        : /^(?:0?[1-9]|1[0-2])$/u.test(customDisplayValue) ? "月" : ""
      : "";
    const explicitLabel = element.id
      ? normalized(document.querySelector('label[for="' + CSS.escape(element.id) + '"]')?.textContent)
      : "";
    const wrappingLabel = normalized(element.closest("label")?.textContent);
    const ariaLabelledBy = normalized((element.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" "));
    const previous = element.previousElementSibling;
    const uploadText = resumableHiddenFile(element)
      ? normalized(element.closest(".ant-upload-wrapper, .ant-upload, [class*='upload']")?.textContent)
      : "";
    const nearbyText = roleCombobox
      ? normalized(element.getAttribute("aria-label"))
      : textBackedSelect
        ? selectPlaceholder || inferredDateUnit
      : uploadText || (previous && !previous.matches("input, textarea, select, button, [role=combobox]")
      ? normalized(previous.textContent)
      : normalized(element.getAttribute("placeholder")));
    const itemLabel = formItemLabel(element);
    const usableLabel = [
      explicitLabel,
      normalized(element.getAttribute("aria-label")),
      ariaLabelledBy,
      itemLabel,
      wrappingLabel,
      nearbyText,
      normalized(element.getAttribute("name"))
    ].find(Boolean);
    if (!usableLabel) return [];
    const allOptions = element instanceof HTMLSelectElement
      ? [...element.options].filter((option) => option.value !== "").map((option) => normalized(option.textContent))
      : [];
    return {
      path: "field:" + index,
      registryIndex,
      tag: customSelect ? "select" : tag,
      inputType: customSelect ? "custom-select" : element instanceof HTMLInputElement ? element.type : tag,
      name: element.getAttribute("name") ?? "",
      required: required(element, [explicitLabel, wrappingLabel, ariaLabelledBy, itemLabel, nearbyText].filter(Boolean).join(" ")),
      value: roleCombobox
        ? element instanceof HTMLInputElement ? element.value : normalized(element.textContent)
        : textBackedSelect
        ? customDisplayValue || element.value
        : element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)
        ? element.checked
        : element.value,
      options: allOptions.slice(0, ${MAX_FIELD_OPTIONS}),
      optionsTruncated: allOptions.length > ${MAX_FIELD_OPTIONS} || undefined,
      controlKind: customSelect ? "custom" : "native",
      interactionMode: customSelect ? "search" : element instanceof HTMLInputElement && element.type === "file" ? "file" : "native",
      explicitLabel,
      wrappingLabel: itemLabel || wrappingLabel,
      ariaLabel: normalized(element.getAttribute("aria-label")),
      ariaLabelledBy,
      nearbyText
    };
  });
  let actionIndex = 0;
  const actions = [...document.querySelectorAll('button, input[type="button"], input[type="submit"], a[href], a[role="button"]')]
    .flatMap((element, registryIndex) => {
    if (unavailable(element) || !visible(element) || internal(element)) return [];
    return [{
      path: "action:" + actionIndex++,
      registryIndex,
      text: normalized(element instanceof HTMLInputElement ? element.value : element.textContent),
      ariaLabel: normalized(element.getAttribute("aria-label")),
      nearbyText: actionContext(element)
    }];
  });
  const errors = [...document.querySelectorAll('[role="alert"], .error, .field-error')]
    .filter((element) => element.getClientRects().length > 0)
    .map((element) => normalized(element.textContent))
    .filter(Boolean);
  return { fields, actions, errors };
})()`;

const PAGE_STRUCTURE_SCRIPT = String.raw`(() => {
  const normalized = (value) => (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  const visible = (element) => {
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0
      && style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse"
      && style.pointerEvents !== "none" && style.opacity !== "0"
      && (typeof element.checkVisibility !== "function" || element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  };
  const internal = (element) => Boolean(element.closest("[hidden], [inert], [aria-hidden=true], [data-resume-internal], [data-internal]"));
  const unavailable = (element) => element.matches(":disabled") || element.readOnly
    || (element.getAttribute("aria-disabled") ?? "").toLocaleLowerCase() === "true";
  const resumableHiddenFile = (element) => element instanceof HTMLInputElement
    && element.type === "file"
    && /简历|resume|cv/iu.test(normalized(element.closest(".ant-upload-wrapper, .ant-upload, [class*='upload']")?.textContent));
  const formItem = (element) => {
    let ancestor = element.parentElement;
    while (ancestor && ancestor !== document.body) {
      const standardLabel = ancestor.querySelector(":scope > .ant-form-item-label label, :scope > .form-item-label label");
      const mokahrTitle = ancestor.querySelector(":scope > [class*='title-']");
      const mokahrControl = ancestor.querySelector(":scope > [class*='ctrl-']");
      if (standardLabel || (mokahrTitle && mokahrControl?.contains(element))) return ancestor;
      ancestor = ancestor.parentElement;
    }
    return null;
  };
  const required = (element, labelText) => element.required
    || (element.getAttribute("aria-required") ?? "").toLocaleLowerCase() === "true"
    || (element.getAttribute("data-required") ?? "").toLocaleLowerCase() === "true"
    || Boolean(element.closest(".ant-form-item-required, .form-item-required, [class*='required']"))
    || Boolean(formItem(element)?.querySelector("label.ant-form-item-required, label[class*='required'], [class*='required-asterisk'], [aria-required=true], [data-required=true]"))
    || /(?:^|\s)[*＊](?:\s|$)/u.test(labelText);
  const formItemLabel = (element) => normalized(formItem(element)
    ?.querySelector(":scope > .ant-form-item-label label, :scope > .form-item-label label, :scope > [class*='title-']")?.textContent);
  const labelledBy = (element) => normalized((element.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
  const fieldName = (element) => [
    normalized(element.getAttribute("aria-label")),
    labelledBy(element),
    formItemLabel(element),
    normalized([...(element.labels ?? [])].map((label) => label.textContent ?? "").join(" ")),
    normalized(element.getAttribute("placeholder")),
    normalized(element.getAttribute("name"))
  ].find(Boolean) ?? "";
  const actionName = (element) => [
    normalized(element.getAttribute("aria-label")),
    labelledBy(element),
    normalized(element.textContent),
    normalized(element.getAttribute("value")),
    normalized(element.getAttribute("title"))
  ].find(Boolean) ?? "";
  const fields = [...document.querySelectorAll("input:not([type=hidden]), textarea, select, [role=combobox]")]
    .filter((element) => !unavailable(element) && (visible(element) || resumableHiddenFile(element)) && !internal(element) && (fieldName(element) !== "" || resumableHiddenFile(element)))
    .map((element, index) => {
      const customSelect = element.getAttribute("role")?.toLocaleLowerCase() === "combobox"
        || (element instanceof HTMLInputElement && Boolean(element.closest("[class*='Select-container']")));
      return {
      path: "field:" + index,
      tag: customSelect ? "select" : element.tagName.toLocaleLowerCase(),
      inputType: customSelect
        ? "custom-select"
        : element instanceof HTMLInputElement ? element.type : element.tagName.toLocaleLowerCase(),
      required: required(element, fieldName(element)),
      accessibleName: fieldName(element)
    };
    });
  const actions = [...document.querySelectorAll('button, input[type="button"], input[type="submit"], a[href], a[role="button"]')]
    .filter((element) => !unavailable(element) && visible(element) && !internal(element))
    .map((element, index) => ({ path: "action:" + index, kind: element instanceof HTMLInputElement ? "input" : element instanceof HTMLAnchorElement ? "link" : "button", accessibleName: actionName(element) }));
  return { fields, actions };
})()`;

interface RawPageStructure {
  fields: Array<{ path: string; tag: "input" | "textarea" | "select"; inputType: string; required: boolean; accessibleName: string }>;
  actions: Array<{ path: string; kind: "button" | "input" | "link"; accessibleName: string }>;
}

interface BrowserRawFormObservation extends RawFormObservation {
  fields: Array<RawFormObservation["fields"][number] & { registryIndex: number }>;
  actions: Array<RawFormObservation["actions"][number] & { registryIndex: number }>;
}

export interface BrowserObservation {
  snapshot: FormSnapshot;
  registry: DomRegistry;
}

export class BrowserObserver {
  constructor(private readonly page: Page) {}

  async observe(taskId: string): Promise<BrowserObservation> {
    const raw = await this.waitForObservablePage();
    const snapshot = normalizeForm(raw, {
      taskId,
      url: this.page.url(),
      title: await this.page.title(),
      stage: await this.detectStage(raw)
    });
    return {
      snapshot,
      registry: new DomRegistry(snapshot, this.page, {
        fields: raw.fields.map((field) => field.registryIndex),
        actions: raw.actions.map((action) => action.registryIndex)
      })
    };
  }

  private async waitForObservablePage(): Promise<BrowserRawFormObservation> {
    let raw = await this.page.evaluate<BrowserRawFormObservation>(BROWSER_OBSERVATION_SCRIPT);
    const deadline = Date.now() + EMPTY_PAGE_WAIT_CAP_MS;
    const route = this.page.url().toLocaleLowerCase();
    const isFormRoute = /\/(?:apply|application|login)(?:[/?#]|$)/u.test(route);
    while (isFormRoute && raw.fields.length === 0 && raw.errors.length === 0 && Date.now() < deadline) {
      await delay(EMPTY_PAGE_SAMPLE_MS);
      raw = await this.page.evaluate<BrowserRawFormObservation>(BROWSER_OBSERVATION_SCRIPT);
    }
    return raw;
  }

  async observeStructure(): Promise<PageStructure> {
    const raw = await this.page.evaluate<RawPageStructure>(PAGE_STRUCTURE_SCRIPT);
    return {
      url: this.page.url(),
      title: await this.page.title(),
      stage: this.detectStructureStage(raw),
      fields: raw.fields.map((field) => ({
        id: opaqueId("field", field.path),
        type: field.tag === "textarea" ? "textarea" : field.tag === "select" || field.inputType === "custom-select" ? "select" : field.inputType,
        required: field.required,
        accessibleName: field.accessibleName
      })),
      actions: raw.actions.map((action) => ({
        id: opaqueId("action", action.path),
        kind: action.kind,
        accessibleName: action.accessibleName
      }))
    };
  }

  private async detectStage(raw: RawFormObservation): Promise<FormSnapshot["stage"]> {
    const url = this.page.url().toLocaleLowerCase();
    if (/review|confirm|preview/u.test(url)) return "review";
    if (/success|complete|finished/u.test(url)) return "success";
    if (raw.fields.some((field) => field.inputType === "password")) return "login";
    if (raw.fields.length > 0) return "application_form";
    return "unknown";
  }

  private detectStructureStage(raw: RawPageStructure): FormSnapshot["stage"] {
    const url = this.page.url().toLocaleLowerCase();
    if (/review|confirm|preview/u.test(url)) return "review";
    if (/success|complete|finished/u.test(url)) return "success";
    if (raw.fields.some((field) => field.inputType === "password")) return "login";
    if (raw.fields.length > 0) return "application_form";
    return "unknown";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
