import type { FormSnapshot } from "@resume/contracts";
import type { Locator, Page } from "playwright-core";

const FIELD_SELECTOR = "input:not([type=hidden]), textarea, select, [role=combobox], [role=radiogroup]";
const ACTION_SELECTOR = 'button, input[type="button"], input[type="submit"], a[href], a[role="button"]';

interface RegistryIndices {
  fields: number[];
  actions: number[];
}

export class DomRegistry {
  private readonly fields = new Map<string, Locator>();
  private readonly actions = new Map<string, Locator>();

  constructor(readonly snapshot: FormSnapshot, page: Page, indices?: RegistryIndices) {
    const fieldLocators = page.locator(FIELD_SELECTOR);
    snapshot.fields.forEach((field, index) => {
      this.fields.set(field.id, fieldLocators.nth(indices?.fields[index] ?? index));
    });
    const actionLocators = page.locator(ACTION_SELECTOR);
    snapshot.actions.forEach((action, index) => {
      this.actions.set(action.id, actionLocators.nth(indices?.actions[index] ?? index));
    });
  }

  field(fieldId: string): Locator | undefined {
    return this.fields.get(fieldId);
  }

  action(actionId: string): Locator | undefined {
    return this.actions.get(actionId);
  }
}
