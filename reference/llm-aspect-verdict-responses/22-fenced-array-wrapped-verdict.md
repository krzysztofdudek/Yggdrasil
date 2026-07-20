---
id: 22-fenced-array-wrapped-verdict
category: malformed
expectation: verdict
---

## Rule

A markdown-fenced reply whose fenced payload is a JSON array wrapping the verdict object — the fence step must not short-circuit on the array; the inner verdict is recovered.

## Input

````text
```json
[{"satisfied": false, "reason": "missing input validation"}]
```
````

## Expect

- satisfied: false
- error_source: codeViolation
- reason_includes: input validation
