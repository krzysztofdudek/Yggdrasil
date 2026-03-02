import { db } from "../db/index.js";

export function summary(userId: number, month: string) {
  const totalRow = db
    .prepare(
      "SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE user_id = ? AND strftime('%Y-%m', date) = ?"
    )
    .get(userId, month) as { total: number };

  const byCategory = db
    .prepare(
      `SELECT c.id, c.name, c.icon, c.color, COALESCE(SUM(e.amount), 0) as total
       FROM categories c
       LEFT JOIN expenses e ON e.category_id = c.id AND e.user_id = ? AND strftime('%Y-%m', e.date) = ?
       WHERE c.user_id IS NULL OR c.user_id = ?
       GROUP BY c.id
       HAVING total > 0
       ORDER BY total DESC
       LIMIT 5`
    )
    .all(userId, month, userId);

  return {
    total: totalRow.total,
    topCategories: byCategory,
  };
}

export function byCategory(userId: number, month: string) {
  return db
    .prepare(
      `SELECT c.id, c.name, c.icon, c.color, COALESCE(SUM(e.amount), 0) as total
       FROM categories c
       LEFT JOIN expenses e ON e.category_id = c.id AND e.user_id = ? AND strftime('%Y-%m', e.date) = ?
       WHERE c.user_id IS NULL OR c.user_id = ?
       GROUP BY c.id
       ORDER BY total DESC`
    )
    .all(userId, month, userId);
}
