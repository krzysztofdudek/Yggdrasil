# Expenses — Responsibility

CRUD for expenses. Create: enforces Free plan limit (50/month). Returns budget_exceeded flag when category budget is exceeded. List with filters: month, category, pagination.

Not responsible for: budget calculation (reads from budgets table), subscription limits (checks plan).