import { db } from "../db/index.js";
import type { BudgetInput } from "@expense-tracker/shared";

export function list(userId: number, month: string) {
  return db
    .prepare(
      `SELECT b.*, c.name as category_name,
        (SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE user_id = b.user_id AND category_id = b.category_id AND strftime('%Y-%m', date) = b.month) as current_total
       FROM budgets b
       JOIN categories c ON b.category_id = c.id
       WHERE b.user_id = ? AND b.month = ?`
    )
    .all(userId, month);
}

export function upsert(userId: number, input: BudgetInput) {
  db.prepare(
    `INSERT INTO budgets (user_id, category_id, month, limit_amount) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, category_id, month) DO UPDATE SET limit_amount = excluded.limit_amount`
  ).run(userId, input.category_id, input.month, input.limit_amount);
}
