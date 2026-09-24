---
id: rust-use-grouped-crate-root-edge
language: rust
category: import
expectation: edge
cites: "Rust Reference — Use declarations (nested use trees `use crate::{a::X, b::Y}`); rustfmt `imports_granularity = \"Crate\"`; rust-analyzer merge-imports"
---

## Rule

A crate-rooted use tree `use crate::{billing::Invoice, orders::Order};` imports from TWO different modules in one declaration. It is what rustfmt with `imports_granularity = "Crate"` or `"One"` and rust-analyzer's merge-imports produce, so it is the ordinary shape of imports in a formatted crate. Each item carries its own path under the common `crate` prefix, so each item is resolved on its own: `crate::billing::Invoice` binds `src/billing/mod.rs` (node `billing`) and `crate::orders::Order` binds `src/orders/mod.rs` (node `orders`). The group prefix alone (`crate`) names no module and establishes nothing.

## Files

```toml path=Cargo.toml
[package]
name = "mycrate"
```

```rust path=src/billing/mod.rs
pub struct Invoice;
```

```rust path=src/orders/mod.rs
pub struct Order;
```

```rust path=src/app/mod.rs
use crate::{billing::Invoice, orders::Order};
```

## Expect

- src/app/mod.rs:1 -> node:billing      # the item crate::billing::Invoice → src/billing/mod.rs
- src/app/mod.rs:1 -> node:orders       # the item crate::orders::Order → src/orders/mod.rs, same line, its own edge

## Why

Emitting only the group prefix loses both real dependencies: `crate` on its own resolves to no module file. The item paths are the dependencies.
