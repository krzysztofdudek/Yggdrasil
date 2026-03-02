import type { FastifyInstance } from "fastify";
import { changePasswordSchema } from "@expense-tracker/shared";
import * as usersService from "../services/users.js";
import { requireAuth } from "../middleware/auth.js";

export async function usersRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/users/me", async (request, reply) => {
    const user = request.user!;
    const me = usersService.getMe(user.userId);
    if (!me) {
      return reply.status(404).send({ error: "User not found" });
    }
    return reply.send(me);
  });

  app.put("/users/me/password", async (request, reply) => {
    const user = request.user!;

    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      await usersService.changePassword(user.userId, parsed.data);
      return reply.status(200).send({ ok: true });
    } catch (err) {
      if (err instanceof Error && err.message === "INVALID_PASSWORD") {
        return reply.status(400).send({ error: "Current password is incorrect" });
      }
      throw err;
    }
  });
}
