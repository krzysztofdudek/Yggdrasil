import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { makeResolvePathToFile, parseCargoManifest, rustFileDeclares } from '../../../../src/relations/resolve-path.js';
import { resolveRustPath } from '../../../../src/relations/extractors/rust-resolve.js';

// The Rust resolver maps a `::`-path → a `.rs` file through the crate module tree.
// The crate root is the nearest ancestor of the importing file containing a
// Cargo.toml; its `src/` is the module-tree root. These tests build a real temp
// crate and clean it up in `afterEach`, driven through the production
// makeResolvePathToFile (disk-backed Cargo.toml + existence).

describe('resolveRustPath via makeResolvePathToFile (disk-backed)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rust-resolve-'));
    // A crate named `mycrate` with src/ as the module-tree root.
    writeFileSync(
      path.join(root, 'Cargo.toml'),
      '[package]\nname = "mycrate"\nversion = "0.1.0"\nedition = "2021"\n',
      'utf-8',
    );
    mkdirSync(path.join(root, 'src', 'a'), { recursive: true });
    // crate::a::b → src/a/b.rs
    writeFileSync(path.join(root, 'src', 'a', 'b.rs'), '// b\n', 'utf-8');
    // crate::a (module via file) → src/a.rs
    writeFileSync(path.join(root, 'src', 'a.rs'), 'pub mod b;\n', 'utf-8');
    // crate::orders → src/orders/mod.rs (mod.rs form)
    mkdirSync(path.join(root, 'src', 'orders'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'orders', 'mod.rs'), '// orders\n', 'utf-8');
    // crate root entry
    writeFileSync(path.join(root, 'src', 'lib.rs'), 'pub mod a;\npub mod orders;\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves crate::a::b to src/a/b.rs (item path → file)', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('crate::a::b', 'src/lib.rs', 'rust')).toBe('src/a/b.rs');
  });

  it('resolves crate::a::b::Sym to src/a/b.rs via the longest-match item fallback', () => {
    // Sym is a TYPE inside module a::b — the module file is src/a/b.rs.
    const resolve = makeResolvePathToFile(root);
    expect(resolve('crate::a::b::Sym', 'src/lib.rs', 'rust')).toBe('src/a/b.rs');
  });

  it('resolves crate::a::Type to src/a.rs (last segment is an item in module a)', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('crate::a::Type', 'src/lib.rs', 'rust')).toBe('src/a.rs');
  });

  it('resolves crate::orders to src/orders/mod.rs (mod.rs form)', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('crate::orders::Order', 'src/lib.rs', 'rust')).toBe('src/orders/mod.rs');
  });

  it('treats the crate own name like `crate` (2018+ path clarity)', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('mycrate::a::b', 'src/lib.rs', 'rust')).toBe('src/a/b.rs');
  });

  it('resolves super:: relative to the importing file module', () => {
    // From src/a/b.rs (module crate::a::b), `super::` is module crate::a → src/a.rs.
    const resolve = makeResolvePathToFile(root);
    expect(resolve('super::Type', 'src/a/b.rs', 'rust')).toBe('src/a.rs');
  });

  it('resolves self:: against the importing file own module', () => {
    // From src/a.rs (module crate::a), `self::b` is crate::a::b → src/a/b.rs.
    const resolve = makeResolvePathToFile(root);
    expect(resolve('self::b', 'src/a.rs', 'rust')).toBe('src/a/b.rs');
  });

  it('returns undefined for a stdlib import (external crate root)', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('std::collections::HashMap', 'src/lib.rs', 'rust')).toBeUndefined();
  });

  it('returns undefined for a third-party crate (serde) — not the crate own name', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('serde::Serialize', 'src/lib.rs', 'rust')).toBeUndefined();
  });

  it('returns undefined for a crate path whose module file is absent', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('crate::nope::Thing', 'src/lib.rs', 'rust')).toBeUndefined();
  });

  it('returns undefined when there is no Cargo.toml ancestor', () => {
    const noCrate = mkdtempSync(path.join(tmpdir(), 'rust-nocrate-'));
    try {
      mkdirSync(path.join(noCrate, 'src'), { recursive: true });
      writeFileSync(path.join(noCrate, 'src', 'a.rs'), '// a\n', 'utf-8');
      const resolve = makeResolvePathToFile(noCrate);
      expect(resolve('crate::a', 'src/lib.rs', 'rust')).toBeUndefined();
    } finally {
      rmSync(noCrate, { recursive: true, force: true });
    }
  });

  it('returns undefined when super:: climbs above the crate root', () => {
    const resolve = makeResolvePathToFile(root);
    // From src/lib.rs (crate root module), super:: climbs above src → silence.
    expect(resolve('super::super::Thing', 'src/lib.rs', 'rust')).toBeUndefined();
  });

  it('returns undefined for an empty specifier', () => {
    // No path segments at all → nothing to resolve.
    const resolve = makeResolvePathToFile(root);
    expect(resolve('', 'src/lib.rs', 'rust')).toBeUndefined();
  });

  it('resolves a bare module path (no trailing item) via its mod.rs file', () => {
    // `crate::orders` with no further segments → the module dir`s own file src/orders/mod.rs.
    const resolve = makeResolvePathToFile(root);
    expect(resolve('crate::orders', 'src/lib.rs', 'rust')).toBe('src/orders/mod.rs');
  });

  it('resolves a bare module path via its <dir>.rs file when there is no mod.rs', () => {
    // `crate::a` with no further segments → src/a.rs (the file form of the empty tail).
    const resolve = makeResolvePathToFile(root);
    expect(resolve('crate::a', 'src/lib.rs', 'rust')).toBe('src/a.rs');
  });

  it('resolves a bare `self` to the importing file own module file', () => {
    // `self` with an empty tail from src/a.rs (module crate::a) → the module`s own file src/a.rs.
    const resolve = makeResolvePathToFile(root);
    expect(resolve('self', 'src/a.rs', 'rust')).toBe('src/a.rs');
  });

  it('resolves a bare `self` from a mod.rs file to that mod.rs', () => {
    // From src/orders/mod.rs (module crate::orders), bare `self` → src/orders/mod.rs.
    const resolve = makeResolvePathToFile(root);
    expect(resolve('self', 'src/orders/mod.rs', 'rust')).toBe('src/orders/mod.rs');
  });

  it('resolves a bare `crate` to the crate root file (the crate root module`s own file)', () => {
    // `crate` alone names the crate root module, whose file is src/lib.rs (there is no
    // src/mod.rs or src.rs), so the empty tail binds the crate root file.
    const resolve = makeResolvePathToFile(root);
    expect(resolve('crate', 'src/orders/mod.rs', 'rust')).toBe('src/lib.rs');
  });

  it('returns undefined for a super:: path when there is no Cargo.toml ancestor', () => {
    // `super::`/`self::` resolution still needs a crate root to anchor `src/`; with no
    // Cargo.toml ancestor the relative resolver yields silence.
    const noCrate = mkdtempSync(path.join(tmpdir(), 'rust-nocrate-rel-'));
    try {
      mkdirSync(path.join(noCrate, 'src'), { recursive: true });
      writeFileSync(path.join(noCrate, 'src', 'a.rs'), '// a\n', 'utf-8');
      const resolve = makeResolvePathToFile(noCrate);
      expect(resolve('super::Type', 'src/a.rs', 'rust')).toBeUndefined();
      expect(resolve('self::x', 'src/a.rs', 'rust')).toBeUndefined();
    } finally {
      rmSync(noCrate, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cargo targets, crate-root items and in-repo path dependencies (disk-backed).
describe('resolveRustPath — Cargo targets, crate-root items, path dependencies', () => {
  let ws: string;
  const put = (rel: string, text: string): void => {
    mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    writeFileSync(path.join(ws, rel), text, 'utf-8');
  };

  beforeEach(() => {
    ws = mkdtempSync(path.join(tmpdir(), 'rust-targets-'));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('binds a crate-root item to src/lib.rs only when the root file declares or uses the name', () => {
    put('Cargo.toml', '[package]\nname = "app"\n');
    put('src/lib.rs', '// pub struct Commented;\npub enum Error {}\npub use self::inner::Result;\n#[macro_export]\nmacro_rules! local_mac { () => {} }\n');
    put('src/orders/mod.rs', '');
    const resolve = makeResolvePathToFile(ws);
    expect(resolve('crate::Error', 'src/orders/mod.rs', 'rust')).toBe('src/lib.rs');
    expect(resolve('crate::Error::Variant', 'src/orders/mod.rs', 'rust')).toBe('src/lib.rs');
    expect(resolve('crate::Result', 'src/orders/mod.rs', 'rust')).toBe('src/lib.rs');
    expect(resolve('crate::local_mac', 'src/orders/mod.rs', 'rust')).toBe('src/lib.rs');
    expect(resolve('crate::exported_elsewhere', 'src/orders/mod.rs', 'rust')).toBeUndefined();
    expect(resolve('crate::Commented', 'src/orders/mod.rs', 'rust')).toBeUndefined();
    // `super::X` from a top-level module climbs to the crate root module too.
    put('src/billing.rs', '');
    expect(resolve('super::Error', 'src/billing.rs', 'rust')).toBe('src/lib.rs');
  });

  it('falls back to src/main.rs when the package has no library', () => {
    put('Cargo.toml', '[package]\nname = "app"\n');
    put('src/main.rs', 'pub struct Config;\nfn main() {}\n');
    put('src/cli/mod.rs', '');
    const resolve = makeResolvePathToFile(ws);
    expect(resolve('crate::Config', 'src/cli/mod.rs', 'rust')).toBe('src/main.rs');
  });

  it('treats only real target roots as mod-rs-like: src/c/lib.rs is module c::lib', () => {
    put('Cargo.toml', '[package]\nname = "app"\n');
    put('src/c/lib/x.rs', '');
    put('src/c/x.rs', '');
    const resolve = makeResolvePathToFile(ws);
    expect(resolve('self::x', 'src/c/lib.rs', 'rust')).toBe('src/c/lib/x.rs');
  });

  it('roots crate:: of src/bin/<name>.rs and src/bin/<name>/main.rs at the binary, and the package name at the lib', () => {
    put('Cargo.toml', '[package]\nname = "app"\n');
    put('src/lib.rs', '');
    put('src/opts.rs', '');
    put('src/bin/opts.rs', '');
    put('src/bin/multi/opts.rs', '');
    const resolve = makeResolvePathToFile(ws);
    expect(resolve('crate::opts::Args', 'src/bin/tool.rs', 'rust')).toBe('src/bin/opts.rs');
    expect(resolve('self::opts', 'src/bin/tool.rs', 'rust')).toBe('src/bin/opts.rs');
    expect(resolve('crate::opts::Args', 'src/bin/multi/main.rs', 'rust')).toBe('src/bin/multi/opts.rs');
    expect(resolve('app::opts::Args', 'src/bin/tool.rs', 'rust')).toBe('src/opts.rs');
    // A binary root has no parent module.
    expect(resolve('super::opts', 'src/bin/tool.rs', 'rust')).toBeUndefined();
  });

  it('resolves tests/<name>.rs as a test crate root and a shared tests/common/mod.rs under tests/', () => {
    put('Cargo.toml', '[package]\nname = "app"\n');
    put('tests/common/mod.rs', '');
    put('tests/fixtures.rs', '');
    put('examples/demo/main.rs', '');
    put('examples/demo/ui.rs', '');
    const resolve = makeResolvePathToFile(ws);
    expect(resolve('self::common', 'tests/it.rs', 'rust')).toBe('tests/common/mod.rs');
    expect(resolve('super::fixtures', 'tests/common/mod.rs', 'rust')).toBe('tests/fixtures.rs');
    // A shared helper has no single crate root to hold items → silence.
    expect(resolve('crate::Thing', 'tests/common/mod.rs', 'rust')).toBeUndefined();
    expect(resolve('crate::ui', 'examples/demo/main.rs', 'rust')).toBe('examples/demo/ui.rs');
  });

  it('resolves in-repo path dependencies: inline, table form, workspace-inherited, renamed, [lib] name', () => {
    put('Cargo.toml', '[workspace]\nmembers = ["crates/*"]\n\n[workspace.dependencies]\n"shared-kit" = { path = "crates/shared", package = "shared" }\nremote = "1"\n');
    put('crates/core-lib/Cargo.toml', '[package]\nname = "core-lib"\n');
    put('crates/core-lib/src/lib.rs', 'pub struct Engine;\n');
    put('crates/tables/Cargo.toml', '[package]\nname = "tables"\n');
    put('crates/tables/src/grid/mod.rs', '');
    put('crates/named/Cargo.toml', '[package]\nname = "named-pkg"\n\n[lib]\nname = "nm"\npath = "lib/root.rs"\n');
    put('crates/named/lib/root.rs', 'pub struct Root;\n');
    put('crates/shared/Cargo.toml', '[package]\nname = "shared"\n');
    put('crates/shared/src/kit.rs', '');
    put(
      'crates/server/Cargo.toml',
      [
        '[package]',
        'name = "server"',
        '',
        '[dependencies]',
        'core-lib = { path = "../core-lib", version = "0.1" } # a comment',
        'renamed = { path = "../core-lib", package = "core-lib" }',
        'nm = { path = "../named" }',
        'shared-kit = { workspace = true }',
        'outside = { path = "../../../elsewhere" }',
        'serde = "1"',
        '',
        '[dependencies.tables]',
        'path = "../tables"',
        '',
        "[target.'cfg(unix)'.dev-dependencies]",
        'nix-only = { path = "../missing" }',
      ].join('\n') + '\n',
    );
    const from = 'crates/server/src/main.rs';
    const resolve = makeResolvePathToFile(ws);
    expect(resolve('core_lib::Engine', from, 'rust')).toBe('crates/core-lib/src/lib.rs');
    expect(resolve('renamed::Engine', from, 'rust')).toBe('crates/core-lib/src/lib.rs');
    expect(resolve('tables::grid::Grid', from, 'rust')).toBe('crates/tables/src/grid/mod.rs');
    expect(resolve('nm::Root', from, 'rust')).toBe('crates/named/lib/root.rs');
    expect(resolve('shared_kit::kit::K', from, 'rust')).toBe('crates/shared/src/kit.rs');
    expect(resolve('core_lib', from, 'rust')).toBe('crates/core-lib/src/lib.rs');
    // Silence: registry dep, a dep whose path leaves the repo, a path with no crate, an
    // undeclared name, and a crate-root item the dependency's root file does not declare.
    expect(resolve('serde::Serialize', from, 'rust')).toBeUndefined();
    expect(resolve('outside::X', from, 'rust')).toBeUndefined();
    expect(resolve('nix_only::X', from, 'rust')).toBeUndefined();
    expect(resolve('shared::kit::K', from, 'rust')).toBeUndefined();
    expect(resolve('core_lib::Missing', from, 'rust')).toBeUndefined();
  });
});

describe('parseCargoManifest / rustFileDeclares', () => {
  it('reads [lib].name over [package].name and normalizes hyphens', () => {
    expect(parseCargoManifest('[package]\nname = "a-b"\n').crateName).toBe('a_b');
    expect(parseCargoManifest('[package]\nname = "a-b"\n[lib]\nname = "c_d"\n').crateName).toBe('c_d');
  });

  it('ignores a `name` outside [package] / [lib]', () => {
    expect(parseCargoManifest('[[bin]]\nname = "tool"\n').crateName).toBeUndefined();
  });

  it('matches a declared or used name as a whole word only', () => {
    expect(rustFileDeclares('pub struct Engine;', 'Engine')).toBe(true);
    expect(rustFileDeclares('pub struct EngineRoom;', 'Engine')).toBe(false);
    expect(rustFileDeclares('pub use a::{b::Engine, c};', 'Engine')).toBe(true);
    expect(rustFileDeclares('fn f() { let Engine = 1; }', 'Engine')).toBe(false);
    expect(rustFileDeclares('pub mod r#gen;', 'gen')).toBe(true);
  });
});

describe('resolveRustPath — manifest and target edge forms (disk-backed)', () => {
  let ws: string;
  const put = (rel: string, text: string): void => {
    mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    writeFileSync(path.join(ws, rel), text, 'utf-8');
  };
  beforeEach(() => {
    ws = mkdtempSync(path.join(tmpdir(), 'rust-manifest-'));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('build.rs is a crate root at the package directory', () => {
    put('Cargo.toml', '[package]\nname = "app"\n');
    put('gen_helpers.rs', '');
    const resolve = makeResolvePathToFile(ws);
    expect(resolve('self::gen_helpers', 'build.rs', 'rust')).toBe('gen_helpers.rs');
  });

  it('reads table-form and workspace table-form dependencies, single-quoted fields and multi-line arrays', () => {
    put(
      'Cargo.toml',
      "[package]\nname = \"rootlib\"\n\n[workspace]\nmembers = [\n  \"crates/*\",\n]\n\n[workspace.dependencies.kit]\npath = 'crates/kit'\npackage = 'kit-pkg'\n",
    );
    put('src/lib.rs', 'pub struct Top;\n');
    put('crates/kit/Cargo.toml', '[package]\nname = "kit-pkg"\n');
    put('crates/kit/src/lib.rs', 'pub struct Kit;\n');
    put('crates/anon/Cargo.toml', '[lib]\npath = "src/lib.rs"\n');
    put('crates/anon/src/lib.rs', 'pub struct Anon;\n');
    put(
      'crates/app/Cargo.toml',
      [
        '[package]',
        'name = "app"',
        '',
        '[dependencies.kit]',
        'workspace = true',
        '',
        '[dependencies.top]',
        "path = '../..'",
        "package = 'rootlib'",
        '',
        '[dependencies]',
        'anon = { path = "../anon" }',
        'ghost = { workspace = true }',
      ].join('\n') + '\n',
    );
    const from = 'crates/app/src/main.rs';
    const resolve = makeResolvePathToFile(ws);
    // Workspace-inherited, renamed in the workspace table: code uses the key `kit`.
    expect(resolve('kit::Kit', from, 'rust')).toBe('crates/kit/src/lib.rs');
    // A path dependency on the repository-root package, renamed in the table form.
    expect(resolve('top::Top', from, 'rust')).toBe('src/lib.rs');
    // A dependency crate with no package name is called by its key.
    expect(resolve('anon::Anon', from, 'rust')).toBe('crates/anon/src/lib.rs');
    // `workspace = true` with no workspace entry anywhere → silence.
    expect(resolve('ghost::X', from, 'rust')).toBeUndefined();
  });

  it('walks past an intermediate manifest to the workspace that defines an inherited dependency', () => {
    put('Cargo.toml', '[workspace]\n\n[workspace.dependencies]\nkit = { path = "libs/kit" }\n');
    put('libs/kit/Cargo.toml', '[package]\nname = "kit"\n');
    put('libs/kit/src/lib.rs', 'pub struct Kit;\n');
    put('apps/Cargo.toml', '[workspace]\n');
    put('apps/web/Cargo.toml', '[package]\nname = "web"\n\n[dependencies]\nkit = { workspace = true }\n');
    const resolve = makeResolvePathToFile(ws);
    expect(resolve('kit::Kit', 'apps/web/src/main.rs', 'rust')).toBe('libs/kit/src/lib.rs');
  });

  it('a [lib] path that leaves the repository falls back to src/lib.rs', () => {
    put('Cargo.toml', '[package]\nname = "app"\n\n[lib]\npath = "../../outside.rs"\n');
    put('src/lib.rs', 'pub struct Here;\n');
    put('tests/it.rs', '');
    const resolve = makeResolvePathToFile(ws);
    expect(resolve('app::Here', 'tests/it.rs', 'rust')).toBe('src/lib.rs');
  });

  it('no Cargo.toml anywhere → a bare crate name is not a dependency', () => {
    put('src/a.rs', '');
    const resolve = makeResolvePathToFile(ws);
    expect(resolve('kit::Kit', 'src/a.rs', 'rust')).toBeUndefined();
  });
});

describe('resolveRustPath — crate-root lookup without a declares check (injected deps)', () => {
  it('binds the first existing root file when the deps supply no rootDeclares', () => {
    const deps = {
      crateRootFor: () => ({ srcDir: 'src', crateName: 'c', rootFiles: ['src/lib.rs'], fileIsRoot: false }),
    };
    const known = new Set(['src/lib.rs']);
    expect(resolveRustPath('crate::Anything', 'src/a.rs', (p) => known.has(p), deps)).toBe('src/lib.rs');
  });
});
