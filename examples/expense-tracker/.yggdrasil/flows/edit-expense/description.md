# Edit Expense Flow

## Business context

User corrects an existing expense — wrong amount, category, date, or description. Edit does not count toward plan limits.

## Trigger

User clicks "Edit" on an expense and submits the edit form.

## Goal

Expense updated in database. User sees updated list.

## Participants

- `api/expenses` — updates expense, enforces ownership
- `api/categories` — provides category list for selection
- `web/expenses` — edit form, pre-filled data, submit handling

## Paths

### Happy path

Validation OK → verify ownership → update Expense → 200 → redirect /expenses.

### Not found / no permission

Expense does not exist or belongs to another user. API returns 404.

### Validation failure

Invalid amount, category, or date. API returns 400. UI shows field errors.

## Invariants across all paths

- Edit does not increase plan limit counter (limit applies to new inserts only).
- Amount must remain positive. Category must be accessible to user.
