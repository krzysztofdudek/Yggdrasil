// =============================================================================
// E2E coverage for the Phase-1 grouped `yg check` default output.
//
// Phase 1 replaced the per-issue block wall with a GROUPED default view, and
// the one-grammar change (issue 191) gave it its current shape: each failing
// rule renders ONE block —
//   error[<label>] <subject>
//     at:   <one line per rule: `<aspect>  <P> pairs · <M> nodes · <kind>`,
//            or `<aspect> @ <unit>` for a single pair>
//     why:  <shared why, once>
//     fix:  <shared fix, once>
// — `--details` lists every pair as `<aspect> @ <unit>`. When --approve cannot
// clear every error, `next:` names the code/graph fix first and `then:` names
// the fill; the JSON `next.remaining` carries the needs-fix / fillable split.
//
// `unverified` issues group by CODE (and cause), not (code, aspectId): two
// aspects unverified on one node share one block, one `at:` line per rule.
//
// These tests spawn the REAL built binary (dist/bin.js) against a hermetic
// fixture built in code (mirroring cli-check-output-flush.test.ts), then assert
// the grouped grammar on PIPED stdout (non-TTY → node lists never truncate).
//
// Implementation under test: src/cli/check-render-groups.ts (blocks) and
// src/cli/check-render-views.ts (the next:/then: step).
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
 * `next:`/`then:` residual.
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
      'version: "6.0.0"', 'quality:',
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
      expect(out).toMatch(new RegExp(`^yg check: FAIL  ${nodes.length} errors · `, 'm'));
      // No section sub-headers in the one grammar.
      expect(out).not.toMatch(/^Errors \(/m);

      // Exactly ONE group block for the unverified code: glossed label + "<P> pairs"
      // + "<M> nodes" — NO aspect segment in the header (unverified groups by code only).
      const groupHeaders = out.match(/^error\[unverified\] .*$/gm) ?? [];
      expect(groupHeaders.length).toBe(1);
      // The heading reports P = node count pairs.
      expect(groupHeaders[0]).toBe(`error[unverified] ${nodes.length} pairs with no verdict yet`);
      // The capped view names the rule once, with P pairs over M nodes.
      expect(out).toMatch(new RegExp(`^  at:   shared  ${nodes.length} pairs · ${nodes.length} nodes · reviewer$`, 'm'));

      // Shared why + fix lines render once for the whole group (NOT once per node).
      expect(out.match(/The lock holds no entry for this pair/g)?.length).toBe(1);
      expect(out).toMatch(new RegExp(`^  fix:  yg check --approve  \\(${nodes.length} reviewer pairs · paid — ask the user to approve it first\\)$`, 'm'));

      // Every affected node is listed by --details as "shared @ <node>".
      const details = strip(run(['check', '--details'], dir).stdout);
      for (const n of nodes) {
        expect(details).toMatch(new RegExp(`^ +(at: +)?shared @ ${n}$`, 'm'));
      }
      const nodeBullets = (details.match(/^ +(at: +)?shared @ \w+$/gm) ?? []).length;
      expect(nodeBullets).toBe(nodes.length);

      // A clean step (no residual) — the only errors are unverified, which
      // --approve clears entirely: the lone block's fix IS the step, so no
      // separate next:/then: residual is printed.
      expect(out).not.toMatch(/^then: /m);
      expect(out).not.toMatch(/need a code or graph fix/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mixed errors (unverified group + relation error) render one block per rule and a next:/then: residual', () => {
    const nodes = ['alpha', 'beta'];
    const dir = buildGroupedFixture({ nodeNames: nodes, withRelationError: true });
    try {
      const { status, stdout } = run(['check'], dir);
      const out = strip(stdout);

      expect(status).toBe(1);

      // Two distinct groups: the `shared` unverified group (over alpha, beta, dep,
      // importer = 4 unverified pairs) and the relation-undeclared-dependency
      // group (1 error). Total N = 5 errors in M = 2 groups.
      // 4 unverified pairs (one per node) + 1 relation error = 5 errors, in two blocks.
      expect(out).toMatch(new RegExp(`^yg check: FAIL  ${nodes.length + 2 + 1} errors · `, 'm'));
      expect((out.match(/^error\[/gm) ?? []).length).toBe(2);

      // ONE block for the shared unverified code, spanning all 4 nodes.
      const unverifiedHeaders = out.match(/^error\[unverified\] .*$/gm) ?? [];
      expect(unverifiedHeaders.length).toBe(1);
      expect(unverifiedHeaders[0]).toBe(`error[unverified] ${nodes.length + 2} pairs with no verdict yet`);
      expect(out).toMatch(new RegExp(`^  at:   shared  ${nodes.length + 2} pairs · ${nodes.length + 2} nodes · reviewer$`, 'm'));

      // ONE relation-undeclared-dependency block. It is not a pair's verdict —
      // no pair count — and it DOES retain the per-node detail: the importer's
      // undeclared edge to dep.
      const relationHeaders = out.match(/^error\[relation-undeclared-dependency\] .*$/gm) ?? [];
      expect(relationHeaders.length).toBe(1);
      expect(relationHeaders[0]).not.toMatch(/\bpairs?\b/);
      expect(out).toMatch(/^ {2}at: {3}importer\n {10}src\/importer\.ts:\d+ → dep$/m);

      // Each unverified node appears in --details as "shared @ <node>",
      // importer included (it also carries the relation error).
      const details = strip(run(['check', '--details'], dir).stdout);
      for (const n of [...nodes, 'dep', 'importer']) {
        expect(details).toMatch(new RegExp(`^ +(at: +)?shared @ ${n}$`, 'm'));
      }

      // The partial residual: the relation error needs a code/graph fix first,
      // then --approve fills the 4 unverified pairs.
      expect(out).toMatch(/^next: edit \.yggdrasil\/model\/importer\/yg-node\.yaml {2}\(relation-undeclared-dependency\)$/m);
      expect(out).toMatch(/^then: yg check --approve {2}\(4 reviewer pairs · paid — ask the user to approve it first\)$/m);
      const doc = JSON.parse(run(['check', '--json'], dir).stdout) as { next: { remaining: { needsFix: number; fillable: number } } };
      expect(doc.next.remaining).toEqual({ needsFix: 1, fillable: 4, needsUser: 0, waitingOnReviewer: 0 });
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
          'version: "6.0.0"', 'quality:',
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
      expect(out).toMatch(/^yg check: FAIL {2}2 errors · /m);

      // ONE block — the heading carries no aspect (unverified collapses by code).
      const headers = out.match(/^error\[unverified\] .*$/gm) ?? [];
      expect(headers).toEqual(['error[unverified] 2 pairs with no verdict yet']);

      // Members: two lines, one per (aspect, node) pair.
      expect(out).toMatch(/^ {2}at: {3}aspect-alpha @ mynode$/m);
      expect(out).toMatch(/^ {8}aspect-beta @ mynode$/m);

      // Shared why+fix rendered ONCE.
      expect(out.match(/The lock holds no entry for this pair/g)?.length).toBe(1);
      const fixMatches = out.match(/fix: {2}yg check --approve/g) ?? [];
      expect(fixMatches.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
