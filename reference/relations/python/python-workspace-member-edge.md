---
id: python-workspace-member-edge
language: python
category: import
expectation: edge
cites: "uv workspaces — every member is installed into one environment; Poetry path dependencies; research 2026-09-24 languages and relations M12 (PY-2)"
---

## Rule

In a uv (or Poetry) workspace each member is a project with its own `pyproject.toml`, and every member is installed into the same environment, so one member imports another by its package name. Neither member's source root is an ancestor of the other's files. Each member's `pyproject.toml` makes its `src/` child a discovered source root, so `from lib.util import helper` in the `api` member resolves to `packages/lib/src/lib/util.py`.

## Files

```toml path=pyproject.toml
[tool.uv.workspace]
members = ["packages/*"]
```

```toml path=packages/lib/pyproject.toml
[project]
name = "lib"
version = "0.1.0"
```

```python path=packages/lib/src/lib/util.py
def helper():
    pass
```

```toml path=packages/api/pyproject.toml
[project]
name = "api"
version = "0.1.0"
dependencies = ["lib"]
```

```python path=packages/api/src/api/main.py
from lib.util import helper

helper()
```

## Expect

- packages/api/src/api/main.py:1 -> node:lib      # the lib member's src/ is a discovered source root → lib.util is packages/lib/src/lib/util.py

## Why

Cross-member imports are the dependencies a workspace most needs to police, and they were invisible. Discovered roots keep the existing rule that two distinct matches across roots stay silent.
