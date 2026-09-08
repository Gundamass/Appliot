import {
  ConflictJobSelectionInputSchema,
  JobExpectationSnapshotSchema,
  JobMatchMutationGuardSchema,
  JobSelectionInputSchema
} from "@resume/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { sendError } from "../http-response.js";
import type { createJobMatchService } from "./job-match-service.js";

const SessionParamsSchema = z.object({ id: z.string().uuid() }).strict();
const CreateSessionSchema = z.object({
  url: z.string().url().refine((value) => value.startsWith("http://") || value.startsWith("https://"))
}).strict();
const FilterConfirmationSchema = JobMatchMutationGuardSchema.extend({
  expectation: JobExpectationSnapshotSchema
}).strict();
const ApplicationConversionSchema = z.union([
  ConflictJobSelectionInputSchema,
  JobSelectionInputSchema
]);

export interface JobMatchRouteDependencies {
  service: ReturnType<typeof createJobMatchService>;
}

export function registerJobMatchRoutes(app: FastifyInstance, dependencies: JobMatchRouteDependencies): void {
  app.post("/api/job-match-sessions", async (request, reply) => {
    const input = CreateSessionSchema.safeParse(request.body);
    if (!input.success) return invalid(reply, "invalid_job_match_create_input");
    return execute(reply, 201, () => dependencies.service.create(input.data));
  });

  app.get("/api/job-match-sessions/:id", async (request, reply) => {
    const params = SessionParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, "invalid_job_match_session_id");
    return execute(reply, 200, () => dependencies.service.get(params.data.id));
  });

  app.put("/api/job-match-sessions/:id/filter-confirmation", async (request, reply) => {
    const params = SessionParamsSchema.safeParse(request.params);
    const input = FilterConfirmationSchema.safeParse(request.body);
    if (!params.success) return invalid(reply, "invalid_job_match_session_id");
    if (!input.success) return invalid(reply, "invalid_job_filter_confirmation_input");
    const { expectation, ...guard } = input.data;
    return execute(reply, 200, () => dependencies.service.confirmFilters(params.data.id, expectation, guard));
  });

  registerGuardMutation(app, dependencies, "pause", (id, guard) => dependencies.service.pause(id, guard));
  registerGuardMutation(app, dependencies, "resume", (id, guard) => dependencies.service.resume(id, guard));
  registerGuardMutation(app, dependencies, "continue-extraction", (id, guard) =>
    dependencies.service.continueExtraction(id, guard));
  registerGuardMutation(app, dependencies, "rematch", (id, guard) => dependencies.service.rematch(id, guard));
  registerGuardMutation(app, dependencies, "cancel", (id, guard) => dependencies.service.cancel(id, guard));

  app.post("/api/job-match-sessions/:id/selection", async (request, reply) => {
    const params = SessionParamsSchema.safeParse(request.params);
    const input = JobSelectionInputSchema.safeParse(request.body);
    if (!params.success) return invalid(reply, "invalid_job_match_session_id");
    if (!input.success) return invalid(reply, "invalid_job_selection_input");
    return execute(reply, 200, () => dependencies.service.select(params.data.id, input.data));
  });

  app.post("/api/job-match-sessions/:id/conflict-selection", async (request, reply) => {
    const params = SessionParamsSchema.safeParse(request.params);
    const input = ConflictJobSelectionInputSchema.safeParse(request.body);
    if (!params.success) return invalid(reply, "invalid_job_match_session_id");
    if (!input.success) return invalid(reply, "invalid_job_conflict_selection_input");
    return execute(reply, 200, () => dependencies.service.selectConflict(params.data.id, input.data));
  });

  app.post("/api/job-match-sessions/:id/application", async (request, reply) => {
    const params = SessionParamsSchema.safeParse(request.params);
    const input = ApplicationConversionSchema.safeParse(request.body);
    if (!params.success) return invalid(reply, "invalid_job_match_session_id");
    if (!input.success) return invalid(reply, "invalid_job_application_input");
    return execute(reply, 200, () => dependencies.service.convert(params.data.id, input.data));
  });
}

function registerGuardMutation(
  app: FastifyInstance,
  dependencies: JobMatchRouteDependencies,
  resource: "pause" | "resume" | "continue-extraction" | "rematch" | "cancel",
  operation: (sessionId: string, guard: z.infer<typeof JobMatchMutationGuardSchema>) => unknown | Promise<unknown>
): void {
  app.post(`/api/job-match-sessions/:id/${resource}`, async (request, reply) => {
    const params = SessionParamsSchema.safeParse(request.params);
    const input = JobMatchMutationGuardSchema.safeParse(request.body);
    if (!params.success) return invalid(reply, "invalid_job_match_session_id");
    if (!input.success) return invalid(reply, `invalid_job_match_${resource.replaceAll("-", "_")}_input`);
    return execute(reply, 200, () => operation(params.data.id, input.data));
  });
}

async function execute(
  reply: FastifyReply,
  successStatus: number,
  operation: () => unknown | Promise<unknown>
) {
  try {
    return reply.code(successStatus).send(await operation());
  } catch (error) {
    const mapped = mapJobMatchError(error);
    return sendError(reply, mapped.statusCode, mapped.error, mapped.code);
  }
}

function invalid(reply: FastifyReply, code: string) {
  return sendError(reply, 400, "Invalid request", code);
}

function mapJobMatchError(error: unknown): { statusCode: number; error: string; code: string } {
  const code = error instanceof Error ? error.message : "job_match_operation_failed";
  if (code === "job_match_session_not_found") {
    return { statusCode: 404, error: "Job match session not found", code };
  }
  if (code === "unsupported_job_entry") {
    return { statusCode: 422, error: "Unsupported job entry", code };
  }
  if (code === "job_expectation_required") {
    return { statusCode: 422, error: "Job expectation is required", code };
  }
  if (code === "invalid_job_url") {
    return { statusCode: 400, error: "Invalid request", code };
  }
  if (code === "browser_lease_in_use") {
    return { statusCode: 409, error: "Job match operation conflicts with current state", code: "browser_task_in_use" };
  }
  if (CONFLICT_CODES.has(code)) {
    return { statusCode: 409, error: "Job match operation conflicts with current state", code };
  }
  return { statusCode: 500, error: "Internal server error", code: "job_match_operation_failed" };
}

const CONFLICT_CODES = new Set([
  "job_match_version_conflict",
  "job_match_mutation_not_allowed",
  "job_match_expectation_conflict",
  "job_filter_confirmation_not_allowed",
  "job_filter_readback_mismatch",
  "job_extraction_not_allowed",
  "job_match_selection_not_allowed",
  "job_match_conflict_confirmation_required",
  "job_match_conflict_confirmation_not_required",
  "job_match_conflict_confirmation_stale",
  "job_match_result_not_found",
  "job_match_result_stale",
  "job_match_result_version_conflict",
  "job_match_posting_changed",
  "job_match_conversion_not_allowed"
]);
