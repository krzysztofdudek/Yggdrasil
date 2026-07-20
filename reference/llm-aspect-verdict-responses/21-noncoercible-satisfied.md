---
id: 21-noncoercible-satisfied
category: infra
expectation: infra
---

## Rule

A "satisfied" field whose value is neither a boolean nor a quoted true/false ("yes") is not a coercible verdict — must fail closed as a provider/infra error, not a false satisfied=false refusal.

## Input

````text
{"satisfied": "yes", "reason": "looks fine"}
````

## Expect

- error_source: provider
