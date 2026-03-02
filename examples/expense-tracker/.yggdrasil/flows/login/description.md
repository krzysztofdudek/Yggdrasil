# Login Flow

## Business context

Existing user authenticates to access the app. After login, user can access dashboard and all protected features.

## Trigger

User enters email and password on Login page and clicks "Log in".

## Goal

JWT stored (cookie/localStorage), user redirected to Dashboard.

## Participants

- `api/auth` — validates credentials, issues JWT
- `web/auth` — login form, stores token, redirects

## Paths

### Happy path

Validation OK → find User → verify password → return JWT → redirect /dashboard.

### Invalid credentials

Wrong password or non-existent email. API returns 401. "Invalid email or password" (no hint which is wrong).

### Validation failure

Invalid email format or empty password. API returns 400. UI shows field errors.

## Invariants across all paths

- JWT contains user_id and plan. Lifetime e.g. 7 days.
- Never reveal whether email exists.
