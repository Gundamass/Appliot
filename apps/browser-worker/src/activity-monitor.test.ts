import { createHash } from "node:crypto";
import type { WorkerActivity } from "@resume/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createActivityMonitor,
  fingerprintPageStructure,
  opaqueActionIdForIndex,
  opaqueFieldIdForIndex,
  type PageStructure
} from "./activity-monitor.js";

class FakePage {
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  private binding: ((source: unknown, activity: unknown) => void) | undefined;
  readonly calls: string[] = [];

  on(event: string, listener: (...args: any[]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  async evaluate(): Promise<void> {
    this.calls.push("evaluate");
  }

  async addInitScript(): Promise<void> {
    this.calls.push("addInitScript");
  }

  async exposeBinding(
    _name: string,
    callback: (source: unknown, activity: unknown) => void
  ): Promise<void> {
    this.calls.push("exposeBinding");
    this.binding = callback;
  }

  emitNavigation(url: string): void {
    this.emit("framenavigated", { url: () => url });
  }

  emitDomChange(): void {
    this.emitActivity({ kind: "mutation" });
  }

  emitUserInput(index: number, value: string): void {
    this.emitActivity({
      kind: "user_activity",
      index,
      activity: "input",
      value,
      password: value,
      captcha: "captcha-answer",
      label: "Raw DOM label",
      selector: "#password",
      coordinates: { x: 12, y: 24 }
    });
  }

  emitUserClick(index: number): void {
    this.emitActivity({ kind: "user_activity", index, target: "action", activity: "click" });
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }

  emitActivity(activity: object): void {
    this.binding?.({}, activity);
  }

  private emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function structure(version = 1): PageStructure {
  return {
    url: "https://jobs.example/apply",
    title: "Apply",
    stage: "application_form",
    fields: [{ id: `field_${version}`, type: "text", required: true, accessibleName: "Email address" }],
    actions: [{ id: "action_next", kind: "button", accessibleName: "Continue" }]
  } as PageStructure;
}

function fingerprint(value: PageStructure): string {
  return `page_${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("ActivityMonitor", () => {
  it("emits one stable page event after duplicate DOM changes settle", async () => {
    const page = new FakePage();
    const monitor = createActivityMonitor(page, {
      settleMs: 20,
      sampleMs: 10,
      stableWaitCapMs: 100,
      readStructure: async () => structure()
    });
    const events: WorkerActivity[] = [];
    monitor.subscribe((event) => events.push(event));

    await monitor.start("task-1");
    page.emitNavigation("https://jobs.example/apply");
    page.emitDomChange();
    await waitFor(60);

    expect(events.filter((event) => event.type === "page_stable")).toEqual([{
      type: "page_stable",
      taskId: "task-1",
      fingerprint: fingerprint(structure())
    }]);
    monitor.stop();
  });

  it("reports user activity without collecting sensitive page data", async () => {
    const page = new FakePage();
    const monitor = createActivityMonitor(page, { readStructure: async () => structure() });
    const events: WorkerActivity[] = [];
    monitor.subscribe((event) => events.push(event));

    await monitor.start("task-1");
    page.emitUserInput(0, "secret");

    expect(events.filter((event) => event.type === "user_activity")).toEqual([{
      type: "user_activity",
      taskId: "task-1",
      fieldId: opaqueFieldIdForIndex(0),
      activity: "input"
    }]);
    expect(JSON.stringify(events)).not.toMatch(/secret|password|captcha|Raw DOM label|selector|coordinates|#password/);
    monitor.stop();
  });

  it("suppresses worker input events only inside the automation scope", async () => {
    const page = new FakePage();
    const monitor = createActivityMonitor(page, { readStructure: async () => structure() });
    const events: WorkerActivity[] = [];
    monitor.subscribe((event) => events.push(event));

    await monitor.start("task-1");
    await monitor.runAutomation(async () => {
      page.emitUserInput(0, "worker-value");
    });
    page.emitUserInput(0, "manual-value");

    expect(events.filter((event) => event.type === "user_activity")).toEqual([{
      type: "user_activity",
      taskId: "task-1",
      fieldId: opaqueFieldIdForIndex(0),
      activity: "input"
    }]);
    monitor.stop();
  });

  it("suppresses framework input events dispatched just after the automation callback returns", async () => {
    const page = new FakePage();
    const monitor = createActivityMonitor(page, {
      automationEventDrainMs: 20,
      readStructure: async () => structure()
    });
    const events: WorkerActivity[] = [];
    monitor.subscribe((event) => events.push(event));

    await monitor.start("task-1");
    await monitor.runAutomation(async () => {
      setTimeout(() => page.emitUserInput(0, "framework-value"), 5);
    });
    await waitFor(30);
    page.emitUserInput(0, "manual-value");

    expect(events.filter((event) => event.type === "user_activity")).toEqual([{
      type: "user_activity",
      taskId: "task-1",
      fieldId: opaqueFieldIdForIndex(0),
      activity: "input"
    }]);
    monitor.stop();
  });

  it("suppresses delayed browser binding callbacks from an automatic control click", async () => {
    const page = new FakePage();
    const monitor = createActivityMonitor(page, { readStructure: async () => structure() });
    const events: WorkerActivity[] = [];
    monitor.subscribe((event) => events.push(event));

    await monitor.start("task-1");
    await monitor.runAutomation(async () => {
      setTimeout(() => page.emitUserInput(0, "delayed-worker-value"), 80);
    });
    page.emitUserInput(0, "manual-value");
    await waitFor(50);

    expect(events.filter((event) => event.type === "user_activity")).toEqual([{
      type: "user_activity",
      taskId: "task-1",
      fieldId: opaqueFieldIdForIndex(0),
      activity: "input"
    }]);
    monitor.stop();
  });

  it("reports ordinary button and link clicks with opaque action IDs", async () => {
    const page = new FakePage();
    const monitor = createActivityMonitor(page, { readStructure: async () => structure() });
    const events: WorkerActivity[] = [];
    monitor.subscribe((event) => events.push(event));

    await monitor.start("task-1");
    page.emitUserClick(0);
    page.emitUserClick(1);

    expect(events.filter((event) => event.type === "user_activity")).toEqual([
      { type: "user_activity", taskId: "task-1", fieldId: opaqueActionIdForIndex(0), activity: "click" },
      { type: "user_activity", taskId: "task-1", fieldId: opaqueActionIdForIndex(1), activity: "click" }
    ]);
    expect(JSON.stringify(events)).not.toMatch(/button|link|label|selector|coordinates/i);
    monitor.stop();
  });

  it("suppresses worker clicks inside the automation scope", async () => {
    const page = new FakePage();
    const monitor = createActivityMonitor(page, { readStructure: async () => structure() });
    const events: WorkerActivity[] = [];
    monitor.subscribe((event) => events.push(event));

    await monitor.start("task-1");
    await monitor.runAutomation(async () => page.emitUserClick(0));
    page.emitUserClick(1);

    expect(events.filter((event) => event.type === "user_activity")).toEqual([
      { type: "user_activity", taskId: "task-1", fieldId: opaqueActionIdForIndex(1), activity: "click" }
    ]);
    monitor.stop();
  });

  it("resamples and re-emits stability after real input even when structure is unchanged", async () => {
    vi.useFakeTimers();
    const page = new FakePage();
    const monitor = createActivityMonitor(page, {
      settleMs: 5,
      sampleMs: 5,
      stableWaitCapMs: 100,
      readStructure: async () => structure()
    });
    const events: WorkerActivity[] = [];
    monitor.subscribe((event) => events.push(event));

    try {
      await monitor.start("task-1");
      page.emitDomChange();
      await vi.advanceTimersByTimeAsync(10);
      expect(events.filter((event) => event.type === "page_stable")).toHaveLength(1);

      page.emitUserInput(0, "manual-value");
      await vi.advanceTimersByTimeAsync(10);

      expect(events.filter((event) => event.type === "user_activity")).toHaveLength(1);
      expect(events.filter((event) => event.type === "page_stable")).toHaveLength(2);
    } finally {
      monitor.stop();
      vi.useRealTimers();
    }
  });

  it("uses the same opaque field ID as the observed page structure", async () => {
    const page = new FakePage();
    const observed = structure();
    observed.fields[0]!.id = opaqueFieldIdForIndex(0);
    const monitor = createActivityMonitor(page, { readStructure: async () => observed });
    const events: WorkerActivity[] = [];
    monitor.subscribe((event) => events.push(event));

    await monitor.start("task-1");
    page.emitUserInput(0, "secret");

    expect(events).toContainEqual({
      type: "user_activity",
      taskId: "task-1",
      fieldId: observed.fields[0]!.id,
      activity: "input"
    });
    monitor.stop();
  });

  it("rejects malformed page activity instead of forwarding page-controlled fields", async () => {
    const page = new FakePage();
    const monitor = createActivityMonitor(page, { readStructure: async () => structure() });
    const events: WorkerActivity[] = [];
    monitor.subscribe((event) => events.push(event));
    await monitor.start("task-1");

    page.emitActivity({
      kind: "user_activity",
      index: "#password",
      fieldId: "raw-password-field",
      activity: "input",
      value: "secret"
    });

    expect(events).toEqual([]);
    monitor.stop();
  });

  it("emits a bounded unstable activity when structure never settles", async () => {
    const page = new FakePage();
    let version = 0;
    const monitor = createActivityMonitor(page, {
      settleMs: 5,
      sampleMs: 10,
      stableWaitCapMs: 45,
      readStructure: async () => structure(++version)
    });
    const events: WorkerActivity[] = [];
    monitor.subscribe((event) => events.push(event));

    await monitor.start("task-1");
    page.emitDomChange();
    await waitFor(70);

    expect(events.filter((event) => event.type === "page_unstable")).toHaveLength(1);
    monitor.stop();
  });

  it("removes local listeners and timers on stop", async () => {
    const page = new FakePage();
    const monitor = createActivityMonitor(page, {
      settleMs: 20,
      readStructure: async () => structure()
    });
    const events: WorkerActivity[] = [];
    monitor.subscribe((event) => events.push(event));

    await monitor.start("task-1");
    page.emitDomChange();
    monitor.stop();
    await waitFor(30);

    expect(page.listenerCount()).toBe(0);
    expect(events.filter((event) => event.type === "page_stable" || event.type === "page_unstable")).toEqual([]);
  });

  it("uses a 750ms debounce and two samples 500ms apart by default", async () => {
    vi.useFakeTimers();
    const page = new FakePage();
    const readStructure = vi.fn(async () => structure());
    const monitor = createActivityMonitor(page, { readStructure });
    const events: WorkerActivity[] = [];
    monitor.subscribe((event) => events.push(event));
    try {
      await monitor.start("task-1");
      page.emitDomChange();

      await vi.advanceTimersByTimeAsync(749);
      expect(readStructure).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(readStructure).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(499);
      expect(events.some((event) => event.type === "page_stable")).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(readStructure).toHaveBeenCalledTimes(2);
      expect(events.filter((event) => event.type === "page_stable")).toHaveLength(1);
    } finally {
      monitor.stop();
      vi.useRealTimers();
    }
  });

  it("uses a 5s hard cap by default", async () => {
    vi.useFakeTimers();
    const page = new FakePage();
    let version = 0;
    const monitor = createActivityMonitor(page, { readStructure: async () => structure(++version) });
    const events: WorkerActivity[] = [];
    monitor.subscribe((event) => events.push(event));
    try {
      await monitor.start("task-1");
      page.emitDomChange();

      await vi.advanceTimersByTimeAsync(4_999);
      expect(events.some((event) => event.type === "page_unstable")).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(events.filter((event) => event.type === "page_unstable")).toHaveLength(1);
    } finally {
      monitor.stop();
      vi.useRealTimers();
    }
  });

  it("emits a stable event for a new task even when the fingerprint is unchanged", async () => {
    vi.useFakeTimers();
    const page = new FakePage();
    const monitor = createActivityMonitor(page, {
      settleMs: 5,
      sampleMs: 5,
      stableWaitCapMs: 100,
      readStructure: async () => structure()
    });
    const events: WorkerActivity[] = [];
    monitor.subscribe((event) => events.push(event));

    try {
      await monitor.start("task-1");
      page.emitDomChange();
      await vi.advanceTimersByTimeAsync(10);
      await monitor.start("task-2");
      page.emitDomChange();
      await vi.advanceTimersByTimeAsync(10);

      expect(events.filter((event) => event.type === "page_stable").map((event) => event.taskId)).toEqual([
        "task-1",
        "task-2"
      ]);
    } finally {
      monitor.stop();
      vi.useRealTimers();
    }
  });

  it("installs the persistent observer only once across repeated starts", async () => {
    const page = new FakePage();
    const monitor = createActivityMonitor(page, { readStructure: async () => structure() });

    await monitor.start("task-1");
    await monitor.start("task-2");

    expect(page.calls.filter((call) => call === "addInitScript")).toHaveLength(1);
    expect(page.calls.filter((call) => call === "exposeBinding")).toHaveLength(1);
    monitor.stop();
  });

  it("includes accessible names in the fingerprint without emitting them", async () => {
    const first = structure();
    const changed = {
      ...first,
      fields: first.fields.map((field) => ({ ...field, accessibleName: "Phone number" }))
    } as PageStructure;

    expect(fingerprintPageStructure(first)).not.toBe(fingerprintPageStructure(changed));

    const page = new FakePage();
    const monitor = createActivityMonitor(page, {
      settleMs: 5,
      sampleMs: 5,
      stableWaitCapMs: 100,
      readStructure: async () => changed
    });
    const events: WorkerActivity[] = [];
    monitor.subscribe((event) => events.push(event));
    await monitor.start("task-1");
    page.emitDomChange();
    await waitFor(20);

    expect(JSON.stringify(events)).not.toMatch(/Email address|Phone number|Continue/);
    monitor.stop();
  });
});
