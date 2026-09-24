---
id: python-src-layout-tests-edge
language: python
category: import
expectation: edge
cites: "PyPA packaging guide — src layout vs flat layout (the package is importable from `src/`, tests live beside it); research 2026-09-24 languages and relations M12 (PY-2)"
---

## Rule

In the PyPA src layout the project's `pyproject.toml` sits at the project root and the importable packages live under `src/`, which is the source root the installed project puts on `sys.path`. Tests live in `tests/`, outside `src/`, so `src/` is not an ancestor of the importing file. The resolver discovers source roots repo-wide: every directory holding a `pyproject.toml`, `setup.cfg` or `setup.py` contributes its `src/` child when that exists, and the directory itself otherwise. `from core.service import run` in `tests/test_service.py` then resolves to `src/core/service.py`.

## Files

```toml path=pyproject.toml
[project]
name = "shop"
version = "0.1.0"
```

```python path=src/core/service.py
def run():
    pass
```

```python path=tests/test_service.py
from core.service import run


def test_run():
    run()
```

## Expect

- tests/test_service.py:1 -> node:core      # `src/` is the project's discovered source root, so core.service resolves to src/core/service.py

## Why

The src layout is the layout PyPA recommends. Without discovered roots the check only probed the importer's own ancestors and silently missed every dependency from tests onto the code under test.
