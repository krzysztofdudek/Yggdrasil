import { z } from "zod";

export const registerSchema = z
  .object({
    email: z.string().min(1, "Email jest wymagany").email("Nieprawidłowy email"),
    password: z.string().min(8, "Hasło musi mieć min. 8 znaków"),
    passwordConfirm: z.string(),
  })
  .refine((data) => data.password === data.passwordConfirm, {
    message: "Hasła muszą się zgadzać",
    path: ["passwordConfirm"],
  });

export const loginSchema = z.object({
  email: z.string().min(1, "Email jest wymagany").email("Nieprawidłowy email"),
  password: z.string().min(1, "Hasło jest wymagane"),
});

export const expenseSchema = z.object({
  category_id: z.number().int().positive("Wybierz kategorię"),
  amount: z.number().int().positive("Kwota musi być większa od 0"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data w formacie YYYY-MM-DD"),
  description: z.string().optional().default(""),
});

export const categorySchema = z.object({
  name: z.string().min(1, "Nazwa jest wymagana").max(50),
  icon: z.string().optional().nullable(),
  color: z.string().optional().nullable(),
});

export const budgetSchema = z.object({
  category_id: z.number().int().positive(),
  month: z.string().regex(/^\d{4}-\d{2}$/, "Miesiąc w formacie YYYY-MM"),
  limit_amount: z.number().int().min(0, "Limit nie może być ujemny"),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Obecne hasło jest wymagane"),
    newPassword: z.string().min(8, "Nowe hasło musi mieć min. 8 znaków"),
    newPasswordConfirm: z.string(),
  })
  .refine((data) => data.newPassword === data.newPasswordConfirm, {
    message: "Hasła muszą się zgadzać",
    path: ["newPasswordConfirm"],
  });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ExpenseInput = z.infer<typeof expenseSchema>;
export type CategoryInput = z.infer<typeof categorySchema>;
export type BudgetInput = z.infer<typeof budgetSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
