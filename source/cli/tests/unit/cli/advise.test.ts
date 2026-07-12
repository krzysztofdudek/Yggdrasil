import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAdviseCommand } from '../../../src/cli/advise.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');
const distExists = existsSync(BIN_PATH);

// The always-live nomination the fixture is rigged to produce (a far-past
// review_by injected onto an existing aspect).
const LIVE_ID = 'overdue-review-by:requires-logging';
const HEX64 = /^[0-9a-f]{64}$/;

function run(args: string[], cwd: string) {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

function readRegister(projectRoot: string): string[] {
  const p = path.join(projectRoot, '.yggdrasil', 'advise-decisions.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').split('\n').filter((l) => l.length > 0);
}

describe('registerAdviseCommand', () => {
  it('registers `yg advise` with dismiss and defer subcommands', () => {
    const program = new Command();
    registerAdviseCommand(program);
    const advise = program.commands.find((c) => c.name() === 'advise');
    expect(advise).toBeDefined();
    const subs = (advise!.commands ?? []).map((c) => c.name()).sort();
    expect(subs).toEqual(['defer', 'dismiss']);
  });
});

describe.skipIf(!distExists)('yg advise dismiss / defer (spawned)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-advise-e2e-'));
    cpSync(FIXTURE, projectRoot, { recursive: true });
    appendFileSync(
      path.join(projectRoot, '.yggdrasil', 'aspects', 'requires-logging', 'yg-aspect.yaml'),
      '\nreview_by: 2020-01-01\n',
      'utf-8',
    );
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('dismiss <id> --reason appends exactly one line bound to the current evidence hash', () => {
    const { status } = run(['advise', 'dismiss', LIVE_ID, '--reason', 'reviewed, keeping'], projectRoot);
    expect(status).toBe(0);

    const lines = readRegister(projectRoot);
    expect(lines).toHaveLength(1);
    const decision = JSON.parse(lines[0]);
    expect(decision.id).toBe(LIVE_ID);
    expect(decision.action).toBe('dismiss');
    expect(decision.reason).toBe('reviewed, keeping');
    expect(decision.evidenceHash).toMatch(HEX64);
    expect(decision.v).toBe(1);
  });

  it('defer <id> --until <date> --reason appends a defer line with the until date', () => {
    const { status } = run(
      ['advise', 'defer', LIVE_ID, '--until', '2030-01-01', '--reason', 'revisit next quarter'],
      projectRoot,
    );
    expect(status).toBe(0);

    const lines = readRegister(projectRoot);
    expect(lines).toHaveLength(1);
    const decision = JSON.parse(lines[0]);
    expect(decision.action).toBe('defer');
    expect(decision.until).toBe('2030-01-01');
    expect(decision.reason).toBe('revisit next quarter');
  });

  it('defer with a mis-shaped --until is rejected and writes nothing', () => {
    const { status } = run(
      ['advise', 'defer', LIVE_ID, '--until', '2030-13-40', '--reason', 'bad date'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(readRegister(projectRoot)).toHaveLength(0);
  });

  it('dismiss with an empty --reason is rejected and writes nothing', () => {
    const { status } = run(['advise', 'dismiss', LIVE_ID, '--reason', ''], projectRoot);
    expect(status).toBe(1);
    expect(readRegister(projectRoot)).toHaveLength(0);
  });

  it('dismiss of an unknown id is rejected, names the known ids, and writes nothing', () => {
    const { status, stderr } = run(
      ['advise', 'dismiss', 'overdue-review-by:does-not-exist', '--reason', 'x'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toContain(LIVE_ID);
    expect(readRegister(projectRoot)).toHaveLength(0);
  });
});
