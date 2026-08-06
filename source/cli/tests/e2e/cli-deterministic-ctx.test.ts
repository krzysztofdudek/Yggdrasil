import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLock } from './support/read-lock.js';

// ---------------------------------------------------------------------------
// E2E suite — the GRAPH-AWARE deterministic check.mjs surface.
//
// Proves, end-to-end against the real built binary, the four pillars of the
// graph-aware deterministic reviewer:
//   * ctx.graph (node lookup, children) — cross-node topology rules
//   * ctx.fs (exists/list/read) — file-system shape rules
//   * ctx.parseAst — syntax-tree inspection inside a graph-aware check
//   * the allowed-reads boundary — UndeclaredGraphReadError /
//     structure-aspect-undeclared-graph-read when a check reaches outside it
// plus the `yg aspect-test` command surface: --node (graph-scoped),
// --files (ad-hoc), and --check-determinism — and the `yg check --approve`
// (fill) enforcement surface, which records each (aspect, unit) verdict in
// the verdict lock (the deterministic verdicts land in the gitignored
// .yg-lock.deterministic.json file of the 5.1.0 triad) with its `touched`
// observation set. Tests read the lock via readLock, which merges the triad.
//
// Every aspect / check.mjs used here is AUTHORED INTO A FRESH mkdtemp COPY of
// the committed e2e-lifecycle fixture. The committed fixture is never mutated;
// zero committed bytes change. Each test rmSync's its temp dir in finally.
// Fully hermetic: no network host/port, no random source, no wall-clock reads
// inside assertions. The fixture's LLM aspect is stripped so every outcome is
// driven purely by deterministic check.mjs runs (no LLM, no reviewer endpoint).
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

function run(
  args: string[],
  cwd: string,
): {
  stdout: string;
  stderr: string;
  status: number | null;
  all: string;
} {
  const result = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the e2e-lifecycle fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-detctx-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so the node's
 * effective aspects are purely deterministic. This makes the lifecycle hermetic:
 * no network, no LLM verdict, fully reproducible — only deterministic check.mjs
 * runs drive every refuse/pass outcome.
 */
function deterministicFixture(label: string): string {
  const dir = copyFixture(label);
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  const arch = readFileSync(archPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '- has-doc-comment')
    .join('\n');
  writeFileSync(archPath, arch, 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), {
    recursive: true,
    force: true,
  });
  return dir;
}

/**
 * Author a deterministic aspect into the temp graph: writes the aspect dir,
 * yg-aspect.yaml, and check.mjs. All bytes land in the temp copy only.
 */
function writeAspect(dir: string, id: string, description: string, checkSource: string): void {
  const aspectDir = path.join(dir, '.yggdrasil', 'aspects', id);
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(
    path.join(aspectDir, 'yg-aspect.yaml'),
    [
      `name: ${id}`,
      `description: ${description}`,
      'reviewer:',
      '  type: deterministic',
      'status: enforced',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(path.join(aspectDir, 'check.mjs'), checkSource, 'utf-8');
}

/** Append an aspect id to a node's own `aspects:` list (creating the list). */
function attachAspectToNode(dir: string, nodePath: string, aspectId: string): void {
  const nodeYaml = path.join(dir, '.yggdrasil', 'model', ...nodePath.split('/'), 'yg-node.yaml');
  const content = readFileSync(nodeYaml, 'utf-8');
  if (/^aspects:/m.test(content)) {
    // Insert after the existing aspects: line's last list entry. Simplest robust
    // approach: append a new entry right after the `aspects:` line.
    const out = content.replace(/^aspects:\n/m, `aspects:\n  - ${aspectId}\n`);
    writeFileSync(nodeYaml, out, 'utf-8');
  } else {
    writeFileSync(nodeYaml, content.trimEnd() + `\naspects:\n  - ${aspectId}\n`, 'utf-8');
  }
}

/**
 * Append a `uses` relation to a node's yg-node.yaml (creating the `relations:`
 * block if absent). Used to flip a graph-aware check's reachability of the
 * target node from THROW (unreachable) to RETURN (reachable).
 */
function addUsesRelation(dir: string, nodePath: string, target: string): void {
  const nodeYaml = path.join(dir, '.yggdrasil', 'model', ...nodePath.split('/'), 'yg-node.yaml');
  const content = readFileSync(nodeYaml, 'utf-8');
  const block = `relations:\n  - type: uses\n    target: ${target}\n`;
  writeFileSync(nodeYaml, content.trimEnd() + '\n' + block, 'utf-8');
}

/**
 * Strip the exact `uses` relation block that addUsesRelation appended (mirror
 * inverse). Removes the three appended lines verbatim so the node returns to its
 * pre-relation yaml bytes, flipping a graph-aware check's reachability of the
 * target back from RETURN (reachable) to THROW (unreachable).
 */
function removeUsesRelation(dir: string, nodePath: string, target: string): void {
  const nodeYaml = path.join(dir, '.yggdrasil', 'model', ...nodePath.split('/'), 'yg-node.yaml');
  const content = readFileSync(nodeYaml, 'utf-8');
  const block = `relations:\n  - type: uses\n    target: ${target}\n`;
  const stripped = content.replace('\n' + block, '\n');
  if (stripped === content) {
    throw new Error(`removeUsesRelation: no 'uses' relation to ${target} found on ${nodePath}`);
  }
  writeFileSync(nodeYaml, stripped.trimEnd() + '\n', 'utf-8');
}

const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');

interface LockVerdict {
  hash: string;
  verdict: 'approved' | 'refused';
  reason?: string;
  /** Observation set folded into the verdict hash: [observationKey, hash] pairs. */
  touched?: Array<[string, string]>;
}

/**
 * Read the stored verdict (and its `touched` observation set) for an
 * (aspect, node) pair from the verdict lock, or undefined if the pair has no
 * recorded verdict. The lock keys by aspect first, then unitKey
 * (`node:<model-relative path>`).
 *
 * Under the 5.1.0 triad the lock is split across three files; readLock merges
 * them into one { version, verdicts, nodes } object. These aspects are all
 * deterministic, so their verdicts live in the gitignored
 * .yg-lock.deterministic.json — readLock folds that in.
 */
function lockVerdict(dir: string, aspectId: string, node: string): LockVerdict | undefined {
  const lock = readLock(path.join(dir, '.yggdrasil')) as {
    verdicts?: Record<string, Record<string, LockVerdict>>;
  };
  return lock.verdicts?.[aspectId]?.[`node:${node}`];
}

/** The observation keys (read:/list:/exists:/graph:) folded into a pair's verdict hash. */
function touchedKeys(dir: string, aspectId: string, node: string): string[] {
  return (lockVerdict(dir, aspectId, node)?.touched ?? []).map(([key]) => key);
}

// ---------------------------------------------------------------------------
// Reusable check.mjs sources (authored into the temp copy at run time).
// ---------------------------------------------------------------------------

// Graph topology rule: every child of a node must be of type `service`.
// Attached to the `services` (module) parent — uses ctx.graph.children.
const CHILD_TYPE_CHECK = `export function check(ctx) {
  const violations = [];
  for (const child of ctx.graph.children(ctx.node)) {
    if (child.type !== 'service') {
      violations.push({
        message: \`Child '\${child.id}' has type '\${child.type}', expected 'service'.\`,
      });
    }
  }
  return violations;
}
`;

// Graph + file rule: the node's own source file (read back through
// ctx.graph.node(ctx.node.id), always inside the allowed set) must export a
// create* function. Attached to a node WITH files so the fill evaluates it.
const GRAPH_NAME_MATCH_CHECK = `export function check(ctx) {
  const violations = [];
  const self = ctx.graph.node(ctx.node.id);
  if (!self) return violations;
  for (const file of self.files) {
    if (!/export\\s+function\\s+create/.test(file.content)) {
      violations.push({
        file: file.path,
        line: 1,
        column: 0,
        message: \`Service must export a create* function (node '\${self.id}').\`,
      });
    }
  }
  return violations;
}
`;

// Allowed-reads boundary violation: reach a SIBLING node id that is NOT in the
// allowed set (no relation, not ancestor/descendant). ctx.graph.node throws
// UndeclaredGraphReadError -> structure-aspect-undeclared-graph-read.
const CROSS_GRAPH_READ_CHECK = `export function check(ctx) {
  // 'services/payments' is a sibling of 'services/orders' — outside the allowed
  // reads boundary. This throws and the runner surfaces a boundary violation.
  const other = ctx.graph.node('services/payments');
  return other ? [] : [];
}
`;

// Allowed-reads boundary violation via ctx.fs: reach a SIBLING file that is
// NOT in the allowed set (no relation, not ancestor/descendant, not own
// mapping). ctx.fs.read throws UndeclaredFsReadError -> the runner's own
// translation of it (structure/runner.ts).
const CROSS_FS_READ_CHECK = `export function check(ctx) {
  // 'services/payments.ts' is a sibling file of 'services/orders' — outside
  // the allowed reads boundary. This throws and the runner surfaces it.
  ctx.fs.read('src/services/payments.ts');
  return [];
}
`;

// ctx.parseAst rule: parse the node's own files and count export_statement
// nodes via the re-exported tree-sitter `walk` helper. Flags a file with none.
const AST_EXPORTS_CHECK = `import { walk } from '@chrisdudek/yg/structure';
export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    const tree = ctx.parseAst(file, 'typescript');
    let exportCount = 0;
    walk(tree.rootNode, (n) => {
      if (n.type === 'export_statement') exportCount++;
    });
    if (exportCount === 0) {
      violations.push({
        file: file.path,
        line: 1,
        column: 0,
        message: \`No exported declarations found (ctx.parseAst saw \${exportCount} export_statement nodes).\`,
      });
    }
  }
  return violations;
}
`;

// Intentionally NON-deterministic: a module-level call counter. The aspect is
// imported once per process and the two runOnce() calls of --check-determinism
// share module state, so call 1 returns a violation and call 2 returns none.
// No random/clock source — a pure (but stateful) counter.
const FLAKY_CHECK = `let calls = 0;
export function check(ctx) {
  calls++;
  if (calls === 1) {
    const f = ctx.files[0];
    return [{
      file: f ? f.path : undefined,
      line: 1,
      column: 0,
      message: 'First-run-only violation (call counter).',
    }];
  }
  return [];
}
`;

// Finding G: ctx.graph.node(id).files must expose a glob-mapped node's files.
// Reads the node's OWN files two ways — via ctx.files (glob-expanded) and via
// ctx.graph.node(ctx.node.id).files — and flags a mismatch. A glob mapping that
// ctx.graph fails to expand makes the second count 0 while the first is N.
const GLOB_GRAPH_FILES_CHECK = `export function check(ctx) {
  const self = ctx.graph.node(ctx.node.id);
  const viaGraph = self ? self.files.length : 0;
  const viaOwn = ctx.files.length;
  if (viaGraph !== viaOwn) {
    return [{
      file: ctx.files[0] ? ctx.files[0].path : ctx.node.id,
      line: 1,
      column: 0,
      message: \`ctx.graph exposed \${viaGraph} files but the node owns \${viaOwn} (glob mapping not expanded in ctx.graph).\`,
    }];
  }
  return [];
}
`;

// Reachability rule (mirrors the dogfood `sibling-test-file` shape): try to
// reach a target node and REFUSE (via a caught throw) when it is unreachable.
// Unlike CROSS_GRAPH_READ_CHECK this SWALLOWS the UndeclaredGraphReadError, so
// the fill records a refused verdict (cached) instead of an uncached runtime
// error — exactly the path where a stale refusal could survive a relation add.
const REACH_TARGET_OR_REFUSE_CHECK = `export function check(ctx) {
  const violations = [];
  try {
    ctx.graph.node('services/payments');
  } catch {
    violations.push({
      file: ctx.files[0] ? ctx.files[0].path : ctx.node.id,
      line: 1,
      column: 0,
      message: "Cannot reach 'services/payments'. Add a 'uses' relation to this node.",
    });
  }
  return violations;
}
`;

// A check that returns a "violation" against a file it was NOT given (not in
// the node's mapping, not reached via a relation). The structure runner rejects
// this with a structured STRUCTURE_CHECK_FILE_NOT_IN_CONTEXT error — a CLASSIFIED
// aspect-author error, not a CLI bug. Under --check-determinism this previously
// routed through the generic "error it does not classify" abort.
const VIOLATION_OUT_OF_CONTEXT_CHECK = `export function check(ctx) {
  return [{ file: 'src/services/payments.ts', line: 1, message: 'violation against a non-context file' }];
}
`;

describe.skipIf(!distExists)('CLI E2E — graph-aware deterministic ctx surface + aspect-test + fill', () => {
  // -------------------------------------------------------------------------
  // Scenario 1: GRAPH-AWARE check passes/refuses through the yg check --approve fill.
  // -------------------------------------------------------------------------

  it('S1a: a graph-aware (ctx.graph + ctx.files) rule that HOLDS passes aspect-test and fill (verdict + touched recorded)', () => {
    const dir = deterministicFixture('s1a');
    try {
      writeAspect(dir, 'graph-name-match', 'Service file must export a create* function (read via ctx.graph).', GRAPH_NAME_MATCH_CHECK);
      attachAspectToNode(dir, 'services/orders', 'graph-name-match');

      // aspect-test --node confirms the rule holds with the real graph-aware ctx.
      const test = run(['aspect-test', '--aspect', 'graph-name-match', '--node', 'services/orders'], dir);
      expect(test.status).toBe(0);
      expect(test.all).toContain('No violations.');
      // aspect-test is diagnostic only — it never writes the lock.
      expect(test.all).toContain('diagnostic only — lock unchanged; yg check judges the lock against your files, not this run');

      // The fill evaluates the same graph-aware aspect and records an approved
      // verdict in the lock, with the node's graph observation in `touched`.
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(lockVerdict(dir, 'graph-name-match', 'services/orders')?.verdict).toBe('approved');
      // The check read its own node through ctx.graph.node — that folds a
      // graph:<node> observation into the verdict hash.
      expect(touchedKeys(dir, 'graph-name-match', 'services/orders')).toContain('graph:services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S1b: breaking the graph-aware rule makes the fill REFUSE (exit 1) and records a refused verdict naming the aspect', () => {
    const dir = deterministicFixture('s1b');
    try {
      writeAspect(dir, 'graph-name-match', 'Service file must export a create* function (read via ctx.graph).', GRAPH_NAME_MATCH_CHECK);
      attachAspectToNode(dir, 'services/orders', 'graph-name-match');

      // Rename the only create* export so the rule no longer holds.
      const broken = readFileSync(ordersFile(dir), 'utf-8').replace(
        'export function createOrder',
        'export function buildOrder',
      );
      writeFileSync(ordersFile(dir), broken, 'utf-8');

      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      // The fill records the refusal and the check renderer surfaces the enforced
      // refusal as a blocking error naming the aspect.
      expect(fill.all).toContain('[det] graph-name-match on node:services/orders — refused');
      // Grouped view: an enforced refusal group names the aspect; the per-member
      // `Violations:` tail (FULL_WHAT detail) is retained and names the node.
      expect(fill.all).toContain("enforced  1 pairs  1 nodes  aspect 'graph-name-match'");
      expect(fill.all).toContain('- services/orders  Violations:');
      // The graph-aware check's violation message is preserved in the lock reason.
      expect(lockVerdict(dir, 'graph-name-match', 'services/orders')?.verdict).toBe('refused');
      expect(lockVerdict(dir, 'graph-name-match', 'services/orders')?.reason).toContain(
        "Service must export a create* function (node 'services/orders').",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S1c: a ctx.graph.children topology rule HOLDS, and a wrongly-typed child breaks it', () => {
    const dir = deterministicFixture('s1c');
    try {
      writeAspect(dir, 'child-type', 'Every child of the services module must be of type service.', CHILD_TYPE_CHECK);
      attachAspectToNode(dir, 'services', 'child-type');

      // HOLDS: all children of `services` (orders, payments) are type `service`.
      const ok = run(['aspect-test', '--aspect', 'child-type', '--node', 'services'], dir);
      expect(ok.status).toBe(0);
      expect(ok.all).toContain('No violations.');

      // BREAK: add a child node of a different type (module, parent-only).
      const subDir = path.join(dir, '.yggdrasil', 'model', 'services', 'sub');
      mkdirSync(subDir, { recursive: true });
      writeFileSync(
        path.join(subDir, 'yg-node.yaml'),
        ['name: SubModule', 'description: A wrongly-typed child for testing.', 'type: module', ''].join('\n'),
        'utf-8',
      );

      const broken = run(['aspect-test', '--aspect', 'child-type', '--node', 'services'], dir);
      expect(broken.status).toBe(1);
      // Graph-level violation (no file) renders under the <graph> bucket.
      expect(broken.all).toContain('<graph>');
      expect(broken.all).toContain("Child 'services/sub' has type 'module', expected 'service'.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 2: ALLOWED-READS boundary — reaching a node outside the boundary.
  // -------------------------------------------------------------------------

  it('S2: ctx.graph.node on an out-of-boundary sibling surfaces structure-aspect-undeclared-graph-read', () => {
    const dir = deterministicFixture('s2');
    try {
      writeAspect(dir, 'cross-read', 'Reads a sibling node outside the allowed boundary on purpose.', CROSS_GRAPH_READ_CHECK);
      attachAspectToNode(dir, 'services/orders', 'cross-read');

      // services/payments is a SIBLING of services/orders — not ancestor,
      // descendant, or relation target — so it is outside the allowed reads set.
      // aspect-test --node renders the boundary breach as an actionable violation.
      const test = run(['aspect-test', '--aspect', 'cross-read', '--node', 'services/orders'], dir);
      expect(test.status).toBe(1);
      // The runner converts UndeclaredGraphReadError into an actionable violation.
      expect(test.all).toContain("Aspect tried to read undeclared graph node 'services/payments'");
      expect(test.all).toContain('Add a relation in yg-node.yaml');

      // The same boundary error blocks the fill (exit 1): the check crashed on the
      // undeclared read, so its pair is classified aspect-check-runtime-error and
      // left unverified rather than recording a verdict.
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      expect(fill.all).toContain('cross-read');
      expect(fill.all).toContain('aspect-check-runtime-error');
      expect(fill.all).toContain("Aspect tried to read undeclared graph node 'services/payments'");
      // No verdict was written for the crashing pair.
      expect(lockVerdict(dir, 'cross-read', 'services/orders')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S2-fs: ctx.fs.read on an out-of-boundary sibling file surfaces its OWN remedy, never the generic "fix check.mjs" fallback', () => {
    const dir = deterministicFixture('s2-fs');
    try {
      writeAspect(dir, 'cross-fs-read', 'Reads a sibling file outside the allowed boundary on purpose.', CROSS_FS_READ_CHECK);
      attachAspectToNode(dir, 'services/orders', 'cross-fs-read');

      // services/payments.ts is a SIBLING of services/orders — not ancestor,
      // descendant, relation target, or own mapping — so it is outside the
      // allowed reads set. aspect-test --node renders the boundary breach.
      const test = run(['aspect-test', '--aspect', 'cross-fs-read', '--node', 'services/orders'], dir);
      expect(test.status).toBe(1);
      expect(test.all).toContain("Aspect tried to read undeclared path 'src/services/payments.ts'");
      expect(test.all).toContain('Add a relation in yg-node.yaml');

      // The same boundary error blocks the fill (exit 1): the check crashed on
      // the undeclared read, so its pair is classified aspect-check-runtime-error
      // and left unverified. The remedy is a GRAPH change (declare the relation)
      // — there is nothing wrong with check.mjs, so the generic "fix check.mjs"
      // fallback must never be the printed NEXT step for this disposition.
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      expect(fill.all).toContain('cross-fs-read');
      expect(fill.all).toContain('aspect-check-runtime-error');
      expect(fill.all).toContain("Aspect tried to read undeclared path 'src/services/payments.ts'");
      expect(fill.all).toContain('Add a relation in yg-node.yaml to the node owning this path.');
      expect(fill.all).not.toContain('Fix the check.mjs, then re-run: yg check --approve');
      // No verdict was written for the crashing pair.
      expect(lockVerdict(dir, 'cross-fs-read', 'services/orders')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 3: ctx.parseAst inspects the node's own files.
  // -------------------------------------------------------------------------

  it('S3a: a ctx.parseAst rule PASSES on conforming code (exports present)', () => {
    const dir = deterministicFixture('s3a');
    try {
      writeAspect(dir, 'ast-exports', 'Service file must contain at least one exported declaration (via ctx.parseAst).', AST_EXPORTS_CHECK);
      attachAspectToNode(dir, 'services/orders', 'ast-exports');

      const test = run(['aspect-test', '--aspect', 'ast-exports', '--node', 'services/orders'], dir);
      expect(test.status).toBe(0);
      expect(test.all).toContain('No violations.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S3b: the same ctx.parseAst rule FLAGS violating code (no exports), exit 1', () => {
    const dir = deterministicFixture('s3b');
    try {
      writeAspect(dir, 'ast-exports', 'Service file must contain at least one exported declaration (via ctx.parseAst).', AST_EXPORTS_CHECK);
      attachAspectToNode(dir, 'services/orders', 'ast-exports');

      // Strip every `export ` keyword so the parsed tree has no export_statement.
      const stripped = readFileSync(ordersFile(dir), 'utf-8').replace(/^export /gm, '');
      writeFileSync(ordersFile(dir), stripped, 'utf-8');

      const test = run(['aspect-test', '--aspect', 'ast-exports', '--node', 'services/orders'], dir);
      expect(test.status).toBe(1);
      expect(test.all).toContain('No exported declarations found');
      // Confirms parseAst actually walked the tree and found zero exports.
      expect(test.all).toContain('0 export_statement nodes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 4: yg aspect-test --check-determinism.
  // -------------------------------------------------------------------------

  it('S4a: --check-determinism passes for a STABLE graph-aware check (exit 0)', () => {
    const dir = deterministicFixture('s4a');
    try {
      writeAspect(dir, 'graph-name-match', 'Service file must export a create* function (read via ctx.graph).', GRAPH_NAME_MATCH_CHECK);
      attachAspectToNode(dir, 'services/orders', 'graph-name-match');

      const test = run(
        ['aspect-test', '--aspect', 'graph-name-match', '--node', 'services/orders', '--check-determinism'],
        dir,
      );
      expect(test.status).toBe(0);
      expect(test.all).toContain('No violations.');
      // A stable check must NOT trigger the non-determinism dump.
      expect(test.all).not.toContain('non-deterministic');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S4b: --check-determinism FAILS (exit 1) for a check that differs across runs, with a Run 1 / Run 2 dump', () => {
    const dir = deterministicFixture('s4b');
    try {
      // Module-level call counter — NOT a random or clock source. The two
      // consecutive runOnce() calls in --check-determinism share module state.
      writeAspect(dir, 'flaky', 'Intentionally non-deterministic via a module-level call counter.', FLAKY_CHECK);
      attachAspectToNode(dir, 'services/orders', 'flaky');

      const test = run(
        ['aspect-test', '--aspect', 'flaky', '--node', 'services/orders', '--check-determinism'],
        dir,
      );
      expect(test.status).toBe(1);
      expect(test.all).toContain("Deterministic aspect 'flaky' produced non-deterministic results");
      // The diagnostic dumps both runs' violation sets.
      expect(test.all).toContain('Run 1:');
      expect(test.all).toContain('Run 2:');
      expect(test.all).toContain('First-run-only violation (call counter).');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 5: --node (graph-scoped) vs --files (ad-hoc) on a graph-aware aspect.
  //
  // --node runs the graph-aware structure runner: ctx.graph / ctx.fs /
  // ctx.parseAst are all present. --files runs the single-file AST runner:
  // ctx exposes only ctx.files — no graph-aware surfaces. A graph-aware check
  // therefore THROWS in --files mode (TypeError: ctx.graph/ctx.parseAst
  // undefined). This is the documented mode distinction, asserted here.
  // -------------------------------------------------------------------------

  it('S5a: --node runs the graph-aware ctx (ctx.graph works); the same aspect in --files mode throws (no graph ctx)', () => {
    const dir = deterministicFixture('s5a');
    try {
      writeAspect(dir, 'graph-name-match', 'Service file must export a create* function (read via ctx.graph).', GRAPH_NAME_MATCH_CHECK);
      attachAspectToNode(dir, 'services/orders', 'graph-name-match');

      // --node: graph-aware ctx is available, rule holds.
      const node = run(['aspect-test', '--aspect', 'graph-name-match', '--node', 'services/orders'], dir);
      expect(node.status).toBe(0);
      expect(node.all).toContain('No violations.');

      // --files: ad-hoc single-file runner — ctx.graph is undefined, so the
      // graph-aware check throws. exit 1, error names the aspect.
      const files = run(['aspect-test', '--aspect', 'graph-name-match', '--files', 'src/services/orders.ts'], dir);
      expect(files.status).toBe(1);
      expect(files.all).toContain("check.mjs threw an exception while running (aspect 'graph-name-match')");
      // ctx.graph is absent in --files mode — the thrown error reflects that.
      expect(files.all).toContain("Cannot read properties of undefined (reading 'node')");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S5b: --files runs a single-file (ctx.files-only) check ad-hoc with no graph attachment', () => {
    const dir = deterministicFixture('s5b');
    try {
      // The fixture ships `no-todo-comments` — a pure ctx.files check. In --files
      // mode it runs ad-hoc with no node/graph: a clean file passes, a TODO flags.
      const clean = run(['aspect-test', '--aspect', 'no-todo-comments', '--files', 'src/services/orders.ts'], dir);
      expect(clean.status).toBe(0);
      expect(clean.all).toContain('No violations.');

      const withTodo = readFileSync(ordersFile(dir), 'utf-8') + '\n// TODO: ad-hoc check should flag this\n';
      writeFileSync(ordersFile(dir), withTodo, 'utf-8');
      const flagged = run(['aspect-test', '--aspect', 'no-todo-comments', '--files', 'src/services/orders.ts'], dir);
      expect(flagged.status).toBe(1);
      expect(flagged.all).toContain('TODO comment found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Mode guards (cheap, hermetic) — exactly-one-mode contract.
  // -------------------------------------------------------------------------

  it('S5c: aspect-test rejects both --node and --files together (exit 1)', () => {
    const dir = deterministicFixture('s5c');
    try {
      const test = run(
        ['aspect-test', '--aspect', 'no-todo-comments', '--node', 'services/orders', '--files', 'src/services/orders.ts'],
        dir,
      );
      expect(test.status).toBe(1);
      // --node/--file/--files are a three-way exactly-one-mode contract; the
      // wording names all three.
      expect(test.all).toContain('More than one of --node, --file, --files was provided');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S5d: aspect-test rejects neither --node nor --files (exit 1)', () => {
    const dir = deterministicFixture('s5d');
    try {
      const test = run(['aspect-test', '--aspect', 'no-todo-comments'], dir);
      expect(test.status).toBe(1);
      expect(test.all).toContain('None of --node, --file, --files was provided');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Finding G: a glob-mapped node's files must be visible through ctx.graph.
  // -------------------------------------------------------------------------

  it('G: ctx.graph exposes a glob-mapped node\'s files (matches ctx.files)', () => {
    const dir = deterministicFixture('glob-graph');
    try {
      // orders owns its source file via a GLOB instead of the exact path.
      const ordersYaml = path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
      const y = readFileSync(ordersYaml, 'utf-8').replace('src/services/orders.ts', 'src/services/order*.ts');
      writeFileSync(ordersYaml, y, 'utf-8');

      writeAspect(dir, 'glob-graph-files', 'ctx.graph must expose the same files a node owns.', GLOB_GRAPH_FILES_CHECK);
      attachAspectToNode(dir, 'services/orders', 'glob-graph-files');

      const test = run(['aspect-test', '--aspect', 'glob-graph-files', '--node', 'services/orders'], dir);
      // Post-fix: ctx.graph expands the glob, so it sees the same file ctx.files does.
      expect(test.all).toContain('No violations');
      expect(test.all).not.toContain('glob mapping not expanded');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Reachability invalidation: an UNREACHABLE ctx.graph.node(id) probe that the
  // check SWALLOWS (try/catch → refuse) must fold a graph observation so that
  // ADDING the relation that makes the target reachable INVALIDATES the cached
  // refusal — without manually deleting the deterministic cache. (Dogfood: a
  // command node missing its `uses` relation refused + cached forever even after
  // the relation was added, because the throw was never folded into `touched`.)
  // -------------------------------------------------------------------------

  it('R: adding the relation that makes an unreachable ctx.graph.node target reachable self-invalidates the cached refusal', () => {
    const dir = deterministicFixture('reach-invalidate');
    try {
      writeAspect(dir, 'reach-or-refuse', 'Node must declare a relation reaching services/payments.', REACH_TARGET_OR_REFUSE_CHECK);
      attachAspectToNode(dir, 'services/orders', 'reach-or-refuse');

      // 1) services/orders has NO relation to services/payments → the probe throws,
      //    the check swallows it and refuses; the fill caches the refused verdict.
      const refuse = run(['check', '--approve'], dir);
      expect(refuse.status).toBe(1);
      expect(lockVerdict(dir, 'reach-or-refuse', 'services/orders')?.verdict).toBe('refused');
      // The unreachable probe folded a graph observation of the CALLING node, so
      // a later relation add changes that observation's value.
      expect(touchedKeys(dir, 'reach-or-refuse', 'services/orders')).toContain('graph:services/orders');

      // 2) Add the `uses` relation so services/payments becomes reachable. Do NOT
      //    touch any source file and do NOT delete the deterministic cache.
      addUsesRelation(dir, 'services/orders', 'services/payments');

      // 3) Plain `yg check` must now report the cached refusal as STALE (unverified)
      //    — proving the verdict self-invalidated on the reachability change. Before
      //    the fix this stayed RED-as-refused forever (the relation add was invisible
      //    to the hash) or, worse, GREEN over the unreviewed refusal.
      const recheck = run(['check'], dir);
      expect(recheck.all).toContain('unverified');
      expect(recheck.all).not.toContain('reach-or-refuse on node:services/orders — refused');

      // 4) Re-fill: the probe now RETURNS the node (reachable), the check finds no
      //    violation, and the verdict re-verifies GREEN — with NO manual cache delete.
      const refill = run(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      expect(lockVerdict(dir, 'reach-or-refuse', 'services/orders')?.verdict).toBe('approved');

      // 5) A final plain check is clean (exit 0) — the cache invalidated itself.
      const clean = run(['check'], dir);
      expect(clean.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Reachability invalidation — INVERSE direction. Scenario R proves a relation
  // ADD (unreachable→reachable) self-invalidates a cached REFUSAL. This proves
  // the symmetric, more dangerous direction: a relation REMOVE
  // (reachable→unreachable) self-invalidates a cached APPROVAL — so a node that
  // SHOULD now refuse cannot keep serving a stale green. Same self-invalidation,
  // no manual cache delete: ctx.graph.node() folds the CALLING node's
  // graph:<self> observation on EVERY probe (reachable AND unreachable), so the
  // node yaml byte change on the relation remove moves the verdict's inputHash.
  // -------------------------------------------------------------------------

  it('R-inverse: removing the relation that makes a reachable ctx.graph.node target unreachable self-invalidates the cached approval', () => {
    const dir = deterministicFixture('reach-invalidate-inverse');
    try {
      writeAspect(dir, 'reach-or-refuse', 'Node must declare a relation reaching services/payments.', REACH_TARGET_OR_REFUSE_CHECK);
      attachAspectToNode(dir, 'services/orders', 'reach-or-refuse');

      // 1) Start with the `uses` relation PRESENT → services/payments is reachable,
      //    the probe RETURNS (no throw), the check finds no violation, and the fill
      //    caches an APPROVED verdict.
      addUsesRelation(dir, 'services/orders', 'services/payments');
      const approve = run(['check', '--approve'], dir);
      expect(approve.status).toBe(0);
      expect(lockVerdict(dir, 'reach-or-refuse', 'services/orders')?.verdict).toBe('approved');
      // The reachable probe folded the CALLING node's graph observation (the same
      // key the unreachable branch folds), so removing the relation will move it.
      expect(touchedKeys(dir, 'reach-or-refuse', 'services/orders')).toContain('graph:services/orders');

      // 2) REMOVE the `uses` relation so services/payments becomes unreachable
      //    again. Do NOT touch any source file and do NOT delete the deterministic
      //    cache (.yggdrasil/.yg-lock.deterministic.json stays in place).
      removeUsesRelation(dir, 'services/orders', 'services/payments');

      // 3) Plain `yg check` (NOT --approve) must now report the cached approval as
      //    STALE (unverified) — proving the verdict self-invalidated on the
      //    reachability change. Before the fold-on-every-probe fix the approval
      //    would survive (the relation remove was invisible to the hash), leaving
      //    a stale GREEN over code that should now refuse — the dangerous direction.
      const recheck = run(['check'], dir);
      expect(recheck.all).toContain('unverified');

      // 4) Re-fill: the probe now THROWS (unreachable), the check swallows it and
      //    refuses, and the verdict re-verifies as REFUSED — with NO manual cache
      //    delete. The stale green could not survive the relation remove.
      const refill = run(['check', '--approve'], dir);
      expect(refill.status).toBe(1);
      expect(lockVerdict(dir, 'reach-or-refuse', 'services/orders')?.verdict).toBe('refused');
      expect(refill.all).toContain('[det] reach-or-refuse on node:services/orders — refused');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // aspect-test --check-determinism on a deterministic aspect whose check
  // produces a CLASSIFIED runner error (here: a violation against a file the
  // check was not given) must render that structured what/why/next and exit 1
  // — NOT route through the generic "CLI encountered an error it does not
  // classify / file an issue" abort.
  // -------------------------------------------------------------------------

  it('F: --check-determinism surfaces a classified runner error cleanly (no "does not classify")', () => {
    const dir = deterministicFixture('det-classified-error');
    try {
      writeAspect(dir, 'out-of-context', 'Returns a violation against a non-context file (author error).', VIOLATION_OUT_OF_CONTEXT_CHECK);
      attachAspectToNode(dir, 'services/orders', 'out-of-context');

      const res = run(['aspect-test', '--aspect', 'out-of-context', '--node', 'services/orders', '--check-determinism'], dir);
      // Exit 1 (the aspect under test has a problem) — but a CLEAN, classified one.
      expect(res.status).toBe(1);
      // The structured runner message (what/why/next) is rendered verbatim.
      expect(res.all).toContain("Violation references file 'src/services/payments.ts' not in ctx");
      expect(res.all).toContain('Author cannot synthesize violations against files they were not given.');
      // The generic unclassified-error wrapper must NOT appear.
      expect(res.all).not.toContain('does not classify');
      expect(res.all).not.toContain('please file an issue');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Verdict stamp: every deterministic aspect-test run LEADS with one grep-able
  // 'yg aspect-test: <verdict>' line — satisfied/refused vocabulary, never the
  // 'yg check: PASS/FAIL' build stamp.
  // -------------------------------------------------------------------------

  it('G1: a deterministic refusal leads with the verdict stamp as the FIRST stdout line, exit 1', () => {
    const dir = deterministicFixture('stamp-refused');
    try {
      // The fixture's no-todo-comments aspect (architecture default on services)
      // refuses on a TODO line.
      const src = readFileSync(ordersFile(dir), 'utf-8');
      writeFileSync(ordersFile(dir), src + '// TODO: remove this later\n', 'utf-8');

      const res = run(['aspect-test', '--aspect', 'no-todo-comments', '--node', 'services/orders'], dir);
      expect(res.status).toBe(1);
      // Stamp first (spawned process, no TTY → no color codes), then the file list.
      expect(res.stdout.split('\n')[0]).toBe('yg aspect-test: refused — 1 violation');
      expect(res.stdout.indexOf('yg aspect-test: refused')).toBeLessThan(res.stdout.indexOf('src/services/orders.ts'));
      expect(res.all).toContain('diagnostic only — lock unchanged; yg check judges the lock against your files, not this run');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('G2: a clean deterministic run leads with the satisfied stamp (substring "No violations." preserved), exit 0', () => {
    const dir = deterministicFixture('stamp-satisfied');
    try {
      const res = run(['aspect-test', '--aspect', 'no-todo-comments', '--node', 'services/payments'], dir);
      expect(res.status).toBe(0);
      expect(res.stdout.split('\n')[0]).toBe('yg aspect-test: satisfied — No violations.');
      expect(res.all).toContain('diagnostic only — lock unchanged; yg check judges the lock against your files, not this run');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Line-less violations: a check.mjs may return { file, message } with no
  // line — both render surfaces omit the line segment (no ':?:' / 'L?:').
  // -------------------------------------------------------------------------

  it('H: a line-less violation renders without placeholder on both surfaces (aspect-test and grouped check)', () => {
    const dir = deterministicFixture('no-line-render');
    try {
      writeAspect(
        dir,
        'no-line-e2e',
        'Flags the orders file as a whole (no line number).',
        `export function check(ctx) {
  return [{ file: 'src/services/orders.ts', message: 'file-scoped issue without a line' }];
}
`,
      );
      attachAspectToNode(dir, 'services/orders', 'no-line-e2e');

      // aspect-test surface: bare indented message under the file header.
      const test = run(['aspect-test', '--aspect', 'no-line-e2e', '--node', 'services/orders'], dir);
      expect(test.status).toBe(1);
      expect(test.stdout).toContain('src/services/orders.ts');
      expect(test.stdout).toContain('  file-scoped issue without a line');
      expect(test.stdout).not.toContain('L?');

      // Fill + grouped check surface: 'file: message' with no ':?:' placeholder.
      const fill = run(['check', '--approve', '--only-deterministic'], dir);
      expect(fill.status).toBe(1);
      expect(fill.all).toContain('src/services/orders.ts: file-scoped issue without a line');
      expect(fill.all).not.toContain(':?:');
      // The stored verdict reason carries the same placeholder-free rendering.
      expect(lockVerdict(dir, 'no-line-e2e', 'services/orders')?.reason).toContain(
        'src/services/orders.ts: file-scoped issue without a line',
      );
      expect(lockVerdict(dir, 'no-line-e2e', 'services/orders')?.reason).not.toContain(':?:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Draft aspects and aspect-test: status never gates the diagnostic. The
  // fixture's wip-rule is a DRAFT deterministic aspect attached to
  // services/orders — it must still run live via --node.
  // -------------------------------------------------------------------------

  it('I: a DRAFT deterministic aspect still runs live via --node and exits 1 on violations', () => {
    const dir = deterministicFixture('draft-det-runs');
    try {
      const src = readFileSync(ordersFile(dir), 'utf-8');
      writeFileSync(ordersFile(dir), src + '// WIP marker here\n', 'utf-8');

      const res = run(['aspect-test', '--aspect', 'wip-rule', '--node', 'services/orders'], dir);
      expect(res.status).toBe(1);
      expect(res.stdout.split('\n')[0]).toBe('yg aspect-test: refused — 1 violation');
      expect(res.stdout).toContain('WIP marker found.');
      // Dormancy in the fill is untouched: the draft aspect never blocks check.
      const check = run(['check', '--approve', '--only-deterministic'], dir);
      expect(check.all).not.toContain('wip-rule');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
