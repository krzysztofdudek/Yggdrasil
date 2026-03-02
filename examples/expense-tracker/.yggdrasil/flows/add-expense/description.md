# Add Expense Flow

## Business context

User records a new expense in the system. This is the core user action — tracking how much was spent, when, and under which category.

## Trigger

User is authenticated and navigates to the Expenses page, then submits the add-expense form.

## Goal

Expense is stored in the database, linked to the user and category, and visible in the expense list.

## Participants

- `api/auth` — verifies user identity for protected routes
- `api/categories` — provides category list for selection
- `api/expenses` — creates expense record, checks Free plan limit (50/month) and budget exceeded internally
- `web/auth` — maintains session, redirects if unauthenticated
- `web/expenses` — form UI, category picker, submit handling

## Paths

### Happy path

User selects category, enters amount and date, optionally description. Limit check OK (Free: count < 50). Submit succeeds. New expense appears in list.

### Plan limit exceeded (Free)

User has 50 expenses this month. API returns 403. UI shows "You've reached the Free plan limit. Upgrade to Pro for unlimited expenses."

### Budget exceeded

Expense saved, but category budget exceeded. API returns 201 with `budget_exceeded: true`. UI shows toast "Budget exceeded for category X".

### Validation failure

Invalid amount (negative, zero), missing category, or invalid date. API returns 400. UI shows error message.

### Unauthenticated

User session expired or missing. Web redirects to Login. API returns 401 if called directly.

## Invariants across all paths

- Amount must be positive integer (cents).
- Category must exist and be accessible to user (predef or custom).
- Date must be valid ISO date string.
