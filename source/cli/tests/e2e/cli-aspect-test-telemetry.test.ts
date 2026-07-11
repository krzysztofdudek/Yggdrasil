// =============================================================================
// `yg aspect-test` diagnostic telemetry (source:'diag') end-to-end over the
// PUBLIC CLI surface (spawned bin.js) against the in-process mock reviewer.
// Covers:
//   (1) --repeat N: consensus forced to 1 per run, N runs → EXACTLY N
//       source:'diag' event lines for the unit, each kind:'llm', votes.total:1,
//       carrying tier + judge. (This closes the "--repeat emits zero" gap.)
//   (2) --tier <known>: the same pairs re-run under a NAMED tier from the merged
//       config (overriding the aspect's default), emitting a diag line tagged
//       with THAT tier + its resolved judge. The lock is NEVER written.
//   (3) --tier <unknown>: the verbatim what/why/next error, nonzero exit, no call.
//   (4) --tier rejected with --files and on a deterministic aspect (mirrors
//       --repeat's guards).
//   (5) --tier + --repeat combine: N runs, all under the chosen tier.
//
// HERMETIC: a fresh mkdtemp copy of e2e-lifecycle per test, rmSync'd in finally.
// Ephemeral loopback port for the mock, no fixed ports.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync } from './support/mock-reviewer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const cfgPath = (d: string) => path.join(d, '.yggdrasil', 'yg-config.yaml');
const eventsPath = (d: string) => path.join(d, '.yggdrasil', '.yg-events.jsonl');
const lockPath = (d: string) => path.join(d, '.yggdrasil', 'yg-lock.nondeterministic.json');

const ASPECT = 'has-doc-comment'; // LLM aspect, default on type `service`
const NODE = 'services/payments'; // type service, maps one file → one LLM pair
const UNIT = 'node:services/payments';
const STANDARD_MODEL = 'qwen2.5-coder:0.5b';
const PROBE_MODEL = 'probe-model:1b';

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-atest-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** Two ollama tiers (`standard` default + `probe`), both pointed at the mock. */
function writeTwoTierConfig(dir: string, endpoint: string): void {
  writeFileSync(
    cfgPath(dir),
    [
      'version: "5.1.0"',
      '',
      'quality:',
      '  max_direct_relations: 10',
      '',
      'reviewer:',
      '  default: standard',
      '  tiers:',
      '    standard:',
      '      provider: ollama',
      '      consensus: 1',
      '      config:',
      `        model: "${STANDARD_MODEL}"`,
      `        endpoint: "${endpoint}"`,
      '    probe:',
      '      provider: ollama',
      '      consensus: 1',
      '      config:',
      `        model: "${PROBE_MODEL}"`,
      `        endpoint: "${endpoint}"`,
      '',
    ].join('\n'),
    'utf-8',
  );
}

function diagLines(dir: string): Record<string, unknown>[] {
  const p = eventsPath(dir);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.source === 'diag');
}

describe.skipIf(!distExists)('CLI E2E — yg aspect-test diagnostic telemetry', () => {
  it('(1) --repeat 3 emits EXACTLY 3 source:diag lines (kind llm, votes.total 1, tier+judge)', async () => {
    const dir = copyFixture('repeat');
    const mock = await startMockReviewer(); // default: always satisfied
    try {
      writeTwoTierConfig(dir, mock.endpoint);
      const lockBefore = existsSync(lockPath(dir)) ? readFileSync(lockPath(dir), 'utf-8') : '';

      const r = await runAsync(['aspect-test', '--aspect', ASPECT, '--node', NODE, '--repeat', '3'], dir);
      expect(r.status).toBe(0);
      // Three reviewer calls were actually made (consensus forced to 1 × 3 runs).
      expect(mock.chatCount()).toBe(3);

      const events = diagLines(dir).filter((e) => e.unitKey === UNIT);
      expect(events).toHaveLength(3);
      for (const e of events) {
        expect(e.kind).toBe('llm');
        expect(e.disposition).toBe('approved');
        expect(e.tier).toBe('standard');
        expect(e.promptRev).toBe(1);
        expect(e.votes).toEqual({ satisfied: 1, total: 1 });
        expect(e.judge).toEqual({ provider: 'ollama', model: STANDARD_MODEL });
      }

      // The lock was NEVER written by the diagnostic.
      const lockAfter = existsSync(lockPath(dir)) ? readFileSync(lockPath(dir), 'utf-8') : '';
      expect(lockAfter).toBe(lockBefore);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(1b) a BARE run (no --repeat, no --tier) emits exactly ONE diag line for the unit', async () => {
    const dir = copyFixture('bare');
    const mock = await startMockReviewer(); // default: always satisfied
    try {
      writeTwoTierConfig(dir, mock.endpoint);

      const r = await runAsync(['aspect-test', '--aspect', ASPECT, '--node', NODE], dir);
      expect(r.status).toBe(0);
      // One reviewer call for the single pair; one telemetry line under the default tier.
      expect(mock.chatCount()).toBe(1);

      const events = diagLines(dir).filter((e) => e.unitKey === UNIT);
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('llm');
      expect(events[0].disposition).toBe('approved');
      expect(events[0].tier).toBe('standard');
      expect(events[0].votes).toEqual({ satisfied: 1, total: 1 });
      expect(events[0].judge).toEqual({ provider: 'ollama', model: STANDARD_MODEL });
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(2) --tier <known> runs under the named tier and emits a diag line tagged with it', async () => {
    const dir = copyFixture('tier');
    const mock = await startMockReviewer();
    try {
      writeTwoTierConfig(dir, mock.endpoint);

      const r = await runAsync(['aspect-test', '--aspect', ASPECT, '--node', NODE, '--tier', 'probe'], dir);
      expect(r.status).toBe(0);
      expect(mock.chatCount()).toBe(1);
      // The model actually sent to the reviewer is the probe tier's model.
      expect(mock.chatRequests[0].model).toBe(PROBE_MODEL);

      const events = diagLines(dir).filter((e) => e.unitKey === UNIT);
      expect(events).toHaveLength(1);
      expect(events[0].tier).toBe('probe');
      expect(events[0].disposition).toBe('approved');
      expect(events[0].judge).toEqual({ provider: 'ollama', model: PROBE_MODEL });
      expect(events[0].votes).toEqual({ satisfied: 1, total: 1 });
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(3) --tier <unknown> errors with the verbatim what/why/next, exit 1, no reviewer call', async () => {
    const dir = copyFixture('unknown');
    const mock = await startMockReviewer();
    try {
      writeTwoTierConfig(dir, mock.endpoint);

      const r = await runAsync(['aspect-test', '--aspect', ASPECT, '--node', NODE, '--tier', 'nope'], dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`Tier 'nope' is not defined in .yggdrasil/yg-config.yaml.`);
      expect(r.stderr).toContain(
        `--tier re-runs the same pairs under a named reviewer tier from the merged config (yg-secrets included); an unknown tier has no provider or model to call.`,
      );
      expect(r.stderr).toContain('Use one of: standard, probe, or add the tier to yg-config.yaml (or yg-secrets).');
      // The tier failed to resolve BEFORE any reviewer call, and nothing was emitted.
      expect(mock.chatCount()).toBe(0);
      expect(diagLines(dir)).toHaveLength(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(4) --tier is rejected with --files and on a deterministic aspect', async () => {
    const dir = copyFixture('reject');
    try {
      const withFiles = await runAsync(
        ['aspect-test', '--aspect', ASPECT, '--files', 'src/services/payments.ts', '--tier', 'standard'],
        dir,
      );
      expect(withFiles.status).toBe(1);
      expect(withFiles.stderr).toContain('--tier cannot be combined with --files.');

      const onDet = await runAsync(
        ['aspect-test', '--aspect', 'no-todo-comments', '--node', NODE, '--tier', 'standard'],
        dir,
      );
      expect(onDet.status).toBe(1);
      expect(onDet.stderr).toContain("--tier is not supported for deterministic aspect 'no-todo-comments'.");

      // No telemetry from a rejected invocation.
      expect(diagLines(dir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(5) --tier + --repeat combine: N runs, all emitted under the chosen tier', async () => {
    const dir = copyFixture('combo');
    const mock = await startMockReviewer();
    try {
      writeTwoTierConfig(dir, mock.endpoint);

      const r = await runAsync(
        ['aspect-test', '--aspect', ASPECT, '--node', NODE, '--tier', 'probe', '--repeat', '2'],
        dir,
      );
      expect(r.status).toBe(0);
      expect(mock.chatCount()).toBe(2);

      const events = diagLines(dir).filter((e) => e.unitKey === UNIT);
      expect(events).toHaveLength(2);
      for (const e of events) {
        expect(e.tier).toBe('probe');
        expect(e.votes).toEqual({ satisfied: 1, total: 1 });
        expect(e.judge).toEqual({ provider: 'ollama', model: PROBE_MODEL });
      }
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
