---
id: 20-empty-json-object
category: infra
expectation: infra
---

## Rule

An empty JSON object carries no verdict — must fail closed as a provider/infra error rather than caching a false satisfied=false refusal with an empty reason over code the reviewer never judged.

## Input

````text
{}
````

## Expect

- error_source: provider
