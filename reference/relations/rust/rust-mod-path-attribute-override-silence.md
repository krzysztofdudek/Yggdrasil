---
id: rust-mod-path-attribute-override-silence
language: rust
category: dynamic
expectation: silence
cites: "Rust Reference — Modules (`#[path = \"…\"]` attribute); research Form C4 / D1 (override skipped)"
---

## Rule

A `#[path = "…"] mod foo;` overrides the conventional file location of the child
module. Resolving the override correctly needs nesting-sensitive directory rules a
source-only walk cannot get right in every case, so a `#[path]`-annotated `mod` is
SKIPPED (silence) rather than risk binding the wrong file — a tolerated recall gap,
never a false positive. Here the override points at `custom/loc.rs` (a real mapped
file in node `custom`), yet the `mod foo;` emits NOTHING.

## Files

```toml path=Cargo.toml
[package]
name = "mycrate"
```

```rust path=src/c/custom/loc.rs
pub struct X;
```

```rust path=src/c/mod.rs
#[path = "custom/loc.rs"]
mod foo;
```

## Expect

- silence      # the `#[path]` override is skipped; no edge to node:custom even though custom/loc.rs exists and is mapped

## Why

A wrong override resolution would be a false positive; skipping `#[path]` mods
forgoes the (rare) edge instead of risking a mis-bind — the safe under-detect
direction.
