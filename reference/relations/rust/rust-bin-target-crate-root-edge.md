---
id: rust-bin-target-crate-root-edge
language: rust
category: import
expectation: edge
cites: "The Cargo Book — Target auto-discovery (src/bin/*.rs, src/bin/*/main.rs are binary crate roots); Rust Reference — Modules (a crate root file resolves `mod` beside itself)"
---

## Rule

`src/bin/tool.rs` is the root of its own binary crate. `crate::` in it names that binary crate, whose module tree is rooted at `src/bin/`, not the library's `src/`. A crate root resolves `mod opts;` beside itself, like a `mod.rs`: `src/bin/opts.rs` or `src/bin/opts/mod.rs`. So `mod opts;` and `use crate::opts::Args;` both bind `src/bin/opts/mod.rs` (node `opts`). The library module `src/opts.rs` (node `src`) is a same-named decoy that only `mycrate::opts` would reach.

## Files

```toml path=Cargo.toml
[package]
name = "mycrate"
```

```rust path=src/opts.rs
pub struct Args;
```

```rust path=src/bin/opts/mod.rs
pub struct Args;
```

```rust path=src/bin/tool.rs
mod opts;
use crate::opts::Args;
```

## Expect

- src/bin/tool.rs:1 -> node:opts      # `mod opts;` in a crate root → src/bin/opts/mod.rs
- src/bin/tool.rs:2 -> node:opts      # crate:: from the bin crate root → src/bin/, never the lib decoy src/opts.rs (node:src)

## Why

Treating a binary target as a module of the library binds same-named library modules (a wrong target) and misses the binary's own `mod` edges.
