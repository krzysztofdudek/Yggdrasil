import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGitFixture } from '../support/git-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

// ---------------------------------------------------------------------------
// HERMETICITY
//
// `yg log read` loads the graph and reads log.md + the local events sidecar — it
// never contacts a reviewer, reads no wall clock, and dials no network. Every
// timestamp asserted on is a FIXED far-future literal seeded into log.md and the
// synthetic .yg-events.jsonl, so ordering is invariant across runs. Each test
// works inside a fresh mkdtemp copy of the committed fixture and removes it in a
// finally block; the committed fixture bytes are never mutated.
// ---------------------------------------------------------------------------

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-logwv-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

const ordersLog = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'log.md');
const eventsFile = (dir: string) => path.join(dir, '.yggdrasil', '.yg-events.jsonl');

const j = (o: Record<string, unknown>): string => JSON.stringify(o);

describe.skipIf(!distExists)('CLI E2E — yg log read --with-verdicts (interleaved log + telemetry)', () => {
  it('interleaves the log entry with only the matching fill events, newest first, under a local-telemetry header', () => {
    const dir = copyFixture('interleave');
    try {
      // One log entry at a fixed far-future instant.
      writeFileSync(
        ordersLog(dir),
        '## [2027-01-01T12:00:00.000Z]\nOrders log body marker LOGBODY.\n',
        'utf-8',
      );

      // Synthetic sidecar: 2 matching fill events (node: + file: under mapping),
      // 1 event for another node, 1 drill event (wrong source). Only the two
      // matching fill events must render.
      const lines = [
        j({
          v: 1,
          ts: '2027-01-01T00:00:00.000Z',
          source: 'fill',
          aspectId: 'ASPECT-NODE',
          unitKey: 'node:services/orders',
          kind: 'deterministic',
          disposition: 'approved',
          hash: 'h1',
        }),
        j({
          v: 1,
          ts: '2027-01-02T00:00:00.000Z',
          source: 'fill',
          aspectId: 'ASPECT-FILE',
          unitKey: 'file:src/services/orders.ts',
          kind: 'llm',
          disposition: 'refused',
          hash: 'h2',
          reason: 'some reason',
          tier: 'default',
        }),
        j({
          v: 1,
          ts: '2027-01-01T06:00:00.000Z',
          source: 'fill',
          aspectId: 'ASPECT-PAYMENTS',
          unitKey: 'node:services/payments',
          kind: 'deterministic',
          disposition: 'approved',
          hash: 'h3',
        }),
        j({
          v: 1,
          ts: '2027-01-01T18:00:00.000Z',
          source: 'drill',
          aspectId: 'ASPECT-DRILL',
          unitKey: 'node:services/orders',
          kind: 'llm',
          disposition: 'approved',
          hash: 'h4',
        }),
      ];
      writeFileSync(eventsFile(dir), lines.join('\n') + '\n', 'utf-8');

      const { stdout, status } = run(
        ['log', 'read', '--node', 'services/orders', '--with-verdicts'],
        dir,
      );

      expect(status).toBe(0);
      // Honest local-telemetry header spanning the whole sidecar (earliest ts).
      expect(stdout).toContain('local telemetry since 2027-01-01T00:00:00.000Z');
      // Both matching fill events render.
      expect(stdout).toContain('ASPECT-NODE');
      expect(stdout).toContain('ASPECT-FILE');
      // The log entry body renders.
      expect(stdout).toContain('LOGBODY');
      // The other node's event and the drill event are excluded.
      expect(stdout).not.toContain('ASPECT-PAYMENTS');
      expect(stdout).not.toContain('ASPECT-DRILL');

      // Newest-first interleave: file event (2027-01-02) > log (12:00) > node event (00:00).
      const idxFile = stdout.indexOf('ASPECT-FILE');
      const idxLog = stdout.indexOf('LOGBODY');
      const idxNode = stdout.indexOf('ASPECT-NODE');
      expect(idxFile).toBeGreaterThanOrEqual(0);
      expect(idxLog).toBeGreaterThan(idxFile);
      expect(idxNode).toBeGreaterThan(idxLog);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses the "local telemetry" wording when the events sidecar is git-tracked, and says so plainly', () => {
    const dir = copyFixture('git-tracked');
    try {
      // One log entry + one matching fill event, fixed far-future instants.
      writeFileSync(
        ordersLog(dir),
        '## [2027-01-01T12:00:00.000Z]\nOrders log body marker LOGBODY.\n',
        'utf-8',
      );
      writeFileSync(
        eventsFile(dir),
        j({
          v: 1,
          ts: '2027-01-01T00:00:00.000Z',
          source: 'fill',
          aspectId: 'ASPECT-NODE',
          unitKey: 'node:services/orders',
          kind: 'deterministic',
          disposition: 'approved',
          hash: 'h1',
        }) + '\n',
        'utf-8',
      );

      // Put the sidecar under git — the dishonest state the label must call out.
      // A fresh, independent repo in the temp dir (never the Yggdrasil repo); `-f`
      // because the sidecar is normally gitignored, so it can only be tracked by force.
      const init = runGitFixture(dir, ['init']);
      expect(init.status).toBe(0);
      const add = runGitFixture(dir, ['add', '-f', '.yggdrasil/.yg-events.jsonl']);
      expect(add.status).toBe(0);

      const { stdout, status } = run(
        ['log', 'read', '--node', 'services/orders', '--with-verdicts'],
        dir,
      );

      expect(status).toBe(0);
      // The header must NOT claim "local" telemetry — a tracked sidecar is shared.
      expect(stdout).not.toContain('local telemetry since');
      // Instead it states plainly that the sidecar is git-tracked (shared history).
      expect(stdout).toContain('the events sidecar is git-tracked');
      expect(stdout).toContain('shared history, not local-only telemetry');
      // It still reports the telemetry window and interleaves the event + log entry.
      expect(stdout).toContain('verification telemetry since 2027-01-01T00:00:00.000Z');
      expect(stdout).toContain('ASPECT-NODE');
      expect(stdout).toContain('LOGBODY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves plain `yg log read` (no flag) output unchanged — no telemetry header', () => {
    const dir = copyFixture('plain');
    try {
      writeFileSync(
        ordersLog(dir),
        '## [2027-01-01T12:00:00.000Z]\nOrders log body marker LOGBODY.\n',
        'utf-8',
      );
      writeFileSync(
        eventsFile(dir),
        j({
          v: 1,
          ts: '2027-01-01T00:00:00.000Z',
          source: 'fill',
          aspectId: 'ASPECT-NODE',
          unitKey: 'node:services/orders',
          kind: 'deterministic',
          disposition: 'approved',
          hash: 'h1',
        }) + '\n',
        'utf-8',
      );

      const { stdout, status } = run(['log', 'read', '--node', 'services/orders'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('LOGBODY');
      expect(stdout).not.toContain('local telemetry since');
      expect(stdout).not.toContain('ASPECT-NODE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
