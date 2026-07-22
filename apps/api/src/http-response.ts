import type { FastifyReply } from "fastify";
import { z } from "zod";

export const ErrorResponseSchema = z.object({ error: z.string().min(1) }).strict();

export function sendError(reply: FastifyReply, statusCode: number, error: string) {
  return reply.code(statusCode).send(ErrorResponseSchema.parse({ error }));
}
