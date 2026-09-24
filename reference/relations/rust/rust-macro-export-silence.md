---
id: rust-macro-export-silence
language: rust
category: dynamic
expectation: silence
cites: "Rust Reference — Macros by example, path-based scope (`#[macro_export]` places the macro in the crate root namespace wherever it is defined)"
---

## Rule

A `#[macro_export] macro_rules! mk` defined in `src/macros/mod.rs` is addressed as `crate::mk!` from anywhere in the crate: the export moves it to the crate root namespace, but its definition stays in the macros module. Neither the path (`crate::mk`) nor the crate root file names the defining file, so no edge can be pinned. The crate root file (`src/lib.rs`, node `src`) does not declare `mk`, so it is not bound either. A bare `mk!()` brought in by `#[macro_use]` carries no path at all.

## Files

```toml path=Cargo.toml
[package]
name = "mycrate"
```

```rust path=src/lib.rs
pub struct Unrelated;
```

```rust path=src/macros/mod.rs
#[macro_export]
macro_rules! mk {
    () => {};
}
```

```rust path=src/app/mod.rs
fn f() {
    crate::mk!();
    mk!();
}
```

## Expect

- silence      # crate::mk names the crate root namespace, not a file; src/lib.rs does not declare mk → no edge to node:src or node:macros

## Why

Binding `crate::mk` to the crate root file would point the edge at a node that neither defines nor re-exports the macro, a false positive.
