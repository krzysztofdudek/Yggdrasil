import bcrypt from "bcrypt";
import { db } from "../db/index.js";
import type { ChangePasswordInput } from "@expense-tracker/shared";

export function getMe(userId: number) {
  const row = db
    .prepare("SELECT id, email, created_at FROM users WHERE id = ?")
    .get(userId) as { id: number; email: string; created_at: string } | undefined;
  return row;
}

export async function changePassword(userId: number, input: ChangePasswordInput) {
  const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as { password_hash: string } | undefined;
  if (!row) {
    throw new Error("NOT_FOUND");
  }

  const valid = await bcrypt.compare(input.currentPassword, row.password_hash);
  if (!valid) {
    throw new Error("INVALID_PASSWORD");
  }

  const hash = await bcrypt.hash(input.newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);
}
