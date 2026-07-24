import { AdapterHealthResponseSchema } from "@resume/contracts";
import type { FastifyInstance } from "fastify";
import type { AdapterHealthRegistry } from "./adapter-health.js";

export function registerHealthRoutes(app: FastifyInstance, adapterHealth: AdapterHealthRegistry): void {
  app.get("/api/health/adapters", async (_request, reply) => {
    const statuses = AdapterHealthResponseSchema.parse(await adapterHealth.getStatuses());
    return reply.code(200).send(statuses);
  });
}
