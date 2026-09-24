---
id: rust-use-grouped-nested-subpath-edge
language: rust
category: import
expectation: edge
cites: "Rust Reference — Use declarations (nested use trees `use crate::p::{a::X, b::Y}`, `use super::{…}`)"
---

## Rule

When a group's items are themselves paths (`use crate::domain::{billing::Invoice, orders::Order};`), each item is joined to the accumulated prefix and resolved on its own: `crate::domain::billing::Invoice` binds `src/domain/billing/mod.rs` (node `billing`), not the prefix module `src/domain/mod.rs` (node `domain`). The same holds for a `super::`-rooted group: from `src/domain/web/mod.rs`, `super::{billing::Invoice, orders::Order}` climbs to module `domain` and resolves each item under it. The prefix module is never the target of an item that names a deeper path.

## Files

```toml path=Cargo.toml
[package]
name = "mycrate"
```

```rust path=src/domain/mod.rs
pub mod billing;
pub mod orders;
```

```rust path=src/domain/billing/mod.rs
pub struct Invoice;
```

```rust path=src/domain/orders/mod.rs
pub struct Order;
```

```rust path=src/app/mod.rs
use crate::domain::{billing::Invoice, orders::Order};
```

```rust path=src/domain/web/mod.rs
use super::{billing::Invoice, orders::Order};
```

## Expect

- src/domain/mod.rs:1 -> node:billing        # `pub mod billing;` in the domain module file
- src/domain/mod.rs:2 -> node:orders         # `pub mod orders;` in the domain module file
- src/app/mod.rs:1 -> node:billing           # crate::domain::billing::Invoice → src/domain/billing/mod.rs
- src/app/mod.rs:1 -> node:orders            # crate::domain::orders::Order → src/domain/orders/mod.rs; no edge to node:domain
- src/domain/web/mod.rs:1 -> node:billing    # super:: from module domain::web climbs to domain, then billing
- src/domain/web/mod.rs:1 -> node:orders     # same climb, then orders

## Why

Binding every item of a nested group to the prefix module points the edge at the parent node, a wrong target, and hides the real dependencies on the child modules.
