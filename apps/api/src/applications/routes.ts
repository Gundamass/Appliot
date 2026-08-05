import { randomUUID } from "node:crypto";
import {
  ApplicationCommandSchema,
  ApplicationTaskInputSchema,
  ApplicationTaskSchema,
  suggestApplicationTaskName,
  type ApplicationCommand,
  type ApplicationTask,
  type ApplicationTaskProgressEvent,
  type ApplicationTaskState
} from "@resume/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendError } from "../http-response.js";
import type { ApplicationService } from "./application-service.js";
import type { TaskEventBus } from "./task-events.js";
import type { ProfileRepository } from "../profile/profile-repository.js";
import type { ApplicationTaskRepository, StoredApplicationTask } from "./application-task-repository.js";

const TaskParamsSchema = z.object({ id: z.string().uuid() }).strict();
const RecoveryCommandSchema = z.object({
  type: z.enum(["retry_current", "manual_done", "cancel"])
}).strict();

export interface ApplicationRouteDependencies {
  applicationService: ApplicationService;
  taskEvents: TaskEventBus;
  tasks: ApplicationTaskRepository;
  profileRepository: ProfileRepository;
  sseHeartbeatMs?: number;
}

export function registerApplicationRoutes(app: FastifyInstance, dependencies: ApplicationRouteDependencies): void {
  const taskResponse = (task: StoredApplicationTask): ApplicationTask => {
    const state = toApiState(dependencies.applicationService.state(task.id).value);
    const contentReview = dependencies.applicationService.contentReview(task.id);
    const fieldCoverage = dependencies.applicationService.fieldCoverage(task.id);
    const commands = dependencies.applicationService.requiresRecovery(task.id)
      ? ["cancel", "resume"] as ApplicationTask["commands"]
      : commandsForState(state);
    const taskAnswers = dependencies.profileRepository.listForTask(task.id).filter((fact) =>
      fact.scope === "application" && fact.taskId === task.id
    );
    const hasTaskAnswer = taskAnswers.length > 0;
    if (hasTaskAnswer && !["review_locked", "cancelled", "failed"].includes(state)) {
      commands.push("promote_answer_to_profile");
    }
    if (contentReview?.status === "blocked" || (contentReview?.unsupportedClaims.length ?? 0) > 0) {
      const approveIndex = commands.indexOf("approve_content");
      if (approveIndex >= 0) commands.splice(approveIndex, 1);
    }
    return ApplicationTaskSchema.parse({
      id: task.id,
      name: task.name,
      applicationUrl: task.applicationUrl,
      state,
      commands,
      recoveryCommands: dependencies.applicationService.recoveryCommands(task.id),
      questions: dependencies.applicationService.state(task.id).context.questions,
      taskAnswers: taskAnswers.map((answer) => ({
        id: answer.id,
        fieldPath: answer.fieldPath,
        value: answer.value
      })),
      ...(fieldCoverage === undefined ? {} : { fieldCoverage }),
      ...(contentReview === undefined ? {} : {
        contentReview: {
          id: contentReview.id,
          fieldId: contentReview.fieldId,
          fieldLabel: contentReview.fieldLabel,
          original: contentReview.original,
          draft: contentReview.draft,
          reasons: contentReview.reasons,
          evidence: contentReview.evidence,
          unsupportedClaims: contentReview.unsupportedClaims,
          status: contentReview.unsupportedClaims.length > 0 ? "blocked" : contentReview.status
        }
      })
    });
  };

  const emitState = (taskId: string): void => {
    dependencies.taskEvents.emit(taskId, toApiState(dependencies.applicationService.state(taskId).value));
  };

  app.post("/api/applications", async (request, reply) => {
    const body = ApplicationTaskInputSchema.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, "Invalid request", "invalid_application_task_input");

    const activeTaskId = dependencies.applicationService.activeBrowserTaskId();
    if (activeTaskId !== undefined) {
      return sendError(
        reply,
        409,
        "受控浏览器正在处理另一个投递任务，请先完成或取消该任务。",
        "browser_task_in_use",
        activeTaskId
      );
    }

    const name = body.data.name ?? suggestApplicationTaskName(body.data.applicationUrl);
    const taskInput = { id: randomUUID(), name, applicationUrl: body.data.applicationUrl };
    let serviceStarted = false;
    try {
      dependencies.applicationService.start({ taskId: taskInput.id, applicationUrl: taskInput.applicationUrl });
      serviceStarted = true;
      const task = dependencies.tasks.create(taskInput);
      emitState(task.id);
      await dependencies.applicationService.openBrowser(task.id);
      await dependencies.applicationService.runUntilPause(task.id);
      emitState(task.id);
      return reply.code(201).send(taskResponse(task));
    } catch (error) {
      console.error("[application.create] failed", error instanceof Error ? error.stack ?? error.message : error);
      if (serviceStarted) {
        try {
          dependencies.applicationService.cancel(taskInput.id);
        } catch {
          // Cleanup below must still run when cancellation observes a terminal actor.
        } finally {
          dependencies.applicationService.dispose(taskInput.id);
        }
      }
      dependencies.tasks.delete(taskInput.id);
      const code = error instanceof Error && error.message === "browser_task_in_use"
        ? "browser_task_in_use"
        : "application_task_creation_failed";
      return sendError(reply, 409, "任务创建失败，请检查受控浏览器状态后重试", code);
    }
  });

  app.get("/api/applications", async (_request, reply) => {
    return reply.code(200).send(dependencies.tasks.list().map(taskResponse));
  });

  app.get("/api/applications/:id", async (request, reply) => {
    const params = TaskParamsSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "Invalid request", "invalid_task_id");
    const task = dependencies.tasks.get(params.data.id);
    return task
      ? reply.code(200).send(taskResponse(task))
      : sendError(reply, 404, "Application task not found", "application_task_not_found");
  });

  app.delete("/api/applications/:id", async (request, reply) => {
    const params = TaskParamsSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "Invalid request", "invalid_task_id");
    const task = dependencies.tasks.get(params.data.id);
    if (!task) return sendError(reply, 404, "Application task not found", "application_task_not_found");
    const state = dependencies.applicationService.state(task.id).value;
    if (!(["review_locked", "cancelled", "failed"] as const).includes(state as "review_locked" | "cancelled" | "failed")) {
      return sendError(reply, 409, "Application task cannot be deleted while active", "application_task_delete_not_allowed");
    }
    dependencies.tasks.delete(task.id);
    dependencies.applicationService.dispose(task.id);
    return reply.code(204).send();
  });

  app.post("/api/applications/:id/commands", async (request, reply) => {
    const params = TaskParamsSchema.safeParse(request.params);
    const command = ApplicationCommandSchema.safeParse(request.body);
    if (!params.success) return sendError(reply, 400, "Invalid request", "invalid_task_id");
    if (!command.success) return sendError(reply, 400, "Invalid application command", "invalid_application_command");
    const task = dependencies.tasks.get(params.data.id);
    if (!task) return sendError(reply, 404, "Application task not found", "application_task_not_found");
    const allowed = taskResponse(task).commands;
    if (!allowed.includes(command.data.type)) {
      return sendError(reply, 409, "Application command is not allowed in the current state", "application_command_not_allowed");
    }

    try {
      await executeCommand(dependencies, task.id, command.data);
      emitState(task.id);
      return reply.code(200).send(taskResponse(task));
    } catch (error) {
      return sendError(reply, 409, "Application command cannot be applied", commandErrorCode(error));
    }
  });

  app.post("/api/applications/:id/recovery", async (request, reply) => {
    const params = TaskParamsSchema.safeParse(request.params);
    const command = RecoveryCommandSchema.safeParse(request.body);
    if (!params.success) return sendError(reply, 400, "请求参数无效", "invalid_task_id");
    if (!command.success) return sendError(reply, 400, "恢复操作无效", "invalid_recovery_command");
    const task = dependencies.tasks.get(params.data.id);
    if (!task) return sendError(reply, 404, "投递任务不存在", "application_task_not_found");
    if (!dependencies.applicationService.recoveryCommands(task.id).includes(command.data.type)) {
      return sendError(reply, 409, "当前状态不允许该恢复操作", "recovery_command_not_allowed");
    }
    try {
      if (command.data.type === "retry_current") await dependencies.applicationService.retryCurrent(task.id);
      else if (command.data.type === "manual_done") await dependencies.applicationService.manualDone(task.id);
      else dependencies.applicationService.cancel(task.id);
      emitState(task.id);
      return reply.code(200).send(taskResponse(task));
    } catch (error) {
      return sendError(reply, 409, "恢复操作未能完成", commandErrorCode(error));
    }
  });

  app.get("/api/applications/:id/events", async (request, reply) => {
    const params = TaskParamsSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "Invalid request", "invalid_task_id");
    if (!dependencies.tasks.get(params.data.id)) {
      return sendError(reply, 404, "Application task not found", "application_task_not_found");
    }
    const lastEventId = request.headers["last-event-id"];
    const afterId = typeof lastEventId === "string" && /^\d+$/.test(lastEventId) ? lastEventId : undefined;
    reply.hijack();
    reply.raw.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no"
    });
    reply.raw.flushHeaders();

    let closed = false;
    const writeEvent = (event: ApplicationTaskProgressEvent) => {
      if (!closed && !reply.raw.destroyed) reply.raw.write(formatSseEvent(event));
    };
    let replaying = true;
    const bufferedEvents: ApplicationTaskProgressEvent[] = [];
    const unsubscribe = dependencies.taskEvents.subscribeAll(params.data.id, (event) => {
      if (replaying) bufferedEvents.push(event);
      else writeEvent(event);
    });
    // Invoke the legacy state replay hook first so existing reconnect instrumentation remains valid.
    dependencies.taskEvents.replay(params.data.id, afterId);
    const replay = dependencies.taskEvents.replayAll(params.data.id, afterId);
    if (replay.reset && !closed && !reply.raw.destroyed) {
      reply.raw.write(`event: history_reset\ndata: ${JSON.stringify(replay.reset)}\n\n`);
    }
    const replayEvents = replay.events;
    const replayIds = new Set<string>();
    for (const event of [...replayEvents, ...bufferedEvents].sort(compareEventIds)) {
      if (replayIds.has(event.id)) continue;
      replayIds.add(event.id);
      writeEvent(event);
    }
    replaying = false;
    const heartbeat = setInterval(() => {
      if (!closed && !reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
    }, dependencies.sseHeartbeatMs ?? 15_000);
    heartbeat.unref();
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.once("close", cleanup);
    reply.raw.once("close", cleanup);
    reply.raw.once("error", cleanup);
    return reply;
  });
}

function commandErrorCode(error: unknown): string {
  const stableCodes = new Set([
    "answer_persistence_failed",
    "answer_persistence_unavailable",
    "application_answer_not_found",
    "browser_open_unavailable",
    "checkpoint_mismatch",
    "content_review_mismatch",
    "content_review_not_allowed",
    "content_review_persistence_failed",
    "content_review_unsupported_edit",
    "content_review_validation_unavailable",
    "incomplete_question_answers",
    "manual_readback_failed",
    "profile_resumption_not_allowed",
    "recovery_not_allowed",
    "review_locked"
  ]);
  return error instanceof Error && stableCodes.has(error.message)
    ? error.message
    : "application_command_failed";
}

function commandsForState(state: ApplicationTaskState): ApplicationTask["commands"] {
  switch (state) {
    case "created":
    case "observing_page":
      return ["cancel", "open_browser"];
    case "waiting_for_login":
      return ["cancel", "open_browser", "resume"];
    case "needs_questions":
      return ["cancel", "open_browser", "answer_questions", "resume_with_profile"];
    case "awaiting_content_review":
      return ["cancel", "open_browser", "approve_content", "reject_content"];
    case "filling":
    case "validating":
    case "navigating":
      return ["cancel"];
    case "review_locked":
    case "cancelled":
    case "failed":
      return [];
  }
}

async function executeCommand(dependencies: ApplicationRouteDependencies, taskId: string, command: ApplicationCommand): Promise<void> {
  const { applicationService: service } = dependencies;
  switch (command.type) {
    case "cancel":
      service.cancel(taskId);
      return;
    case "open_browser":
      await service.openBrowser(taskId);
      if (service.state(taskId).value === "observing") {
        await service.runUntilPause(taskId);
      }
      return;
    case "resume":
      await service.resume(taskId);
      if (service.state(taskId).value === "observing") {
        await service.runUntilPause(taskId);
      }
      return;
    case "resume_with_profile":
      await service.resumeWithProfile(taskId);
      return;
    case "answer_questions":
      const questions = service.state(taskId).context.questions;
      await service.answerQuestions(taskId, Object.fromEntries(command.answers.map((answer) => [answer.id, answer.value])));
      for (const answer of command.answers.filter((candidate) => candidate.promoteToProfile)) {
        const fieldPath = questions.find((question) => question.id === answer.id)?.fieldPath;
        const stored = fieldPath === undefined ? undefined : dependencies.profileRepository.listForTask(taskId).find((fact) =>
          fact.scope === "application" && fact.taskId === taskId && fact.fieldPath === fieldPath
        );
        if (!stored) throw new Error("application_answer_not_found");
        promoteAnswer(dependencies.profileRepository, taskId, stored.id);
      }
      await service.runUntilPause(taskId);
      return;
    case "approve_content":
      await service.approveReview(taskId, command.reviewId, command.editedValue);
      await service.runUntilPause(taskId);
      return;
    case "reject_content":
      await service.rejectReview(taskId, command.reviewId);
      return;
    case "promote_answer_to_profile":
      promoteAnswer(dependencies.profileRepository, taskId, command.answerId);
      return;
  }
}

function promoteAnswer(profileRepository: ProfileRepository, taskId: string, answerId: string): void {
  const answer = profileRepository.listForTask(taskId).find((fact) =>
    fact.id === answerId && fact.scope === "application" && fact.taskId === taskId
  );
  if (!answer) throw new Error("application_answer_not_found");
  const profileFact = profileRepository.createExtracted({
    id: randomUUID(),
    fieldPath: answer.fieldPath,
    value: answer.value,
    status: "extracted",
    confidence: 1,
    scope: "profile",
    evidence: answer.evidence,
    revision: 1
  });
  profileRepository.confirm(profileFact.id);
}

function toApiState(state: string): ApplicationTaskState {
  const stateMap: Record<string, ApplicationTaskState> = {
    created: "created",
    observing: "observing_page",
    awaiting_login: "waiting_for_login",
    needs_questions: "needs_questions",
    awaiting_content_review: "awaiting_content_review",
    filling: "filling",
    validating: "validating",
    navigating: "navigating",
    review_locked: "review_locked",
    cancelled: "cancelled",
    failed: "failed"
  };
  return stateMap[state] ?? "failed";
}

function formatSseEvent(event: ApplicationTaskProgressEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function compareEventIds(
  left: ApplicationTaskProgressEvent,
  right: ApplicationTaskProgressEvent
): number {
  const leftId = BigInt(left.id);
  const rightId = BigInt(right.id);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}
