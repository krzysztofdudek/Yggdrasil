---
id: rust-use-crate-root-item-edge
language: rust
category: import
expectation: edge
cites: "Rust Reference — Paths (`crate` names the crate root module, whose items live in the crate root file src/lib.rs or src/main.rs)"
---

## Rule

Items defined in the crate root (`pub struct Config;`, `pub enum Error` in `src/lib.rs`) are addressed as `crate::Config` and `crate::Error`. The crate root module's file is the crate root file, `src/lib.rs` (else `src/main.rs`), so these paths bind `src/lib.rs` (node `src`). This is the common `crate::Error` / `crate::Result` pattern. The root file is bound only when it actually declares or imports the named item: a name the root file never mentions (`crate::helper!`, a `#[macro_export]` macro defined elsewhere, which also lands in the crate root namespace) stays silent rather than binding the root file, so line 3 (`crate::Missing`) emits nothing.

## Files

```toml path=Cargo.toml
[package]
name = "mycrate"
```

```rust path=src/lib.rs
pub struct Config;
pub enum Error {}
```

```rust path=src/orders/mod.rs
use crate::Error;
use crate::{Config, Error as E};
use crate::Missing;
```

## Expect

- src/orders/mod.rs:1 -> node:src      # crate::Error → src/lib.rs, which declares `enum Error`
- src/orders/mod.rs:2 -> node:src      # the crate-root group: each item resolves to src/lib.rs, one edge for the line

## Why

Without the crate root file as the module file of `crate`, every crate-wide type is unreachable and the dependency on the root node is never enforced. Checking the name keeps crate-root macros defined elsewhere out of it.
