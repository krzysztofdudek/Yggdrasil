---
id: rust-mod-decl-inside-inline-mod-edge
language: rust
category: nested
expectation: edge
cites: "Rust Reference — Modules, module source filenames (a `mod x;` nested in an inline `mod outer { … }` lives under the directory named after `outer`)"
---

## Rule

A file-backed `mod inner;` declared inside an inline `mod outer { … }` does not live beside the file: its file is `<module dir>/outer/inner.rs` (or `…/outer/inner/mod.rs`). From `src/app/mod.rs`, `mod outer { mod inner; }` declares `src/app/outer/inner.rs` (node `outer`). The inline module names are part of the path. The decoy `src/app/inner/mod.rs` (node `inner`) is what a resolver that ignores the inline module would bind.

## Files

```toml path=Cargo.toml
[package]
name = "mycrate"
```

```rust path=src/app/outer/inner.rs
pub struct Deep;
```

```rust path=src/app/inner/mod.rs
pub struct Decoy;
```

```rust path=src/app/mod.rs
mod outer {
    mod inner;
}
```

## Expect

- src/app/mod.rs:2 -> node:outer      # `mod inner;` inside inline `mod outer` → src/app/outer/inner.rs; never the decoy node:inner

## Why

The inline module is a real level of the module tree, so skipping it would bind a same-named sibling module, a wrong target.
