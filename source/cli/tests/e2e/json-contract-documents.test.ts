// =============================================================================
// CLAIM — every yg-*/1 document the CLI emits conforms to its published JSON
// Schema, with no field the schema does not declare.
//
// docs/family-contracts.md says each document's schema is published at
// /schemas/<id>.schema.json and describes exactly what this release writes,
// every mapping closed. tests/unit/repo/json-contract-schemas.test.ts derives
// those schemas from the document types; this suite runs the REAL built CLI over
// a matrix of fixture repositories — a flow and script rules with a drill corpus
// and a waiver, a type-covered tree, a graph with ports, an installed package,
// a broken flow file, and the error paths — collects every document it prints,
// and validates each one against the schema its `schema` field names
// (additionalProperties: false throughout). The package documents are validated
// as written on disk: the fixture manifests, and the record and versions cache
// `yg pack add` / `yg pack list` write.
//
// HERMETIC: every fixture is copied into a fresh temp directory; no reviewer is
// ever called (script rules only, and no fill that would reach one).
// =============================================================================

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { copyFixtureTree } from '../support/fixture-copy.js';
import { schemaFileName, validate, type JsonSchema } from '../support/json-schema-validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURES = path.join(CLI_ROOT, 'tests', 'fixtures');
const SCHEMA_DIR = path.join(CLI_ROOT, '..', '..', 'docs', 'public', 'schemas');
const distExists = existsSync(BIN_PATH);

// Each case's fixture copies are removed when that case ends.
let temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true, maxRetries: 3 });
  temps = [];
});

function fixture(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-json-contract-${name}-`));
  temps.push(dir);
  copyFixtureTree(path.join(FIXTURES, name), dir);
  return dir;
}

function git(dir: string, ...args: string[]): void {
  spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf-8' });
}

function yg(dir: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd: dir, encoding: 'utf-8', env: { ...process.env, CI: '', NO_COLOR: '1' } });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

const schemas = new Map<string, JsonSchema>();
function schemaFor(id: string): JsonSchema {
  if (!schemas.has(id)) schemas.set(id, JSON.parse(readFileSync(path.join(SCHEMA_DIR, schemaFileName(id)), 'utf-8')) as JsonSchema);
  return schemas.get(id)!;
}

/** Every document id validated, and every departure the current case found. */
const seen = new Set<string>();
let departures: string[] = [];
beforeEach(() => {
  departures = [];
});

function check(label: string, doc: unknown): void {
  const id = (doc as { schema?: unknown }).schema;
  if (typeof id !== 'string') {
    departures.push(`${label}: no schema field`);
    return;
  }
  seen.add(id);
  for (const d of validate(doc, schemaFor(id))) departures.push(`${label} (${id}) ${d}`);
}

/** Run a command with --json and validate the document it prints. */
function emitted(dir: string, args: string[]): void {
  const r = yg(dir, args);
  const label = `yg ${args.join(' ')}`;
  let doc: unknown;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    departures.push(`${label}: stdout is not one JSON document (exit ${r.status}): ${r.stdout.slice(0, 200)} ${r.stderr.slice(0, 300)}`);
    return;
  }
  check(label, doc);
}

describe.skipIf(!distExists)('every emitted yg-*/1 document conforms to its published schema', () => {
  it('a flow, script rules with a drill corpus, a waiver and logs (e2e-lifecycle)', () => {
    const dir = fixture('e2e-lifecycle');
    const ygg = path.join(dir, '.yggdrasil');
    // Script rules only: no reviewer is ever needed.
    writeFileSync(path.join(ygg, 'yg-architecture.yaml'), readFileSync(path.join(ygg, 'yg-architecture.yaml'), 'utf-8').split('\n').filter((l) => l.trim() !== '- has-doc-comment').join('\n'));
    rmSync(path.join(ygg, 'aspects', 'has-doc-comment'), { recursive: true, force: true });
    const drills = path.join(ygg, 'aspects', 'no-todo-comments', 'drills');
    mkdirSync(path.join(drills, 'violates-todo', 'src'), { recursive: true });
    mkdirSync(path.join(drills, 'satisfies-clean', 'src'), { recursive: true });
    writeFileSync(path.join(drills, 'violates-todo', 'src', 'a.ts'), '// TODO: finish\nexport const a = 1;\n');
    writeFileSync(path.join(drills, 'satisfies-clean', 'src', 'a.ts'), 'export const a = 1;\n');
    appendFileSync(path.join(dir, 'src', 'services', 'orders.ts'), '\n// yg-suppress(no-todo-comments) the reason this waiver exists\n');
    writeFileSync(path.join(dir, 'README.md'), '# not mapped\n');
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'fixture');
    yg(dir, ['log', 'add', '--node', 'services/orders', '--reason', 'Why the orders service exists.']);
    yg(dir, ['log', 'add', '--type', 'service', '--reason', 'A decision about every service.']);
    const [decided] = (JSON.parse(yg(dir, ['log', 'read', '--type', 'service', '--json']).stdout) as { entries: Array<{ datetime: string }> }).entries;
    yg(dir, ['log', 'add', '--type', 'service', '--reason', 'The decision that replaced it.', '--supersedes', decided.datetime]);
    yg(dir, ['log', 'add', '--type', 'service', '--reason', 'A decision that adds beside it.', '--adds']);
    yg(dir, ['log', 'add', '--node', 'services/orders', '--reason', 'A later reason that replaces the first.', '--supersedes', (JSON.parse(yg(dir, ['log', 'read', '--node', 'services/orders', '--json']).stdout) as { entries: Array<{ datetime: string }> }).entries[0].datetime]);
    yg(dir, ['log', 'add', '--aspect', 'no-todo-comments', '--reason', 'Why the rule exists.']);

    emitted(dir, ['check', '--json']);
    emitted(dir, ['check', '--approve', '--dry-run', '--json']);
    emitted(dir, ['check', '--approve', '--only-deterministic', '--json']);
    emitted(dir, ['check', '--json', '--compact']);
    emitted(dir, ['context', '--node', 'services/orders', '--json']);
    emitted(dir, ['context', '--file', 'src/services/orders.ts', '--json']);
    emitted(dir, ['context', '--file', 'README.md', '--json']);
    emitted(dir, ['impact', '--node', 'services/orders', '--json']);
    emitted(dir, ['impact', '--file', 'src/services/orders.ts', '--json']);
    emitted(dir, ['impact', '--aspect', 'no-todo-comments', '--json']);
    emitted(dir, ['impact', '--flow', 'order-processing', '--json']);
    emitted(dir, ['node', 'services/orders', '--json']);
    emitted(dir, ['aspects', '--json']);
    emitted(dir, ['aspects', '--health', '--json']);
    emitted(dir, ['advise', '--json']);
    emitted(dir, ['log', 'read', '--aspect', 'no-todo-comments', '--json']);
    emitted(dir, ['suppressions', '--json']);
    emitted(dir, ['drill', '--aspect', 'no-todo-comments', '--json']);
    emitted(dir, ['tree', '--json']);
    emitted(dir, ['owner', '--file', 'src/services/orders.ts', '--json']);
    emitted(dir, ['owner', '--files', 'src/services/orders.ts,README.md,src/no/such/file.ts', '--json']);
    emitted(dir, ['find', 'order', '--json']);
    emitted(dir, ['log', 'read', '--node', 'services/orders', '--json']);
    emitted(dir, ['log', 'read', '--type', 'service', '--json']);
    emitted(dir, ['log', 'read', '--type', 'service', '--all', '--json']);
    emitted(dir, ['log', 'read', '--node', 'services/orders', '--with-verdicts', '--json']);
    // Command errors.
    emitted(dir, ['context', '--node', 'no/such/node', '--json']);
    emitted(dir, ['node', 'no/such/node', '--json']);
    emitted(dir, ['log', 'read', '--aspect', 'no-such-rule', '--json']);
    expect(departures).toEqual([]);
  }, 300_000);

  it('a type-covered tree (type-coverage-basic)', () => {
    const dir = fixture('type-coverage-basic');
    emitted(dir, ['check', '--json']);
    emitted(dir, ['tree', '--json']);
    emitted(dir, ['context', '--file', 'src/svc/handler.ts', '--json']);
    emitted(dir, ['context', '--file', 'src/misc/plain.ts', '--json']);
    emitted(dir, ['context', '--file', 'vendor/tool.ts', '--json']);
    emitted(dir, ['owner', '--file', 'src/svc/handler.ts', '--json']);
    emitted(dir, ['impact', '--type', 'service', '--json']);
    expect(departures).toEqual([]);
  }, 300_000);

  it('a graph with ports (sample-project-ports)', () => {
    const dir = fixture('sample-project-ports');
    emitted(dir, ['check', '--json']);
    for (const node of ['services/orders', 'services/payments']) {
      emitted(dir, ['node', node, '--json']);
      emitted(dir, ['context', '--node', node, '--json']);
      emitted(dir, ['impact', '--node', node, '--json']);
    }
    expect(departures).toEqual([]);
  }, 300_000);

  it('a graph with a flow file that does not load', () => {
    const dir = fixture('e2e-lifecycle');
    writeFileSync(path.join(dir, '.yggdrasil', 'flows', 'order-processing', 'yg-flow.yaml'), 'name: X\nnodes: [services/orders]\nparticipant: []\n');
    emitted(dir, ['check', '--json']);
    expect(departures).toEqual([]);
  }, 300_000);

  it('the package documents: manifests as published, and the record and versions cache as written', () => {
    const market = path.join(FIXTURES, 'marketplace-demo');
    check('marketplace-demo/yg-marketplace.yaml', parseYaml(readFileSync(path.join(market, 'yg-marketplace.yaml'), 'utf-8')));
    check('marketplace-demo/packages/demo/yg-package.yaml', parseYaml(readFileSync(path.join(market, 'packages', 'demo', 'yg-package.yaml'), 'utf-8')));
    const dir = fixture('pack-consumer');
    expect(yg(dir, ['pack', 'add', `${market}#demo`, '--as', 'acme/law']).status).toBe(0);
    check('yg pack add → yg-packages.yaml', parseYaml(readFileSync(path.join(dir, '.yggdrasil', 'yg-packages.yaml'), 'utf-8')));
    yg(dir, ['pack', 'list']);
    const cache = path.join(dir, '.yggdrasil', '.yg-packages-versions.json');
    if (existsSync(cache)) check('yg pack list → .yg-packages-versions.json', JSON.parse(readFileSync(cache, 'utf-8')));
    expect(departures).toEqual([]);
  }, 300_000);

  it('covers every published schema', () => {
    const published = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.schema.json')).map((f) => f.replace(/-(\d+)\.schema\.json$/, '/$1'));
    // The versions cache is written only by a listing that reached a source;
    // a local marketplace directory is one, but a run without it is not a gap.
    const missing = published.filter((id) => !seen.has(id) && id !== 'yg-package-versions/1');
    expect(missing, 'a published schema no fixture emitted a document for').toEqual([]);
  });
});
