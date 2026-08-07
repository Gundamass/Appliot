import type { Locator } from "playwright-core";

export interface CustomSelectResult {
  selectedValue: string;
  recovered: boolean;
}

export async function selectCustomControl(locator: Locator, expected: string): Promise<CustomSelectResult> {
  await locator.click();
  const options = locator.page().locator('[role="option"]:visible, [data-option]:visible, [class*="option"]:visible');
  const count = await options.count();
  const texts = await options.allTextContents();
  const expectedNormalized = normalizeOption(expected);
  const index = texts.findIndex((text) => normalizeOption(text) === expectedNormalized);
  if (index < 0 || index >= count || texts[index] === undefined) throw new Error("custom_option_not_found");
  const selectedValue = normalizeText(texts[index]!);
  await options.nth(index).click();
  return { selectedValue, recovered: selectedValue !== expected };
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function normalizeOption(value: string): string {
  const normalized = normalizeText(value).replace(/[年月日]$/u, "");
  return /^\d{1,2}$/u.test(normalized) ? String(Number(normalized)) : normalized;
}
