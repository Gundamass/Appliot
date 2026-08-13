import type { Locator } from "playwright-core";

export interface CustomSelectResult {
  selectedValue: string;
  recovered: boolean;
}

export async function selectCustomControl(locator: Locator, expected: string): Promise<CustomSelectResult> {
  await locator.click();
  const options = locator.page().locator('[role="option"]:visible, [data-option]:visible, [class*="option"]:visible, [class*="Select-menu-item"]:visible, [class*="Select-item"]:visible, [class*="Menu-content-item"]:visible');
  const searchable = await locator.evaluate((element) => element instanceof HTMLInputElement
    && (element.getAttribute("role")?.toLocaleLowerCase() === "combobox"
      || element.hasAttribute("aria-autocomplete")));
  if (searchable) {
    await locator.fill(expected);
    await options.first().waitFor({ state: "visible", timeout: 1_500 }).catch(() => undefined);
  }
  const count = await options.count();
  const texts = await options.allTextContents();
  const expectedNormalized = normalizeOption(expected);
  const index = texts.findIndex((text) => normalizeOption(text) === expectedNormalized);
  if (index < 0 || index >= count || texts[index] === undefined) {
    await locator.press("Escape").catch(() => undefined);
    throw new Error("custom_option_not_found");
  }
  const selectedValue = normalizeText(texts[index]!);
  await options.nth(index).click();
  await locator.page().waitForTimeout(0);
  const readback = normalizeText(await locator.evaluate((element) => {
    if (!(element instanceof HTMLInputElement)) return element.textContent ?? "";
    if (element.value.trim() !== "") return element.value;
    return element.closest("label")?.textContent ?? "";
  }));
  if (normalizeOption(readback) !== normalizeOption(expected)) {
    throw new Error("custom_readback_mismatch");
  }
  return { selectedValue, recovered: selectedValue !== expected };
}

export async function selectChoiceGroup(locator: Locator, expected: string): Promise<string> {
  const nativeRadio = await locator.evaluate((element) =>
    element instanceof HTMLInputElement && element.type === "radio");
  let choices: Locator;
  if (nativeRadio) {
    const fieldset = locator.locator("xpath=ancestor::fieldset[1]");
    if (await fieldset.count() > 0) {
      choices = fieldset.locator('input[type="radio"]');
    } else {
      const name = await locator.getAttribute("name");
      choices = name === null
        ? locator.page().locator('input[type="radio"]')
        : locator.page().locator(`input[type="radio"][name=${JSON.stringify(name)}]`);
    }
  } else {
    choices = locator.locator('[role="radio"]');
  }

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
  if (nativeRadio) await selected.check();
  else await selected.click();
  return matches[0]!.text;
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
