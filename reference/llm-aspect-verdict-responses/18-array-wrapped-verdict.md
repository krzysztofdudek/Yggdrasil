---
id: 18-array-wrapped-verdict
category: malformed
expectation: verdict
---

## Rule

Valid verdict object wrapped in a top-level JSON array — the array itself is not a verdict, but the inner object is; the true verdict must be recovered rather than silently dropped to a false satisfied=false refusal.

## Input

````text
[{"satisfied": true, "reason": "code is compliant"}]
````

## Expect

- satisfied: true
- error_source: codeViolation
- reason_includes: code is compliant
