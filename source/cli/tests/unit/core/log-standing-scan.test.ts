// What every log of a graph holds in force, read once for the attention feed:
// entries replaced by two entries in force (in component, type and rule logs),
// and what each type's nodes read from the type decision logs. Exercised on the
// real loader over the lifecycle fixture, with logs written as files.

import { describe, it, expect, afterEach } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { scanLogStanding } from '../../../src/core/log/log-standing-scan.js';
import { FIXTURE_RM_OPTIONS } from '../../support/git-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'e2e-lifecycle');

const A = '2026-09-01T10:00:00.000Z';
const B = '2026-09-02T10:00:00.000Z';
const C = '2026-09-03T10:00:00.000Z';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, FIXTURE_RM_OPTIONS);
});

function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-log-standing-'));
  dirs.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function entry(datetime: string, text: string, supersedes?: string): string {
  return `## [${datetime}]\n${supersedes !== undefined ? `### Supersedes: ${supersedes}\n\n` : ''}${text}\n`;
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, '.yggdrasil', rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

const CLASH = entry(A, 'First.') + entry(B, 'Second.', A) + entry(C, 'Third.', A);

describe('scanLogStanding', () => {
  it('finds a clash in a component, a type and a rule log, each with the flag that names the log', async () => {
    const dir = project();
    write(dir, 'model/services/orders/log.md', CLASH);
    write(dir, 'types/service/log.md', CLASH);
    write(dir, 'aspects/no-todo-comments/log.md', CLASH);
    const scan = await scanLogStanding(await loadGraph(dir));
    expect(scan.clashes.map((c) => c.flag).sort()).toEqual(['--aspect no-todo-comments', '--node services/orders', '--type service']);
    for (const c of scan.clashes) {
      expect(c.target).toBe(A);
      expect(c.successors).toEqual([B, C]);
    }
    expect(scan.clashes.find((c) => c.flag === '--node services/orders')?.logRel).toBe('.yggdrasil/model/services/orders/log.md');
  });

  it('skips a log with conflict markers or a broken format instead of guessing', async () => {
    const dir = project();
    write(dir, 'model/services/orders/log.md', `<<<<<<< ours\n${CLASH}=======\n>>>>>>> theirs\n`);
    write(dir, 'types/service/log.md', 'no header at all\n');
    const scan = await scanLogStanding(await loadGraph(dir));
    expect(scan.clashes).toEqual([]);
    expect(scan.typeLoads).toEqual([]);
  });

  it('gives a load only to a type with decisions of its own, counting the types above it and not the replaced ones', async () => {
    const dir = project();
    write(dir, 'types/module/log.md', entry(A, 'Modules own their data.'));
    write(dir, 'types/service/log.md', entry(B, 'Services talk over HTTP.') + entry(C, 'Services talk over the queue.', B));
    const { typeLoads } = await scanLogStanding(await loadGraph(dir));
    const service = typeLoads.find((l) => l.typeId === 'service');
    expect(service?.shares.map((s) => [s.typeId, s.datetimes])).toEqual([['service', [C]], ['module', [A]]]);
    expect(service?.shares[0].chars).toBe(`## [${C}]\n### Supersedes: ${B}\n\nServices talk over the queue.\n`.length);
    expect(typeLoads.find((l) => l.typeId === 'module')?.shares.map((s) => s.typeId)).toEqual(['module']);
  });

  it('gives no load to a type whose only log is empty', async () => {
    const dir = project();
    write(dir, 'types/service/log.md', '');
    expect((await scanLogStanding(await loadGraph(dir))).typeLoads).toEqual([]);
  });
});
