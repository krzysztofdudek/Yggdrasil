# Validation

Nodes carrying this aspect validate and sanitize user input before processing.

## Rules

- Use Zod schemas from `packages/shared` for request body validation.
- Reject invalid input with 400 and RFC 7807 problem details.
- Never trust client-provided values for IDs or ownership — resolve from auth context.

## Common validations

- **Amount:** positive integer (cents), never negative or zero.
- **Date:** valid ISO date string, not in future (configurable).
- **Category:** must exist and be accessible to user (predef or custom).
- **Email:** valid format, uniqueness checked where required.
- **Password:** min length, complexity rules if configured.
