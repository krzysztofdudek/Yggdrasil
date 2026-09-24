---
id: rust-workspace-path-dependency-edge
language: rust
category: import
expectation: edge
cites: "The Cargo Book — Specifying dependencies (path dependencies, `workspace = true` inheritance from `[workspace.dependencies]`, `package =` renames)"
---

## Rule

In a Cargo workspace, member crates depend on each other through path dependencies. `crates/server/Cargo.toml` declares `core-lib = { workspace = true }`, inherited from the root `[workspace.dependencies] core-lib = { path = "crates/core-lib" }`, and `util = { path = "../util" }` directly. In code the crates are named `core_lib` and `util`. A path whose first segment is such a name resolves inside that crate's library module tree: `core_lib::Engine` binds `crates/core-lib/src/lib.rs` (node `src`), and `util::text::slug` binds `crates/util/src/text/mod.rs` (node `text`). Only dependencies whose `path` points inside the repository are resolved. A registry dependency (`serde = "1"`) is external and stays silent (line 3 emits nothing).

## Files

```toml path=Cargo.toml
[workspace]
members = ["crates/*"]

[workspace.dependencies]
core-lib = { path = "crates/core-lib" }
```

```toml path=crates/core-lib/Cargo.toml
[package]
name = "core-lib"
```

```toml path=crates/util/Cargo.toml
[package]
name = "util"
```

```toml path=crates/server/Cargo.toml
[package]
name = "server"

[dependencies]
core-lib = { workspace = true }
util = { path = "../util" }
serde = "1"
```

```rust path=crates/core-lib/src/lib.rs
pub struct Engine;
```

```rust path=crates/util/src/text/mod.rs
pub fn slug() {}
```

```rust path=crates/server/src/cmd/run.rs
use core_lib::Engine;
use util::text::slug;
use serde::Serialize;
```

## Expect

- crates/server/src/cmd/run.rs:1 -> node:src      # core_lib (workspace-inherited path dep) → crates/core-lib/src/lib.rs, which declares Engine
- crates/server/src/cmd/run.rs:2 -> node:text     # util (direct path dep) → crates/util/src/text/mod.rs

## Why

In a Rust monorepo a node usually maps to a workspace member crate, so these inter-crate imports are the architecture to enforce. A path dependency that points inside the repository names exactly one in-repo crate, so the edge is deterministic. External crates are never path dependencies.
