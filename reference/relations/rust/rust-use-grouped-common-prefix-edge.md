---
id: rust-use-grouped-common-prefix-edge
language: rust
category: import
expectation: edge
cites: "Rust Reference — Use declarations (nested/grouped `use a::b::{C, D}`); research Form A9"
---

## Rule

A grouped `use crate::a::b::{C, D};` imports several items from the module before the braces. Every item of a use tree is resolved on its own, joined to that prefix: `crate::a::b::C` and `crate::a::b::D`. Here both leaves are items of module `a::b`, so the longest-match walk binds each to the module's file `src/a/b.rs` (node `a`), and the two same-line edges to one node are one finding. A leaf that is itself a submodule (`crate::a::{b}`) binds that submodule's file, exactly as the ungrouped `use crate::a::b;` would; items that are deeper paths are covered by rust-use-grouped-crate-root-edge and rust-use-grouped-nested-subpath-edge.

## Files

```toml path=Cargo.toml
[package]
name = "mycrate"
```

```rust path=src/a/b.rs
pub struct C;
pub struct D;
```

```rust path=src/c/use.rs
use crate::a::b::{C, D};
```

## Expect

- src/c/use.rs:1 -> node:a      # each leaf crate::a::b::C / crate::a::b::D falls back to the module file src/a/b.rs (node a)

## Why

Resolving each item the way its ungrouped `use` would resolve keeps grouped and split imports equivalent, which is what rustfmt and rust-analyzer assume when they merge or split them. Binding every item to the prefix module was only right when all items are leaves of that module.
