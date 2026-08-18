import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { buildFileContextData } from '../../../src/core/context-builder.js';
import { composeBriefExtras } from '../../../src/cli/build-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');
const distExists = existsSync(BIN_PATH);

// The one file orders/order-service maps, read off its own `mapping:` rather
// than guessed (the fixture maps several other files to other nodes): the assertions below are
// about the SHAPE of the compact view, and a wrong path would fail them for the
// wrong reason.
const OWNED_FILE = 'src/orders/order.service.ts';
const BASELINE = path.join(CLI_ROOT, 'tests', 'fixtures', 'context-baselines', 'sample-project-order-service.txt');

// A file covered only by architecture-type matching (no owning component) —
// same fixture and path as context-file-type-coverage.test.ts's "Matched
// type: leaf" case — used to pin the compact view's type-covered owner head.
const TYPE_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine');
const TYPE_COVERED_FILE = 'src/leaf/a.ts';

function copyFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-context-brief-'));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function copyTypeFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-context-brief-typecov-'));
  cpSync(TYPE_FIXTURE, dir, { recursive: true });
  return dir;
}

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

describe('composeBriefExtras — trail pointers', () => {
  it('offers the owner log and the parent node, in that order', async () => {
    const graph = await loadGraph(FIXTURE);
    const data = buildFileContextData(graph, OWNED_FILE, 'orders/order-service');
    const extras = await composeBriefExtras(graph, OWNED_FILE, data);
    expect(extras.nextPointers[0]).toBe('next: yg log read --node orders/order-service');
    expect(extras.nextPointers[1]).toBe('next: yg context --node orders');
    expect(extras.nextPointers.length).toBeLessThanOrEqual(2);
  });
});

describe.skipIf(!distExists)('yg context --file --brief', () => {
  it('is compact, one line per rule, and never exceeds the budget', () => {
    const dir = copyFixture();
    try {
      const { stdout, status } = run(['context', '--file', OWNED_FILE, '--brief'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Must satisfy:');
      expect(stdout).toContain('next: yg log read --node orders/order-service');
      expect(stdout.trimEnd().split('\n').length).toBeLessThanOrEqual(30);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses the compact view for a component, naming the flag that fits', () => {
    const dir = copyFixture();
    try {
      const { stderr, status } = run(['context', '--node', 'orders/order-service', '--brief'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain('--brief is only available with --file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the default full view byte-identical when no new flag is passed', () => {
    // A REAL run of the built binary against a capture taken before this
    // command's output path was touched at all, byte for byte. The default
    // view is a contract with every consumer that already reads it: if adding
    // a flag ever moves one byte of it, this is what says so.
    const dir = copyFixture();
    try {
      const withoutFlag = run(['context', '--file', OWNED_FILE], dir);
      expect(withoutFlag.status).toBe(0);
      // THE pin: the committed pre-edit capture, byte for byte.
      expect(withoutFlag.stdout).toBe(readFileSync(BASELINE, 'utf-8'));
      expect(withoutFlag.stdout).toContain('Must satisfy:');
      expect(withoutFlag.stdout).toContain('Node context: run yg context --node');
      // The compact view is a DIFFERENT rendering, not a reformat of the same text.
      const brief = run(['context', '--file', OWNED_FILE, '--brief'], dir);
      expect(brief.stdout).not.toBe(withoutFlag.stdout);
      expect(brief.stdout.trimEnd().split('\n').length).toBeLessThan(withoutFlag.stdout.trimEnd().split('\n').length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shows the type-covered owner head for a file mapped only by type-level coverage', () => {
    const dir = copyTypeFixture();
    try {
      const { stdout, status } = run(['context', '--file', TYPE_COVERED_FILE, '--brief'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('  Owner: type:leaf');
      expect(stdout.trimEnd().split('\n').length).toBeLessThanOrEqual(30);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
