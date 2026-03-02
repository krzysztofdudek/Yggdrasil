import { db } from "../db/index.js";
import type { CategoryInput } from "@expense-tracker/shared";

export function list(userId: number) {
  return db
    .prepare(
      "SELECT id, user_id, name, icon, color FROM categories WHERE user_id IS NULL OR user_id = ? ORDER BY user_id, name"
    )
    .all(userId) as Array<{ id: number; user_id: number | null; name: string; icon: string | null; color: string | null }>;
}

export function create(userId: number, plan: string, input: CategoryInput) {
  if (plan === "free") {
    const count = db.prepare("SELECT COUNT(*) as n FROM categories WHERE user_id = ?").get(userId) as { n: number };
    if (count.n >= 5) {
      throw new Error("CATEGORY_LIMIT");
    }
  }

  const result = db
    .prepare("INSERT INTO categories (user_id, name, icon, color) VALUES (?, ?, ?, ?)")
    .run(userId, input.name, input.icon ?? null, input.color ?? null);
  return result.lastInsertRowid as number;
}

export function update(userId: number, categoryId: number, input: CategoryInput) {
  const cat = db.prepare("SELECT user_id FROM categories WHERE id = ?").get(categoryId) as { user_id: number | null } | undefined;
  if (!cat || cat.user_id !== userId) {
    throw new Error("NOT_FOUND");
  }

  db.prepare("UPDATE categories SET name = ?, icon = ?, color = ? WHERE id = ?").run(
    input.name,
    input.icon ?? null,
    input.color ?? null,
    categoryId
  );
}

export function remove(userId: number, categoryId: number) {
  const cat = db.prepare("SELECT user_id FROM categories WHERE id = ?").get(categoryId) as { user_id: number | null } | undefined;
  if (!cat || cat.user_id !== userId) {
    throw new Error("NOT_FOUND");
  }

  db.prepare("DELETE FROM categories WHERE id = ?").run(categoryId);
}
