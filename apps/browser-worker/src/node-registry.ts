import type { FormSnapshot, NodeRef } from "@resume/contracts";
import type { ElementHandle, Locator, Page } from "playwright-core";
import { readDomRuntime } from "./dom-runtime.js";

export const FIELD_SELECTOR = "input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]), textarea, select, [role=combobox], [role=radiogroup]";
export const ACTION_SELECTOR = 'button, input[type="button"], input[type="submit"], a[href], a[role="button"]';

export type NodeRole = "field" | "action";

export interface NodeCaptureBindings {
  fields: Locator[];
  actions: Locator[];
}

interface CapturedNode {
  handle: ElementHandle<Element>;
  ref: NodeRef;
  role: NodeRole;
}

export class NodeRegistryError extends Error {
  constructor(readonly code:
    | "observation_changed"
    | "stale_node_ref"
    | "node_role_changed"
    | "control_unstable"
    | "execution_invalidated") {
    super(code);
    this.name = "NodeRegistryError";
  }
}

export class PreparedNode {
  constructor(
    readonly page: Page,
    readonly handle: ElementHandle<Element>,
    readonly ref: NodeRef,
    readonly role: NodeRole
  ) {}

  evaluate<R>(pageFunction: (element: Element) => R | Promise<R>): Promise<R>;
  evaluate<R, A>(
    pageFunction: (element: Element, arg: A) => R | Promise<R>,
    arg: A
  ): Promise<R>;
  evaluate<R, A>(
    pageFunction: (element: Element, arg: A) => R | Promise<R>,
    arg?: A
  ): Promise<R> {
    const evaluate = this.handle.evaluate as unknown as (
      fn: (element: Element, value: A) => R | Promise<R>,
      value: A | undefined
    ) => Promise<R>;
    return evaluate.call(this.handle, pageFunction, arg);
  }

  click(options?: { force?: boolean }): Promise<void> {
    return this.handle.click(options);
  }

  fill(value: string): Promise<void> {
    return this.handle.fill(value);
  }

  blur(): Promise<void> {
    return this.handle.evaluate((element) => {
      if (element instanceof HTMLElement) element.blur();
    });
  }

  setChecked(checked: boolean): Promise<void> {
    return this.handle.setChecked(checked);
  }

  check(): Promise<void> {
    return this.handle.check();
  }

  selectOption(option: { label: string }): Promise<string[]> {
    return this.handle.selectOption(option);
  }

  setInputFiles(filePath: string): Promise<void> {
    return this.handle.setInputFiles(filePath);
  }

  press(key: string): Promise<void> {
    return this.handle.press(key);
  }

  getAttribute(name: string): Promise<string | null> {
    return this.handle.getAttribute(name);
  }

  async waitForStableWindow(
    stableMs: number,
    capMs: number,
    isCurrent: () => boolean
  ): Promise<void> {
    const startedAt = Date.now();
    const deadline = startedAt + capMs;
    let stableSince = startedAt;

    while (Date.now() < deadline) {
      if (!isCurrent()) throw new NodeRegistryError("execution_invalidated");
      const state = await this.readState();
      this.assertUsable(state);
      stableSince = Math.max(stableSince, state.lastRelevantMutationAt);
      const remaining = stableMs - (Date.now() - stableSince);
      if (remaining <= 0) return;
      await this.page.waitForTimeout(Math.min(50, remaining));
    }
    if (!isCurrent()) throw new NodeRegistryError("execution_invalidated");
    this.assertUsable(await this.readState());
    throw new NodeRegistryError("control_unstable");
  }

  async readValue(): Promise<unknown> {
    const state = await this.readState(true);
    this.assertUsable(state);
    return state.value;
  }

  private async readState(includeValue = false): Promise<PreparedNodeState> {
    const state = await this.handle.evaluate((element, input) => {
      const runtime = (window as unknown as {
        __resumeDomRuntime?: {
          documentId: string;
          nodeId(target: Element): string;
          lastRelevantMutationAt: WeakMap<Element, number>;
        };
      }).__resumeDomRuntime;
      const fieldSelector = "input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]), textarea, select, [role=combobox], [role=radiogroup]";
      const actionSelector = 'button, input[type="button"], input[type="submit"], a[href], a[role="button"]';
      const formContainer = element.closest("form, fieldset, [role=form], .ant-form, .form, [class*='form-']");
      const targetMutationAt = runtime?.lastRelevantMutationAt.get(element) ?? 0;
      const containerMutationAt = formContainer === null
        ? 0
        : runtime?.lastRelevantMutationAt.get(formContainer) ?? 0;
      let value: unknown;
      if (input.includeValue) {
        if (element instanceof HTMLInputElement) {
          if (element.type === "checkbox") value = element.checked;
          else if (element.type === "radio") {
            const choices = element.name !== ""
              ? [...document.querySelectorAll('input[type="radio"]')]
                  .filter((candidate) => candidate instanceof HTMLInputElement && candidate.name === element.name)
              : [...(element.closest("fieldset")?.querySelectorAll('input[type="radio"]') ?? [element])];
            const selected = choices.find((candidate) => candidate instanceof HTMLInputElement && candidate.checked);
            value = selected instanceof HTMLInputElement
              ? [...selected.labels ?? []].map((label) => label.textContent ?? "").join(" ")
                  .normalize("NFKC").replace(/\s+/gu, " ").trim()
                || selected.getAttribute("aria-label")
                || selected.value
              : "";
          }
          else if (element.type === "file") value = element.files?.[0]?.name ?? "";
          else {
            const displayValue = element.closest('[class*="Select-container"]')
              ?.querySelector('[class*="Input-display-value"]')?.textContent?.trim();
            value = displayValue || element.value;
          }
        } else if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
          value = element.value;
        } else if (element.getAttribute("role")?.toLocaleLowerCase() === "radiogroup") {
          const selected = element.querySelector('[role="radio"][aria-checked="true"]');
          value = selected?.getAttribute("aria-label")
            || selected?.textContent?.normalize("NFKC").replace(/\s+/gu, " ").trim()
            || selected?.getAttribute("data-value")
            || "";
        } else {
          value = element.textContent?.normalize("NFKC").replace(/\s+/gu, " ").trim() ?? "";
        }
      }
      return {
        connected: element.isConnected,
        documentId: runtime?.documentId,
        nodeId: runtime?.nodeId(element),
        roleMatches: input.role === "field"
          ? element.matches(fieldSelector)
          : element.matches(actionSelector) && element.closest('[role="radiogroup"]') === null,
        lastRelevantMutationAt: Math.max(targetMutationAt, containerMutationAt),
        value
      };
    }, { includeValue, role: this.role }).catch(() => undefined);
    if (state === undefined) throw new NodeRegistryError("stale_node_ref");
    return state;
  }

  private assertUsable(state: PreparedNodeState): void {
    if (!state.connected
      || state.documentId !== this.ref.documentId
      || state.nodeId !== this.ref.nodeId) {
      throw new NodeRegistryError("stale_node_ref");
    }
    if (!state.roleMatches) throw new NodeRegistryError("node_role_changed");
  }
}

interface PreparedNodeState {
  connected: boolean;
  documentId: string | undefined;
  nodeId: string | undefined;
  roleMatches: boolean;
  lastRelevantMutationAt: number;
  value: unknown;
}

export class NodeRegistry {
  private readonly nodes = new Map<string, CapturedNode>();
  private released = false;

  private constructor(readonly snapshot: FormSnapshot, private readonly page: Page) {}

  static async capture(
    snapshot: FormSnapshot,
    page: Page,
    bindings: NodeCaptureBindings
  ): Promise<NodeRegistry> {
    const registry = new NodeRegistry(snapshot, page);
    const captured: CapturedNode[] = [];
    try {
      if (bindings.fields.length !== snapshot.fields.length
        || bindings.actions.length !== snapshot.actions.length) {
        throw new NodeRegistryError("observation_changed");
      }
      const before = await readDomRuntime(page);
      if (before.documentId !== snapshot.frameRef.documentId || before.epoch !== snapshot.mutationEpoch) {
        throw new NodeRegistryError("observation_changed");
      }

      for (let index = 0; index < snapshot.fields.length; index += 1) {
        const field = snapshot.fields[index]!;
        captured.push(await captureNode(page, field.nodeRef, "field", bindings.fields[index]!));
      }
      for (let index = 0; index < snapshot.actions.length; index += 1) {
        const action = snapshot.actions[index]!;
        captured.push(await captureNode(page, action.nodeRef, "action", bindings.actions[index]!));
      }

      const after = await readDomRuntime(page);
      if (after.documentId !== before.documentId || after.epoch !== before.epoch) {
        throw new NodeRegistryError("observation_changed");
      }
      for (const node of captured) registry.add(node);
      return registry;
    } catch (error) {
      await Promise.all(captured.map((node) => node.handle.dispose().catch(() => undefined)));
      if (error instanceof NodeRegistryError) throw error;
      throw new NodeRegistryError("observation_changed");
    }
  }

  async prepare(ref: NodeRef, expectedEpoch: number, role: NodeRole): Promise<PreparedNode> {
    if (this.released) throw new NodeRegistryError("stale_node_ref");
    const node = this.nodes.get(nodeKey(ref));
    if (node === undefined
      || node.ref.documentId !== ref.documentId
      || node.ref.nodeId !== ref.nodeId
      || node.ref.observedAt !== ref.observedAt) {
      throw new NodeRegistryError("stale_node_ref");
    }

    const state = await node.handle.evaluate((element, expectedRole) => {
      const runtime = (window as unknown as {
        __resumeDomRuntime?: {
          documentId: string;
          epoch: number;
          nodeId(target: Element): string;
        };
      }).__resumeDomRuntime;
      const fieldSelector = "input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]), textarea, select, [role=combobox], [role=radiogroup]";
      const actionSelector = 'button, input[type="button"], input[type="submit"], a[href], a[role="button"]';
      return {
        connected: element.isConnected,
        documentId: runtime?.documentId,
        epoch: runtime?.epoch,
        nodeId: runtime?.nodeId(element),
        roleMatches: expectedRole === "field"
          ? element.matches(fieldSelector)
          : element.matches(actionSelector) && element.closest('[role="radiogroup"]') === null
      };
    }, role).catch(() => undefined);

    if (state === undefined
      || !state.connected
      || state.documentId !== ref.documentId
      || state.nodeId !== ref.nodeId) {
      throw new NodeRegistryError("stale_node_ref");
    }
    if (node.role !== role || !state.roleMatches) {
      throw new NodeRegistryError("node_role_changed");
    }
    if (expectedEpoch !== ref.observedAt || state.epoch !== expectedEpoch) {
      throw new NodeRegistryError("stale_node_ref");
    }
    return new PreparedNode(this.page, node.handle, ref, role);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const handles = [...this.nodes.values()].map((node) => node.handle);
    this.nodes.clear();
    await Promise.all(handles.map((handle) => handle.dispose().catch(() => undefined)));
  }

  private add(node: CapturedNode): void {
    this.nodes.set(nodeKey(node.ref), node);
  }
}

async function captureNode(
  page: Page,
  ref: NodeRef,
  role: NodeRole,
  locator: Locator
): Promise<CapturedNode> {
  const handle = await locator.elementHandle();
  if (handle === null) throw new NodeRegistryError("observation_changed");
  const identity = await handle.evaluate((element) => {
    const runtime = (window as unknown as {
      __resumeDomRuntime?: {
        documentId: string;
        epoch: number;
        nodeId(target: Element): string;
      };
    }).__resumeDomRuntime;
    return runtime === undefined ? undefined : {
      connected: element.isConnected,
      documentId: runtime.documentId,
      epoch: runtime.epoch,
      nodeId: runtime.nodeId(element)
    };
  }).catch(() => undefined);
  if (identity === undefined
    || !identity.connected
    || identity.documentId !== ref.documentId
    || identity.nodeId !== ref.nodeId
    || identity.epoch !== ref.observedAt) {
    await handle.dispose().catch(() => undefined);
    throw new NodeRegistryError("observation_changed");
  }
  return { handle: handle as ElementHandle<Element>, ref, role };
}

function nodeKey(ref: NodeRef): string {
  return `${ref.documentId}\u0000${ref.nodeId}`;
}
