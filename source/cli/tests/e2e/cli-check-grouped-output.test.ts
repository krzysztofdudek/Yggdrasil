// =============================================================================
// E2E coverage for the Phase-1 grouped `yg check` default output.
//
// Phase 1 replaced the per-issue block wall with a GROUPED default view: each
// failing rule renders ONE group block keyed by (code, aspectId) —
//   <glossLabel(label)>  <P> pairs  <M> nodes[  aspect '<id>']
//   <shared why>
//   Fix: <shared next>
//   - <node>            (one affected node per line)
// — and the Errors/Warnings sub-header gains " in M groups" when M > 1. The
// `Next:` line carries a residual parenthetical when --approve cannot clear
// every error (unverified pairs fill, but refused/relation errors remain).
//
// Phase 1.6 change: `unverified` issues group by CODE ONLY (not (code,aspectId)).
// The group header drops the `aspect '<id>'` segment; instead each member body
// line appends `  aspect '<id>'` so the agent sees which aspect is unverified
// on each node without a near-identical group block per aspect.
//
// These tests spawn the REAL built binary (dist/bin.js) against a hermetic
// fixture built in code (mirroring cli-check-output-flush.test.ts), then assert
// the grouped grammar on PIPED stdout (non-TTY → node lists never truncate).
//
// Implementation under test: src/cli/check.ts (renderErrorSection / renderGroup)
// and src/cli/group-issues.ts (groupIssues).
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

// A loopback reviewer endpoint that is never dialed by read-only `yg check`.
const LOOPBACK_ENDPOINT = 'http://127.0.0.1:11434';

function run(args: string[], cwd: string): { stdout: string; status: number | null; all: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { stdout, status: r.status, all: stdout + stderr };
}

/** Strip chalk ANSI escapes so colour codes never break substring/regex matches. */
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Build a hermetic project where ONE enforced LLM aspect (`shared`) is the type
 * default for every node, so a cold `yg check` (no lock) renders that aspect as
 * a single `unverified` group spanning all nodes. `withRelationError` optionally
 * adds a second node whose source imports an undeclared peer node, producing one
 * extra `relation-undeclared-dependency` error → a SECOND group + the partial
 * `Next:` residual.
 */
function buildGroupedFixture(opts: {
  nodeNames: string[];
  withRelationError?: boolean;
}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-check-grouped-'));
  const ygRoot = path.join(dir, '.yggdrasil');
  mkdirSync(path.join(ygRoot, 'model'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'flows'), { recursive: true });
  const srcDir = path.join(dir, 'src');
  mkdirSync(srcDir, { recursive: true });

  // One enforced LLM aspect (content.md present, no check.mjs → LLM). The
  // reviewer is never invoked by read-only `yg check`, so the content text is
  // irrelevant; what matters is that the pair is `unverified` on a cold lock.
  const aDir = path.join(ygRoot, 'aspects', 'shared');
  mkdirSync(aDir, { recursive: true });
  writeFileSync(
    path.join(aDir, 'yg-aspect.yaml'),
    ['name: shared', 'description: Shared rule for grouped-output coverage', 'status: enforced', ''].join('\n'),
    'utf-8',
  );
  writeFileSync(path.join(aDir, 'content.md'), '# shared\n\nEvery file must satisfy shared.\n', 'utf-8');

  // Architecture: one node type carrying the LLM aspect as a default. With no
  // allowed relations declared, svc→svc has the full default relation set, so a
  // cross-node import that is not declared is a relation-undeclared-dependency.
  writeFileSync(
    path.join(ygRoot, 'yg-architecture.yaml'),
    [
      'node_types:',
      '  svc:',
      "    description: 'Service node for grouped-output coverage'",
      '    log_required: false',
      '    when:',
      '      path: "src/**"',
      '    aspects:',
      '      - shared',
      '',
    ].join('\n'),
    'utf-8',
  );

  writeFileSync(
    path.join(ygRoot, 'yg-config.yaml'),
    [
      'quality:',
      '  max_direct_relations: 10',
      'reviewer:',
      '  tiers:',
      '    standard:',
      '      provider: ollama',
      '      consensus: 1',
      '      config:',
      '        model: test',
      `        endpoint: ${LOOPBACK_ENDPOINT}`,
      '',
    ].join('\n'),
    'utf-8',
  );

  for (const name of opts.nodeNames) {
    const nodeDir = path.join(ygRoot, 'model', name);
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(
      path.join(nodeDir, 'yg-node.yaml'),
      [`name: ${name}`, 'type: svc', `description: ${name}`, 'aspects: []', 'relations: []', 'mapping:', `  - src/${name}.ts`, ''].join('\n'),
      'utf-8',
    );
    writeFileSync(path.join(srcDir, `${name}.ts`), `export const ${name} = '${name}';\n`, 'utf-8');
  }

  if (opts.withRelationError) {
    // A 'dep' node whose code is imported by an 'importer' node WITHOUT a
    // declared relation → one relation-undeclared-dependency error, live.
    for (const name of ['dep', 'importer']) {
      const nodeDir = path.join(ygRoot, 'model', name);
      mkdirSync(nodeDir, { recursive: true });
      writeFileSync(
        path.join(nodeDir, 'yg-node.yaml'),
        [`name: ${name}`, 'type: svc', `description: ${name}`, 'aspects: []', 'relations: []', 'mapping:', `  - src/${name}.ts`, ''].join('\n'),
        'utf-8',
      );
    }
    writeFileSync(path.join(srcDir, 'dep.ts'), 'export function helper(): number { return 1; }\n', 'utf-8');
    writeFileSync(
      path.join(srcDir, 'importer.ts'),
      "import { helper } from './dep.js';\nexport const importerValue = helper();\n",
      'utf-8',
    );
  }

  return dir;
}

describe.skipIf(!distExists)('CLI E2E — yg check grouped default output', () => {
  it('the SAME aspect unverified across MANY nodes renders ONE group block, nodes one-per-line', () => {
    const nodes = ['alpha', 'beta', 'gamma', 'delta'];
    const dir = buildGroupedFixture({ nodeNames: nodes });
    try {
      const { status, stdout } = run(['check'], dir);
      const out = strip(stdout);

      // Cold lock → every (node, shared) pair unverified → exit 1.
      expect(status).toBe(1);

      // Single group (one (code, aspectId) → no " in M groups" segment): the true
      // total is the number of pairs (one per node), NOT a group count.
      expect(out).toMatch(new RegExp(`^Errors \\(${nodes.length}\\):$`, 'm'));
      // Defensive: a single group must NOT carry the " in M groups" segment.
      expect(out).not.toMatch(/Errors \(\d+\) in \d+ groups:/);

      // Exactly ONE group block for the unverified code: glossed label + "<P> pairs"
      // + "<M> nodes" — NO aspect segment in the header (unverified groups by code only).
      const groupHeaders = out.match(
        /^ {2}unverified \(not yet reviewed\) {2}(\d+) pairs {2}(\d+) nodes$/gm,
      ) ?? [];
      expect(groupHeaders.length).toBe(1);
      // The header reports P = node count pairs over M = node count nodes.
      expect(groupHeaders[0]).toContain(`${nodes.length} pairs`);
      expect(groupHeaders[0]).toContain(`${nodes.length} nodes`);
      // The header must NOT carry an aspect segment (aspect on body lines instead).
      expect(out).not.toMatch(/^ {2}unverified \(not yet reviewed\).*aspect 'shared'/m);

      // Shared why + Fix lines render once for the whole group (NOT once per node).
      expect(out).toContain('The lock holds no entry for this pair');
      expect(out).toMatch(/^ {12}Fix: yg check --approve$/m);

      // Every affected node is listed as "            - <node>  aspect 'shared'".
      for (const n of nodes) {
        expect(out).toMatch(new RegExp(`^ {12}- ${n}  aspect 'shared'$`, 'm'));
      }
      const nodeBullets = (out.match(/^ {12}- \w+ {2}aspect 'shared'$/gm) ?? []).length;
      expect(nodeBullets).toBe(nodes.length);

      // A clean Next (no residual) — the only errors are unverified, which
      // --approve clears entirely.
      expect(out).toMatch(/^Next: yg check --approve$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mixed errors (unverified group + relation error) render "Errors (N) in M groups:" and the partial Next residual', () => {
    const nodes = ['alpha', 'beta'];
    const dir = buildGroupedFixture({ nodeNames: nodes, withRelationError: true });
    try {
      const { status, stdout } = run(['check'], dir);
      const out = strip(stdout);

      expect(status).toBe(1);

      // Two distinct groups: the `shared` unverified group (over alpha, beta, dep,
      // importer = 4 unverified pairs) and the relation-undeclared-dependency
      // group (1 error). Total N = 5 errors in M = 2 groups.
      const header = out.match(/^Errors \((\d+)\) in (\d+) groups:$/m);
      expect(header, 'Expected grouped "Errors (N) in M groups:" sub-header').not.toBeNull();
      const totalErrors = parseInt(header![1], 10);
      const groupCount = parseInt(header![2], 10);
      expect(groupCount).toBe(2);
      // 4 unverified pairs (one per node) + 1 relation error = 5.
      expect(totalErrors).toBe(nodes.length + 2 + 1);

      // ONE group block for the shared unverified code, spanning all 4 nodes.
      // Header has NO aspect segment (unverified groups by code only since Phase 1.6).
      const unverifiedHeaders = out.match(
        /^ {2}unverified \(not yet reviewed\) {2}(\d+) pairs {2}(\d+) nodes$/gm,
      ) ?? [];
      expect(unverifiedHeaders.length).toBe(1);
      expect(unverifiedHeaders[0]).toContain(`${nodes.length + 2} pairs`);
      expect(unverifiedHeaders[0]).toContain(`${nodes.length + 2} nodes`);
      // The aspect appears on each body line, not in the header.
      expect(out).not.toMatch(/^ {2}unverified \(not yet reviewed\).*aspect 'shared'/m);

      // ONE relation-undeclared-dependency group block. It carries no aspect
      // segment (built-in check, not an aspect) and DOES retain the per-node
      // detail (FULL_WHAT code): the importer's undeclared edge to dep.
      const relationHeaders = out.match(/^ {2}relation-undeclared-dependency {2}(\d+) pairs {2}(\d+) nodes$/gm) ?? [];
      expect(relationHeaders.length).toBe(1);
      expect(relationHeaders[0]).toContain('1 pairs');
      // The affected-node line keeps the file:line → target detail for relations.
      expect(out).toMatch(/^ {12}- importer {2}src\/importer\.ts:\d+ → dep$/m);

      // Each unverified node appears as "            - <node>  aspect 'shared'".
      for (const n of [...nodes, 'dep']) {
        expect(out).toMatch(new RegExp(`^ {12}- ${n}  aspect 'shared'$`, 'm'));
      }
      // 'importer' appears in the relation group with perMemberReason detail;
      // it also has an unverified pair — assert the unverified bullet is there.
      expect(out).toMatch(/^ {12}- importer {2}aspect 'shared'$/m);

      // The partial Next residual: --approve fills the 4 unverified pairs but the
      // 1 relation error remains (needs a code/graph fix). N = 4 filled, K = 1
      // remaining → singular "error".
      expect(out).toMatch(
        /^Next: yg check --approve {2}\(fills 4 unverified; 1 error remain — need code\/graph fixes\)$/m,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('TWO DIFFERENT aspects unverified on ONE node collapse into ONE group', () => {
    // Build a fixture with ONE node and TWO enforced LLM aspects (both unverified
    // on a cold lock). The old behaviour produced 2 per-(code,aspectId) groups;
    // the new behaviour produces ONE group with both aspect ids on body lines.
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-check-multi-aspect-'));
    try {
      const ygRoot = path.join(dir, '.yggdrasil');
      mkdirSync(path.join(ygRoot, 'model', 'mynode'), { recursive: true });
      mkdirSync(path.join(ygRoot, 'flows'), { recursive: true });
      const srcDir = path.join(dir, 'src');
      mkdirSync(srcDir, { recursive: true });

      // Two separate enforced LLM aspects.
      for (const aspectId of ['aspect-alpha', 'aspect-beta']) {
        const aDir = path.join(ygRoot, 'aspects', aspectId);
        mkdirSync(aDir, { recursive: true });
        writeFileSync(
          path.join(aDir, 'yg-aspect.yaml'),
          `name: ${aspectId}\ndescription: ${aspectId} rule\nstatus: enforced\n`,
          'utf-8',
        );
        writeFileSync(path.join(aDir, 'content.md'), `# ${aspectId}\n\nRule.\n`, 'utf-8');
      }

      writeFileSync(
        path.join(ygRoot, 'yg-architecture.yaml'),
        [
          'node_types:',
          '  svc:',
          "    description: 'Service node'",
          '    log_required: false',
          '    when:',
          '      path: "src/**"',
          '',
        ].join('\n'),
        'utf-8',
      );

      writeFileSync(
        path.join(ygRoot, 'yg-config.yaml'),
        [
          'quality:',
          '  max_direct_relations: 10',
          'reviewer:',
          '  tiers:',
          '    standard:',
          '      provider: ollama',
          '      consensus: 1',
          '      config:',
          '        model: test',
          `        endpoint: ${LOOPBACK_ENDPOINT}`,
          '',
        ].join('\n'),
        'utf-8',
      );

      // One node with both aspects attached.
      writeFileSync(
        path.join(ygRoot, 'model', 'mynode', 'yg-node.yaml'),
        [
          'name: mynode',
          'type: svc',
          'description: mynode',
          'aspects:',
          '  - aspect-alpha',
          '  - aspect-beta',
          'relations: []',
          'mapping:',
          '  - src/mynode.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      writeFileSync(path.join(srcDir, 'mynode.ts'), "export const x = 1;\n", 'utf-8');

      const { status, stdout } = run(['check'], dir);
      const out = strip(stdout);

      // Both pairs unverified → 2 errors, exit 1.
      expect(status).toBe(1);
      expect(out).toMatch(/^Errors \(2\):$/m);

      // ONE group block — no " in M groups" (single group).
      expect(out).not.toMatch(/Errors \(\d+\) in \d+ groups:/);

      // Group header: no aspect segment (unverified collapses by code only).
      expect(out).toMatch(/^ {2}unverified \(not yet reviewed\) {2}2 pairs {2}1 nodes$/m);
      expect(out).not.toMatch(/^ {2}unverified \(not yet reviewed\).*aspect '/m);

      // Body: two lines, one per (node, aspect) pair.
      expect(out).toMatch(/^ {12}- mynode {2}aspect 'aspect-alpha'$/m);
      expect(out).toMatch(/^ {12}- mynode {2}aspect 'aspect-beta'$/m);

      // Shared why+fix rendered ONCE.
      expect(out).toContain('The lock holds no entry for this pair');
      const fixMatches = out.match(/Fix: yg check --approve/g) ?? [];
      expect(fixMatches.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
