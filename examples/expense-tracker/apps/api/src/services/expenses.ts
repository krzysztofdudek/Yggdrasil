import { db } from "../db/index.js";
import type { ExpenseInput } from "@expense-tracker/shared";

const FREE_MONTHLY_LIMIT = 50;

export function list(
  userId: number,
  opts: { month?: string; categoryId?: number; page?: number; limit?: number }
) {
  let sql = "SELECT e.*, c.name as category_name FROM expenses e JOIN categories c ON e.category_id = c.id WHERE e.user_id = ?";
  const params: (number | string)[] = [userId];

  if (opts.month) {
    sql += " AND strftime('%Y-%m', e.date) = ?";
    params.push(opts.month);
  }
  if (opts.categoryId) {
    sql += " AND e.category_id = ?";
    params.push(opts.categoryId);
  }

  sql += " ORDER BY e.date DESC, e.id DESC";

  const limit = opts.limit ?? 20;
  const offset = ((opts.page ?? 1) - 1) * limit;
  sql += " LIMIT ? OFFSET ?";
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}

export function countThisMonth(userId: number): number {
  const month = new Date().toISOString().slice(0, 7);
  const row = db
    .prepare("SELECT COUNT(*) as n FROM expenses WHERE user_id = ? AND strftime('%Y-%m', date) = ?")
    .get(userId, month) as { n: number };
  return row.n;
}

export function getCategoryTotal(userId: number, categoryId: number, month: string): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE user_id = ? AND category_id = ? AND strftime('%Y-%m', date) = ?"
    )
    .get(userId, categoryId, month) as { total: number };
  return row.total;
}

export function create(userId: number, plan: string, input: ExpenseInput) {
  if (plan === "free") {
    const count = countThisMonth(userId);
    if (count >= FREE_MONTHLY_LIMIT) {
      throw new Error("EXPENSE_LIMIT");
    }
  }

  const result = db
    .prepare(
      "INSERT INTO expenses (user_id, category_id, amount, date, description) VALUES (?, ?, ?, ?, ?)"
    )
    .run(userId, input.category_id, input.amount, input.date, input.description ?? "");
  const id = result.lastInsertRowid as number;

  const budgetRow = db
    .prepare(
      "SELECT limit_amount FROM budgets WHERE user_id = ? AND category_id = ? AND month = ?"
    )
    .get(userId, input.category_id, input.date.slice(0, 7)) as { limit_amount: number } | undefined;

  let budgetExceeded: { categoryId: number; categoryName: string } | undefined;
  if (budgetRow) {
    const total = getCategoryTotal(userId, input.category_id, input.date.slice(0, 7));
    if (total > budgetRow.limit_amount) {
      const cat = db.prepare("SELECT name FROM categories WHERE id = ?").get(input.category_id) as { name: string };
      budgetExceeded = { categoryId: input.category_id, categoryName: cat.name };
    }
  }

  return { id, budgetExceeded };
}

export function getById(userId: number, id: number) {
  const row = db
    .prepare("SELECT e.*, c.name as category_name FROM expenses e JOIN categories c ON e.category_id = c.id WHERE e.id = ? AND e.user_id = ?")
    .get(id, userId);
  return row;
}

export function update(userId: number, id: number, input: ExpenseInput) {
  const existing = db.prepare("SELECT id FROM expenses WHERE id = ? AND user_id = ?").get(id, userId);
  if (!existing) {
    throw new Error("NOT_FOUND");
  }

  db.prepare(
    "UPDATE expenses SET category_id = ?, amount = ?, date = ?, description = ? WHERE id = ?"
  ).run(input.category_id, input.amount, input.date, input.description ?? "", id);
}

export function remove(userId: number, id: number) {
  const result = db.prepare("DELETE FROM expenses WHERE id = ? AND user_id = ?").run(id, userId);
  if (result.changes === 0) {
    throw new Error("NOT_FOUND");
  }
}
