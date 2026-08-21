import { describe, expect, it, vi } from "vitest";
import { createRestrictedToolRegistry } from "./tool-registry.js";

describe("RestrictedToolRegistry", () => {
  it("invokes a registered tool for an allowed caller", async () => {
    const handler = vi.fn(async (input: { revision: number }) => ({ revision: input.revision }));
    const registry = createRestrictedToolRegistry({ read_profile: handler });

    await expect(registry.invoke("read_profile", { revision: 3 }, {
      caller: "model", runId: "run-1", taskId: "task-1"
    })).resolves.toEqual({ revision: 3 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not expose browser writes to model callers", async () => {
    const registry = createRestrictedToolRegistry({
      execute_browser_command: {
        allowedCallers: ["graph"],
        handler: async () => ({ ok: true })
      }
    });

    await expect(registry.invoke("execute_browser_command", {}, {
      caller: "model", runId: "run-1", taskId: "task-1"
    })).rejects.toThrow("tool_not_allowed");
    await expect(registry.invoke("execute_browser_command", {}, {
      caller: "graph", runId: "run-1", taskId: "task-1"
    })).resolves.toEqual({ ok: true });
  });

  it("rejects unknown tools before invoking any handler", async () => {
    const handler = vi.fn();
    const registry = createRestrictedToolRegistry({ read_profile: handler });
    await expect(registry.invoke("missing_tool", {}, {
      caller: "graph", runId: "run-1", taskId: "task-1"
    })).rejects.toThrow("tool_not_allowed");
    expect(handler).not.toHaveBeenCalled();
  });
});
