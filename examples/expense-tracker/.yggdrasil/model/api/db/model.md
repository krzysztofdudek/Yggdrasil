# DB — Model

## Tables

- **users**: id, email, password_hash, created_at
- **subscriptions**: user_id (PK, FK), plan (free|pro), status (active|cancelled), created_at
- **categories**: id, user_id (NULL = predef), name, icon, color. UNIQUE(user_id, name)
- **expenses**: id, user_id, category_id, amount (grosze), date (YYYY-MM-DD), description, created_at
- **budgets**: user_id, category_id, month (YYYY-MM), limit_amount. PK (user_id, category_id, month)

## Amounts

All amounts stored in smallest currency unit (integer). Display: amount / 100.
