# View Reports Flow

## Business context

User reviews spending by category for a selected month. Chart and table show totals per category and percentage of total.

## Trigger

User navigates to Reports, selects month from dropdown.

## Goal

User sees chart (e.g. bar chart) and table: category, sum, % of total.

## Participants

- `api/reports` — aggregates expenses by category for month (reads from expenses table)
- `web/reports` — month selector, chart, table

## Paths

### Happy path

User selects month. API returns aggregated data. Chart and table render. Empty month shows "No expenses".

### No data

Selected month has no expenses. API returns empty array. UI shows empty state.

## Invariants across all paths

- Amounts in cents. Display converts to currency (e.g. 1234 → 12.34).
- Only user's own expenses included.
