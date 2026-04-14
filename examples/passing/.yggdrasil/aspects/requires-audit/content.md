# Requires Audit

Every function that mutates state (creates, updates, or deletes data) must emit
an audit event before returning. The audit event must include:

- The operation name (e.g. "charge", "refund")
- A timestamp
- The relevant entity ID

Acceptable patterns:

- Calling an `audit()` or `emitAudit()` function with the required fields
- Logging to an audit-specific channel with structured data

Not acceptable:

- Generic `console.log` statements (not structured, not routable)
- Audit calls only in error paths (must audit success too)
