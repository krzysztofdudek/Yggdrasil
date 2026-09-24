---
id: rust-extern-crate-alias-edge
language: rust
category: import
expectation: edge
cites: "Rust Reference — Extern crate declarations (`extern crate name as alias;`); The Cargo Book — path dependencies"
---

## Rule

`extern crate core_lib as cl;` links the in-repo path dependency `core_lib` and binds it under the local alias `cl`. The declaration itself names the crate, so it binds the crate's root file `crates/core-lib/src/lib.rs` (node `src`) on its own line. A later `use cl::Engine;` is rooted at the local alias, a name only the extern-crate binding introduces, so it stays silent: the dependency is already carried by the declaration line. `extern crate std as s;` names an external crate and stays silent too.

## Files

```toml path=Cargo.toml
[workspace]
members = ["crates/*"]
```

```toml path=crates/core-lib/Cargo.toml
[package]
name = "core-lib"
```

```toml path=crates/server/Cargo.toml
[package]
name = "server"

[dependencies]
core-lib = { path = "../core-lib" }
```

```rust path=crates/core-lib/src/lib.rs
pub struct Engine;
```

```rust path=crates/server/src/cmd/run.rs
extern crate core_lib as cl;
use cl::Engine;
extern crate std as s;
```

## Expect

- crates/server/src/cmd/run.rs:1 -> node:src      # extern crate core_lib → the path dependency's crate root file

## Why

The extern-crate declaration is the one place the real crate name appears. Following aliases would need a binding table the extractor does not keep, and the dependency is already recorded on the declaration line.
