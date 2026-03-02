import type { FastifyInstance } from "fastify";
import { budgetSchema } from "@expense-tracker/shared";
import * as budgetsService from "../services/budgets.js";
import { requireAuth } from "../middleware/auth.js";

export async function budgetsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get<{ Querystring: { month?: string } }>("/budgets", async (request, reply) => {
    const user = request.user!;
    const month = request.query.month ?? new Date().toISOString().slice(0, 7);
    const list = budgetsService.list(user.userId, month);
    return reply.send(list);
  });

  app.put("/budgets", async (request, reply) => {
    const user = request.user!;

    const parsed = budgetSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Walidacja nie powiodła się",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    budgetsService.upsert(user.userId, parsed.data);
    return reply.status(200).send({ ok: true });
  });
}
