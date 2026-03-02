import { db } from "../db/index.js";

export function getMe(userId: number) {
  const row = db
    .prepare("SELECT user_id, plan, status, created_at FROM subscriptions WHERE user_id = ?")
    .get(userId) as { user_id: number; plan: string; status: string; created_at: string } | undefined;
  return row;
}

export function upgrade(userId: number) {
  const row = db.prepare("SELECT plan FROM subscriptions WHERE user_id = ?").get(userId) as { plan: string } | undefined;
  if (!row) {
    throw new Error("NOT_FOUND");
  }
  if (row.plan === "pro") {
    return; // idempotent
  }

  db.prepare("UPDATE subscriptions SET plan = 'pro' WHERE user_id = ?").run(userId);
}
