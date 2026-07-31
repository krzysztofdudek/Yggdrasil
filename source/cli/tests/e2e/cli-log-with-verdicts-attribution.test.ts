import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `yg log read --node <path> --with-verdicts` matched a `file:` verdict event
// against a node by testing whether the event's path fell textually inside the
// node's own mapping strings — never consulting the graph's real, hierarchy-
// first ownership resolution (the same one `yg owner --file` uses) or its
// exclusion set. Two consequences, pinned here on a real on-disk fixture driven
// only through the built bin.js:
//
//   (a) a directory-mapping ANCESTOR textually contains every path under a
//       DESCENDANT node's own, more specific mapping too, so the ancestor's
//       timeline claimed an outcome for a file `yg owner --file` attributes to
//       the descendant.
//   (b) an excluded path is still textually "inside" its would-be owner's
//       mapping, so its historical verdicts kept showing up on that node's
//       timeline even though `yg owner --file` calls the same path excluded.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status: result.status, all: (result.stdout ?? '') + (result.stderr ?? '') };
}

const ARCHITECTURE = [
  'node_types:',
  '  module:',
  "    description: 'A rootable grouping'",
  '  code:',
  "    description: 'A code unit'",
  '    log_required: false',
  '    when:',
  '      path: "src/**/*.ts"',
  '    parents: [module, code]',
  '',
].join('\n');

const j = (o: Record<string, unknown>): string => JSON.stringify(o);

/**
 * Ancestor `parent` maps the whole DIRECTORY `src/a/` — textually covering
 * every file under it, including `src/a/child.ts` and `src/a/excluded.ts`.
 * Descendant `parent/child` maps `src/a/child.ts` exactly, so hierarchy-first
 * ownership carves that one file out to the child. `src/a/excluded.ts` is
 * additionally named by `coverage.excluded`, so no node owns it at all.
 */
function scaffold(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-logwv-attr-'));
  const ygRoot = path.join(dir, '.yggdrasil');
  mkdirSync(path.join(ygRoot, 'aspects'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'flows'), { recursive: true });
  writeFileSync(path.join(ygRoot, 'yg-architecture.yaml'), ARCHITECTURE, 'utf-8');
  writeFileSync(
    path.join(ygRoot, 'yg-config.yaml'),
    [
      'quality:',
      '  max_direct_relations: 10',
      'coverage:',
      '  excluded:',
      '    - src/a/excluded.ts',
      '',
    ].join('\n'),
    'utf-8',
  );

  const writeNode = (nodePath: string, yaml: string): void => {
    const nodeDir = path.join(ygRoot, 'model', ...nodePath.split('/'));
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(path.join(nodeDir, 'yg-node.yaml'), yaml, 'utf-8');
  };
  writeNode(
    'parent',
    ['name: Parent', 'type: code', "description: 'Maps the whole directory'", 'mapping:', '  - src/a/', ''].join('\n'),
  );
  writeNode(
    'parent/child',
    ['name: Child', 'type: code', "description: 'Maps one file inside the parent directory'", 'mapping:', '  - src/a/child.ts', ''].join(
      '\n',
    ),
  );

  const writeSource = (relPath: string, body: string): void => {
    const abs = path.join(dir, ...relPath.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf-8');
  };
  writeSource('src/a/own.ts', 'export const own = 1;\n');
  writeSource('src/a/child.ts', 'export const child = 1;\n');
  writeSource('src/a/excluded.ts', 'export const excluded = 1;\n');

  const events = [
    j({
      v: 1,
      ts: '2027-01-01T00:00:00.000Z',
      source: 'fill',
      aspectId: 'ASPECT-OWN',
      unitKey: 'file:src/a/own.ts',
      kind: 'deterministic',
      disposition: 'approved',
      hash: 'h-own',
    }),
    j({
      v: 1,
      ts: '2027-01-01T01:00:00.000Z',
      source: 'fill',
      aspectId: 'ASPECT-CHILD',
      unitKey: 'file:src/a/child.ts',
      kind: 'deterministic',
      disposition: 'approved',
      hash: 'h-child',
    }),
    j({
      v: 1,
      ts: '2027-01-01T02:00:00.000Z',
      source: 'fill',
      aspectId: 'ASPECT-EXCLUDED',
      unitKey: 'file:src/a/excluded.ts',
      kind: 'deterministic',
      disposition: 'approved',
      hash: 'h-excluded',
    }),
  ];
  writeFileSync(path.join(ygRoot, '.yg-events.jsonl'), events.join('\n') + '\n', 'utf-8');

  return dir;
}

describe.skipIf(!distExists)('yg log read --with-verdicts attribution (E2E via bin.js)', () => {
  it('confirms the fixture\'s ownership facts independently, via yg owner --file', () => {
    const dir = scaffold();
    try {
      expect(run(['owner', '--file', 'src/a/own.ts'], dir).all).toContain('src/a/own.ts -> parent');
      expect(run(['owner', '--file', 'src/a/child.ts'], dir).all).toContain('src/a/child.ts -> parent/child');
      expect(run(['owner', '--file', 'src/a/excluded.ts'], dir).all).toContain('excluded from graph coverage by design');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the ancestor\'s timeline shows only ITS OWN file\'s verdict — never the descendant\'s, never the excluded file\'s', () => {
    const dir = scaffold();
    try {
      const { all } = run(['log', 'read', '--node', 'parent', '--with-verdicts'], dir);
      expect(all).toContain('ASPECT-OWN');
      expect(all).not.toContain('ASPECT-CHILD');
      expect(all).not.toContain('ASPECT-EXCLUDED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the descendant\'s timeline shows its own file\'s verdict, unaffected by the fix', () => {
    const dir = scaffold();
    try {
      const { all } = run(['log', 'read', '--node', 'parent/child', '--with-verdicts'], dir);
      expect(all).toContain('ASPECT-CHILD');
      expect(all).not.toContain('ASPECT-OWN');
      expect(all).not.toContain('ASPECT-EXCLUDED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
