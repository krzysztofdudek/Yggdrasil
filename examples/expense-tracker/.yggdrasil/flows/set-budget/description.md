# Set Budget Flow

## Business context

User sets a monthly spending limit for a category. Used to track overspending and show alerts on Dashboard.

## Trigger

User navigates to Budgets, selects category and month, enters limit amount, saves.

## Goal

Budget record stored. Visible on Dashboard and /budgets. Alerts when exceeded.

## Participants

- `api/budgets` — upserts budget per (user, category, month)
- `api/categories` — provides category list
- `web/budgets` — form, limit input, status display

## Paths

### Happy path

Validation OK (limit >= 0) → upsert Budget → 200. UI shows saved limit and current vs limit.

### Validation failure

Negative limit. API returns 400. UI shows error.

## Invariants across all paths

- One budget per (user, category, month). No record = no limit (unlimited).
- Limit in cents (integer). Zero = no spending allowed for that category.
