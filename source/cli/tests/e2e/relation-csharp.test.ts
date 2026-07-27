import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// End-to-end: C# relation conformance is LIVE — the HARDEST language and the
// design's poster child for SymbolTable resolution. C# has NO file-level import
// that names a file: `using` names a NAMESPACE (which spans files), so the
// dependency EDGE comes from a SYMBOL USE (here a fully-qualified `new
// MyApp.Payments.Gateway()`) resolved to an FQN and looked up in the shared
// SymbolTable. We build a temp repo from scratch, spawn the REAL built binary,
// and assert:
//   1. an undeclared cross-node type use is refused by `yg check --approve` (exit 1);
//   2. declaring the relation clears it under `--approve` (exit 0);
//   3. CRITICAL — a PLAIN `yg check` AFTER `--approve` returns exit 0 / verified
//      (NOT unverified). This proves verify.ts's parse-free symbol re-validation
//      reconstructs the SAME fingerprint the pass sealed. If this comes back
//      unverified, the symbol re-validation path is broken.
//
// C#'s namespace is decoupled from the directory, so the source dirs (src/a,
// src/b) deliberately do NOT mirror the namespaces (MyApp.*).
// Mirrors tests/e2e/relation-kotlin.test.ts.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, status: result.status, all: stdout + stderr };
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

/**
 * Build a temp repo with two component nodes a, b under src/, where a/Order.cs
 * constructs b's type across the node boundary via a fully-qualified
 * `new MyApp.Payments.Gateway()`. The single `component` type maps `src/**` and
 * allows `uses: [component]`, so the only thing verified is the deterministic
 * relation-conformance pass (no aspects → no LLM needed). Namespaces are decoupled
 * from directories to exercise the SymbolTable. `withRelation` controls whether a
 * declares the relation to b.
 */
function buildRepo(label: string, withRelation: boolean): string {
  const root = mkdtempSync(path.join(tmpdir(), `yg-rel-csharp-${label}-`));

  writeFile(
    root,
    '.yggdrasil/yg-architecture.yaml',
    [
      'node_types:',
      '  component:',
      "    description: 'A source component mapped under src/.'",
      '    log_required: false',
      '    when:',
      '      path: "src/**"',
      '    relations:',
      '      uses: [component]',
      '',
    ].join('\n'),
  );
  writeFile(
    root,
    '.yggdrasil/yg-config.yaml',
    [
      'version: "5.2.0"',
      '',
      'quality:',
      '  max_direct_relations: 10',
      '',
      'reviewer:',
      '  default: standard',
      '  tiers:',
      '    standard:',
      '      provider: ollama',
      '      consensus: 1',
      '      config:',
      '        model: "qwen2.5-coder:0.5b"',
      '        endpoint: "http://host.docker.internal:11434"',
      '',
    ].join('\n'),
  );

  // Node b — the dependency target. Directory src/b, namespace MyApp.Payments.
  writeFile(
    root,
    '.yggdrasil/model/b/yg-node.yaml',
    'name: B\ndescription: Dependency target component.\ntype: component\nmapping:\n  - src/b\n',
  );
  // Node a — constructs b's type across the boundary. With/without the declared relation.
  const aNode = withRelation
    ? 'name: A\ndescription: Constructing component.\ntype: component\nrelations:\n  - target: b\n    type: uses\nmapping:\n  - src/a\n'
    : 'name: A\ndescription: Constructing component.\ntype: component\nmapping:\n  - src/a\n';
  writeFile(root, '.yggdrasil/model/a/yg-node.yaml', aNode);

  // Source — a/Order.cs depends on b/Gateway.cs by a fully-qualified `new`. Note: src
  // dir != namespace. The symbol-table resolution maps MyApp.Payments.Gateway → src/b.
  writeFile(
    root,
    'src/a/Order.cs',
    [
      'namespace MyApp.Orders;',
      'public class Order {',
      '  public void Pay() {',
      '    var gw = new MyApp.Payments.Gateway();',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  writeFile(
    root,
    'src/b/Gateway.cs',
    ['namespace MyApp.Payments;', 'public class Gateway { }', ''].join('\n'),
  );

  return root;
}

/** Write the shared architecture (one `component` type mapping `src/**`, `uses: [component]`)
 *  and an aspect-free reviewer config into a fresh repo skeleton. Returns the repo root. */
function buildSkeleton(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `${prefix}-`));
  writeFile(
    root,
    '.yggdrasil/yg-architecture.yaml',
    [
      'node_types:',
      '  component:',
      "    description: 'A source component mapped under src/.'",
      '    log_required: false',
      '    when:',
      '      path: "src/**"',
      '    relations:',
      '      uses: [component]',
      '',
    ].join('\n'),
  );
  writeFile(
    root,
    '.yggdrasil/yg-config.yaml',
    [
      'version: "5.2.0"',
      '',
      'quality:',
      '  max_direct_relations: 10',
      '',
      'reviewer:',
      '  default: standard',
      '  tiers:',
      '    standard:',
      '      provider: ollama',
      '      consensus: 1',
      '      config:',
      '        model: "qwen2.5-coder:0.5b"',
      '        endpoint: "http://host.docker.internal:11434"',
      '',
    ].join('\n'),
  );
  return root;
}

/** A `component` node yaml, optionally declaring a `uses` relation to `target`. */
function nodeYaml(name: string, mapDir: string, target?: string): string {
  const head = `name: ${name}\ndescription: ${name} component.\ntype: component\n`;
  const rel = target ? `relations:\n  - target: ${target}\n    type: uses\n` : '';
  return `${head}${rel}mapping:\n  - ${mapDir}\n`;
}

/**
 * THE DECISIVE FALSE-POSITIVE repo (must exit 0 — NO relation flag).
 *
 * n1 maps src/n1/** and contains BOTH the consumer and the NEARER binding:
 *   - src/n1/Order.cs : `namespace App.Services; using App.Data; ... new Models.Order()`.
 *   - src/n1/Data.cs  : `namespace App.Data; class Models { class Order { } }` → key
 *                       App.Data.Models+Order (Models is a TYPE, Order nested in it). This is
 *                       what `using App.Data;` + `Models.Order` legitimately binds: `using A;`
 *                       imports the TYPES of A (here the type `Models`), and `Order` is the
 *                       nested type — NOT a sub-namespace. (A `class Models`, not a
 *                       `namespace Models`: per the C# spec a using-namespace directive imports
 *                       A's types, NEVER A's nested namespaces, so a `namespace App.Data.Models`
 *                       would make `Models.Order` bind the GLOBAL `Models.Order` instead — the
 *                       recall case below, not this one.)
 * n2 maps src/n2/** with a TOP-LEVEL `namespace Models; class Order { }` → key Models.Order.
 * n1 declares NO relation to n2.
 *
 * For the ordered group [App.Services.Models.Order, App.Models.Order, App.Data.Models.Order,
 * Models.Order], the walk binds the using-relative `App.Data.Models.Order` — which splits at the
 * declared TYPE `App.Data.Models` to `App.Data.Models+Order` → n1 (intra-node, exempt) — FIRST
 * and STOPS. The verbatim `Models.Order` (which would resolve to n2) is never reached → NO
 * n1→n2 edge → exit 0. (Pre-Stage-2, the independent verbatim hint resolved to n2 and
 * false-flagged.)
 */
function buildDecisiveFpRepo(): string {
  const root = buildSkeleton('yg-rel-csharp-fp');
  writeFile(root, '.yggdrasil/model/n1/yg-node.yaml', nodeYaml('N1', 'src/n1'));
  writeFile(root, '.yggdrasil/model/n2/yg-node.yaml', nodeYaml('N2', 'src/n2'));
  writeFile(
    root,
    'src/n1/Order.cs',
    [
      'namespace App.Services;',
      'using App.Data;',
      'public class C { void M() { var o = new Models.Order(); } }',
      '',
    ].join('\n'),
  );
  // The NEARER binding lives intra-node (n1): the TYPE App.Data.Models with nested Order →
  // App.Data.Models+Order. `using App.Data;` imports the type `Models`; `Order` is nested in it.
  writeFile(
    root,
    'src/n1/Data.cs',
    ['namespace App.Data;', 'public class Models { public class Order { } }', ''].join('\n'),
  );
  // The foreign top-level Models.Order in n2 — must NEVER be flagged.
  writeFile(
    root,
    'src/n2/Order.cs',
    ['namespace Models;', 'public class Order { }', ''].join('\n'),
  );
  return root;
}

/**
 * THE RECALL POSITIVE repo. A partial `Models.Order` inside `namespace App.Services;` where NO
 * nearer binding exists intra-node — only a TOP-LEVEL `Models.Order` in another node (n2). The
 * verbatim candidate (LAST) is the one that resolves → the real cross-node edge IS detected:
 * undeclared → exit 1; declared → exit 0. `withRelation` toggles the declared `uses` edge.
 */
function buildRecallRepo(withRelation: boolean): string {
  const root = buildSkeleton(`yg-rel-csharp-recall-${withRelation ? 'decl' : 'undecl'}`);
  writeFile(
    root,
    '.yggdrasil/model/n1/yg-node.yaml',
    nodeYaml('N1', 'src/n1', withRelation ? 'n2' : undefined),
  );
  writeFile(root, '.yggdrasil/model/n2/yg-node.yaml', nodeYaml('N2', 'src/n2'));
  // No intra-node `Models.Order` here — only the foreign top-level one exists.
  writeFile(
    root,
    'src/n1/Order.cs',
    [
      'namespace App.Services;',
      'public class C { void M() { var o = new Models.Order(); } }',
      '',
    ].join('\n'),
  );
  writeFile(
    root,
    'src/n2/Order.cs',
    ['namespace Models;', 'public class Order { }', ''].join('\n'),
  );
  return root;
}

/**
 * A NESTED-TYPE cross-node repo. n2 declares `namespace App; class Outer { class Inner { } }`
 * → key App.Outer+Inner. n1 uses `new App.Outer.Inner()`. The resolver splits the dotted use at
 * the declared type App.Outer → App.Outer+Inner → n2. `withRelation` toggles the declared edge:
 * undeclared → exit 1; declared → exit 0. (Pre-Stage-2 this silently missed — the declaration
 * side keyed only the simple name App.Inner.)
 */
function buildNestedRepo(withRelation: boolean): string {
  const root = buildSkeleton(`yg-rel-csharp-nested-${withRelation ? 'decl' : 'undecl'}`);
  writeFile(
    root,
    '.yggdrasil/model/n1/yg-node.yaml',
    nodeYaml('N1', 'src/n1', withRelation ? 'n2' : undefined),
  );
  writeFile(root, '.yggdrasil/model/n2/yg-node.yaml', nodeYaml('N2', 'src/n2'));
  writeFile(
    root,
    'src/n1/Use.cs',
    [
      'namespace Other;',
      'public class C { void M() { var x = new App.Outer.Inner(); } }',
      '',
    ].join('\n'),
  );
  writeFile(
    root,
    'src/n2/Nested.cs',
    ['namespace App;', 'public class Outer { public class Inner { } }', ''].join('\n'),
  );
  return root;
}

describe.skipIf(!distExists)('CLI E2E — C# relation conformance (live, symbol-table)', () => {
  it('refuses an undeclared cross-node type use, then passes once the relation is declared', () => {
    // 1. No declared relation → the cross-node type use is refused.
    const undeclared = buildRepo('undeclared', false);
    try {
      const refused = run(['check', '--approve'], undeclared);
      expect(refused.status).toBe(1);
      expect(refused.all).toContain('relation-undeclared-dependency');
      expect(refused.all).toContain('b');
      expect(refused.all).toContain('src/a/Order.cs');
    } finally {
      rmSync(undeclared, { recursive: true, force: true });
    }

    // 2. With the relation declared (a --uses--> b) → check --approve passes.
    const declared = buildRepo('declared', true);
    try {
      const ok = run(['check', '--approve'], declared);
      expect(ok.status, ok.all).toBe(0);
      expect(ok.all).not.toContain('relation-undeclared-dependency');

      // 3. CRITICAL round-trip: a PLAIN `yg check` (no --approve, no parsing) after
      //    the seal must stay GREEN — the symbol verdict re-validates parse-free to
      //    the SAME fingerprint. A regression here surfaces as exit 1 / unverified.
      const plain = run(['check'], declared);
      expect(plain.status, plain.all).toBe(0);
      expect(plain.all).not.toContain('unverified');
      expect(plain.all).not.toContain('relation-undeclared-dependency');
    } finally {
      rmSync(declared, { recursive: true, force: true });
    }
  });

  it('DECISIVE FP: a partially-qualified ref binds the NEARER intra-node candidate and never the foreign top-level (exit 0)', () => {
    // The whole point of the ordered-group mechanism: `new Models.Order()` inside
    // `namespace App.Services; using App.Data;` binds the using-relative App.Data.Models.Order
    // (intra-node n1, exempt) FIRST and stops; the verbatim Models.Order (n2) is never reached.
    // n1 declares NO relation to n2 → a stale verbatim flag would surface as exit 1.
    const repo = buildDecisiveFpRepo();
    try {
      const res = run(['check', '--approve'], repo);
      expect(res.status, res.all).toBe(0);
      expect(res.all).not.toContain('relation-undeclared-dependency');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('RECALL: a partial ref whose ONLY binding is the foreign top-level (verbatim, last) IS detected (exit 1, then exit 0 when declared)', () => {
    // No nearer intra-node binding → the verbatim candidate resolves to n2 → the real
    // cross-node edge is flagged when undeclared, and clears once the relation is declared.
    const undeclared = buildRecallRepo(false);
    try {
      const res = run(['check', '--approve'], undeclared);
      expect(res.status, res.all).toBe(1);
      expect(res.all).toContain('relation-undeclared-dependency');
      expect(res.all).toContain('n2');
      expect(res.all).toContain('src/n1/Order.cs');
    } finally {
      rmSync(undeclared, { recursive: true, force: true });
    }

    const declared = buildRecallRepo(true);
    try {
      const ok = run(['check', '--approve'], declared);
      expect(ok.status, ok.all).toBe(0);
      expect(ok.all).not.toContain('relation-undeclared-dependency');
    } finally {
      rmSync(declared, { recursive: true, force: true });
    }
  });

  it('NESTED TYPE: a cross-node use of `Outer.Inner` resolves via the guarded `+`-split (exit 1 undeclared, exit 0 declared)', () => {
    const undeclared = buildNestedRepo(false);
    try {
      const res = run(['check', '--approve'], undeclared);
      expect(res.status, res.all).toBe(1);
      expect(res.all).toContain('relation-undeclared-dependency');
      expect(res.all).toContain('n2');
      expect(res.all).toContain('src/n1/Use.cs');
    } finally {
      rmSync(undeclared, { recursive: true, force: true });
    }

    const declared = buildNestedRepo(true);
    try {
      const ok = run(['check', '--approve'], declared);
      expect(ok.status, ok.all).toBe(0);
      expect(ok.all).not.toContain('relation-undeclared-dependency');
    } finally {
      rmSync(declared, { recursive: true, force: true });
    }
  });
});
