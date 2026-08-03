import { ErrorResponseSchema } from "@resume/contracts";
import type { FastifyReply } from "fastify";

export function sendError(reply: FastifyReply, statusCode: number, error: string, code?: string, taskId?: string) {
  return reply.code(statusCode).send(ErrorResponseSchema.parse({
    error,
    ...(code === undefined ? {} : { code }),
    ...(taskId === undefined ? {} : { taskId })
  }));
}
