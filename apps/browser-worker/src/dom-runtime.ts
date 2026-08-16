import type { Page } from "playwright-core";

export interface DomRuntimeState {
  documentId: string;
  epoch: number;
}

export const DOM_RUNTIME_SCRIPT = String.raw`(() => {
  const runtimeKey = "__resumeDomRuntime";
  if (Object.prototype.hasOwnProperty.call(window, runtimeKey)) return;

  const fieldSelector = "input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]), textarea, select, [role=combobox], [role=radiogroup]";
  const actionSelector = 'button, input[type="button"], input[type="submit"], a[href], a[role="button"]';
  const interactiveSelector = fieldSelector + ", " + actionSelector;
  const formContainerSelector = "form, fieldset, [role=form], .ant-form, .form, [class*='form-']";
  const randomUuid = () => {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
    return hex.slice(0, 4).join("") + "-" + hex.slice(4, 6).join("") + "-"
      + hex.slice(6, 8).join("") + "-" + hex.slice(8, 10).join("") + "-"
      + hex.slice(10).join("");
  };
  const ids = new WeakMap();
  const lastRelevantMutationAt = new WeakMap();
  const runtime = {
    documentId: "document-" + randomUuid(),
    epoch: 0,
    ids,
    lastRelevantMutationAt,
    nodeId(element) {
      if (!(element instanceof Element)) throw new TypeError("node_identity_requires_element");
      let id = ids.get(element);
      if (id === undefined) {
        id = "node-" + randomUuid();
        ids.set(element, id);
      }
      return id;
    }
  };

  Object.defineProperty(window, runtimeKey, {
    value: runtime,
    enumerable: false,
    configurable: false,
    writable: false
  });

  const identityAttribute = (name) => name === "type"
    || name === "role"
    || name === "name"
    || name === "disabled"
    || name === "readonly"
    || name.startsWith("aria-");
  const elementContainsInteractive = (node) => node instanceof Element
    && (node.matches(interactiveSelector) || node.querySelector(interactiveSelector) !== null);
  const nearestFormContainer = (element) => element.closest(formContainerSelector);
  const relevantMutation = (mutation) => {
    const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
    if (target === null) return false;
    if (mutation.type === "attributes") {
      return identityAttribute(mutation.attributeName ?? "")
        && (target.matches(interactiveSelector) || nearestFormContainer(target) !== null);
    }
    return target.matches(interactiveSelector)
      || nearestFormContainer(target) !== null
      || [...mutation.addedNodes, ...mutation.removedNodes].some(elementContainsInteractive);
  };
  const markMutation = (mutation, timestamp) => {
    const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
    if (target !== null) {
      lastRelevantMutationAt.set(target, timestamp);
      const container = nearestFormContainer(target);
      if (container !== null) lastRelevantMutationAt.set(container, timestamp);
    }
    for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
      if (!(node instanceof Element)) continue;
      lastRelevantMutationAt.set(node, timestamp);
      for (const element of node.querySelectorAll(interactiveSelector)) {
        lastRelevantMutationAt.set(element, timestamp);
      }
    }
  };

  new MutationObserver((mutations) => {
    const relevant = mutations.filter(relevantMutation);
    if (relevant.length === 0) return;
    runtime.epoch += 1;
    const timestamp = Date.now();
    for (const mutation of relevant) markMutation(mutation, timestamp);
  }).observe(document, {
    attributes: true,
    childList: true,
    subtree: true
  });
})()`;

const initializedPages = new WeakSet<Page>();

export async function installDomRuntime(page: Page): Promise<void> {
  if (!initializedPages.has(page)) {
    await page.addInitScript({ content: DOM_RUNTIME_SCRIPT });
    initializedPages.add(page);
  }
  await page.evaluate(DOM_RUNTIME_SCRIPT);
}

export async function readDomRuntime(page: Page): Promise<DomRuntimeState> {
  return page.evaluate(() => {
    const runtime = (window as unknown as {
      __resumeDomRuntime?: { documentId: string; epoch: number };
    }).__resumeDomRuntime;
    if (runtime === undefined) throw new Error("dom_runtime_missing");
    return { documentId: runtime.documentId, epoch: runtime.epoch };
  });
}
