---
id: rust-raw-identifier-module-edge
language: rust
category: import
expectation: edge
cites: "Rust Reference — Identifiers (raw identifiers `r#ident`); Rust Reference — Modules (`mod r#gen;` loads gen.rs); edition 2024 reserves `gen`"
---

## Rule

A raw identifier `r#gen` is the identifier `gen` written so it does not collide with the keyword reserved in edition 2024 (`cargo fix --edition` rewrites `gen` to `r#gen`). The module file of `mod r#gen;` is `gen.rs` / `gen/mod.rs`, and `crate::r#gen::Generated` names module `gen`. The `r#` prefix is stripped from every path segment before resolution, so both bind `src/gen/mod.rs` (node `gen`).

## Files

```toml path=Cargo.toml
[package]
name = "mycrate"
edition = "2024"
```

```rust path=src/gen/mod.rs
pub struct Generated;
```

```rust path=src/lib.rs
pub mod r#gen;
```

```rust path=src/app/mod.rs
use crate::r#gen::Generated;
```

## Expect

- src/lib.rs:1 -> node:gen          # `mod r#gen;` → src/gen/mod.rs
- src/app/mod.rs:1 -> node:gen      # crate::r#gen::Generated → module gen → src/gen/mod.rs

## Why

Probing a file literally named `r#gen.rs` misses every edge into a module whose name became a keyword.
