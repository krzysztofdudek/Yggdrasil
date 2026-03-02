export interface User {
  id: number;
  email: string;
  created_at: string;
}

export type Plan = "free" | "pro";

export interface Subscription {
  user_id: number;
  plan: Plan;
  status: "active" | "cancelled";
  created_at: string;
}

export interface Category {
  id: number;
  user_id: number | null;
  name: string;
  icon: string | null;
  color: string | null;
}

export interface Expense {
  id: number;
  user_id: number;
  category_id: number;
  amount: number;
  date: string;
  description: string | null;
  created_at: string;
}

export interface Budget {
  user_id: number;
  category_id: number;
  month: string;
  limit_amount: number;
}
