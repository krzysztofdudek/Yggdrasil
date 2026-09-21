/**
 * A deterministic verdict must move when the LIST of a node's files it looked at
 * moves, not only when a file it read changes.
 *
 * A check can decide from file NAMES alone — "this node has no FORBIDDEN.md",
 * "every source file has a test beside it" — by walking `ctx.node.files` or
 * `ctx.graph.node(x).files` and reading only `.path`. Nothing in that walk is a
 * subject file of the pair (a `per: file` pair's subject is one file) and nothing
 * reads a file's content, so the only input the verdict rests on is which paths
 * the list held. When a file then appears in the node's directory without
 * becoming a subject of the pair, a recorded PASS has to stop counting: the gate
 * must report the pair as needing a fresh run, never as still approved.
 *
 * Driven through the built binary exactly as an adopter meets it: `check
 * --approve` records the verdicts, a bare `check` is the gate that must refuse
 * to trust them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', '..', 'dist', 'bin.js');
const distExists = existsSync(BIN);

const YG_CONFIG = `version: "6.0.0"
reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config: { model: m, endpoint: http://x }
`;

// No relations: map on the type, so the `uses` relation below is unconstrained.
const YG_ARCH = `node_types:
  service:
    description: Discrete service unit
    log_required: false
    when:
      path: "**"
`;

interface CheckDoc {
  pairs: Array<{ aspect: string; node: string | null; unit: { kind: string; path: string }; verdict: string }>;
}

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [BIN, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Refuses a node whose file list names FORBIDDEN.md — decided from `.path` alone. */
const NAME_ONLY_RULE = (listExpr: string): string =>
  `export function check(ctx) {\n` +
  `  const paths = ${listExpr}.map((f) => f.path);\n` +
  `  if (paths.some((p) => p.endsWith('FORBIDDEN.md'))) {\n` +
  `    return [{ message: 'FORBIDDEN.md is not allowed here', file: ctx.subject[0].path, line: 1 }];\n` +
  `  }\n` +
  `  return [];\n` +
  `}\n`;

function aspectYaml(id: string, scope: string): string {
  return `name: ${id}\ndescription: ${id} rule\nreviewer:\n  type: deterministic\nstatus: enforced\n${scope}`;
}

describe.skipIf(!distExists)('a file joining a node\'s file list invalidates a verdict decided from that list', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'yg-fileset-'));
    write(root, '.yggdrasil/yg-config.yaml', YG_CONFIG);
    write(root, '.yggdrasil/yg-architecture.yaml', YG_ARCH);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('ctx.node.files read by path in a per: file rule', () => {
    // A directory-mapped node. The rule is per: file over .ts files only, so a
    // markdown file added to the directory becomes no pair's subject.
    write(root, 'src/svc/a.ts', 'export const a = 1;\n');
    write(root, 'src/svc/b.ts', 'export const b = 1;\n');
    write(root, '.yggdrasil/model/svc/yg-node.yaml',
      'name: svc\ntype: service\ndescription: x\nmapping:\n  - src/svc/\naspects:\n  - no-forbidden\n');
    write(root, '.yggdrasil/aspects/no-forbidden/yg-aspect.yaml',
      aspectYaml('no-forbidden', 'scope:\n  per: file\n  files:\n    path: "**/*.ts"\n'));
    write(root, '.yggdrasil/aspects/no-forbidden/check.mjs', NAME_ONLY_RULE('ctx.node.files'));

    expect(run(['check', '--approve'], root).status).toBe(0);
    expect(run(['check'], root).status).toBe(0);

    write(root, 'src/svc/FORBIDDEN.md', '# not allowed\n');

    const gate = run(['check', '--json'], root);
    const doc = JSON.parse(gate.stdout) as CheckDoc;
    const pairs = doc.pairs.filter((p) => p.aspect === 'no-forbidden');
    // Still exactly the two .ts subjects — the new file is no pair of its own,
    // so nothing but the file list itself can move these verdicts.
    expect(pairs.map((p) => p.unit.path).sort()).toEqual(['src/svc/a.ts', 'src/svc/b.ts']);
    for (const p of pairs) expect(p.verdict).toBe('stale');
    expect(gate.status).toBe(1);

    // A fresh run sees the file and refuses; the gate stays red for the right reason.
    run(['check', '--approve'], root);
    const after = JSON.parse(run(['check', '--json'], root).stdout) as CheckDoc;
    for (const p of after.pairs.filter((q) => q.aspect === 'no-forbidden')) expect(p.verdict).toBe('refused');
  });

  it('ctx.node.files read by path in a per: node rule whose filter kept every file when it was approved', () => {
    // Whether a run sees a narrowed subject is decided by counting files: with
    // both mapped files matching the filter, the approving run is un-narrowed.
    // The file list must still be recorded — a file the filter drops can arrive
    // later without changing the pair's subjects.
    write(root, 'src/svc/a.ts', 'export const a = 1;\n');
    write(root, 'src/svc/b.ts', 'export const b = 1;\n');
    write(root, '.yggdrasil/model/svc/yg-node.yaml',
      'name: svc\ntype: service\ndescription: x\nmapping:\n  - src/svc/\naspects:\n  - no-forbidden\n');
    write(root, '.yggdrasil/aspects/no-forbidden/yg-aspect.yaml',
      aspectYaml('no-forbidden', 'scope:\n  per: node\n  files:\n    path: "**/*.ts"\n'));
    write(root, '.yggdrasil/aspects/no-forbidden/check.mjs', NAME_ONLY_RULE('ctx.node.files'));

    expect(run(['check', '--approve'], root).status).toBe(0);
    expect(run(['check'], root).status).toBe(0);

    write(root, 'src/svc/FORBIDDEN.md', '# not allowed\n');

    const gate = run(['check', '--json'], root);
    const pair = (JSON.parse(gate.stdout) as CheckDoc).pairs.find((p) => p.aspect === 'no-forbidden' && p.node === 'svc');
    expect(pair?.verdict).toBe('stale');
    expect(gate.status).toBe(1);

    run(['check', '--approve'], root);
    const after = JSON.parse(run(['check', '--json'], root).stdout) as CheckDoc;
    expect(after.pairs.find((p) => p.aspect === 'no-forbidden' && p.node === 'svc')?.verdict).toBe('refused');
  });

  it('ctx.graph.node(related).files read by path', () => {
    // N reaches the directory-mapped node L through a declared relation and
    // decides from L's file names only.
    write(root, 'src/n.ts', 'export const n = 1;\n');
    write(root, 'src/lib/x.ts', 'export const x = 1;\n');
    write(root, '.yggdrasil/model/L/yg-node.yaml',
      'name: L\ntype: service\ndescription: library\nmapping:\n  - src/lib/\n');
    write(root, '.yggdrasil/model/N/yg-node.yaml',
      'name: N\ntype: service\ndescription: dependent\nmapping:\n  - src/n.ts\nrelations:\n  - target: L\n    type: uses\naspects:\n  - lib-no-forbidden\n');
    write(root, '.yggdrasil/aspects/lib-no-forbidden/yg-aspect.yaml', aspectYaml('lib-no-forbidden', ''));
    write(root, '.yggdrasil/aspects/lib-no-forbidden/check.mjs', NAME_ONLY_RULE("ctx.graph.node('L').files"));

    expect(run(['check', '--approve'], root).status).toBe(0);
    expect(run(['check'], root).status).toBe(0);

    write(root, 'src/lib/FORBIDDEN.md', '# not allowed\n');

    const gate = run(['check', '--json'], root);
    const doc = JSON.parse(gate.stdout) as CheckDoc;
    const pair = doc.pairs.find((p) => p.aspect === 'lib-no-forbidden' && p.node === 'N');
    expect(pair?.verdict).toBe('stale');
    expect(gate.status).toBe(1);

    run(['check', '--approve'], root);
    const after = JSON.parse(run(['check', '--json'], root).stdout) as CheckDoc;
    expect(after.pairs.find((p) => p.aspect === 'lib-no-forbidden' && p.node === 'N')?.verdict).toBe('refused');
  });
});
