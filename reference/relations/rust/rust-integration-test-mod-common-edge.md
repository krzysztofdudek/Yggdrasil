---
id: rust-integration-test-mod-common-edge
language: rust
category: import
expectation: edge
cites: "The Rust Book ch. 11.3 (tests/common/mod.rs shared helpers); The Cargo Book — Target auto-discovery (tests/*.rs are test crate roots)"
---

## Rule

Each `tests/*.rs` file is the root of its own test crate, so `mod common;` in `tests/it.rs` resolves beside it: `tests/common/mod.rs` (node `common`). The library is reached from a test crate by its package name: `mycrate::api::Client` binds the library module `src/api/mod.rs` (node `api`).

## Files

```toml path=Cargo.toml
[package]
name = "mycrate"
```

```rust path=src/api/mod.rs
pub struct Client;
```

```rust path=tests/common/mod.rs
pub fn setup() {}
```

```rust path=tests/it.rs
mod common;
use mycrate::api::Client;
```

## Expect

- tests/it.rs:1 -> node:common      # `mod common;` in a test crate root → tests/common/mod.rs
- tests/it.rs:2 -> node:api         # the package name from a test crate → the library's src/api/mod.rs

## Why

This is the Rust Book's shared-helper idiom. Resolving a test root like a library module probes `tests/it/common.rs` and misses the edge.
