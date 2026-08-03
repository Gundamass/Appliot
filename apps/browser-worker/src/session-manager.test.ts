import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  context: undefined as FakeContext | undefined,
  executorPages: [] as FakePage[]
}));

class FakePage {
  private closed = false;

  constructor(readonly name: string, private readonly host = `${name}.example`) {}

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
  }

  async goto(): Promise<void> {}

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

  async close(): Promise<void> {}
}

vi.mock("playwright-core", () => ({
  chromium: {
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

    constructor(private readonly observer: { page: FakePage }) {
      runtime.executorPages.push(observer.page);
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

    async execute(command: { taskId: string; type: string }) {
      return {
        type: "execution_result",
        taskId: command.taskId,
        snapshotId: this.snapshotId,
        commandType: command.type,
        status: "applied",
        snapshot: await this.observe(command.taskId),
        actualValue: null,
        errors: []
      };
    }
  }
}));

import { BrowserSessionManager } from "./session-manager.js";

const executablePath = process.execPath;
const approvalKey = Buffer.alloc(32).toString("base64url");

function createManager(context: FakeContext): BrowserSessionManager {
  runtime.context = context;
  runtime.executorPages = [];
  return new BrowserSessionManager({ profileDir: ".test-profile", headless: true, executablePath });
}

describe("BrowserSessionManager 页面生命周期", () => {
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
});
