import { EventEmitter } from "node:events";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  context: undefined as FakeContext | undefined,
  executorPages: [] as FakePage[],
  executorTraces: [] as unknown[],
  executorInvalidations: [] as string[],
  onExecutorInvalidate: undefined as (() => void) | undefined,
  jobObserverPages: [] as FakePage[],
  jobFilterPlans: [] as unknown[],
  jobAdvanceCursors: [] as Array<string | undefined>
}));

class FakePage extends EventEmitter {
  private closed = false;
  routeCalls = 0;
  unrouteCalls = 0;

  constructor(readonly name: string, private readonly host = `${name}.example`) {
    super();
  }

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
  }

  async goto(): Promise<void> {}

  async route(): Promise<void> { this.routeCalls += 1; }

  async unroute(): Promise<void> { this.unrouteCalls += 1; }

  async addInitScript(): Promise<void> {}

  async evaluate(): Promise<void> {}

  url(): string {
    if (this.closed) throw new Error(`页面 ${this.name} 已关闭`);
    return `https://${this.host}/apply`;
  }

  async title(): Promise<string> {
    return this.name;
  }
}

class FakeContext extends EventEmitter {
  private readonly openPages: FakePage[];
  closeCalls = 0;

  constructor(...pages: FakePage[]) {
    super();
    this.openPages = pages;
  }

  pages(): FakePage[] {
    return this.openPages.filter((page) => !page.isClosed());
  }

  async newPage(): Promise<FakePage> {
    const page = new FakePage(`new-${this.openPages.length + 1}`);
    this.openPages.push(page);
    this.emit("page", page);
    return page;
  }

  addPage(page: FakePage): void {
    this.openPages.push(page);
    this.emit("page", page);
  }

  async close(): Promise<void> { this.closeCalls += 1; }
}

vi.mock("playwright-core", () => ({
  chromium: {
    executablePath: vi.fn(() => process.execPath),
    launchPersistentContext: vi.fn(async () => runtime.context)
  }
}));

vi.mock("./observer.js", () => ({
  BrowserObserver: class {
    constructor(readonly page: FakePage) {}

    async observeStructure() {
      return { url: this.page.url(), title: await this.page.title(), stage: "application_form", fields: [], actions: [] };
    }
  }
}));

vi.mock("./activity-monitor.js", () => ({
  ActivityMonitor: class {
    constructor(readonly page: FakePage) {}
    async start(): Promise<void> {}
    stop(): void {}
    subscribe(): () => void { return () => undefined; }
    async runAutomation<T>(operation: () => Promise<T>): Promise<T> { return operation(); }
  }
}));

vi.mock("./executor.js", () => ({
  ControlledExecutor: class {
    private snapshotId = "";

    constructor(
      private readonly observer: { page: FakePage },
      _approvalKey: unknown,
      _fileResolver: unknown,
      _activityMonitor: unknown,
      trace: unknown
    ) {
      runtime.executorPages.push(observer.page);
      runtime.executorTraces.push(trace);
    }

    async release(): Promise<void> {}

    async invalidate(taskId: string): Promise<void> {
      runtime.executorInvalidations.push(taskId);
      runtime.onExecutorInvalidate?.();
    }

    async observe(taskId: string) {
      this.snapshotId = `snapshot-${this.observer.page.name}`;
      return {
        type: "snapshot",
        id: this.snapshotId,
        taskId,
        url: this.observer.page.url(),
        title: this.observer.page.name,
        stage: "application_form",
        fields: [],
        actions: [],
        errors: []
      };
    }

    async execute(command: { taskId: string; type: string }, isCurrent: () => boolean = () => true) {
      const snapshot = await this.observe(command.taskId);
      return {
        type: "execution_result",
        taskId: command.taskId,
        snapshotId: this.snapshotId,
        commandType: command.type,
        status: isCurrent() ? "applied" : "blocked",
        snapshot,
        actualValue: null,
        errors: isCurrent() ? [] : ["execution_invalidated"]
      };
    }
  }
}));

vi.mock("./job-observer.js", () => ({
  JobObserver: class {
    constructor(private readonly page: FakePage) {
      runtime.jobObserverPages.push(page);
    }
    async observe(ownerId: string) {
      return jobSnapshot(ownerId, this.page.name === "popup" ? 2 : 1);
    }
    async applyFilters(ownerId: string, plan: unknown) {
      runtime.jobFilterPlans.push(plan);
      return { ...jobSnapshot(ownerId, 1), filterState: [{ key: "location", values: ["深圳"] }] };
    }
    async advance(ownerId: string, cursor?: string) {
      runtime.jobAdvanceCursors.push(cursor);
      return jobSnapshot(ownerId, 2);
    }
  }
}));

import { BrowserSessionManager, resolveExecutablePath } from "./session-manager.js";

const executablePath = process.execPath;
const approvalKey = Buffer.alloc(32).toString("base64url");
const originalBrowserExecutable = process.env.RESUME_BROWSER_EXECUTABLE;

afterEach(() => {
  if (originalBrowserExecutable === undefined) delete process.env.RESUME_BROWSER_EXECUTABLE;
  else process.env.RESUME_BROWSER_EXECUTABLE = originalBrowserExecutable;
  vi.mocked(chromium.executablePath).mockClear();
});

describe("browser executable resolution", () => {
  it("prefers Playwright's matching Chromium when no explicit path is configured", () => {
    delete process.env.RESUME_BROWSER_EXECUTABLE;

    expect(resolveExecutablePath()).toBe(process.execPath);
    expect(chromium.executablePath).toHaveBeenCalledTimes(1);
  });

  it("keeps an explicit executable ahead of Playwright's Chromium", () => {
    process.env.RESUME_BROWSER_EXECUTABLE = process.execPath;

    expect(resolveExecutablePath(import.meta.filename)).toBe(import.meta.filename);
    expect(chromium.executablePath).not.toHaveBeenCalled();
  });
});

it("replaces and disposes the main-document response listener with each page lifecycle", async () => {
  const initial = new FakePage("initial");
  const context = new FakeContext(initial);
  const manager = createManager(context);
  await manager.start(approvalKey);
  expect(initial.listenerCount("response")).toBe(1);

  const popup = new FakePage("popup", "initial.example");
  context.addPage(popup);
  await manager.observe("task-listener");

  expect(initial.listenerCount("response")).toBe(0);
  expect(popup.listenerCount("response")).toBe(1);
  await manager.releaseTask("task-listener");
  expect(popup.listenerCount("response")).toBe(0);
  await manager.stop();
});

it("shares one runtime trace buffer across page rebinds", async () => {
  const initial = new FakePage("initial");
  const context = new FakeContext(initial);
  const manager = createManager(context);
  await manager.start(approvalKey);

  const popup = new FakePage("popup", "initial.example");
  context.addPage(popup);
  await manager.observe("task-trace");

  expect(runtime.executorTraces).toHaveLength(2);
  expect(runtime.executorTraces[0]).toBeDefined();
  expect(runtime.executorTraces[1]).toBe(runtime.executorTraces[0]);
  await manager.stop();
});

function createManager(context: FakeContext): BrowserSessionManager {
  runtime.context = context;
  runtime.executorPages = [];
  runtime.executorTraces = [];
  runtime.executorInvalidations = [];
  runtime.onExecutorInvalidate = undefined;
  runtime.jobObserverPages = [];
  runtime.jobFilterPlans = [];
  runtime.jobAdvanceCursors = [];
  return new BrowserSessionManager({ profileDir: ".test-profile", headless: true, executablePath });
}

function jobSnapshot(ownerId: string, current: number) {
  return {
    id: `job-snapshot-${current}`,
    ownerId,
    url: "https://initial.example/jobs",
    title: "Jobs",
    capturedAt: "2026-08-16T00:00:00.000Z",
    entryHint: "job_list" as const,
    visibleText: ["Jobs"],
    jobCards: [],
    filterState: [],
    pagination: { kind: "page" as const, current, hasNext: current === 1 },
    boundaries: []
  };
}

describe("BrowserSessionManager 页面生命周期", () => {
  it("observes jobs and authorizes filter and page mutations by epoch", async () => {
    const manager = createManager(new FakeContext(new FakePage("initial")));
    await manager.start(approvalKey);
    const plan = { source: "moka" as const, adapterVersion: "moka-job-v1", mapped: [], localOnly: [] };

    await expect(manager.observeJob("jm-1")).resolves.toMatchObject({ ownerId: "jm-1" });
    await expect(manager.applyJobFilters("jm-1", plan, 3)).resolves.toMatchObject({
      filterState: [{ key: "location", values: ["深圳"] }]
    });
    await manager.invalidateExecution("jm-1", 4);
    await expect(manager.advanceJobPage("jm-1", "page-2", 3)).rejects.toThrow("execution_invalidated");
    await expect(manager.advanceJobPage("jm-1", "page-2", 4)).resolves.toMatchObject({
      pagination: { current: 2 }
    });
    expect(runtime.jobFilterPlans).toEqual([plan]);
    expect(runtime.jobAdvanceCursors).toEqual(["page-2"]);
    await manager.stop();
  });

  it("advances the task epoch before invalidating executor state", async () => {
    const initial = new FakePage("initial");
    const manager = createManager(new FakeContext(initial));
    await manager.start(approvalKey);
    const snapshot = await manager.observe("task-invalidate");
    let epochDuringInvalidation: number | undefined;
    runtime.onExecutorInvalidate = () => {
      epochDuringInvalidation = (manager as unknown as {
        executionEpochs: Map<string, number>;
      }).executionEpochs.get("task-invalidate");
    };

    await manager.invalidateExecution("task-invalidate", 2);

    expect(epochDuringInvalidation).toBe(2);
    expect(runtime.executorInvalidations).toEqual(["task-invalidate"]);
    await expect(manager.execute({
      type: "fill",
      taskId: "task-invalidate",
      snapshotId: snapshot.id,
      fieldId: "field-1",
      nodeRef: {
        documentId: "document-fixture-00000001",
        nodeId: "node-fixture-000000000001",
        observedAt: 7
      },
      executionEpoch: 1,
      value: "stale",
      approval: "stale-approval"
    }, 1)).resolves.toMatchObject({
      status: "blocked",
      errors: ["execution_invalidated"]
    });
    await manager.stop();
  });

  it("当前页关闭后，observe 会切换到同一上下文中仍存活的页面", async () => {
    const current = new FakePage("current");
    const fallback = new FakePage("fallback", "current.example");
    const manager = createManager(new FakeContext(current, fallback));
    await manager.start(approvalKey);

    current.close();
    const snapshot = await manager.observe("task-1");

    expect(snapshot.url).toBe("https://current.example/apply");
    await manager.stop();
  });

  it("站点打开新标签页后，observe 和 execute 都绑定到新页面", async () => {
    const initial = new FakePage("initial");
    const context = new FakeContext(initial);
    const manager = createManager(context);
    await manager.start(approvalKey);

    const popup = new FakePage("popup", "initial.example");
    context.addPage(popup);
    const snapshot = await manager.observe("task-2");
    const result = await manager.execute({
      type: "fill",
      taskId: "task-2",
      snapshotId: snapshot.id,
      fieldId: "field-1",
      nodeRef: {
        documentId: "document-fixture-00000001",
        nodeId: "node-fixture-000000000001",
        observedAt: 7
      },
      executionEpoch: 1,
      value: "测试",
      approval: "test-approval"
    }, 1);

    expect(snapshot.url).toBe("https://initial.example/apply");
    expect(result.snapshot.url).toBe("https://initial.example/apply");
    expect(runtime.executorPages.at(-1)).toBe(popup);
    await manager.stop();
  });

  it("跨源弹窗不会接管当前投递任务", async () => {
    const initial = new FakePage("initial");
    const context = new FakeContext(initial);
    const manager = createManager(context);
    await manager.start(approvalKey);

    const advertisement = new FakePage("advertisement", "ads.example");
    context.addPage(advertisement);
    const snapshot = await manager.observe("task-3");

    expect(snapshot.url).toBe("https://initial.example/apply");
    expect(runtime.executorPages.at(-1)).toBe(initial);
    await manager.stop();
  });

  it("并发观察同一个新标签页时只重建一次执行器", async () => {
    const initial = new FakePage("initial");
    const context = new FakeContext(initial);
    const manager = createManager(context);
    await manager.start(approvalKey);
    await manager.observe("task-4");

    const popup = new FakePage("popup", "initial.example");
    context.addPage(popup);
    await Promise.all([manager.observe("task-4"), manager.observe("task-4")]);

    expect(runtime.executorPages.filter((page) => page === popup)).toHaveLength(1);
    await manager.stop();
  });

  it("当前页关闭后不会回退到跨源弹窗", async () => {
    const initial = new FakePage("initial");
    const context = new FakeContext(initial);
    const manager = createManager(context);
    await manager.start(approvalKey);
    context.addPage(new FakePage("advertisement", "ads.example"));
    initial.close();

    await expect(manager.observe("task-5")).rejects.toThrow("没有同源的可用投递页面");
    await manager.stop();
  });

  it("当前任务页关闭且没有剩余页面时不会创建空白页", async () => {
    const initial = new FakePage("initial");
    const manager = createManager(new FakeContext(initial));
    await manager.start(approvalKey);
    initial.close();

    await expect(manager.observe("task-6")).rejects.toThrow("没有同源的可用投递页面");
    await manager.stop();
  });

  it("释放旧任务后保留浏览器上下文并允许新任务接管跨源残留页面", async () => {
    const initial = new FakePage("initial");
    const context = new FakeContext(initial);
    const manager = createManager(context);
    await manager.start(approvalKey);
    await manager.observe("task-1");
    context.addPage(new FakePage("other", "other.example"));
    initial.close();

    manager.releaseTask("task-1");
    const opened = await manager.open("task-2", "https://jobs.example.test/apply");

    expect(opened.taskId).toBe("task-2");
    expect(context.closeCalls).toBe(0);
    await manager.stop();
  });

  it("only installs the public navigation guard for public recruitment opens", async () => {
    const initial = new FakePage("initial");
    const manager = createManager(new FakeContext(initial));
    await manager.start(approvalKey);

    await manager.open("task-default", "https://jobs.example.test/apply");
    expect(initial.routeCalls).toBe(0);
    expect(initial.unrouteCalls).toBe(0);

    await manager.open("task-public", "https://jobs.example.test/apply", "public_https" as never);
    expect(initial.routeCalls).toBe(1);
    expect(initial.unrouteCalls).toBe(1);
    await manager.stop();
  });
});
