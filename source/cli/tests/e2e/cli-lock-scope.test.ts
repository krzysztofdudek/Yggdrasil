// =============================================================================
// THE LOCK MATRIX — part 3: per-file scope + files filter, and observation
// invalidation. MATRIX points (4) and (5). Deterministic-only (no reviewer
// needed) — real spawned binary via spawnSync.
//
// HERMETIC: fresh mkdtemp copy of e2e-lifecycle per test, mutated in place,
// rmSync'd in finally. No fixed ports, no clock/random assertions.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLock as readTriadLock } from './support/read-lock.js';

// Each case spawns the real CLI binary many times; on a loaded CI runner that
// exceeds vitest's 5000ms default and flakily times out. Use the same 30s budget
// the other heavy lock e2e suites (lifecycle, format-recovery, fill-semantics)
// already apply.
vi.setConfig({ testTimeout: 30000 });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const archPath = (d: string) => path.join(d, '.yggdrasil', 'yg-architecture.yaml');
const flowPath = (d: string) => path.join(d, '.yggdrasil', 'flows', 'order-processing', 'yg-flow.yaml');
const aspectYaml = (d: string, a: string) => path.join(d, '.yggdrasil', 'aspects', a, 'yg-aspect.yaml');
const nodeYaml = (d: string, n: string) => path.join(d, '.yggdrasil', 'model', ...n.split('/'), 'yg-node.yaml');
// The verdict lock is the 5.1.0 triad (nondeterministic + logs + gitignored
// deterministic). Read the MERGED view via the src store, so deterministic
// verdicts (this suite's subject) surface under `.verdicts` exactly as before.
const readLock = (d: string) => readTriadLock(path.join(d, '.yggdrasil'));

function run(args: string[], cwd: string): { all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { all: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}

function deterministicFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-lockscope-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  writeFileSync(archPath(dir), readFileSync(archPath(dir), 'utf-8').split('\n').filter((l) => l.trim() !== '- has-doc-comment').join('\n'), 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), { recursive: true, force: true });
  return dir;
}

/**
 * Silence the flow + architecture-default channels for `no-todo-comments`, leaving
 * the orders node's OWN declaration as the sole delivery channel. Keeps the
 * per-file scope test's subject set confined to the orders node.
 */
function isolateNoTodoToOrders(dir: string): void {
  // Architecture: drop no-todo-comments from the service-type default.
  writeFileSync(
    archPath(dir),
    readFileSync(archPath(dir), 'utf-8').replace('    aspects:\n      - no-todo-comments\n      - requires-named-export\n', '    aspects:\n      - requires-named-export\n'),
    'utf-8',
  );
  // Flow: drop the participation-level attach.
  writeFileSync(flowPath(dir), readFileSync(flowPath(dir), 'utf-8').replace('aspects:\n  - no-todo-comments\n', 'aspects: []\n'), 'utf-8');
  // Orders node: attach no-todo-comments on its own declaration.
  const oy = nodeYaml(dir, 'services/orders');
  writeFileSync(oy, readFileSync(oy, 'utf-8').replace(/^aspects:\n/m, 'aspects:\n  - no-todo-comments\n'), 'utf-8');
}

describe.skipIf(!distExists)('CLI E2E — lock matrix: per-file scope / observation invalidation', () => {
  // ===========================================================================
  // MATRIX (4) — PER-FILE SCOPE + FILES FILTER
  //   aspect {per: file, files: <glob>} on a 3-file node (1 excluded) → 2 file:
  //   entries; edit excluded file → check stays verified (no unverified); edit
  //   one included file → ONLY its pair unverified; re-fill = 1 reviewer call
  //   (here: 1 deterministic fill — deterministic is free but still exactly one).
  // ===========================================================================

  it('(4) per-file scope + files filter: excluded edit is immune, included edit invalidates only its pair', () => {
    const dir = deterministicFixture('perfile');
    try {
      isolateNoTodoToOrders(dir);
      // Also drop the advisory requires-named-export default so the ONLY aspect in
      // play is the per-file no-todo-comments under test — keeps the re-fill pair
      // count exact (no node-scoped aspect re-verifying alongside it).
      writeFileSync(archPath(dir), readFileSync(archPath(dir), 'utf-8').replace('    aspects:\n      - requires-named-export\n', '    aspects: []\n'), 'utf-8');
      rmSync(path.join(dir, '.yggdrasil', 'aspects', 'requires-named-export'), { recursive: true, force: true });
      // Restructure orders to map a 3-file DIRECTORY; broaden the service when to src/**.
      writeFileSync(archPath(dir), readFileSync(archPath(dir), 'utf-8').replace('path: "src/services/**"', 'path: "src/**"'), 'utf-8');
      const base = path.join(dir, 'src', 'services', 'orders');
      mkdirSync(base, { recursive: true });
      rmSync(path.join(dir, 'src', 'services', 'orders.ts'), { force: true });
      writeFileSync(path.join(base, 'a.ts'), '// a\nexport const a = 1;\n');
      writeFileSync(path.join(base, 'b.ts'), '// b\nexport const b = 1;\n');
      writeFileSync(path.join(base, 'c.gen.ts'), '// generated\nexport const c = 1;\n');
      const oy = nodeYaml(dir, 'services/orders');
      writeFileSync(oy, ['name: OrdersService', 'description: Orders.', 'type: service', 'aspects:', '  - no-todo-comments', 'mapping:', '  - src/services/orders', ''].join('\n'), 'utf-8');

      // Make no-todo-comments per:file, filtered to exclude *.gen.ts.
      const ay = aspectYaml(dir, 'no-todo-comments');
      writeFileSync(ay, readFileSync(ay, 'utf-8').trimEnd() + '\nscope:\n  per: file\n  files:\n    not: { path: "**/*.gen.ts" }\n', 'utf-8');

      // FILL: exactly TWO file: entries (a.ts, b.ts) — c.gen.ts excluded.
      const fill = run(['check', '--approve'], dir);
      expect(fill.all).not.toContain('c.gen.ts');
      const noTodo = readLock(dir).verdicts['no-todo-comments'];
      expect(Object.keys(noTodo).sort()).toEqual(['file:src/services/orders/a.ts', 'file:src/services/orders/b.ts']);
      expect(run(['check'], dir).status).toBe(0);

      // EDIT THE EXCLUDED FILE → c.gen.ts is outside the no-todo-comments subject
      // set, so that per-file aspect's verdicts stay valid (none of its pairs go
      // unverified). The per-file immunity — the point under test — is preserved:
      // no no-todo-comments pair is named unverified.
      //
      // Relations are computed LIVE: c.gen.ts has no cross-node dependency, so the live
      // relation pass finds nothing to flag. The edit leaves the node fully green.
      appendFileSync(path.join(base, 'c.gen.ts'), '\nexport const cc = 2;\n');
      const afterExcluded = run(['check'], dir);
      expect(afterExcluded.all).not.toContain("No valid verdict for aspect 'no-todo-comments'");
      expect(afterExcluded.all).not.toContain('relation-undeclared-dependency');
      expect(afterExcluded.status).toBe(0); // excluded-file edit invalidates nothing

      // EDIT ONE INCLUDED FILE (a.ts) → ONLY its pair goes unverified; b.ts stays valid.
      appendFileSync(path.join(base, 'a.ts'), '\nexport const aa = 2;\n');
      const afterIncluded = run(['check'], dir);
      expect(afterIncluded.status).toBe(1);
      // Grouped view: exactly ONE no-todo-comments pair (a.ts) went unverified.
      // The per-file `what` detail is gone in the default view, but the group
      // header proves only a single pair was invalidated (b.ts's pair stays valid).
      expect(afterIncluded.all).toContain('unverified (not yet reviewed)');
      // The aspect appears on the body line (not in the group header).
      expect(afterIncluded.all).toContain("aspect 'no-todo-comments'");
      expect(afterIncluded.all).toMatch(/unverified \(not yet reviewed\)\s+1 pairs\s+1 nodes$/m);
      expect(afterIncluded.all).toContain("- services/orders  aspect 'no-todo-comments'");

      // RE-FILL: exactly ONE pair re-verified (a.ts). b.ts carries its prior verdict.
      const refill = run(['check', '--approve'], dir);
      expect(refill.all).toContain('Filling 1 unverified pairs');
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // MATRIX (5) — OBSERVATION INVALIDATION
  //   graph-aware det check using fs.list + fs.exists(negative) + ctx.graph.node
  //   → verified; (a) add file to listed dir → unverified+refill; (b) create the
  //   file behind the negative exists probe → unverified; (c) edit the related
  //   node's yg-node.yaml → unverified.
  // ===========================================================================

  it('(5) observation invalidation: list / negative-exists / graph-node observations re-verify', () => {
    const dir = deterministicFixture('obs');
    try {
      // Broaden the service when so a directory-mapped helper node validates.
      writeFileSync(archPath(dir), readFileSync(archPath(dir), 'utf-8').replace('path: "src/services/**"', 'path: "src/**"'), 'utf-8');

      // A helper node `services/extras` mapping the directory src/extras (so a
      // negative exists probe under it is INSIDE the allowed-reads set).
      mkdirSync(path.join(dir, 'src', 'extras'), { recursive: true });
      writeFileSync(path.join(dir, 'src', 'extras', 'placeholder.ts'), '// placeholder\nexport const p = 1;\n');
      mkdirSync(path.join(dir, '.yggdrasil', 'model', 'services', 'extras'), { recursive: true });
      writeFileSync(
        nodeYaml(dir, 'services/extras'),
        ['name: ExtrasService', 'description: Auxiliary extras directory.', 'type: service', 'mapping:', '  - src/extras', ''].join('\n'),
        'utf-8',
      );

      // The graph-aware observation aspect on orders: lists src/services (an
      // ancestor dir of its own mapping), negatively probes src/extras/secret.ts
      // (inside the extras mapping, via the relation), and reads payments' node
      // through ctx.graph.node (folds graph:services/payments).
      const obsDir = path.join(dir, '.yggdrasil', 'aspects', 'obs-rule');
      mkdirSync(obsDir, { recursive: true });
      writeFileSync(
        path.join(obsDir, 'yg-aspect.yaml'),
        ['name: ObsRule', 'description: A graph-aware observation rule for invalidation testing.', 'reviewer:', '  type: deterministic', 'status: enforced', ''].join('\n'),
        'utf-8',
      );
      writeFileSync(
        path.join(obsDir, 'check.mjs'),
        [
          'export function check(ctx) {',
          "  ctx.fs.list('src/services');",                 // list observation
          "  const secret = ctx.fs.exists('src/extras/secret.ts');", // negative exists observation
          "  let payType = 'none';",
          "  try { payType = ctx.graph.node('services/payments').type; } catch (e) { payType = 'ERR'; }", // graph observation
          '  const v = [];',
          "  if (secret !== false) v.push({ message: 'secret.ts must not exist' });",
          "  if (payType !== 'service') v.push({ message: 'payments must be a service' });",
          '  return v;',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      // Orders: attach obs-rule + relations to payments (for graph.node) and extras
      // (for the exists probe). Strip default no-todo-comments noise by leaving the
      // architecture defaults — they still apply but pass cleanly.
      writeFileSync(
        nodeYaml(dir, 'services/orders'),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - obs-rule',
          'relations:',
          '  - target: services/payments',
          '    type: uses',
          '  - target: services/extras',
          '    type: uses',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      // BASELINE: fill → green. obs-rule on orders carries the three observations.
      run(['check', '--approve'], dir);
      const touched = readLock(dir).verdicts['obs-rule']['node:services/orders'].touched as Array<[string, string]>;
      const keys = touched.map((t) => t[0]);
      expect(keys).toContain('list:src/services');
      expect(keys).toContain('exists:src/extras/secret.ts');
      expect(keys).toContain('graph:services/payments');
      expect(run(['check'], dir).status).toBe(0);

      // (a) Add a file to the listed directory → the listing observation changes → unverified.
      writeFileSync(path.join(dir, 'src', 'services', 'sibling.ts'), '// sibling\nexport const s = 1;\n');
      const afterList = run(['check'], dir);
      expect(afterList.status).toBe(1);
      expect(afterList.all).toContain('unverified (not yet reviewed)');
      expect(afterList.all).toContain("aspect 'obs-rule'");
      expect(afterList.all).toContain('- services/orders');
      // Re-fill restores green (sibling is harmless to the rule).
      rmSync(path.join(dir, 'src', 'services', 'sibling.ts'), { force: true });
      run(['check', '--approve'], dir);
      expect(run(['check'], dir).status).toBe(0);

      // (b) Create the file behind the negative exists probe → the exists observation
      //     flips (false → file) → unverified. (And the rule now refuses, proving
      //     the probe is real.)
      writeFileSync(path.join(dir, 'src', 'extras', 'secret.ts'), '// secret\nexport const x = 1;\n');
      const afterExists = run(['check'], dir);
      expect(afterExists.status).toBe(1);
      expect(afterExists.all).toContain('unverified (not yet reviewed)');
      expect(afterExists.all).toContain("aspect 'obs-rule'");
      expect(afterExists.all).toContain('- services/orders');
      const refillB = run(['check', '--approve'], dir);
      expect(refillB.all).toContain('[det] obs-rule on node:services/orders — refused');
      // Restore green.
      rmSync(path.join(dir, 'src', 'extras', 'secret.ts'), { force: true });
      run(['check', '--approve'], dir);
      expect(run(['check'], dir).status).toBe(0);

      // (c) Edit the related node's yg-node.yaml → the graph: observation changes → unverified.
      appendFileSync(nodeYaml(dir, 'services/payments'), '\n# byte-changing trailing comment\n');
      const afterGraph = run(['check'], dir);
      expect(afterGraph.status).toBe(1);
      expect(afterGraph.all).toContain('unverified (not yet reviewed)');
      expect(afterGraph.all).toContain("aspect 'obs-rule'");
      expect(afterGraph.all).toContain('- services/orders');
      // Re-fill restores green (the node is still a service).
      run(['check', '--approve'], dir);
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
