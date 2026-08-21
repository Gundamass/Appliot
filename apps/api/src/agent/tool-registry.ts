export type ToolCaller = "graph" | "model";

export interface ToolContext {
  caller: ToolCaller;
  runId: string;
  taskId: string;
}

export type ToolHandler<Input = unknown, Output = unknown> =
  (input: Input, context: ToolContext) => Output | Promise<Output>;

export interface ToolDefinition<Input = unknown, Output = unknown> {
  readonly handler: ToolHandler<Input, Output>;
  readonly allowedCallers: readonly ToolCaller[];
}

export type ToolRegistration = ToolHandler | ToolDefinition;

export interface RestrictedToolRegistry {
  invoke<Output = unknown>(name: string, input: unknown, context: ToolContext): Promise<Output>;
  names(): readonly string[];
}

const graphOnlyTools = new Set([
  "execute_browser_command",
  "navigate_browser",
  "authorize_browser_command",
  "invalidate_execution_epoch",
  "retrieve_job_evidence",
  "submit",
  "final_submit"
]);

export function createRestrictedToolRegistry(
  registrations: Readonly<Record<string, ToolRegistration>>
): RestrictedToolRegistry {
  const definitions = new Map<string, ToolDefinition>();
  for (const [name, registration] of Object.entries(registrations)) {
    const definition = isToolDefinition(registration)
      ? registration
      : { handler: registration, allowedCallers: graphOnlyTools.has(name) ? ["graph"] : ["graph", "model"] };
    if (definition.allowedCallers.length === 0) throw new Error(`tool_definition_invalid:${name}`);
    definitions.set(name, Object.freeze({
      handler: definition.handler,
      allowedCallers: Object.freeze([...definition.allowedCallers])
    }));
  }

  return Object.freeze({
    async invoke<Output = unknown>(name: string, input: unknown, context: ToolContext): Promise<Output> {
      const definition = definitions.get(name);
      if (definition === undefined || !definition.allowedCallers.includes(context.caller)) {
        throw new Error("tool_not_allowed");
      }
      return await definition.handler(input, context) as Output;
    },
    names: () => Object.freeze([...definitions.keys()])
  });
}

function isToolDefinition(registration: ToolRegistration): registration is ToolDefinition {
  return typeof registration === "object" && registration !== null && "handler" in registration;
}
