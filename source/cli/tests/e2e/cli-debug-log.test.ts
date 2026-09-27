// =============================================================================
// CLI E2E — `debug: true` writes .yggdrasil/.debug.log for every command that
// reads the graph.
//
// The reviewer error hint of `yg aspect-test` and `yg drill` tells the user to
// set `debug: true` and read .yggdrasil/.debug.log, and the configuration docs
// say every command appends its output there. Before the debug log was started
// by the shared graph loader, only twelve commands started it and the log never
// appeared for the rest — aspect-test and drill among them.
//
//   1. yg find with debug: true   → .debug.log exists and names the command
//   2. yg find with debug: false  → no .debug.log
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');
const distExists = existsSync(BIN_PATH);

function copyFixture(debug: boolean): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-debuglog-'));
  cpSync(FIXTURE, dir, { recursive: true });
  if (debug) appendFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), '\ndebug: true\n');
  return dir;
}

describe.skipIf(!distExists)('CLI E2E — the debug log', () => {
  it('1: debug: true — a command outside the old twelve (yg find) writes .yggdrasil/.debug.log', () => {
    const dir = copyFixture(true);
    try {
      const result = spawnSync('node', [BIN_PATH, 'find', 'order'], { cwd: dir, encoding: 'utf-8' });
      expect(result.status, result.stderr).toBe(0);
      const log = path.join(dir, '.yggdrasil', '.debug.log');
      expect(existsSync(log)).toBe(true);
      expect(readFileSync(log, 'utf-8')).toContain('yg find order');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2: debug unset — no .debug.log is written', () => {
    const dir = copyFixture(false);
    try {
      const result = spawnSync('node', [BIN_PATH, 'find', 'order'], { cwd: dir, encoding: 'utf-8' });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(path.join(dir, '.yggdrasil', '.debug.log'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
