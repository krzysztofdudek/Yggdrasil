import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Channel-propagation COMPLETION suite. Closes the last gaps in the 7-channel
// cascade so every propagation path is proven end-to-end against the real
// binary:
//   - CH5 (flow) reaching a node via an ANCESTOR participant — the "(via
//     parent …)" provenance branch — and the negative case (a sibling that is
//     neither the participant nor its descendant is NOT matched).
//   - CH7 (implies): a DRAFT implier does NOT propagate its implied aspect; and
//     an intermediate implied aspect whose global `when` is false gates the
//     nested expansion (its own implications are never reached).
//   - The aspect-default status path: an aspect with NO explicit `status:` field
//     resolves to the `enforced` default across channels.
//
// Fully hermetic: each test copies the e2e-lifecycle fixture into a fresh
// mkdtemp, strips the LLM aspect, points the reviewer at a dead loopback
// endpoint, and rmSync's in finally. No network, no clock, no randomness.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const DEAD_ENDPOINT = 'http://127.0.0.1:1';

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the fixture, strip the LLM aspect, and kill the reviewer endpoint. */
function hermeticFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-chancomp-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  writeFileSync(
    archPath,
    readFileSync(archPath, 'utf-8').split('\n').filter((l) => l.trim() !== '- has-doc-comment').join('\n'),
    'utf-8',
  );
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), { recursive: true, force: true });
  const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  writeFileSync(
    cfgPath,
    readFileSync(cfgPath, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${DEAD_ENDPOINT}"`),
    'utf-8',
  );
  return dir;
}

const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');
const aspectDir = (dir: string, id: string) => path.join(dir, '.yggdrasil', 'aspects', id);
const ordersNodeYaml = (dir: string) => path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');

/**
 * Author a deterministic aspect that flags any line containing `literal`. When
 * `status` is undefined the `status:` field is OMITTED entirely (exercising the
 * `enforced` aspect-default path). `implies`/`when` blocks are spliced verbatim.
 */
function writeLiteralAspect(
  dir: string,
  id: string,
  literal: string,
  opts: { status?: 'draft' | 'advisory' | 'enforced'; implies?: string[]; whenBlock?: string[] } = {},
): void {
  const adir = aspectDir(dir, id);
  mkdirSync(adir, { recursive: true });
  const lines = [
    `name: ${id.replace(/-/g, '')}`,
    `description: Source files must not contain the literal token ${literal}.`,
    'reviewer:',
    '  type: deterministic',
  ];
  if (opts.status) lines.push(`status: ${opts.status}`);
  if (opts.whenBlock) lines.push(...opts.whenBlock);
  if (opts.implies && opts.implies.length > 0) {
    lines.push('implies:');
    for (const im of opts.implies) lines.push(`  - ${im}`);
  }
  lines.push('');
  writeFileSync(path.join(adir, 'yg-aspect.yaml'), lines.join('\n'), 'utf-8');
  writeFileSync(
    path.join(adir, 'check.mjs'),
    [
      'export function check(ctx) {',
      '  const violations = [];',
      '  for (const file of ctx.files) {',
      "    const lines = file.content.split('\\n');",
      '    for (let i = 0; i < lines.length; i++) {',
      `      if (lines[i].includes(${JSON.stringify(literal)})) {`,
      `        violations.push({ file: file.path, line: i + 1, column: 0, message: ${JSON.stringify(`${literal} found.`)} });`,
      '      }',
      '    }',
      '  }',
      '  return violations;',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );
}

/** Set the OWN aspect list on services/orders (channel 1). */
function setOrdersAspects(dir: string, aspectIds: string[]): void {
  writeFileSync(
    ordersNodeYaml(dir),
    [
      'name: OrdersService',
      'description: Creates and retrieves customer orders.',
      'type: service',
      'aspects:',
      ...aspectIds.map((id) => `  - ${id}`),
      'mapping:',
      '  - src/services/orders.ts',
      '',
    ].join('\n'),
    'utf-8',
  );
}

/** Author a flow at flows/<name>/yg-flow.yaml with the given participants + aspects. */
function writeFlow(dir: string, name: string, nodes: string[], aspects: string[]): void {
  const fdir = path.join(dir, '.yggdrasil', 'flows', name);
  mkdirSync(fdir, { recursive: true });
  writeFileSync(
    path.join(fdir, 'yg-flow.yaml'),
    [
      `name: ${name}`,
      `description: Flow exercising channel-5 propagation for ${name}.`,
      'nodes:',
      ...nodes.map((n) => `  - ${n}`),
      'aspects:',
      ...aspects.map((a) => `  - ${a}`),
      '',
    ].join('\n'),
    'utf-8',
  );
}

const plantBanned = (dir: string) => appendFileSync(ordersFile(dir), '\n// BANNED token here\n');

describe.skipIf(!distExists)('CLI E2E — channel propagation completion (CH5 ancestor, CH7 draft/when gating, status default)', () => {
  // --- CH7: a DRAFT implier does not propagate its implied aspect ---

  it('1: a DRAFT implier does NOT pull its implied aspect into the effective set; flipping it to enforced does', () => {
    const dir = hermeticFixture('draft-implier');
    try {
      // gate-rule (DRAFT) implies no-banned-word (enforced). Attach gate-rule on
      // the node directly (CH1). A draft implier is dormant — its implied aspect
      // must NOT become effective.
      writeLiteralAspect(dir, 'no-banned-word', 'BANNED', { status: 'enforced' });
      writeLiteralAspect(dir, 'gate-rule', 'NEVERMATCH', { status: 'draft', implies: ['no-banned-word'] });
      setOrdersAspects(dir, ['gate-rule']);

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('gate-rule [draft]');
      // The implied aspect is NOT an effective aspect while the implier is draft.
      // (It still appears in gate-rule's "Implies: no-banned-word" advertisement,
      // so assert on the effective-aspect header `<id> [` rather than the bare id.)
      expect(ctx.stdout).not.toContain('no-banned-word [');

      // Planting the banned token does NOT trip anything — no-banned-word is not
      // effective, so the fill passes.
      plantBanned(dir);
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // Flip the implier to enforced → the implied aspect now propagates and the
      // already-planted token blocks.
      writeLiteralAspect(dir, 'gate-rule', 'NEVERMATCH', { status: 'enforced', implies: ['no-banned-word'] });
      const ctx2 = run(['context', '--node', 'services/orders'], dir);
      expect(ctx2.stdout).toContain('no-banned-word [enforced]');
      const refused = run(['check', '--approve'], dir);
      expect(refused.status).toBe(1);
      expect(refused.all).toContain('no-banned-word');
      // The fill refused exactly one pair (the closing fill line counts it), and
      // the enforced refusal block names the rule and the child node it refused on.
      expect(refused.all).toMatch(/fill {2}done in \S+ — \d+ passed · 1 refused · 0 failed/);
      expect(refused.all).toContain('error[refused] no-banned-word — 1 violation in services/orders');
      // The block's member line lists the node with the violating file:line.
      expect(refused.all).toMatch(/at: {3}services\/orders {2}src\/services\/orders\.ts:\d+ {2}/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- CH7: an intermediate implied aspect's global `when` gates nested expansion ---

  it('2: an intermediate implied aspect whose global `when` is false is excluded AND its own implications are never reached', () => {
    const dir = hermeticFixture('implies-when-gate');
    try {
      // chain-root (attached, enforced) implies mid-gate; mid-gate has a global
      // `when` that is false on a `service` node (type: module), so it is filtered
      // out — and chain-leaf, which mid-gate implies, must never be reached.
      writeLiteralAspect(dir, 'chain-leaf', 'LEAFTOKEN', { status: 'enforced' });
      writeLiteralAspect(dir, 'mid-gate', 'MIDTOKEN', {
        status: 'enforced',
        whenBlock: ['when:', '  node:', '    type: module'],
        implies: ['chain-leaf'],
      });
      writeLiteralAspect(dir, 'chain-root', 'ROOTTOKEN', { status: 'enforced', implies: ['mid-gate'] });
      setOrdersAspects(dir, ['chain-root']);

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      // The root is an effective aspect; the gated middle and everything below it
      // are not. (mid-gate still appears in chain-root's "Implies: mid-gate"
      // advertisement, so assert on the effective-aspect header `<id> [`.)
      expect(ctx.stdout).toContain('chain-root [enforced]');
      expect(ctx.stdout).not.toContain('mid-gate [');
      expect(ctx.stdout).not.toContain('chain-leaf [');
      // The chain is structurally valid — no implies-cycle error.
      expect(run(['check'], dir).all).not.toContain('cycle');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- CH5: flow reaches a child via an ANCESTOR participant ("via parent") ---

  it('3: a flow listing the PARENT module reaches the child service with "(via parent ...)" provenance and enforces', () => {
    const dir = hermeticFixture('flow-via-parent');
    try {
      writeLiteralAspect(dir, 'no-banned-word', 'BANNED', { status: 'enforced' });
      // The flow lists only the parent `services` module; the child inherits the
      // flow aspect through ancestor matching.
      writeFlow(dir, 'parent-flow', ['services'], ['no-banned-word']);

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('no-banned-word');
      expect(ctx.stdout).toContain("flow 'parent-flow' (via parent 'services')");

      // Clean fill passes; planting the token trips the flow's enforced aspect.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      plantBanned(dir);
      const refused = run(['check', '--approve'], dir);
      expect(refused.status).toBe(1);
      expect(refused.all).toContain('no-banned-word');
      // The fill refused exactly one pair (the closing fill line counts it), and
      // the enforced refusal block names the rule and the child node it refused on.
      expect(refused.all).toMatch(/fill {2}done in \S+ — \d+ passed · 1 refused · 0 failed/);
      expect(refused.all).toContain('error[refused] no-banned-word — 1 violation in services/orders');
      // The block's member line lists the node with the violating file:line.
      expect(refused.all).toMatch(/at: {3}services\/orders {2}src\/services\/orders\.ts:\d+ {2}/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4: a flow listing only one leaf participant does NOT reach a sibling leaf', () => {
    const dir = hermeticFixture('flow-sibling-isolation');
    try {
      writeLiteralAspect(dir, 'no-banned-word', 'BANNED', { status: 'enforced' });
      // The flow lists ONLY services/orders. Its sibling services/payments is
      // neither the participant nor a descendant, so it must NOT receive the
      // flow aspect.
      writeFlow(dir, 'leaf-flow', ['services/orders'], ['no-banned-word']);

      const ordersCtx = run(['context', '--node', 'services/orders'], dir);
      expect(ordersCtx.stdout).toContain('no-banned-word');
      expect(ordersCtx.stdout).toContain("flow 'leaf-flow'");

      const paymentsCtx = run(['context', '--node', 'services/payments'], dir);
      expect(paymentsCtx.status).toBe(0);
      expect(paymentsCtx.stdout).not.toContain('no-banned-word');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- aspect-default status: no explicit `status:` field → enforced ---

  it('5: an aspect with NO explicit status field resolves to the enforced default and blocks', () => {
    const dir = hermeticFixture('default-status');
    try {
      // no-banned-word is authored WITHOUT a `status:` line — it must default to
      // enforced. Attach it on the node (CH1).
      writeLiteralAspect(dir, 'no-banned-word', 'BANNED', {}); // no status
      setOrdersAspects(dir, ['no-banned-word']);

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('no-banned-word [enforced]');

      plantBanned(dir);
      const refused = run(['check', '--approve'], dir);
      expect(refused.status).toBe(1);
      expect(refused.all).toContain('no-banned-word');
      // The fill refused exactly one pair (the closing fill line counts it), and
      // the enforced refusal block names the rule and the child node it refused on.
      expect(refused.all).toMatch(/fill {2}done in \S+ — \d+ passed · 1 refused · 0 failed/);
      expect(refused.all).toContain('error[refused] no-banned-word — 1 violation in services/orders');
      // The block's member line lists the node with the violating file:line.
      expect(refused.all).toMatch(/at: {3}services\/orders {2}src\/services\/orders\.ts:\d+ {2}/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
