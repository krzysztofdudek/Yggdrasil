import type { FastifyInstance } from "fastify";
import * as subscriptionsService from "../services/subscriptions.js";
import { requireAuth } from "../middleware/auth.js";

export async function subscriptionsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/subscriptions/me", async (request, reply) => {
    const user = request.user!;
    const sub = subscriptionsService.getMe(user.userId);
    if (!sub) {
      return reply.status(404).send({ error: "Subscription not found" });
    }
    return reply.send(sub);
  });

  app.post("/subscriptions/upgrade", async (request, reply) => {
    const user = request.user!;
    subscriptionsService.upgrade(user.userId);
    return reply.status(200).send({ ok: true, plan: "pro" });
  });
}
