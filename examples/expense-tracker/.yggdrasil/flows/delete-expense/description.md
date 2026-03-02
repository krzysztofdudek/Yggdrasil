# Delete Expense Flow

## Business context

User removes an expense from the system. Hard delete — record is removed from database.

## Trigger

User clicks "Delete" on an expense (with optional confirmation).

## Goal

Expense removed. List refreshed.

## Participants

- `api/expenses` — deletes expense, enforces ownership
- `web/expenses` — delete button, confirmation, list refresh

## Paths

### Happy path

Verify ownership → delete → 204 → frontend removes row from list.

### Not found

Expense does not exist or belongs to another user. API returns 404.

## Invariants across all paths

- Only owner can delete. No soft delete on start.
