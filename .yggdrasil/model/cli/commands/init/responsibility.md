# Init Command Responsibility

**In scope:** `yg init`. Bootstrap operation — creates the `.yggdrasil/` directory structure and platform-specific rules file. The entry point for adopting Yggdrasil in any repository.

Two modes: full init (creates everything from scratch) and upgrade (`--upgrade` — refreshes rules, runs migrations, updates schemas without touching existing graph content). This distinction exists because rules and schemas evolve with CLI versions, but the graph content belongs to the project.

Does not use `loadGraph` or `findYggRoot` — it creates the structure these functions depend on.

**Out of scope:** Graph loading, validation, drift detection, node/aspect/flow creation.
