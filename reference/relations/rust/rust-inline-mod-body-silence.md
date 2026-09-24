---
id: rust-inline-mod-body-silence
language: rust
category: nested
expectation: silence
cites: "Rust Reference — Modules (inline `mod foo { … }`); research Form D2"
---

## Rule

An inline `mod foo { … }` (a `mod_item` WITH a body) declares no separate file —
its items live in the ENCLOSING file. There is no cross-file dependency, so it emits
NOTHING. Crucially, the inline `mod foo` must NOT bind to a same-named file-backed
module elsewhere in the crate: `src/foo/mod.rs` (node `foo`) is a real, mapped, but
UNRELATED module — the inline block is local detail, never an edge to it.

## Files

```toml path=Cargo.toml
[package]
name = "mycrate"
```

```rust path=src/foo/mod.rs
pub struct Other;
```

```rust path=src/c/app.rs
mod foo {
    pub struct X;
}
```

## Expect

- silence      # the inline `mod foo { … }` is same-file detail; no edge to the unrelated file-backed node:foo

## Why

Binding an inline module to a coincidentally same-named file-backed module would be
a false positive; an inline module has no file dependency at all.
