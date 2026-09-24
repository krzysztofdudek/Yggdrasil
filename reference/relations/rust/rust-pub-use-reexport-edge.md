---
id: rust-pub-use-reexport-edge
language: rust
category: import
expectation: edge
cites: "Rust Reference — Use declarations (`pub use` re-export); Visibility and privacy; research Form A12"
---

## Rule

A `pub use crate::api::Handler;` re-exports a name — a real runtime dependency on
the re-exported path, resolved exactly like a private `use`. The leading
`visibility_modifier` (`pub`) is a child of `use_declaration`, not part of the
`argument` field the extractor reads, so visibility never shifts the parse: the
edge is `crate::api::Handler` (item `Handler` in module `api`, file `src/api/mod.rs`).

## Files

```toml path=Cargo.toml
[package]
name = "mycrate"
```

```rust path=src/api/mod.rs
pub struct Handler;
```

```rust path=src/c/app.rs
pub use crate::api::Handler;
```

## Expect

- src/c/app.rs:1 -> node:api      # `pub use` is identical to `use` for the edge; crate::api::Handler → src/api/mod.rs (node api)

## Why

Visibility is irrelevant to the dependency: a re-export still depends on the
re-exported path. Keying off the `argument` field (never a child index) keeps the
`pub` token from shifting anything.
