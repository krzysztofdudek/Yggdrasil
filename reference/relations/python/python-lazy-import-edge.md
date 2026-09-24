---
id: python-lazy-import-edge
language: python
category: import
expectation: edge
cites: "PEP 810 — explicit lazy imports (`lazy import`, `lazy from … import`), Python 3.15; research 2026-09-24 languages and relations §6"
---

## Rule

A `lazy import` defers loading to first use, but it names the same module as an eager import, so it is the same dependency. The shipped grammar has no `lazy` keyword: it reads `lazy` as a stray identifier and still parses the rest as an ordinary `import_statement` or `import_from_statement`, so both forms produce the edge.

## Files

```python path=src/billing/charge.py
def run():
    pass
```

```python path=src/app/main.py
lazy import billing.charge
lazy from billing.charge import run
```

## Expect

- src/app/main.py:1 -> node:billing      # `lazy import billing.charge` → billing/charge.py
- src/app/main.py:2 -> node:billing      # `lazy from billing.charge import run` → billing/charge.py

## Why

Deferred loading changes when a module is imported, never which module, so the edge must not depend on whether the grammar knows the keyword.
