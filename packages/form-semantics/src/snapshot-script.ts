export interface RawFormField {
  path: string;
  tag: "input" | "textarea" | "select";
  inputType: string;
  name: string;
  required: boolean;
  value: string | boolean;
  options: string[];
  optionsTruncated?: boolean;
  controlKind?: "native" | "custom";
  interactionMode?: "native" | "search" | "choice_group" | "date_group" | "file";
  explicitLabel: string;
  wrappingLabel: string;
  ariaLabel: string;
  ariaLabelledBy: string;
  nearbyText: string;
}

const MAX_FIELD_OPTIONS = 100;

export interface RawPageAction {
  path: string;
  text: string;
  ariaLabel: string;
  nearbyText: string;
}

export interface RawFormObservation {
  fields: RawFormField[];
  actions: RawPageAction[];
  errors: string[];
}

export function collectRawFormObservation(document: Document): RawFormObservation {
  const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    "input:not([type=hidden]), textarea, select"
  )].filter((element) => !element.disabled).map((element) => fieldObservation(document, element));
  const actions = [...document.querySelectorAll<HTMLElement>(
    'button, input[type="button"], input[type="submit"], a[role="button"]'
  )].filter((element) => !isDisabled(element)).map((element) => ({
    path: elementPath(element),
    text: elementText(element),
    ariaLabel: normalized(element.getAttribute("aria-label")),
    nearbyText: normalized(element.closest("[data-action-context]")?.textContent)
  }));
  const errors = [...document.querySelectorAll<HTMLElement>('[role="alert"], .error, .field-error')]
    .map((element) => normalized(element.textContent))
    .filter(Boolean);
  return { fields, actions, errors };
}

function fieldObservation(
  document: Document,
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
): RawFormField {
  const tag = element.tagName.toLocaleLowerCase() as RawFormField["tag"];
  const explicitLabel = element.id
    ? normalized(document.querySelector<HTMLLabelElement>(`label[for="${cssEscape(element.id)}"]`)?.textContent)
    : "";
  const wrappingLabel = wrappingLabelText(element);
  const labelledBy = normalized((element.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" "));
  const labelText = [explicitLabel, wrappingLabel, normalized(element.getAttribute("aria-label")), labelledBy]
    .filter(Boolean)
    .join(" ");
  const allOptions = element instanceof document.defaultView!.HTMLSelectElement
    ? [...element.options].filter((option) => option.value !== "").map((option) => normalized(option.textContent))
    : [];
  return {
    path: elementPath(element),
    tag,
    inputType: element instanceof document.defaultView!.HTMLInputElement ? element.type : tag,
    name: element.getAttribute("name") ?? "",
    required: element.required
      || (element.getAttribute("aria-required") ?? "").toLocaleLowerCase() === "true"
      || (element.getAttribute("data-required") ?? "").toLocaleLowerCase() === "true"
      || Boolean(element.closest(".ant-form-item-required, .form-item-required, [class*='required']"))
      || /(?:^|\s)[*＊](?:\s|$)/u.test(labelText),
    value: element instanceof document.defaultView!.HTMLInputElement && ["checkbox", "radio"].includes(element.type)
      ? element.checked
      : element.value,
    options: allOptions.slice(0, MAX_FIELD_OPTIONS),
    ...(allOptions.length > MAX_FIELD_OPTIONS ? { optionsTruncated: true } : {}),
    interactionMode: element instanceof document.defaultView!.HTMLInputElement && element.type === "file"
      ? "file"
      : "native",
    explicitLabel,
    wrappingLabel,
    ariaLabel: normalized(element.getAttribute("aria-label")),
    ariaLabelledBy: labelledBy,
    nearbyText: nearbyFieldText(element)
  };
}

function elementPath(element: Element): string {
  const segments: string[] = [];
  let current: Element | null = element;
  while (current && current.tagName.toLocaleLowerCase() !== "html") {
    if (current.id) {
      segments.unshift(`#${current.id}`);
      break;
    }
    const tag = current.tagName.toLocaleLowerCase();
    const siblings = current.parentElement
      ? [...current.parentElement.children].filter((sibling) => sibling.tagName === current!.tagName)
      : [];
    segments.unshift(`${tag}:nth-of-type(${Math.max(1, siblings.indexOf(current) + 1)})`);
    current = current.parentElement;
  }
  return segments.join(" > ");
}

function nearbyFieldText(element: Element): string {
  const previous = element.previousElementSibling;
  if (previous && !previous.matches("input, textarea, select, button")) return normalized(previous.textContent);
  return normalized(element.getAttribute("placeholder"));
}

function wrappingLabelText(element: Element): string {
  const label = element.closest("label");
  if (!label) return "";
  const clone = label.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("input, textarea, select, option, button").forEach((control) => control.remove());
  return normalized(clone.textContent);
}

function elementText(element: HTMLElement): string {
  if (element instanceof element.ownerDocument.defaultView!.HTMLInputElement) return normalized(element.value);
  return normalized(element.textContent);
}

function isDisabled(element: HTMLElement): boolean {
  return "disabled" in element && element.disabled === true;
}

function normalized(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
