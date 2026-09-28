/**
 * The refused-content store (io/refused-store.ts) wired into the fill writer:
 * every refusal a fill records keeps the refused subject files and the reason in
 * `.yggdrasil/.refused/<hash>.json`, named for the verdict's own input hash, so a
 * reader joins it to the lock entry and the events line. Keyless: deterministic
 * rules only. Issue 397.
 */

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runFill } from '../../../src/core/fill.js';
import { readLock } from '../../../src/io/lock-store.js';
import { EVENTS_FILENAME } from '../../../src/io/events-store.js';
import { REFUSED_DIRNAME, storeRefusedContent, type RefusedRecord } from '../../../src/io/refused-store.js';

const DET_PASS = 'export function check(ctx) { void ctx; return []; }\n';
const DET_FAIL =
  'export function check(ctx) { return /TODO/.test(ctx.files[0]?.content ?? "") ? [{ message: "no TODO", file: "src/svc.ts", line: 1 }] : []; }\n';

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function setupProject(opts: { ignored: boolean; source: string; failRuleExtra?: string }): Promise<{ projectRoot: string; yggRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-refused-store-'));
  roots.push(root);
  const yggRoot = path.join(root, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', 'svc');
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "6.0.0"\n');
  await writeFile(path.join(yggRoot, 'yg-architecture.yaml'), 'node_types:\n  service:\n    description: s\n');
  if (opts.ignored) await writeFile(path.join(yggRoot, '.gitignore'), '.refused/\n');
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    'name: svc\ntype: service\ndescription: x\nmapping:\n  - src/svc.ts\naspects:\n  - det-pass\n  - det-fail\n',
  );
  await writeFile(path.join(root, 'src', 'svc.ts'), opts.source);
  for (const [id, rule] of [['det-pass', DET_PASS], ['det-fail', DET_FAIL]] as const) {
    const aspDir = path.join(yggRoot, 'aspects', id);
    await mkdir(aspDir, { recursive: true });
    await writeFile(path.join(aspDir, 'yg-aspect.yaml'), `name: ${id}\ndescription: ${id} rule\nreviewer:\n  type: deterministic\nstatus: enforced\n${id === 'det-fail' ? (opts.failRuleExtra ?? '') : ''}`);
    await writeFile(path.join(aspDir, 'check.mjs'), rule);
  }
  return { projectRoot: root, yggRoot };
}

async function fill(projectRoot: string): Promise<void> {
  const graph = await loadGraph(projectRoot);
  await runFill(graph, { isTTY: false, now: Date.now, coverageVisibleFiles: null, write: () => {} });
}

function records(yggRoot: string): RefusedRecord[] {
  const dir = path.join(yggRoot, REFUSED_DIRNAME);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf-8')) as RefusedRecord);
}

describe('refused-content store, through a fill', () => {
  it('a refusal keeps the refused bytes and the reason under the verdict hash, which the lock entry and the events line carry too', async () => {
    const { projectRoot, yggRoot } = await setupProject({ ignored: true, source: 'export const x = 1; // TODO\n' });
    await fill(projectRoot);

    const refused = readLock(yggRoot).verdicts['det-fail']['node:svc'];
    expect(refused.verdict).toBe('refused');
    const stored = records(yggRoot);
    // One record: the approval of det-pass stores nothing.
    expect(stored).toHaveLength(1);
    const [rec] = stored;
    expect(existsSync(path.join(yggRoot, REFUSED_DIRNAME, `${refused.hash}.json`))).toBe(true);
    expect(rec).toMatchObject({ v: 1, hash: refused.hash, aspectId: 'det-fail', unitKey: 'node:svc', kind: 'deterministic', reason: refused.reason });
    expect(rec.files).toEqual([{ path: 'src/svc.ts', content: 'export const x = 1; // TODO\n' }]);
    // The join key: the events line of the refusal names the same hash.
    const events = readFileSync(path.join(yggRoot, EVENTS_FILENAME), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as { disposition: string; hash?: string });
    expect(events.find((e) => e.disposition === 'refused')?.hash).toBe(refused.hash);
  });

  it('the fix that follows is the other half of the pair: the approval adds no record and the refused one stays', async () => {
    const { projectRoot, yggRoot } = await setupProject({ ignored: true, source: 'export const x = 1; // TODO\n' });
    await fill(projectRoot);
    const refusedHash = readLock(yggRoot).verdicts['det-fail']['node:svc'].hash;
    writeFileSync(path.join(projectRoot, 'src', 'svc.ts'), 'export const x = 1;\n');
    await fill(projectRoot);
    expect(readLock(yggRoot).verdicts['det-fail']['node:svc'].verdict).toBe('approved');
    expect(records(yggRoot).map((r) => r.hash)).toEqual([refusedHash]);
  });

  it('keeps only the hash and the reason for a rule marked stores_content: false — no copy of the refused file', async () => {
    const secret = 'export const key = "sk-live-TODO-0123456789";\n';
    const { projectRoot, yggRoot } = await setupProject({ ignored: true, source: secret, failRuleExtra: 'stores_content: false\n' });
    await fill(projectRoot);
    const refused = readLock(yggRoot).verdicts['det-fail']['node:svc'];
    expect(refused.verdict).toBe('refused');
    const [rec] = records(yggRoot);
    expect(rec).toMatchObject({ v: 1, hash: refused.hash, aspectId: 'det-fail', reason: refused.reason, contentWithheld: true });
    expect(rec.files).toEqual([]);
    const raw = readFileSync(path.join(yggRoot, REFUSED_DIRNAME, `${refused.hash}.json`), 'utf-8');
    expect(raw).not.toContain('sk-live');
    expect(raw).not.toContain(Buffer.from(secret).toString('base64'));
  });

  it('writes nothing where the store is not gitignored — a fill never edits a tracked .gitignore', async () => {
    const { projectRoot, yggRoot } = await setupProject({ ignored: false, source: 'export const x = 1; // TODO\n' });
    await fill(projectRoot);
    expect(readLock(yggRoot).verdicts['det-fail']['node:svc'].verdict).toBe('refused');
    expect(existsSync(path.join(yggRoot, REFUSED_DIRNAME))).toBe(false);
    expect(existsSync(path.join(yggRoot, '.gitignore'))).toBe(false);
  });
});

describe('storeRefusedContent', () => {
  const HASH = 'a'.repeat(64);
  const base = { hash: HASH, ts: '2026-09-28T00:00:00.000Z', aspectId: 'r', unitKey: 'node:n', kind: 'llm' as const, reason: 'no' };

  async function tmpProject(): Promise<{ projectRoot: string; yggRoot: string }> {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'yg-refused-unit-'));
    roots.push(projectRoot);
    const yggRoot = path.join(projectRoot, '.yggdrasil');
    await mkdir(yggRoot, { recursive: true });
    return { projectRoot, yggRoot };
  }

  it('keeps bytes that are not UTF-8 as base64, and leaves a record already present alone', async () => {
    const { projectRoot, yggRoot } = await tmpProject();
    await writeFile(path.join(projectRoot, 'bin.dat'), Buffer.from([0xff, 0x00, 0xfe]));
    await writeFile(path.join(projectRoot, 'a.ts'), 'x\n');
    expect(storeRefusedContent(yggRoot, projectRoot, { ...base, subjectFiles: ['bin.dat', 'a.ts'] }, true)).toBe(true);
    const rec = JSON.parse(readFileSync(path.join(yggRoot, REFUSED_DIRNAME, `${HASH}.json`), 'utf-8')) as RefusedRecord;
    expect(rec.files).toEqual([{ path: 'a.ts', content: 'x\n' }, { path: 'bin.dat', base64: Buffer.from([0xff, 0x00, 0xfe]).toString('base64') }]);
    expect(storeRefusedContent(yggRoot, projectRoot, { ...base, reason: 'other', subjectFiles: ['a.ts'] }, true)).toBe(false);
  });

  it('stores nothing when disabled, for a malformed hash, or past the size cap', async () => {
    const { projectRoot, yggRoot } = await tmpProject();
    // One byte over the store's two-mebibyte cap.
    await writeFile(path.join(projectRoot, 'big.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
    expect(storeRefusedContent(yggRoot, projectRoot, { ...base, subjectFiles: [] }, false)).toBe(false);
    expect(storeRefusedContent(yggRoot, projectRoot, { ...base, hash: '../x', subjectFiles: [] }, true)).toBe(false);
    expect(storeRefusedContent(yggRoot, projectRoot, { ...base, subjectFiles: ['big.txt'] }, true)).toBe(false);
    expect(existsSync(path.join(yggRoot, REFUSED_DIRNAME))).toBe(false);
  });

  it('records the commit when one is given, names a deleted subject with empty content, and a write that fails returns false', async () => {
    const { projectRoot, yggRoot } = await tmpProject();
    expect(storeRefusedContent(yggRoot, projectRoot, { ...base, sha: 'abc123', unitKey: 'file:src\\gone.ts', subjectFiles: ['src\\gone.ts'] }, true)).toBe(true);
    const rec = JSON.parse(readFileSync(path.join(yggRoot, REFUSED_DIRNAME, `${HASH}.json`), 'utf-8')) as RefusedRecord;
    expect(rec.sha).toBe('abc123');
    expect(rec.unitKey).toBe('file:src/gone.ts');
    expect(rec.files).toEqual([{ path: 'src/gone.ts', content: '' }]);
    // The store's directory cannot be made where a file already sits: best-effort, no throw.
    const blocked = path.join(projectRoot, 'blocked-ygg');
    writeFileSync(blocked, 'not a directory');
    expect(storeRefusedContent(path.join(blocked, 'inner'), projectRoot, { ...base, subjectFiles: [] }, true)).toBe(false);
  });
});
