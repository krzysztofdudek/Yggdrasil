# Error Format

All API error responses follow a consistent structure for client parsing.

## Structure

Prefer RFC 7807 problem details:

```json
{
  "type": "https://api.example.com/errors/validation",
  "title": "Validation Failed",
  "status": 400,
  "detail": "Invalid request body",
  "instance": "/expenses",
  "errors": [
    { "path": "/amount", "message": "Must be positive" }
  ]
}
```

Or simple format when sufficient:

```json
{
  "error": "Human-readable message",
  "details": { "field": "value" }
}
```

## Status codes

- 400 — Validation failure, bad request
- 401 — Unauthenticated
- 403 — Forbidden (e.g. plan limit)
- 404 — Not found
- 409 — Conflict (e.g. duplicate email)
- 500 — Internal error (never expose stack traces)

## Security

- Do not reveal whether an email exists (401 for both invalid password and unknown email).
- Do not expose internal error details to clients.
