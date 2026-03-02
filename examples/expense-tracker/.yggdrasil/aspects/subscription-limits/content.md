# Subscription Limits

Nodes carrying this aspect enforce plan-based limits before allowing operations.

## Plan limits

| Plan | Expenses per month | Custom categories |
|------|--------------------|-------------------|
| Free | 50                 | max 5             |
| Pro  | unlimited          | unlimited         |

## Enforcement

- **Expenses:** Before inserting a new expense, count user's expenses in current month. Free users exceeding 50 get 403.
- **Categories:** Before inserting a custom category, count user's custom categories. Free users exceeding 5 get 403.
- **Edit/Delete:** Do not count toward limits — limits apply only to new inserts.

## Error response

403 Forbidden with message: "You've reached the Free plan limit. Upgrade to Pro for unlimited [expenses|categories]."
