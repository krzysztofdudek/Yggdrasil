# Formatters Errors

No thrown errors — pure transformation. Callers must ensure valid `ContextPackage` input.

- Invalid or malformed `ContextPackage` may produce incomplete or misleading output; no validation is performed.
- No I/O — no filesystem or network errors.
- No recovery behavior — caller responsibility.
