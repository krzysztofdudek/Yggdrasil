import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { registerPrimeCommand } from '../../../src/cli/prime.js';
import { AGENT_RULES_CONTENT } from '../../../src/templates/rules.js';
import { digestBlockBody } from '../../../src/templates/digest.js';
import { cliVersion } from '../../../src/cli/cli-version.js';

// Independent read of source/cli/package.json — NOT via cliVersion() itself —
// so the test has an oracle that does not share the code path under test.
const OWN_PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json');

function runPrime(args: string[]): string {
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  const program = new Command();
  registerPrimeCommand(program);
  program.parse(['node', 'yg', 'prime', ...args]);
  spy.mockRestore();
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe('yg prime', () => {
  it('prints header, full manual, and footer — unconditionally', () => {
    const out = runPrime([]);
    const pkg = JSON.parse(readFileSync(OWN_PACKAGE_JSON, 'utf-8')) as { version: string };
    // Independently-sourced version must actually be interpolated into the
    // header — a substring check alone would still pass for "vundefined".
    expect(out).toContain(`Yggdrasil v${pkg.version} —`);
    expect(out).toContain('agent operating manual');
    expect(out).toContain(AGENT_RULES_CONTENT);
    expect(out).toContain('Start with: yg check');
    // No graph detection: the missing-graph phrasing must NOT appear.
    expect(out).not.toContain('.yggdrasil/ directory');
  });

  it('--digest prints the canonical digest block byte-for-byte, no extra trailing byte', () => {
    const out = runPrime(['--digest']);
    // Whole-output equality (not a trimmed/re-split reconstruction) so any
    // stray or missing byte — e.g. an extra trailing newline appended on top
    // of an already newline-terminated body — fails the assertion.
    expect(out).toBe(digestBlockBody(cliVersion()));
  });
});
