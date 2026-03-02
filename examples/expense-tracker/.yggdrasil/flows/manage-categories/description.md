# Manage Categories Flow

## Business context

User adds, edits, or deletes custom categories. Predefined categories (Food, Transport, etc.) are read-only.

## Trigger

User on Categories page: adds new category, or edits/deletes an existing custom one.

## Goal

Custom category stored, updated, or removed. Free plan: max 5 custom categories.

## Participants

- `api/categories` — CRUD for custom categories, checks Free plan limit (5 custom) internally
- `web/categories` — list, add form, edit/delete actions

## Paths

### Add — happy path

Validation OK → check limit (Free: count < 5) → insert → 201. New category in list.

### Add — limit exceeded (Free)

User has 5 custom categories. API returns 403. "Maximum 5 custom categories on Free plan. Upgrade to Pro."

### Edit / Delete — happy path

Verify ownership → update or delete → 200/204. List refreshed.

### Edit / Delete — not found

Category does not exist or is predefined (read-only). API returns 404.

## Invariants across all paths

- Predefined categories (user_id IS NULL) are read-only. Custom = user_id = current user.
- Name must be unique per user.
