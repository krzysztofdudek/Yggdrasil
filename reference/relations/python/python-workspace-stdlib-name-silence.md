---
id: python-workspace-stdlib-name-silence
language: python
category: trap
expectation: silence
cites: "Python sys.path order — the standard library precedes site-packages, where installed workspace members live; research 2026-09-24 languages and relations M12 (PY-2)"
---

## Rule

A source root discovered from another project's `pyproject.toml` is on `sys.path` only because that project is installed, and installed projects come after the standard library on `sys.path`. A top-level module named like a standard-library module (`logging`, `json`, `types`) in such a root can never shadow the standard library for another project. The resolver therefore never matches a standard-library top-level name against a discovered root: `import logging` in the `api` member stays silent although the flat-layout `tools` member has a top-level `logging.py`.

## Files

```toml path=packages/tools/pyproject.toml
[project]
name = "tools"
version = "0.1.0"
```

```python path=packages/tools/logging.py
def setup():
    pass
```

```toml path=packages/api/pyproject.toml
[project]
name = "api"
version = "0.1.0"
```

```python path=packages/api/src/api/main.py
import logging
```

## Expect

- silence      # `logging` is the standard library; a discovered root never shadows it

## Why

Repo-wide root discovery must not bring back the false edge the ancestor-package rule removes: a discovered root adds recall only for names the standard library cannot own.
