---
id: 19-renamed-verdict-field
category: infra
expectation: infra
---

## Rule

Top-level JSON object with a renamed verdict field (no "satisfied": field) — must NOT become a false satisfied=false codeViolation refusal; it fails closed as a provider/infra error so the pair stays unverified and retryable.

## Input

````text
{"verdict": "pass", "reason": "all good"}
````

## Expect

- error_source: provider
