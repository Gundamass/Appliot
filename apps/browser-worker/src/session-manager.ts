import { existsSync } from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import type {
  ExecutableCommand,
  FilterPlan,
  FormSnapshot,
  JobPageSnapshot,
  WorkerActivity,
  WorkerResponse
} from "@resume/contracts";
import { ActivityMonitor } from "./activity-monitor.js";
import { ChallengeDetector } from "./challenge-detector.js";
import { installDomRuntime } from "./dom-runtime.js";
import { ControlledExecutor } from "./executor.js";
import { BrowserObserver } from "./observer.js";
import { JobObserver } from "./job-observer.js";
import { BoundedRuntimeTraceBuffer } from "./runtime-trace.js";

export interface BrowserSessionOptions {
  profileDir: string;
  headless: boolean;
  executablePath?: string;
  fileResolver?: (fileId: string) => Promise<string | undefined>;
}

const executableCandidates = process.platform === "win32"
  ? [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
    ]
  : [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser"
    ];

function resolveExecutablePath(configuredPath?: string): string {
  const candidate = configuredPath ?? process.env.RESUME_BROWSER_EXECUTABLE
    ?? executableCandidates.find((path) => existsSync(path));
  if (!candidate || !existsSync(candidate)) {
    throw new Error("未找到可用的 Edge、Chrome 或 Chromium 浏览器");
  }
  return candidate;
}

export function requireWebUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("仅允许 HTTP 或 HTTPS 地址");
  }
  return url;
}

export class BrowserSessionManager {
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private preferredPage: Page | undefined;
  private approvalKey: string | undefined;
  private executor: ControlledExecutor | undefined;
  private activityMonitor: ActivityMonitor | undefined;
  private challengeDetector: ChallengeDetector | undefined;
  private jobObserver: JobObserver | undefined;
  private activeTaskId: string | undefined;
  private monitoredTaskId: string | undefined;
  private trustedOrigin: string | undefined;
  private readonly activityListeners = new Set<(activity: WorkerActivity) => void>();
  private executionEpochs = new Map<string, number>();
  private readonly runtimeTrace = new BoundedRuntimeTraceBuffer();
  private readonly onPageOpened = (page: Page): void => {
    this.preferredPage = page;
  };

  constructor(private readonly options: BrowserSessionOptions) {}

  async start(approvalKey: string): Promise<void> {
    if (this.context) {
      throw new Error("浏览器会话已经启动");
    }
    this.approvalKey = approvalKey;
    this.context = await chromium.launchPersistentContext(this.options.profileDir, {
      acceptDownloads: false,
      executablePath: resolveExecutablePath(this.options.executablePath),
      headless: this.options.headless,
      viewport: { width: 1440, height: 1000 }
    });
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    this.context.on("page", this.onPageOpened);
    await this.bindPage(this.page);
  }

  async observe(taskId: string): Promise<FormSnapshot> {
    await this.ensureActivePage();
    if (!this.executor) throw new Error("浏览器 Worker 尚未完成握手");
    await this.monitorTask(taskId);
    return this.executor.observe(taskId);
  }

  async execute(command: ExecutableCommand, executionEpoch = 0): Promise<Extract<WorkerResponse, { type: "execution_result" }>> {
    await this.ensureActivePage();
    if (!this.executor) throw new Error("浏览器 Worker 尚未完成握手");
    await this.monitorTask(command.taskId);
    const currentEpoch = this.executionEpochs.get(command.taskId) ?? 0;
    if (executionEpoch < currentEpoch) {
      return this.executor.execute(command, () => false);
    }
    this.executionEpochs.set(command.taskId, executionEpoch);
    return this.executor.execute(command, () => this.executionEpochs.get(command.taskId) === executionEpoch);
  }

  async invalidateExecution(taskId: string, executionEpoch: number): Promise<void> {
    const currentEpoch = this.executionEpochs.get(taskId) ?? 0;
    this.executionEpochs.set(taskId, Math.max(currentEpoch, executionEpoch));
    await this.executor?.invalidate(taskId);
  }

  async observeJob(ownerId: string): Promise<JobPageSnapshot> {
    await this.ensureActivePage();
    if (!this.jobObserver) throw new Error("浏览器 Worker 尚未完成握手");
    await this.monitorTask(ownerId);
    return this.jobObserver.observe(ownerId);
  }

  async applyJobFilters(
    ownerId: string,
    plan: FilterPlan,
    executionEpoch: number
  ): Promise<JobPageSnapshot> {
    await this.ensureActivePage();
    if (!this.jobObserver) throw new Error("浏览器 Worker 尚未完成握手");
    await this.authorizeJobMutation(ownerId, executionEpoch);
    return this.jobObserver.applyFilters(ownerId, plan);
  }

  async advanceJobPage(
    ownerId: string,
    cursor: string | undefined,
    executionEpoch: number
  ): Promise<JobPageSnapshot> {
    await this.ensureActivePage();
    if (!this.jobObserver) throw new Error("浏览器 Worker 尚未完成握手");
    await this.authorizeJobMutation(ownerId, executionEpoch);
    return this.jobObserver.advance(ownerId, cursor);
  }

  async releaseTask(taskId: string): Promise<void> {
    this.executionEpochs.delete(taskId);
    if (this.activeTaskId !== taskId) return;
    const executor = this.executor;
    this.activityMonitor?.stop();
    this.activityMonitor = undefined;
    this.challengeDetector?.dispose();
    this.challengeDetector = undefined;
    this.jobObserver = undefined;
    this.executor = undefined;
    this.activeTaskId = undefined;
    this.monitoredTaskId = undefined;
    this.trustedOrigin = undefined;
    this.preferredPage = undefined;
    await executor?.release();
  }

  async open(taskId: string, value: string): Promise<Extract<WorkerResponse, { type: "opened" }>> {
    await this.ensureActivePage();
    if (!this.page) {
      throw new Error("浏览器 Worker 尚未完成握手");
    }
    const url = requireWebUrl(value);
    await this.monitorTask(taskId);
    await this.page.goto(url.href, { waitUntil: "domcontentloaded" });
    this.trustedOrigin = pageOrigin(this.page.url());
    return {
      type: "opened",
      taskId,
      url: this.page.url(),
      title: await this.page.title()
    };
  }

  subscribeActivity(listener: (activity: WorkerActivity) => void): () => void {
    if (!this.activityMonitor) throw new Error("浏览器 Worker 尚未完成握手");
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  async stop(): Promise<void> {
    const context = this.context;
    const executor = this.executor;
    context?.off("page", this.onPageOpened);
    this.context = undefined;
    this.page = undefined;
    this.preferredPage = undefined;
    this.approvalKey = undefined;
    this.executor = undefined;
    this.activeTaskId = undefined;
    this.monitoredTaskId = undefined;
    this.trustedOrigin = undefined;
    this.executionEpochs.clear();
    this.activityMonitor?.stop();
    this.activityMonitor = undefined;
    this.challengeDetector?.dispose();
    this.challengeDetector = undefined;
    this.jobObserver = undefined;
    this.activityListeners.clear();
    await executor?.release();
    await context?.close();
  }

  private async ensureActivePage(): Promise<void> {
    if (!this.context || !this.approvalKey) {
      throw new Error("浏览器 Worker 尚未完成握手");
    }
    const pages = this.context.pages().filter((page) => !page.isClosed());
    const currentPage = this.page && pages.includes(this.page) ? this.page : undefined;
    const trustedPages = this.trustedOrigin === undefined
      ? pages
      : pages.filter((page) => pageOrigin(page.url()) === this.trustedOrigin);
    const preferredPage = this.preferredPage && pages.includes(this.preferredPage)
      && (currentPage
        ? sameOrigin(this.preferredPage.url(), currentPage.url())
        : this.trustedOrigin === undefined || pageOrigin(this.preferredPage.url()) === this.trustedOrigin)
      ? this.preferredPage
      : undefined;
    let activePage = preferredPage ?? currentPage ?? trustedPages.at(-1);
    if (!activePage && pages.length > 0) throw new Error("没有同源的可用投递页面");
    if (!activePage) {
      if (this.trustedOrigin !== undefined) throw new Error("没有同源的可用投递页面");
      activePage = await this.context.newPage();
    }
    this.preferredPage = undefined;
    if (activePage !== this.page || !this.executor || !this.activityMonitor) {
      await this.bindPage(activePage);
    }
  }

  private async bindPage(page: Page): Promise<void> {
    if (!this.approvalKey) throw new Error("浏览器 Worker 尚未完成握手");
    const previousExecutor = this.executor;
    this.activityMonitor?.stop();
    this.challengeDetector?.dispose();
    this.monitoredTaskId = undefined;
    this.page = page;
    this.trustedOrigin = pageOrigin(page.url()) ?? this.trustedOrigin;
    await previousExecutor?.release();
    await installDomRuntime(page);
    const challengeDetector = new ChallengeDetector();
    challengeDetector.start(page);
    this.challengeDetector = challengeDetector;
    const observer = new BrowserObserver(page, challengeDetector);
    this.jobObserver = new JobObserver(page, challengeDetector);
    const activityMonitor = new ActivityMonitor(page, { readStructure: () => observer.observeStructure() });
    activityMonitor.subscribe((activity) => {
      for (const listener of this.activityListeners) {
        try {
          listener(activity);
        } catch {
          // Activity listeners are isolated from browser lifecycle handling.
        }
      }
    });
    this.activityMonitor = activityMonitor;
    this.executor = new ControlledExecutor(
      observer,
      Buffer.from(this.approvalKey, "base64url"),
      this.options.fileResolver,
      activityMonitor,
      this.runtimeTrace
    );
    if (this.activeTaskId) {
      await this.monitorTask(this.activeTaskId);
    }
  }

  private async monitorTask(taskId: string): Promise<void> {
    this.activeTaskId = taskId;
    if (this.monitoredTaskId === taskId) return;
    if (!this.activityMonitor) throw new Error("浏览器 Worker 尚未完成握手");
    await this.activityMonitor.start(taskId);
    this.monitoredTaskId = taskId;
  }

  private async authorizeJobMutation(ownerId: string, executionEpoch: number): Promise<void> {
    await this.monitorTask(ownerId);
    const currentEpoch = this.executionEpochs.get(ownerId) ?? 0;
    if (executionEpoch < currentEpoch) throw new Error("execution_invalidated");
    this.executionEpochs.set(ownerId, executionEpoch);
  }
}

function sameOrigin(left: string, right: string): boolean {
  const leftOrigin = pageOrigin(left);
  return leftOrigin !== undefined && leftOrigin === pageOrigin(right);
}

function pageOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}
