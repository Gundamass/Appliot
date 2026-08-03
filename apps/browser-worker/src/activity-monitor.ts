import { createHash, randomUUID } from "node:crypto";
import type { FormSnapshot, WorkerActivity } from "@resume/contracts";
import { opaqueActionIdForIndex, opaqueFieldIdForIndex } from "./opaque-id.js";

const DEFAULT_SETTLE_MS = 750;
const DEFAULT_SAMPLE_MS = 500;
const DEFAULT_STABLE_WAIT_CAP_MS = 5_000;

function activityObserverScript(bindingName: string, automationGuardName: string): string {
  return String.raw`(() => {
  const marker = "__resumeWorkerActivityObserver";
  if (window[marker]) return;
  window[marker] = true;
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
  const fields = () => [...document.querySelectorAll("input:not([type=hidden]), textarea, select")]
    .filter((element) => visible(element) && !unavailable(element) && !internal(element));
  const actionSelector = 'button, input[type="button"], input[type="submit"], a[href], a[role="button"]';
  const actions = () => [...document.querySelectorAll(actionSelector)]
    .filter((element) => visible(element) && !unavailable(element) && !internal(element));
  const emit = (activity) => window[${JSON.stringify(bindingName)}]?.(activity);
  new MutationObserver(() => emit({ kind: "mutation" })).observe(document, { childList: true, subtree: true, attributes: true });
  for (const type of ["input", "change", "click"]) {
    document.addEventListener(type, (event) => {
      if (window[${JSON.stringify(automationGuardName)}] > 0) return;
      const target = event.target instanceof Element ? event.target : null;
      if (type === "click") {
        const actionIndex = actions().indexOf(target?.closest(actionSelector) ?? null);
        if (actionIndex >= 0) {
          emit({ kind: "user_activity", target: "action", index: actionIndex, activity: "click" });
          return;
        }
      }
      const fieldIndex = fields().indexOf(target?.closest("input, textarea, select") ?? null);
      if (fieldIndex >= 0) emit({ kind: "user_activity", target: "field", index: fieldIndex, activity: type });
    }, true);
  }
})()`;
}

interface ActivityPage {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  evaluate(...args: any[]): Promise<unknown>;
  addInitScript?(script: string): Promise<unknown>;
  exposeBinding?(name: string, callback: (source: unknown, activity: unknown) => void): Promise<unknown>;
  mainFrame?: () => unknown;
}

export interface PageStructure {
  url: string;
  title: string;
  stage: FormSnapshot["stage"];
  fields: Array<{ id: string; type: string; required: boolean; accessibleName: string }>;
  actions: Array<{ id: string; kind: "button" | "input" | "link"; accessibleName: string }>;
}

export interface ActivityMonitorOptions {
  settleMs?: number;
  sampleMs?: number;
  stableWaitCapMs?: number;
  readStructure?: () => Promise<PageStructure>;
}

export type WorkerActivityListener = (activity: WorkerActivity) => void;

export function fingerprintPageStructure(structure: PageStructure): string {
  const source = JSON.stringify({
    url: structure.url,
    title: structure.title,
    stage: structure.stage,
    fields: structure.fields.map(({ id, type, required, accessibleName }) => ({ id, type, required, accessibleName })),
    actions: structure.actions.map(({ id, kind, accessibleName }) => ({ id, kind, accessibleName }))
  });
  return `page_${createHash("sha256").update(source, "utf8").digest("hex")}`;
}

export { opaqueActionIdForIndex, opaqueFieldIdForIndex } from "./opaque-id.js";

export class ActivityMonitor {
  private readonly page: ActivityPage;
  private readonly listeners = new Set<WorkerActivityListener>();
  private readonly settleMs: number;
  private readonly sampleMs: number;
  private readonly stableWaitCapMs: number;
  private readonly readStructure: () => Promise<PageStructure>;
  private taskId: string | undefined;
  private changeTimer: NodeJS.Timeout | undefined;
  private capTimer: NodeJS.Timeout | undefined;
  private waitingSince: number | undefined;
  private generation = 0;
  private lastFingerprint: string | undefined;
  private lastStableFingerprint: string | undefined;
  private pageChangedEmitted = false;
  private readonly bindingName = `__resumeWorkerActivity_${randomUUID().replaceAll("-", "")}`;
  private readonly automationGuardName = `__resumeWorkerAutomation_${randomUUID().replaceAll("-", "")}`;
  private automationDepth = 0;
  private forceStableEmission = false;
  private bindingExposed = false;
  private initScriptInstalled = false;
  private readonly onFrameNavigated = (frame: unknown) => {
    if (this.page.mainFrame && frame !== this.page.mainFrame()) return;
    this.markChanged();
  };
  private readonly onLocalActivity = (rawActivity: unknown) => {
    const activity = parseLocalActivity(rawActivity);
    if (!activity) return;
    if (activity.kind === "mutation") {
      this.markChanged();
      return;
    }
    if (this.taskId) {
      if (this.automationDepth > 0) return;
      this.emit({
        type: "user_activity",
        taskId: this.taskId,
        fieldId: activity.target === "action"
          ? opaqueActionIdForIndex(activity.index)
          : opaqueFieldIdForIndex(activity.index),
        activity: activity.activity
      });
      this.forceStableEmission = true;
      this.markChanged();
    }
  };

  constructor(page: unknown, options: ActivityMonitorOptions = {}) {
    this.page = page as ActivityPage;
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.sampleMs = options.sampleMs ?? DEFAULT_SAMPLE_MS;
    this.stableWaitCapMs = options.stableWaitCapMs ?? DEFAULT_STABLE_WAIT_CAP_MS;
    if (!options.readStructure) throw new Error("ActivityMonitor requires a read-only page structure reader");
    this.readStructure = options.readStructure;
  }

  start(taskId: string): Promise<void> {
    this.stopMonitoring();
    this.taskId = taskId;
    this.lastFingerprint = undefined;
    this.lastStableFingerprint = undefined;
    this.page.on("framenavigated", this.onFrameNavigated);
    return this.installObserver();
  }

  stop(): void {
    this.stopMonitoring();
    this.taskId = undefined;
    this.listeners.clear();
  }

  subscribe(listener: WorkerActivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async runAutomation<T>(operation: () => Promise<T>): Promise<T> {
    this.automationDepth += 1;
    await this.setPageAutomationDepth(1);
    try {
      return await operation();
    } finally {
      await this.setPageAutomationDepth(-1);
      this.automationDepth = Math.max(0, this.automationDepth - 1);
    }
  }

  private markChanged(): void {
    if (!this.taskId) return;
    const now = Date.now();
    this.generation += 1;
    if (this.waitingSince === undefined) {
      this.waitingSince = now;
      this.capTimer = setTimeout(() => this.emitUnstable(), this.stableWaitCapMs);
    }
    if (!this.pageChangedEmitted) {
      this.emit({ type: "page_changed", taskId: this.taskId });
      this.pageChangedEmitted = true;
    }
    if (this.changeTimer) clearTimeout(this.changeTimer);
    const remaining = Math.max(0, this.stableWaitCapMs - (now - this.waitingSince));
    this.changeTimer = setTimeout(() => void this.sample(this.generation), Math.min(this.settleMs, remaining));
  }

  private async installObserver(): Promise<void> {
    try {
      if (!this.bindingExposed && this.page.exposeBinding) {
        await this.page.exposeBinding(this.bindingName, (_source, activity) => this.onLocalActivity(activity));
        this.bindingExposed = true;
      }
      const script = activityObserverScript(this.bindingName, this.automationGuardName);
      if (!this.initScriptInstalled && this.page.addInitScript) {
        await this.page.addInitScript(script);
        this.initScriptInstalled = true;
      }
      await this.page.evaluate(script);
    } catch {
      // A navigation can destroy the current evaluation; the init script covers the next document.
    }
  }

  private async sample(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    try {
      const first = await this.readStructure();
      const firstFingerprint = fingerprintPageStructure(first);
      this.lastFingerprint = firstFingerprint;
      await delay(this.sampleMs);
      if (!this.isCurrent(generation)) return;
      const second = await this.readStructure();
      const secondFingerprint = fingerprintPageStructure(second);
      this.lastFingerprint = secondFingerprint;
      if (firstFingerprint === secondFingerprint) {
        if ((this.forceStableEmission || secondFingerprint !== this.lastStableFingerprint) && this.taskId) {
          this.emit({ type: "page_stable", taskId: this.taskId, fingerprint: secondFingerprint });
          this.lastStableFingerprint = secondFingerprint;
          this.forceStableEmission = false;
        }
        this.clearWaiting();
        return;
      }
      this.scheduleNextSample(generation);
    } catch {
      this.scheduleNextSample(generation);
    }
  }

  private scheduleNextSample(generation: number): void {
    if (!this.isCurrent(generation) || this.waitingSince === undefined) return;
    const elapsed = Date.now() - this.waitingSince;
    if (elapsed >= this.stableWaitCapMs) {
      this.emitUnstable();
      return;
    }
    this.changeTimer = setTimeout(() => void this.sample(generation), this.sampleMs);
  }

  private emitUnstable(): void {
    if (!this.taskId || this.waitingSince === undefined) return;
    const fingerprint = this.lastFingerprint ?? fingerprintPageStructure({
      url: "",
      title: "",
      stage: "unknown",
      fields: [],
      actions: []
    });
    this.emit({ type: "page_unstable", taskId: this.taskId, fingerprint });
    this.clearWaiting();
  }

  private isCurrent(generation: number): boolean {
    return this.taskId !== undefined && generation === this.generation && this.waitingSince !== undefined;
  }

  private clearWaiting(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    if (this.capTimer) clearTimeout(this.capTimer);
    this.changeTimer = undefined;
    this.capTimer = undefined;
    this.waitingSince = undefined;
    this.pageChangedEmitted = false;
  }

  private stopMonitoring(): void {
    this.clearWaiting();
    this.page.off("framenavigated", this.onFrameNavigated);
    this.generation += 1;
    this.forceStableEmission = false;
  }

  private async setPageAutomationDepth(change: 1 | -1): Promise<void> {
    try {
      await this.page.evaluate(({ name, delta }: { name: string; delta: number }) => {
        const scope = window as unknown as Record<string, unknown>;
        const current = typeof scope[name] === "number" ? scope[name] as number : 0;
        scope[name] = Math.max(0, current + delta);
      }, { name: this.automationGuardName, delta: change });
    } catch {
      // Navigation can destroy the page while an operation finishes; Worker-local depth still unwinds.
    }
  }

  private emit(activity: WorkerActivity): void {
    for (const listener of this.listeners) listener(activity);
  }
}

export function createActivityMonitor(page: unknown, options: ActivityMonitorOptions): ActivityMonitor {
  return new ActivityMonitor(page, options);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseLocalActivity(value: unknown): { kind: "mutation" } | {
  kind: "user_activity";
  target: "field" | "action";
  index: number;
  activity: "input" | "change" | "click";
} | undefined {
  try {
    if (!value || typeof value !== "object") return undefined;
    if ((value as { kind?: unknown }).kind === "mutation") return { kind: "mutation" };
    const activity = value as { kind?: unknown; target?: unknown; index?: unknown; activity?: unknown };
    if (activity.kind !== "user_activity" || typeof activity.index !== "number" || !Number.isInteger(activity.index) || activity.index < 0) return undefined;
    if (activity.activity !== "input" && activity.activity !== "change" && activity.activity !== "click") return undefined;
    const target = activity.target ?? "field";
    if (target !== "field" && target !== "action") return undefined;
    if (target === "action" && activity.activity !== "click") return undefined;
    return { kind: "user_activity", target, index: activity.index, activity: activity.activity };
  } catch { return undefined; }
}
