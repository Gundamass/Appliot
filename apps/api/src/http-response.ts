import { ErrorResponseSchema } from "@resume/contracts";
import type { FastifyReply } from "fastify";

export function sendError(reply: FastifyReply, statusCode: number, error: string) {
  return reply.code(statusCode).send(ErrorResponseSchema.parse({ error }));
}
