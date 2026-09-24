// =============================================================================
// Synthetic scale fixture — a monorepo-shaped Yggdrasil project, generated.
//
// WHY IT EXISTS
//   Scale defects (a per-pair re-walk of the whole node, per-file × per-mapping
//   matching, a whole-graph validation inside `yg context`) only show once a
//   repository has thousands of files, hundreds of components and a few very
//   large ones. Cloning a real monorepo for that is slow, network-bound and has
//   taken the shared dev container down once; this module writes an equivalent
//   shape in seconds, deterministically, from a handful of numbers.
//
// WHAT IT BUILDS (all counts are options)
//   - `nodes` ordinary components, `src/g<group>/m<i>/`, each with
//     `filesPerNode` small `.ts` files spread over two subdirectories;
//   - `bigNodes` large components, `src/big<j>/`, each with `bigNodeFiles`
//     files in subdirectories of 40;
//   - a `.gitignore` in every tenth directory, plus the root one, and a few
//     ignored files next to them, so gitignore handling is exercised;
//   - `uncoveredFiles` files under `docs/` that no component maps;
//   - four deterministic rules: three `per: file` line scans (no-todo,
//     no-console, no-debugger) and one `per: node` advisory rule
//     (node-has-index), attached to every component;
//   - `relationsPerNode` acyclic `uses` relations from each ordinary node to
//     the next ones;
//   - `padFunctions` extra functions in every source file, when a scenario
//     needs files that are heavier to parse.
//   Every file is clean, so a filled run records only passing verdicts and its
//   output stays small.
//
// USE
//   In a test: `generateScaleFixture(dir, { nodes: 0, bigNodes: 1, bigNodeFiles: 200 })`.
//   From a shell (Node 22 strips the types itself):
//     node tests/support/scale-fixture.ts /tmp/scale-fx --nodes 400 --files-per-node 12 \
//       --big-nodes 3 --big-node-files 1500
//   then `yg check --approve --only-deterministic` inside the directory.
//
//   This module imports ONLY Node builtins — never anything under `src/**` — so
//   e2e suites (which must stay on the public CLI surface) can use it freely.
//   It does not run `yg init`; it writes the `.yggdrasil/` files itself.
// =============================================================================

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface ScaleFixtureOptions {
  /** Ordinary components. */
  nodes?: number;
  /** Files in each ordinary component. */
  filesPerNode?: number;
  /** Large components. */
  bigNodes?: number;
  /** Files in each large component. */
  bigNodeFiles?: number;
  /** Structural relations from each ordinary node to the following ones (acyclic). */
  relationsPerNode?: number;
  /** Files under docs/ that no component maps. */
  uncoveredFiles?: number;
  /** Extra functions appended to every source file (about 5 lines each), to make files heavier to parse. */
  padFunctions?: number;
}

export interface ScaleFixtureSummary {
  nodes: number;
  files: number;
  relations: number;
}

const DEFAULTS: Required<ScaleFixtureOptions> = {
  nodes: 400,
  filesPerNode: 12,
  bigNodes: 3,
  bigNodeFiles: 1500,
  relationsPerNode: 2,
  uncoveredFiles: 200,
  padFunctions: 0,
};

const LINE_SCAN = (pattern: string, message: string): string =>
  [
    'export function check(ctx) {',
    '  const out = [];',
    '  for (const f of ctx.files) {',
    "    const lines = f.content.split('\\n');",
    '    for (let i = 0; i < lines.length; i++) {',
    `      if (/${pattern}/.test(lines[i])) out.push({ file: f.path, line: i + 1, message: '${message}' });`,
    '    }',
    '  }',
    '  return out;',
    '}',
    '',
  ].join('\n');

const NODE_HAS_INDEX = [
  'export function check(ctx) {',
  "  if (ctx.files.length === 0 || ctx.files.some((f) => f.path.endsWith('.ts'))) return [];",
  "  return [{ file: ctx.files[0].path, line: 1, message: 'no TypeScript file in this component' }];",
  '}',
  '',
].join('\n');

function sourceFile(id: string, padFunctions: number): string {
  const pad: string[] = [];
  for (let k = 0; k < padFunctions; k++) {
    pad.push(`export function helper${k}(value: number): number {`, `  const doubled = value * 2 + ${k};`, '  return doubled > 100 ? doubled - 100 : doubled;', '}', '');
  }
  return [
    `// ${id}`,
    `export interface Shape${id.replace(/\W/g, '_')} {`,
    '  readonly name: string;',
    '  readonly size: number;',
    '}',
    '',
    `export function make(name: string, size: number): Shape${id.replace(/\W/g, '_')} {`,
    '  return { name, size };',
    '}',
    '',
    ...pad,
  ].join('\n');
}

export function generateScaleFixture(root: string, options: ScaleFixtureOptions = {}): ScaleFixtureSummary {
  const o = { ...DEFAULTS, ...options };
  let files = 0;
  let relations = 0;
  let dirCount = 0;
  const w = (rel: string, content: string): void => {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  const src = (rel: string, id: string): void => {
    w(rel, sourceFile(id, o.padFunctions));
    files++;
  };
  // Every tenth directory carries its own .gitignore and an ignored file.
  const maybeGitignore = (dir: string): void => {
    dirCount++;
    if (dirCount % 10 !== 0) return;
    w(`${dir}/.gitignore`, '*.tmp\n');
    w(`${dir}/scratch.tmp`, 'ignored\n');
  };

  w('.gitignore', 'node_modules/\n*.log\n');
  // What `yg init` puts in .yggdrasil/.gitignore: the local caches stay untracked.
  w(
    '.yggdrasil/.gitignore',
    [
      'yg-secrets.yaml',
      '.symbols-cache/',
      '.ast-cache/',
      '.type-class-cache/',
      '.debug.log',
      '.yg-lock.deterministic.json',
      '.yg-events.jsonl*',
      '.yg-fill-divergence.log*',
      '.feature-field.json',
      '.yg-packages-versions.json',
      '*.tmp',
      '.yg-*.lock',
      '',
    ].join('\n'),
  );
  w(
    '.yggdrasil/yg-config.yaml',
    ['version: "6.0.0"', 'coverage:', '  required: [src]', ''].join('\n'),
  );
  w(
    '.yggdrasil/yg-architecture.yaml',
    ['node_types:', '  module:', '    description: A source module', '    when:', '      path: "src/**"', ''].join('\n'),
  );
  const aspect = (id: string, perFile: boolean, status: 'enforced' | 'advisory', body: string): void => {
    w(
      `.yggdrasil/aspects/${id}/yg-aspect.yaml`,
      [
        `name: ${id}`,
        `description: "${id}"`,
        ...(perFile ? ['scope:', '  per: file'] : []),
        'errs: exact',
        'reviewer:',
        '  type: deterministic',
        `status: ${status}`,
        'review_by: 2099-01-01',
        '',
      ].join('\n'),
    );
    w(`.yggdrasil/aspects/${id}/check.mjs`, body);
  };
  aspect('no-todo', true, 'enforced', LINE_SCAN('\\bTODO\\b', 'TODO left in code'));
  aspect('no-console', true, 'enforced', LINE_SCAN('\\bconsole\\.log\\b', 'console.log left in code'));
  aspect('no-debugger', true, 'enforced', LINE_SCAN('\\bdebugger\\b', 'debugger statement'));
  aspect('node-has-index', false, 'advisory', NODE_HAS_INDEX);
  const ASPECTS = '[no-todo, no-console, no-debugger, node-has-index]';

  const nodeYaml = (name: string, mapping: string, rels: string[]): string =>
    [
      `name: ${name}`,
      'type: module',
      `description: Component ${name}`,
      `aspects: ${ASPECTS}`,
      'mapping:',
      `  - ${mapping}`,
      ...(rels.length > 0 ? ['relations:', ...rels.flatMap((t) => [`  - target: ${t}`, '    type: uses'])] : []),
      '',
    ].join('\n');

  // Group directories (g<k>) are organisational only: a plain parent node of a
  // type without `when:` would be refused a mapping, so groups get no node and
  // the components below them are top-level model entries named g<k>-m<i>.
  const GROUP = 20;
  const ordinary: string[] = [];
  for (let i = 0; i < o.nodes; i++) ordinary.push(`g${Math.floor(i / GROUP)}-m${i}`);
  for (let i = 0; i < o.nodes; i++) {
    const group = `g${Math.floor(i / GROUP)}`;
    const dir = `src/${group}/m${i}`;
    const rels: string[] = [];
    for (let r = 1; r <= o.relationsPerNode && i + r < o.nodes; r++) rels.push(ordinary[i + r]!);
    relations += rels.length;
    w(`.yggdrasil/model/${ordinary[i]}/yg-node.yaml`, nodeYaml(ordinary[i]!, dir, rels));
    maybeGitignore(dir);
    for (const sub of ['a', 'b']) maybeGitignore(`${dir}/${sub}`);
    for (let f = 0; f < o.filesPerNode; f++) {
      const sub = f % 2 === 0 ? 'a' : 'b';
      src(`${dir}/${sub}/f${f}.ts`, `m${i}_f${f}`);
    }
  }
  for (let j = 0; j < o.bigNodes; j++) {
    const dir = `src/big${j}`;
    w(`.yggdrasil/model/big${j}/yg-node.yaml`, nodeYaml(`big${j}`, dir, []));
    maybeGitignore(dir);
    for (let f = 0; f < o.bigNodeFiles; f++) {
      const sub = `d${Math.floor(f / 40)}`;
      if (f % 40 === 0) maybeGitignore(`${dir}/${sub}`);
      src(`${dir}/${sub}/f${f}.ts`, `big${j}_f${f}`);
    }
  }
  for (let u = 0; u < o.uncoveredFiles; u++) {
    w(`docs/d${Math.floor(u / 50)}/note${u}.md`, `# Note ${u}\n`);
    files++;
  }
  return { nodes: o.nodes + o.bigNodes, files, relations };
}

// Shell entry: node tests/support/scale-fixture.ts <dir> [--nodes N] [--files-per-node N]
//   [--big-nodes N] [--big-node-files N] [--relations-per-node N] [--uncovered-files N]
const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  const [dir, ...rest] = process.argv.slice(2);
  if (!dir) {
    process.stderr.write('usage: node scale-fixture.ts <dir> [--nodes N] [--files-per-node N] [--big-nodes N] [--big-node-files N] [--relations-per-node N] [--uncovered-files N]\n');
    process.exit(2);
  }
  const opts: Record<string, number> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!.replace(/^--/, '').replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    opts[key] = Number(rest[i + 1]);
  }
  const summary = generateScaleFixture(path.resolve(dir), opts as ScaleFixtureOptions);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
