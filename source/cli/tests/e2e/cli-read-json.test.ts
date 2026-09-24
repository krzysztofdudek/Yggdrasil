/**
 * The read commands answer in JSON as well as text (`yg tree`, `yg owner`,
 * `yg find`, `yg log read` take `--json`), a failed command answering in JSON
 * writes a `yg-error/1` document to stdout besides its text on stderr, and
 * `yg tree` prints one line per node by default (first sentence of the
 * description), the whole description under `--long`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.join(__dirname, '..', '..', 'dist', 'bin.js');

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1' } });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content, 'utf-8');
}

const LONG = 'Handles the orders of the shop. It owns the order table and nothing else. A third sentence that makes the whole description run well past one line when it is printed whole.';

describe.skipIf(!existsSync(BIN_PATH))('read commands in JSON, errors as yg-error/1, the one-line tree', () => {
  let dir = '';
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'yg-read-json-')));
    write(dir, '.yggdrasil/yg-config.yaml', 'version: "6.0.0"\n');
    write(dir, '.yggdrasil/yg-architecture.yaml', "node_types:\n  service:\n    description: 'A service.'\n    when:\n      path: \"src/**\"\n");
    write(dir, '.yggdrasil/model/orders/yg-node.yaml', `name: Orders\ntype: service\ndescription: "${LONG}"\nmapping:\n  - src/orders/\n`);
    write(dir, '.yggdrasil/model/orders/log.md', '## [2026-09-01T00:00:00.000Z]\nWhy the orders service exists.\n');
    write(dir, 'src/orders/index.ts', 'export const orders = 1;\n');
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('yg tree prints the first sentence by default and the whole description under --long', () => {
    const short = run(['tree'], dir);
    expect(short.status).toBe(0);
    expect(short.stdout).toContain('orders [service] — Handles the orders of the shop.\n');
    expect(short.stdout).not.toContain('A third sentence');
    expect(run(['tree', '--long'], dir).stdout).toContain(LONG);
  });

  it('yg tree --json is a yg-tree/1 document with whole descriptions', () => {
    const doc = JSON.parse(run(['tree', '--json'], dir).stdout);
    expect(doc.schema).toBe('yg-tree/1');
    expect(doc.nodes).toEqual([{ path: 'orders', type: 'service', description: LONG, parent: null, depth: 0 }]);
  });

  it('yg owner --json is a yg-owner/1 document', () => {
    const doc = JSON.parse(run(['owner', '--file', 'src/orders/index.ts', '--json'], dir).stdout);
    expect(doc).toMatchObject({ schema: 'yg-owner/1', file: 'src/orders/index.ts', kind: 'node', node: 'orders', direct: false, next: 'yg context --node orders' });
    // The file is owned through its node's directory mapping, not a mapping naming it.
    expect(typeof doc.mappingPath).toBe('string');
    const missing = JSON.parse(run(['owner', '--file', 'src/nope.ts', '--json'], dir).stdout);
    expect(missing).toMatchObject({ kind: 'missing', node: null });
  });

  it('yg find --json is a yg-find/1 document', () => {
    const doc = JSON.parse(run(['find', 'orders', '--json'], dir).stdout);
    expect(doc.schema).toBe('yg-find/1');
    expect(doc.results[0]).toMatchObject({ kind: 'node', id: 'orders', score: 1, next: 'yg context --node orders' });
  });

  it('yg log read --json is a yg-log/1 document', () => {
    const doc = JSON.parse(run(['log', 'read', '--node', 'orders', '--json'], dir).stdout);
    expect(doc).toEqual({ schema: 'yg-log/1', node: 'orders', entries: [{ datetime: '2026-09-01T00:00:00.000Z', body: 'Why the orders service exists.\n' }] });
  });

  it('a failed command answering in JSON writes yg-error/1 to stdout and its text to stderr', () => {
    const r = run(['node', 'nope', '--json'], dir);
    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ schema: 'yg-error/1', code: 'node-not-found' });
    expect(doc.what).toContain("'nope'");
    expect(r.stderr).toContain("error[node-not-found]: ");
    expect(r.stderr).toContain("'nope'");

    const uninit = realpathSync(mkdtempSync(path.join(tmpdir(), 'yg-read-json-empty-')));
    try {
      const u = run(['check', '--json'], uninit);
      expect(u.status).toBe(1);
      expect(JSON.parse(u.stdout)).toMatchObject({ schema: 'yg-error/1', code: 'graph-missing' });
    } finally {
      rmSync(uninit, { recursive: true, force: true });
    }
  });

  it('yg context --node <missing> --json answers yg-error/1 with code node-not-found, like yg node and yg impact', () => {
    const r = run(['context', '--node', 'nope', '--json'], dir);
    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ schema: 'yg-error/1', code: 'node-not-found' });
    expect(doc.what).toContain("'nope'");
    const impact = JSON.parse(run(['impact', '--node', 'nope', '--json'], dir).stdout);
    expect(impact.code).toBe('node-not-found');
  });

  it('without --json a failed command writes nothing to stdout', () => {
    const r = run(['node', 'nope'], dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });
});
