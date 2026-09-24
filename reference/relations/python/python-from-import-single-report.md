---
id: python-from-import-single-report
language: python
category: trap
expectation: edge
cites: "research 2026-09-24 languages and relations m18 (PY-4) — one import statement, one reported dependency"
---

## Rule

`from core.service import run, stop` offers the module `core.service` and the submodule candidates `core.service.run` and `core.service.stop`, because an imported name may itself be a submodule. Here all three resolve to the same file, `src/core/service.py`. They describe one dependency on one line, so the check reports exactly one edge for the line: resolved dependencies are deduplicated on the importing file, the line and the target node.

## Files

```python path=src/core/service.py
def run():
    pass


def stop():
    pass
```

```python path=src/app/main.py
from core.service import run, stop
```

## Expect

- src/app/main.py:1 -> node:core      # exactly one row, although three candidates resolve to src/core/service.py

## Why

Each candidate used to be reported as its own violation, so one import printed the same line two or three times and inflated the issue count.
