---
id: python-stdlib-shadowed-by-ancestor-module-silence
language: python
category: trap
expectation: silence
cites: "Python import system — sys.path holds source roots, never directories inside a regular package; research 2026-09-24 languages and relations M1 (PY-1)"
---

## Rule

An absolute import is searched only on `sys.path`, and a directory that holds an `__init__.py` is inside a regular package, so it is never a `sys.path` root. `import logging` in `app/api/routes.py` therefore loads the standard library's `logging`, even though the ancestor package `app/` has its own `logging.py`, and `from celery import shared_task` in `proj/orders/tasks.py` loads the installed Celery library, not the project's `proj/celery.py` (the canonical Django and Celery layout). The resolver probes only ancestor directories that are not inside a regular package (no `__init__.py` in the directory or its parent), so neither import can bind to the same-named module of an ancestor package.

## Files

```python path=src/app/__init__.py
```

```python path=src/app/logging.py
def configure():
    pass
```

```python path=src/app/api/__init__.py
```

```python path=src/app/api/routes.py
import logging

log = logging.getLogger(__name__)
```

```python path=src/proj/__init__.py
```

```python path=src/proj/celery.py
app = None
```

```python path=src/proj/orders/__init__.py
```

```python path=src/proj/orders/tasks.py
from celery import shared_task
```

## Expect

- silence      # `logging` and `celery` are searched on sys.path only; src/app and src/proj are packages, not roots, so the ancestor modules never match

## Why

Before this rule, every ancestor directory was probed as a source root, so a top-level package with a `logging.py`, `types.py`, `email.py` or `celery.py` module turned every import of the real library from one of its sub-packages into a CI-blocking false edge with no waiver.
