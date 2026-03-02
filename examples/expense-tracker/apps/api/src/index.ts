import Fastify from "fastify";
import cors from "@fastify/cors";
import "./db/index.js";
import { authRoutes } from "./routes/auth.js";
import { categoriesRoutes } from "./routes/categories.js";
import { expensesRoutes } from "./routes/expenses.js";
import { budgetsRoutes } from "./routes/budgets.js";
import { reportsRoutes } from "./routes/reports.js";
import { usersRoutes } from "./routes/users.js";
import { subscriptionsRoutes } from "./routes/subscriptions.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

app.get("/health", async () => ({ ok: true }));

await app.register(authRoutes);
await app.register(categoriesRoutes);
await app.register(expensesRoutes);
await app.register(budgetsRoutes);
await app.register(reportsRoutes);
await app.register(usersRoutes);
await app.register(subscriptionsRoutes);

const port = Number(process.env.PORT) || 3000;
await app.listen({ port, host: "0.0.0.0" });
