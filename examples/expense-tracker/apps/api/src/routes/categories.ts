import type { FastifyInstance } from "fastify";
import { categorySchema } from "@expense-tracker/shared";
import * as categoriesService from "../services/categories.js";
import { requireAuth } from "../middleware/auth.js";

export async function categoriesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/categories", async (request, reply) => {
    const user = request.user!;
    const list = categoriesService.list(user.userId);
    return reply.send(list);
  });

  app.post("/categories", async (request, reply) => {
    const user = request.user!;
    const plan = request.user!.plan;

    const parsed = categorySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Walidacja nie powiodła się",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      const id = categoriesService.create(user.userId, plan, parsed.data);
      return reply.status(201).send({ id });
    } catch (err) {
      if (err instanceof Error && err.message === "CATEGORY_LIMIT") {
        return reply.status(403).send({ error: "Maksymalnie 5 własnych kategorii na planie Free" });
      }
      throw err;
    }
  });

  app.put("/categories/:id", async (request, reply) => {
    const user = request.user!;
    const id = Number((request.params as { id: string }).id);

    const parsed = categorySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Walidacja nie powiodła się",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      categoriesService.update(user.userId, id, parsed.data);
      return reply.status(200).send({ ok: true });
    } catch (err) {
      if (err instanceof Error && err.message === "NOT_FOUND") {
        return reply.status(404).send({ error: "Kategoria nie znaleziona" });
      }
      throw err;
    }
  });

  app.delete("/categories/:id", async (request, reply) => {
    const user = request.user!;
    const id = Number((request.params as { id: string }).id);

    try {
      categoriesService.remove(user.userId, id);
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof Error && err.message === "NOT_FOUND") {
        return reply.status(404).send({ error: "Kategoria nie znaleziona" });
      }
      throw err;
    }
  });
}
