// =============================================================================
// CLI E2E — the implicit `default` port, reached with NO declaration on either
// side.
//
// The own-graph test (`cli-own-graph-default-port.test.ts`) proves the
// migration on a real port that used to have a name. This one is the general
// case, isolated from that specific graph: a provider publishes `default`
// with an aspect, a consumer relation names no port at all, and the aspect
// still reaches the consumer — because a relation naming no port has always
// entered through `default`, the one port name every node carries whether it
// declares it or not.
//
//   1. `yg context --node` on the consumer shows the aspect effective, with a
//      `port` channel whose origin is `default@<provider>`
//   2. `yg check --approve --only-deterministic` fills the pair for real
//   3. `yg check` exits 0 — the consumer needs nothing declared to satisfy a
//      rule it was never told to look for
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'implicit-default-reach');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

function copyFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-implicit-default-'));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

interface ContextDoc {
  aspects: Array<{ id: string; channels: Array<{ kind: string; origin: string }> }>;
}

describe.skipIf(!distExists)('CLI E2E — implicit default-port reach', () => {
  it('1+2+3: a consumer declaring no port is bound by the provider default port aspect, fills, and checks green', () => {
    const dir = copyFixture();
    try {
      const ctx = JSON.parse(run(['context', '--node', 'services/orders', '--json'], dir).stdout) as ContextDoc;
      const aspect = ctx.aspects.find((a) => a.id === 'audit-required');
      expect(aspect).toBeDefined();
      const portChannel = aspect!.channels.find((c) => c.kind === 'port');
      expect(portChannel).toBeDefined();
      expect(portChannel!.origin).toBe('port:default@services/payments');

      const approve = run(['check', '--approve', '--only-deterministic'], dir);
      expect(approve.status).toBe(0);

      const check = run(['check'], dir);
      expect(check.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
