import type { FastifyInstance } from "fastify";
import { expenseSchema } from "@expense-tracker/shared";
import * as expensesService from "../services/expenses.js";
import { requireAuth } from "../middleware/auth.js";

export async function expensesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get<{ Querystring: { month?: string; category?: string; page?: string; limit?: string } }>(
    "/expenses",
    async (request, reply) => {
      const user = request.user!;
      const { month, category, page, limit } = request.query;
      const list = expensesService.list(user.userId, {
        month: month ?? undefined,
        categoryId: category ? Number(category) : undefined,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
      });
      return reply.send(list);
    }
  );

  app.get<{ Params: { id: string } }>("/expenses/:id", async (request, reply) => {
    const user = request.user!;
    const id = Number(request.params.id);
    const row = expensesService.getById(user.userId, id);
    if (!row) {
      return reply.status(404).send({ error: "Wydatek nie znaleziony" });
    }
    return reply.send(row);
  });

  app.post("/expenses", async (request, reply) => {
    const user = request.user!;

    const parsed = expenseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Walidacja nie powiodła się",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      const { id, budgetExceeded } = expensesService.create(user.userId, user.plan, parsed.data);
      return reply.status(201).send({ id, budgetExceeded });
    } catch (err) {
      if (err instanceof Error && err.message === "EXPENSE_LIMIT") {
        return reply.status(403).send({
          error: "Osiągnąłeś limit 50 wydatków w tym miesiącu. Upgrade do Pro dla nielimitowanych.",
        });
      }
      throw err;
    }
  });

  app.put<{ Params: { id: string } }>("/expenses/:id", async (request, reply) => {
    const user = request.user!;
    const id = Number(request.params.id);

    const parsed = expenseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Walidacja nie powiodła się",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      expensesService.update(user.userId, id, parsed.data);
      return reply.status(200).send({ ok: true });
    } catch (err) {
      if (err instanceof Error && err.message === "NOT_FOUND") {
        return reply.status(404).send({ error: "Wydatek nie znaleziony" });
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>("/expenses/:id", async (request, reply) => {
    const user = request.user!;
    const id = Number(request.params.id);

    try {
      expensesService.remove(user.userId, id);
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof Error && err.message === "NOT_FOUND") {
        return reply.status(404).send({ error: "Wydatek nie znaleziony" });
      }
      throw err;
    }
  });
}
