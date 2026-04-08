# Formatters Internals

## Decisions

Chose YAML over the previous XML-like tag format for context map output because YAML is more readable for agents and easier to parse programmatically. The old `formatContextText` (XML tags) was removed as dead code.

Chose pure transformation with no validation — formatters receive structured data and produce text. Callers own input validity, keeping the formatting layer deterministic and testable.
