# Support Unit Tests — Responsibility

Parent node for supporting module tests. Formatter and migration tests live here directly; I/O parsers, templates, and utils are delegated to child nodes.

Does not cover core library tests or CLI command wrapper tests — those belong to sibling nodes under `unit/`.
