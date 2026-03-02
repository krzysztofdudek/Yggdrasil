import type { FastifyInstance } from "fastify";
import * as reportsService from "../services/reports.js";
import { requireAuth } from "../middleware/auth.js";

export async function reportsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get<{ Querystring: { month?: string } }>("/reports/summary", async (request, reply) => {
    const user = request.user!;
    const month = request.query.month ?? new Date().toISOString().slice(0, 7);
    const summary = reportsService.summary(user.userId, month);
    return reply.send(summary);
  });

  app.get<{ Querystring: { month?: string } }>("/reports", async (request, reply) => {
    const user = request.user!;
    const month = request.query.month ?? new Date().toISOString().slice(0, 7);
    const data = reportsService.byCategory(user.userId, month);
    return reply.send(data);
  });
}
