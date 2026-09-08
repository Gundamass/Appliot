import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createApplicationTaskRepository } from "./applications/application-task-repository.js";
import { createApp } from "./app.js";
import { createProductionDependencies } from "./production-dependencies.js";
import { loadConfig } from "./config.js";

const browserClient = {
  async open(taskId: string, url: string) { return { type: "opened" as const, taskId, url, title: "Test" }; },
  async observe() {
    throw new Error("browser_not_started");
  },
  async execute() {
    throw new Error("browser_not_started");
  },
  async stop() { return undefined; }
};

describe("production Agent Runtime cutover", () => {
  it("constructs AgentRuntime and Supervisor at the composition root", async () => {
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClient
    });
    try {
      expect(dependencies.agentRuntime).toBeDefined();
      expect(dependencies.agentSupervisor).toBeDefined();
      expect(dependencies.agentIntentResolver).toBeDefined();
      expect(dependencies.agentPlanner).toBeDefined();
      expect(dependencies.agentCapabilityCatalog).toBeDefined();
      expect(dependencies.agentPolicyEngine).toBeDefined();
      expect(dependencies.agentApprovalSystem).toBeDefined();
      expect(dependencies.agentEvidenceStore).toBeDefined();
      expect(dependencies.applicationService).toBeDefined();
    } finally {
      await dependencies.close?.();
    }
  });

  it("registers a concrete application specialist instead of the placeholder executor", async () => {
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClient
    });
    try {
      const result = await dependencies.agentRuntime.start({
        goal: "帮我填写这个申请 https://jobs.example.test/apply",
        requestedBy: "user-1"
      });
      expect(result.error?.code).not.toBe("runtime_specialist_agents_not_registered");
      expect(result.status).not.toBe("blocked");
    } finally {
      await dependencies.close?.();
    }
  });

  it("starts a Runtime-owned application task at the current browser page", async () => {
    let observeCount = 0;
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClient: {
        async open(taskId: string, url: string) { return { type: "opened" as const, taskId, url, title: "Test" }; },
        async observe(taskId: string) {
          observeCount += 1;
          return {
            type: "snapshot" as const,
            snapshot: {
              frameRef: { documentId: "document-1", kind: "main" as const },
              mutationEpoch: 1,
              id: `snapshot-${observeCount}`,
              taskId,
              url: "https://jobs.example.test/apply",
              title: "Login",
              stage: "login" as const,
              fields: [],
              actions: [],
              errors: []
            }
          };
        },
        async execute() { throw new Error("execute_not_expected"); },
        async stop() { return undefined; }
      }
    });
    try {
      const result = await dependencies.agentRuntime.start({
        goal: "\u6295\u9012 https://jobs.example.test/apply",
        requestedBy: "application-service",
        metadata: {
          applicationTaskId: "application-task-1",
          applicationUrl: "https://jobs.example.test/apply"
        }
      });
      expect(result.status).toBe("interrupted");
      expect(result.pendingInterrupt?.reason).toBe("authentication");
      expect(observeCount).toBeGreaterThan(0);
    } finally {
      await dependencies.close?.();
    }
  });

  it("routes resume analysis to the concrete resume specialist", async () => {
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClient
    });
    try {
      const result = await dependencies.agentRuntime.start({
        goal: "帮我分析简历",
        requestedBy: "user-1"
      });
      expect(result.status).toBe("failed");
      expect(result.error?.code).not.toBe("runtime_specialist_agents_not_registered");
    } finally {
      await dependencies.close?.();
    }
  });

  it("exposes the Runtime lifecycle and authoritative event stream", async () => {
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClient
    });
    const app = await createApp(dependencies);
    try {
      const started = await app.inject({
        method: "POST",
        url: "/api/agent/runs",
        payload: { goal: "帮我分析简历", requestedBy: "user-1" }
      });
      expect(started.statusCode).toBe(201);
      const runId = started.json().runId as string;
      const eventResponse = await app.inject({ method: "GET", url: `/api/agent/runs/${runId}/events` });
      expect(eventResponse.statusCode).toBe(200);
      const eventTypes = eventResponse.json().events.map((event: { type: string }) => event.type);
      expect(eventTypes[0]).toBe("run_started");
      expect(eventTypes).toEqual(expect.arrayContaining([
        "intent_resolved",
        "plan_created",
        "agent_dispatched",
        "checkpoint_saved",
        "run_failed"
      ]));
      expect(eventTypes.indexOf("intent_resolved")).toBeLessThan(eventTypes.indexOf("plan_created"));
      expect(eventTypes.indexOf("plan_created")).toBeLessThan(eventTypes.indexOf("agent_dispatched"));
      expect(eventTypes.indexOf("agent_dispatched")).toBeLessThan(eventTypes.indexOf("run_failed"));
    } finally {
      await app.close();
    }
  });

  it("creates only Runtime-owned application tasks", async () => {
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClient
    });
    try {
      const task = createApplicationTaskRepository(dependencies.database).create({
        id: "c4a3bdf5-51d5-4f8e-8a72-1a7a40e1de11",
        applicationUrl: "https://jobs.example.test/apply"
      });
      expect(task.orchestrator).toBe("agent-runtime");
    } finally {
      await dependencies.close?.();
    }
  });

  it("does not compose the legacy graph or a dual-track service router", async () => {
    const source = await readFile(new URL("./production-dependencies.ts", import.meta.url), "utf8");
    expect(source).not.toContain("createLegacyMainGraph");
    expect(source).not.toContain("createGraphService");
    expect(source).not.toContain("createApplicationServiceRouter");
  });
});
