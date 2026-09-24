---
id: rust-inline-mod-tests-super-glob-silence
language: rust
category: nested
expectation: silence
cites: "Rust Reference — Paths (`super` is the parent of the CURRENT module, and an inline `mod` is a module); The Rust Book ch. 11.1 (`mod tests { use super::*; }`)"
---

## Rule

Inside an inline module, `super` names the module that encloses the inline one, not the parent of the file. The canonical unit-test idiom `#[cfg(test)] mod tests { use super::*; }` in `src/orders/service.rs` therefore imports from module `orders::service`, which is the same file. Each enclosing inline module consumes one leading `super` before the file's own module is climbed from, so the import is a self-reference and emits no cross-node edge. The trap is `src/orders.rs`, the parent module's file, mapped to another node (`src`): climbing from the file instead of from the inline module lands there.

## Files

```toml path=Cargo.toml
[package]
name = "mycrate"
```

```rust path=src/orders.rs
pub struct Other;
```

```rust path=src/orders/service.rs
pub fn place() {}

#[cfg(test)]
mod tests {
    use super::*;
    use super::place as p;
}
```

## Expect

- silence      # `use super::*` inside `mod tests` is the service module itself → no edge from service.rs to the parent module's node:src

## Why

Resolving `super` from the file makes nearly every tested file at depth two or more depend on its parent module's node, a false edge that pushes users into declaring fake relations.
