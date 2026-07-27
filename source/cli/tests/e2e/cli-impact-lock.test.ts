// =============================================================================
// `yg impact` RE-SOURCED FROM THE LOCK — end-to-end through the spawned binary.
//
// The verdict-lock redesign re-sources `yg impact` from the committed lock
// (design §8): the refused-verdict annotation, the per-pair fill-cost lines, and
// the cross-node deterministic `touched`-map cascade are all read off an on-disk
// `yg-lock.json`. Those three paths had only in-memory unit coverage
// (tests/unit/cli/impact.test.ts, tests/unit/core/impact.test.ts) — the spawned
// `yg` child reading a REAL on-disk lock was never exercised. This suite closes
// the "## E2E gaps" impact entries from the bounty findings.
//
// HERMETIC: every test builds a fresh mkdtemp copy of the e2e-lifecycle fixture,
// mutates it in place, and removes it in afterEach. No fixed ports, no clock /
// random assertions. `yg impact` is a PURE READ (no reviewer, no LLM call), so
// the lock is either hand-written or produced by a deterministic-only
// `yg check --approve` (no network) — never by a live reviewer.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLock } from './support/read-lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

// Track every tmp dir so afterEach can clean up even if an assertion throws.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(args: string[], cwd: string): { stdout: string; stderr: string; all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { stdout, stderr, all: stdout + stderr, status: r.status };
}

const archPath = (d: string) => path.join(d, '.yggdrasil', 'yg-architecture.yaml');
const configPath = (d: string) => path.join(d, '.yggdrasil', 'yg-config.yaml');
const yggPath = (d: string) => path.join(d, '.yggdrasil');
// 5.1.0 triad: the legacy single yg-lock.json is gone. LLM verdicts live in the
// committed nondeterministic file; deterministic verdicts in the gitignored det file.
const nondetLockPath = (d: string) => path.join(d, '.yggdrasil', 'yg-lock.nondeterministic.json');
const detLockPath = (d: string) => path.join(d, '.yggdrasil', '.yg-lock.deterministic.json');
const nodeYaml = (d: string, n: string) => path.join(d, '.yggdrasil', 'model', ...n.split('/'), 'yg-node.yaml');
const aspectDir = (d: string, a: string) => path.join(d, '.yggdrasil', 'aspects', a);

/** Fresh hermetic copy of the e2e-lifecycle fixture, auto-cleaned in afterEach. */
function fixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-impact-lock-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

/**
 * Drop the LLM `has-doc-comment` default from the service type and delete the
 * aspect so a `yg check --approve` is deterministic-only (no reviewer, no
 * network). Used by the tests that need a REAL lock from `--approve`.
 */
function dropLlmDefault(dir: string): void {
  const arch = readFileSync(archPath(dir), 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '- has-doc-comment')
    .join('\n');
  writeFileSync(archPath(dir), arch, 'utf-8');
  rmSync(aspectDir(dir, 'has-doc-comment'), { recursive: true, force: true });
}

/**
 * Seed a DETERMINISTIC-verdict lock (the CLI ignores the legacy single file;
 * deterministic verdicts are read from the gitignored .yg-lock.deterministic.json).
 */
function writeDetLock(dir: string, lock: unknown): void {
  writeFileSync(detLockPath(dir), JSON.stringify(lock, null, 2) + '\n', 'utf-8');
}

/**
 * Seed an LLM-verdict lock (committed yg-lock.nondeterministic.json — the file
 * readLock parses for non-deterministic verdicts).
 */
function writeNondetLock(dir: string, lock: unknown): void {
  writeFileSync(nondetLockPath(dir), JSON.stringify(lock, null, 2) + '\n', 'utf-8');
}

describe.skipIf(!distExists)('CLI E2E — yg impact re-sourced from the lock', () => {
  // ===========================================================================
  // (1) impact --aspect refused annotation — node: AND file: unit keys.
  //
  // A node holding a `refused` verdict for the aspect is tagged [refused] in the
  // affected list; a node with an `approved` verdict is NOT. Two unit-key shapes
  // are exercised end-to-end: node:<path> (direct) and file:<mapped> (resolved to
  // its owning node through the graph mapping — the file→owner path).
  //
  // `no-todo-comments` is effective on BOTH services/orders and services/payments
  // (service-type default + the order-processing flow). We refuse exactly one and
  // assert the sibling stays untagged.
  // ===========================================================================

  it('tags a node:<path> refused verdict with [refused]; the approved sibling is untagged', () => {
    const dir = fixture('refused-node');
    // no-todo-comments is a DETERMINISTIC aspect → its verdicts live in the
    // gitignored deterministic file, which readLock (and `yg impact`) merge in.
    writeDetLock(dir, {
      version: 1,
      verdicts: {
        'no-todo-comments': {
          'node:services/orders': { verdict: 'refused', hash: 'deadbeef', reason: 'TODO comment found' },
          'node:services/payments': { verdict: 'approved', hash: 'cafef00d' },
        },
      },
      nodes: {},
    });

    const { stdout, status } = run(['impact', '--aspect', 'no-todo-comments'], dir);
    expect(status).toBe(0);
    // The refused node carries the [refused] tag after its [status] tag.
    expect(stdout).toMatch(/services\/orders \([^)]+\) \[enforced\] \[refused\]/);
    // The approved sibling is affected (same flow/type) but NOT tagged refused.
    expect(stdout).toMatch(/^ {2}services\/payments \([^)]+\) \[enforced\]$/m);
    expect(stdout).not.toMatch(/services\/payments[^\n]*\[refused\]/);
  });

  it('resolves a file:<mapped> refused unit key to its owning node and tags it [refused]', () => {
    const dir = fixture('refused-file');
    // The unit key is a file path mapped to services/orders (src/services/orders.ts).
    // Impact must resolve file→owner through the graph and tag services/orders.
    // no-todo-comments is DETERMINISTIC → seed the gitignored deterministic file.
    writeDetLock(dir, {
      version: 1,
      verdicts: {
        'no-todo-comments': {
          'file:src/services/orders.ts': { verdict: 'refused', hash: 'deadbeef', reason: 'TODO' },
        },
      },
      nodes: {},
    });

    const { stdout, status } = run(['impact', '--aspect', 'no-todo-comments'], dir);
    expect(status).toBe(0);
    // file:src/services/orders.ts → owner services/orders → [refused].
    expect(stdout).toMatch(/services\/orders \([^)]+\) \[enforced\] \[refused\]/);
    // services/payments holds no refused entry → untagged.
    expect(stdout).not.toMatch(/services\/payments[^\n]*\[refused\]/);
  });

  // ===========================================================================
  // (2) impact --aspect cost lines — per-pair, re-sourced; lock vocabulary only.
  //
  // LLM aspect: reviewer calls = resolved-tier consensus × affected units. With a
  // consensus-3 tier over 2 effective units the line must print 6 reviewer calls.
  // Deterministic aspect: free — no reviewer calls. Neither line uses drift words.
  // ===========================================================================

  it('LLM aspect: cost line = consensus × units reviewer calls (consensus included)', () => {
    const dir = fixture('cost-llm');
    // Bump the default tier consensus to 3. has-doc-comment (LLM) is effective on
    // BOTH service nodes (type default) → 2 units → 2 × 3 = 6 reviewer calls.
    writeFileSync(
      configPath(dir),
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
        '      consensus: 3',
        '      config:',
        '        model: "qwen2.5-coder:0.5b"',
        '        endpoint: "http://host.docker.internal:11434"',
        '',
      ].join('\n'),
      'utf-8',
    );

    const { stdout, status } = run(['impact', '--aspect', 'has-doc-comment'], dir);
    expect(status).toBe(0);
    // 2 affected service nodes, 2 pairs, 6 reviewer calls (2 units × consensus 3).
    expect(stdout).toContain('Directly affected (2):');
    expect(stdout).toContain('2 affected node(s) (2 pair(s))');
    expect(stdout).toContain('6 reviewer call(s) (consensus included)');
    // Lock vocabulary — never "drift".
    expect(stdout).toContain('would become unverified');
    expect(stdout.toLowerCase()).not.toContain('drift');
  });

  it('deterministic aspect: cost line is free — no reviewer calls, no drift words', () => {
    const dir = fixture('cost-det');
    // no-todo-comments is deterministic, effective on both service nodes.
    const { stdout, status } = run(['impact', '--aspect', 'no-todo-comments'], dir);
    expect(status).toBe(0);
    expect(stdout).toContain('Directly affected (2):');
    expect(stdout).toContain('2 affected node(s) (2 pair(s))');
    expect(stdout).toContain('re-verified for free by yg check --approve (deterministic, no reviewer calls)');
    expect(stdout).not.toContain('reviewer call(s) (consensus included)');
    expect(stdout.toLowerCase()).not.toContain('drift');
  });

  // ===========================================================================
  // (3) impact --file touched-key CROSS-NODE cascade.
  //
  // A deterministic aspect on node A (services/orders) OBSERVES a file owned by a
  // DIFFERENT node B (services/payments) via ctx.fs.list / ctx.fs.read / ctx.graph
  // — recorded in A's lock entry `touched` as read:/list:/graph: keys. Editing B's
  // file must list A under "Nodes whose deterministic aspects observe <file>
  // [structure]" sourced from the on-disk touched map (precise, NOT [structure,
  // potential]). With NO lock, the cold-start fallback lists A pessimistically via
  // collectAllowedReadsForAspect as [structure, potential].
  // ===========================================================================

  /**
   * Builds a deterministic-only graph where services/orders carries an obs-rule
   * check that observes services/payments cross-node (read of payments.ts via
   * ctx.graph.node, plus a list: of src/services). Returns the dir; if `approve`
   * is true a real lock with the touched map is produced.
   */
  function obsRuleFixture(label: string, approve: boolean): string {
    const dir = fixture(label);
    dropLlmDefault(dir);
    // Broaden the service when so a directory-mapped helper node validates.
    writeFileSync(
      archPath(dir),
      readFileSync(archPath(dir), 'utf-8').replace('path: "src/services/**"', 'path: "src/**"'),
      'utf-8',
    );

    // Helper node services/extras mapping src/extras (so a negative exists probe
    // under it is INSIDE the allowed-reads set).
    mkdirSync(path.join(dir, 'src', 'extras'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'extras', 'placeholder.ts'), '// placeholder\nexport const p = 1;\n', 'utf-8');
    mkdirSync(path.join(dir, '.yggdrasil', 'model', 'services', 'extras'), { recursive: true });
    writeFileSync(
      nodeYaml(dir, 'services/extras'),
      ['name: ExtrasService', 'description: Auxiliary extras directory.', 'type: service', 'mapping:', '  - src/extras', ''].join('\n'),
      'utf-8',
    );

    // obs-rule deterministic aspect: lists src/services, reaches payments via
    // ctx.graph.node AND reads its file content (folds read:src/services/payments.ts
    // + graph:services/payments — reading `.content` is what folds a read:
    // observation, so the check genuinely OBSERVES payments.ts content), and
    // negatively probes src/extras/secret.ts.
    const obs = aspectDir(dir, 'obs-rule');
    mkdirSync(obs, { recursive: true });
    writeFileSync(
      path.join(obs, 'yg-aspect.yaml'),
      ['name: ObsRule', 'description: A graph-aware observation rule for cross-node impact.', 'reviewer:', '  type: deterministic', 'status: enforced', ''].join('\n'),
      'utf-8',
    );
    writeFileSync(
      path.join(obs, 'check.mjs'),
      [
        'export function check(ctx) {',
        "  ctx.fs.list('src/services');",
        "  const secret = ctx.fs.exists('src/extras/secret.ts');",
        "  let payType = 'none';",
        "  try {",
        "    const pay = ctx.graph.node('services/payments');",
        "    payType = pay.type;",
        "    for (const f of pay.files) void f.content;",  // read content → folds read:src/services/payments.ts
        "  } catch (e) { payType = 'ERR'; }",
        '  const v = [];',
        "  if (secret !== false) v.push({ message: 'secret.ts must not exist' });",
        "  if (payType !== 'service') v.push({ message: 'payments must be a service' });",
        '  return v;',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    // services/orders: attach obs-rule + relations (so payments.ts is in its
    // allowed-reads for the cold-start fallback too).
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

    if (approve) {
      run(['check', '--approve'], dir);
      // Deterministic-only fill — no reviewer, must succeed and record obs-rule.
      // Sanity: the touched map really references payments.ts cross-node. obs-rule
      // is deterministic → its verdict lands in the gitignored deterministic file;
      // readLock merges the triad so the verdict is available here.
      const lock = readLock(yggPath(dir));
      const touched: Array<[string, string]> = lock.verdicts['obs-rule']['node:services/orders'].touched!;
      const keys = touched.map((t) => t[0]);
      expect(keys).toContain('read:src/services/payments.ts');
      expect(keys).toContain('list:src/services');
    }
    return dir;
  }

  it('precise (lock-sourced): editing a cross-node observed file includes the observing node in the Total', () => {
    const dir = obsRuleFixture('xnode-precise', true);
    // payments.ts is owned by services/payments, but observed cross-node by
    // services/orders' obs-rule (recorded in the lock's touched map).
    const { stdout, status } = run(['impact', '--file', 'src/services/payments.ts'], dir);
    expect(status).toBe(0);
    // The unified Total block now reports both the structural owner (own pairs)
    // and the cross-node observing node (observe-deterministic).
    expect(stdout).toContain('Total to re-verify:');
    // The observing node services/orders appears in the per-node breakdown.
    expect(stdout).toContain('services/orders');
    // The structural owner resolution line still renders.
    expect(stdout).toContain('src/services/payments.ts -> services/payments');
  });

  it('cold-start fallback (no lock): cross-node potential pairs appear in the Total', () => {
    const dir = obsRuleFixture('xnode-coldstart', false);
    // No lock at all → collectInvalidatedPairs uses cold-potential-deterministic
    // for services/orders' obs-rule (payments.ts is in allowed-reads via uses relation).
    // No --approve ran, so neither triad verdict file exists on disk.
    expect(existsSync(detLockPath(dir))).toBe(false);
    expect(existsSync(nondetLockPath(dir))).toBe(false);
    const { stdout, status } = run(['impact', '--file', 'src/services/payments.ts'], dir);
    expect(status).toBe(0);
    // The unified Total block captures both own pairs and potential-deterministic pairs.
    expect(stdout).toContain('Total to re-verify:');
    // services/orders shows up in the per-node breakdown (potential-deterministic).
    expect(stdout).toContain('services/orders');
    // The structural owner resolution line still renders.
    expect(stdout).toContain('src/services/payments.ts -> services/payments');
  });

  // ===========================================================================
  // (4) impact --file companion-LLM renderer path — billed-cost label.
  //
  // When a companion-backed LLM aspect entry in the lock has a `touched` key
  // referencing the edited file, the structure cascade section must render the
  // widened header AND the per-kind blast-radius footer including the
  // "billed: reviewer requests × consensus × units" companion line.
  //
  // The fixture is constructed entirely from a hand-written lock (no --approve
  // needed) so no network / reviewer calls occur.
  // ===========================================================================

  it('companion-LLM renderer: billed-cost label appears in structure cascade output', () => {
    const dir = fixture('companion-llm-renderer');

    // Add a companion-backed LLM aspect (LLM aspect + check.mjs companion) to
    // the e2e-lifecycle fixture. The companion makes it eligible for the
    // structure cascade (hasCompanion === true).
    const compAspDir = aspectDir(dir, 'companion-rule');
    mkdirSync(compAspDir, { recursive: true });
    writeFileSync(
      path.join(compAspDir, 'yg-aspect.yaml'),
      [
        'name: CompanionRule',
        'description: A companion-backed LLM aspect for renderer testing.',
        'reviewer:',
        '  type: llm',
        'status: enforced',
        '',
      ].join('\n'),
      'utf-8',
    );
    // content.md marks this as an LLM aspect.
    writeFileSync(
      path.join(compAspDir, 'content.md'),
      '# CompanionRule\n\nEvery service must be correct.\n',
      'utf-8',
    );
    // companion.mjs makes this a companion-backed LLM aspect (hasCompanion: true).
    writeFileSync(
      path.join(compAspDir, 'companion.mjs'),
      [
        'export function check(ctx) {',
        "  ctx.fs.read('src/services/payments.ts');",
        '  return [];',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    // Attach companion-rule to services/orders with a relation to services/payments.
    writeFileSync(
      nodeYaml(dir, 'services/orders'),
      [
        'name: OrdersService',
        'description: Creates and retrieves customer orders.',
        'type: service',
        'aspects:',
        '  - wip-rule',
        '  - companion-rule',
        'relations:',
        '  - target: services/payments',
        '    type: uses',
        'mapping:',
        '  - src/services/orders.ts',
        '',
      ].join('\n'),
      'utf-8',
    );

    // Write a hand-crafted lock: services/orders' companion-rule verdict has
    // touched read:src/services/payments.ts (cross-node). This is the PRECISE
    // path — the cascade is sourced directly from the lock. companion-rule is an
    // LLM aspect (content.md present) → its verdict lives in the committed
    // nondeterministic file.
    writeNondetLock(dir, {
      version: 1,
      verdicts: {
        'companion-rule': {
          'node:services/orders': {
            verdict: 'approved',
            hash: 'deadbeef',
            touched: [['read:src/services/payments.ts', 'sha-of-payments']],
          },
        },
      },
      nodes: {},
    });

    // services/payments.ts is owned by services/payments — editing it should
    // surface services/orders in the unified Total (observe-companion reason).
    const { stdout, status } = run(['impact', '--file', 'src/services/payments.ts'], dir);
    expect(status).toBe(0);
    // The unified Total block replaces the old cascade section headers.
    expect(stdout).toContain('Total to re-verify:');
    // services/orders is listed in the per-node breakdown (companion observes payments.ts).
    expect(stdout).toContain('services/orders');
    // LLM reviewer calls are billed (companion-rule is an LLM aspect).
    expect(stdout).toMatch(/\d+ reviewer call\(s\)/);
    // Structural owner resolution still renders.
    expect(stdout).toContain('src/services/payments.ts -> services/payments');
    // Old cascade section headers are gone.
    expect(stdout).not.toContain('Nodes whose deterministic or companion-backed aspects observe');
    expect(stdout).not.toContain('Blast radius via observing aspects:');
  });
});

describe.skipIf(!distExists)('CLI E2E — yg impact --node/--file reviewer-call cost', () => {
  // ===========================================================================
  // The node-cost block (`Editing this {node|file} re-verifies: ...`) reports the
  // reviewer-call cost of editing a node (or one file under it): the LLM vs
  // deterministic pair split, the reviewer calls a re-fill dispatches (consensus
  // folded in), and the count of currently-green verdicts the edit re-rolls. All
  // sourced from the OWNER node's expected pairs + the on-disk lock. Lock
  // vocabulary only — never "drift".
  //
  // services/orders (type service, mapping src/services/orders.ts) draws:
  //   has-doc-comment        (LLM, enforced, type default)   → 1 LLM pair
  //   no-todo-comments       (deterministic, enforced)       → 1 det pair
  //   requires-named-export  (deterministic, advisory)       → 1 det pair
  //   wip-rule               (deterministic, draft, own)     → no pair (draft)
  // ===========================================================================

  /** Rewrite the copied fixture's tier consensus (default 1) to `n`. */
  function setConsensus(dir: string, n: number): void {
    writeFileSync(
      configPath(dir),
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
        `      consensus: ${n}`,
        '      config:',
        '        model: "qwen2.5-coder:0.5b"',
        '        endpoint: "http://host.docker.internal:11434"',
        '',
      ].join('\n'),
      'utf-8',
    );
  }

  it('mixed LLM+deterministic node prints the per-kind counts and the reviewer-call cost', () => {
    const dir = fixture('node-cost-mixed');
    const { stdout, status } = run(['impact', '--node', 'services/orders'], dir);
    expect(status).toBe(0);
    // 1 LLM pair (has-doc-comment) at consensus 1 = 1 reviewer call.
    expect(stdout).toMatch(/1 LLM pair\(s\) = 1 reviewer call\(s\)/);
    // 2 deterministic pairs (no-todo-comments, requires-named-export) are free.
    expect(stdout).toContain('2 deterministic = free');
    // Cold lock → nothing green yet.
    expect(stdout).toMatch(/0 currently-green verdict\(s\) re-rolled/);
    // Lock vocabulary — never "drift".
    expect(stdout.toLowerCase()).not.toContain('drift');
  });

  it('consensus 3 multiplies the reviewer-call count (= LLM pairs × consensus)', () => {
    const dir = fixture('node-cost-consensus3');
    setConsensus(dir, 3);
    const { stdout, status } = run(['impact', '--node', 'services/orders'], dir);
    expect(status).toBe(0);
    // 1 LLM pair × consensus 3 = 3 reviewer calls.
    expect(stdout).toMatch(/1 LLM pair\(s\) = 3 reviewer call\(s\)/);
    expect(stdout).toContain('2 deterministic = free');
  });

  it('seeded green verdicts surface as currently-green re-rolled', () => {
    const dir = fixture('node-cost-greens');
    // Both deterministic pairs of services/orders are approved → 2 greens. Their
    // verdicts live in the gitignored deterministic file (readLock merges them).
    writeDetLock(dir, {
      version: 1,
      verdicts: {
        'no-todo-comments': {
          'node:services/orders': { verdict: 'approved', hash: 'aaa' },
        },
        'requires-named-export': {
          'node:services/orders': { verdict: 'approved', hash: 'bbb' },
        },
      },
      nodes: {},
    });
    const { stdout, status } = run(['impact', '--node', 'services/orders'], dir);
    expect(status).toBe(0);
    expect(stdout).toMatch(/2 currently-green verdict\(s\) re-rolled/);
  });

  it('zero-LLM node prints 0 LLM pairs = 0 reviewer calls without crashing', () => {
    const dir = fixture('node-cost-zero-llm');
    // Drop the only LLM aspect (has-doc-comment) → services/orders has only
    // deterministic pairs left.
    dropLlmDefault(dir);
    const { stdout, status } = run(['impact', '--node', 'services/orders'], dir);
    expect(status).toBe(0);
    expect(stdout).toMatch(/0 LLM pair\(s\) = 0 reviewer call\(s\)/);
    expect(stdout).toContain('2 deterministic = free');
  });

  it('--file shows the unified Total to re-verify block (not the old "Editing this file" line)', () => {
    const dir = fixture('node-cost-file');
    const { stdout, status } = run(['impact', '--file', 'src/services/orders.ts'], dir);
    expect(status).toBe(0);
    // The file resolves to its owner node first.
    expect(stdout).toContain('src/services/orders.ts -> services/orders');
    // The unified Total block replaces the old single-line cost framing.
    expect(stdout).toContain('Total to re-verify:');
    // 1 LLM pair (has-doc-comment) at consensus 1 = 1 reviewer call.
    expect(stdout).toMatch(/1 reviewer call\(s\)/);
    // 2 deterministic pairs (no-todo-comments, requires-named-export) are free.
    expect(stdout).toMatch(/2 deterministic pair\(s\)/);
    // The old single-line framing is gone.
    expect(stdout).not.toMatch(/Editing this file re-verifies:/);
  });
});

// =============================================================================
// (5) Unified --file Total — new cases: warm/cold companion-LLM cross-node,
//     always-failing companion (Unresolved), graph-file redirect, no-owner Total.
// =============================================================================

describe.skipIf(!distExists)('CLI E2E — yg impact --file unified Total (new cases)', () => {
  /**
   * Build a fixture with a companion-backed LLM aspect on services/orders that
   * reads src/services/payments.ts. If `warm` is true, seed a nondeterministic
   * lock with a touched entry for payments.ts (precise path); otherwise leave
   * the lock empty (cold — companion resolved live).
   */
  function companionFixture(label: string, warm: boolean): string {
    const dir = fixture(label);
    const compAspDir = aspectDir(dir, 'companion-rule');
    mkdirSync(compAspDir, { recursive: true });
    writeFileSync(
      path.join(compAspDir, 'yg-aspect.yaml'),
      [
        'name: CompanionRule',
        'description: A companion-backed LLM aspect for Total tests.',
        'reviewer:',
        '  type: llm',
        'status: enforced',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      path.join(compAspDir, 'content.md'),
      '# CompanionRule\n\nEvery service must be correct.\n',
      'utf-8',
    );
    writeFileSync(
      path.join(compAspDir, 'companion.mjs'),
      [
        'export function companion(ctx) {',
        "  ctx.fs.read('src/services/payments.ts');",
        '  return [];',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      nodeYaml(dir, 'services/orders'),
      [
        'name: OrdersService',
        'description: Creates and retrieves customer orders.',
        'type: service',
        'aspects:',
        '  - companion-rule',
        'relations:',
        '  - target: services/payments',
        '    type: uses',
        'mapping:',
        '  - src/services/orders.ts',
        '',
      ].join('\n'),
      'utf-8',
    );
    if (warm) {
      writeNondetLock(dir, {
        version: 1,
        verdicts: {
          'companion-rule': {
            'node:services/orders': {
              verdict: 'approved',
              hash: 'deadbeef',
              touched: [['read:src/services/payments.ts', 'sha-of-payments']],
            },
          },
        },
        nodes: {},
      });
    }
    return dir;
  }

  // (a) WARM companion-LLM cross-node edit — lock has the touched entry.
  it('(a) warm companion-LLM: Total shows services/orders with LLM reviewer calls', () => {
    const dir = companionFixture('total-warm-companion', true);
    const { stdout, status } = run(['impact', '--file', 'src/services/payments.ts'], dir);
    expect(status).toBe(0);
    expect(stdout).toContain('Total to re-verify:');
    // services/orders is billed because companion-rule (LLM) touched payments.ts.
    expect(stdout).toContain('services/orders');
    expect(stdout).toMatch(/\d+ reviewer call\(s\)/);
    expect(stdout).toContain('src/services/payments.ts -> services/payments');
  });

  // (b) COLD companion-LLM — no lock, companion resolved live.
  it('(b) cold companion-LLM: Total shows services/orders via live companion resolve', () => {
    const dir = companionFixture('total-cold-companion', false);
    // No lock — companion.mjs is resolved live to detect the observation.
    expect(existsSync(nondetLockPath(dir))).toBe(false);
    const { stdout, status } = run(['impact', '--file', 'src/services/payments.ts'], dir);
    expect(status).toBe(0);
    expect(stdout).toContain('Total to re-verify:');
    expect(stdout).toContain('src/services/payments.ts -> services/payments');
  });

  // (c) Always-failing companion — Unresolved line appears.
  it('(c) always-failing companion: Unresolved line appears in Total output', () => {
    const dir = fixture('total-unresolved-companion');
    // Add a companion-backed LLM aspect whose companion.mjs always throws.
    const failAspDir = aspectDir(dir, 'always-fails');
    mkdirSync(failAspDir, { recursive: true });
    writeFileSync(
      path.join(failAspDir, 'yg-aspect.yaml'),
      [
        'name: AlwaysFails',
        'description: A companion that always throws — for unresolved-path testing.',
        'reviewer:',
        '  type: llm',
        'status: enforced',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      path.join(failAspDir, 'content.md'),
      '# AlwaysFails\n\nThis aspect always fails its companion.\n',
      'utf-8',
    );
    // companion.mjs throws unconditionally.
    writeFileSync(
      path.join(failAspDir, 'companion.mjs'),
      [
        "export function companion() { throw new Error('intentional failure for the unresolved-path test'); }",
        '',
      ].join('\n'),
      'utf-8',
    );
    // Attach always-fails to services/orders with a relation to services/payments so
    // payments.ts is in the allowed-reads set (triggering cold companion resolution).
    writeFileSync(
      nodeYaml(dir, 'services/orders'),
      [
        'name: OrdersService',
        'description: Creates and retrieves customer orders.',
        'type: service',
        'aspects:',
        '  - always-fails',
        'relations:',
        '  - target: services/payments',
        '    type: uses',
        'mapping:',
        '  - src/services/orders.ts',
        '',
      ].join('\n'),
      'utf-8',
    );
    // No lock — cold companion resolution will try to run always-fails companion.
    const { stdout, status } = run(['impact', '--file', 'src/services/payments.ts'], dir);
    expect(status).toBe(0);
    // The Unresolved section must appear (companion threw during resolution).
    expect(stdout).toContain('Unresolved');
    // The node path of the unresolved unit must appear.
    expect(stdout).toContain('services/orders');
  });

  // (d) Graph-file path: prints redirect, no Total.
  it('(d) graph-file path: prints redirect message, exits 0, no Total block', () => {
    const dir = fixture('total-graph-file-redirect');
    const { stdout, status } = run(['impact', '--file', '.yggdrasil/aspects/no-todo-comments/check.mjs'], dir);
    expect(status).toBe(0);
    expect(stdout).toContain('is a graph file');
    expect(stdout).toContain('yg impact --aspect');
    expect(stdout).not.toContain('Total to re-verify:');
  });

  // (e) No-owner observed file: shows Total (not an early exit, not the no-coverage error).
  it('(e) no-owner observed file: shows Total to re-verify (not early-exit, not error)', () => {
    const dir = fixture('total-no-owner-observed');
    // Add a reference to payments.ts in an LLM aspect on services/orders. The
    // file is already owned by services/payments (not unmapped). But to test the
    // no-owner path, we need a file that is referenced or observed but NOT owned.
    // Create an unowned file that is referenced by an aspect on services/orders.
    const refAspDir = aspectDir(dir, 'ref-rule');
    mkdirSync(refAspDir, { recursive: true });
    writeFileSync(
      path.join(refAspDir, 'yg-aspect.yaml'),
      [
        'name: RefRule',
        'description: An LLM aspect referencing an unowned helper file.',
        'reviewer:',
        '  type: llm',
        'status: enforced',
        'references:',
        '  - path: docs/helper.md',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      path.join(refAspDir, 'content.md'),
      '# RefRule\n\nEvery service must follow the helper guide.\n',
      'utf-8',
    );
    writeFileSync(
      nodeYaml(dir, 'services/orders'),
      [
        'name: OrdersService',
        'description: Creates and retrieves customer orders.',
        'type: service',
        'aspects:',
        '  - ref-rule',
        'mapping:',
        '  - src/services/orders.ts',
        '',
      ].join('\n'),
      'utf-8',
    );
    // Create the unowned helper file.
    mkdirSync(path.join(dir, 'docs'), { recursive: true });
    writeFileSync(path.join(dir, 'docs', 'helper.md'), '# Helper\n', 'utf-8');
    // docs/helper.md is NOT mapped to any node — no owner.
    // It IS referenced by ref-rule on services/orders → it has pairs invalidated.
    const { stdout, stderr, status } = run(['impact', '--file', 'docs/helper.md'], dir);
    expect(status).toBe(0);
    // No "no graph coverage" error — the file is referenced even without an owner.
    expect(stderr).not.toContain('no graph coverage');
    // Total is printed (not early-exit with no cost).
    expect(stdout).toContain('Total to re-verify:');
  });
});
