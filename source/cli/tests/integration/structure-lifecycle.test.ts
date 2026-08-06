import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readLock as readTriadLock } from '../../src/io/lock-store.js';
import {
  LOCK_NONDET_FILE_NAME,
  LOCK_LOGS_FILE_NAME,
  LOCK_DET_FILE_NAME,
} from '../../src/model/lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', '..', 'dist', 'bin.js');
const distExists = existsSync(BIN);

const YG_CONFIG = `version: "5.2.0"
quality:
  max_direct_relations: 10
reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config: { model: m, endpoint: http://x }
`;

const YG_ARCH = `node_types:
  module:
    description: Logical grouping
    log_required: false
  service:
    description: Discrete service unit
    log_required: false
    when:
      path: "**"
`;

function run(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [BIN, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

function layout(root: string): void {
  const ygg = path.join(root, '.yggdrasil');
  mkdirSync(path.join(ygg, 'aspects', 'touches-a'), { recursive: true });
  mkdirSync(path.join(ygg, 'model', 'N'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });

  writeFileSync(path.join(root, 'src', 'a.ts'), 'export const x = 1;\n');
  writeFileSync(path.join(ygg, 'yg-architecture.yaml'), YG_ARCH);
  writeFileSync(path.join(ygg, 'yg-config.yaml'), YG_CONFIG);
  writeFileSync(
    path.join(ygg, 'model', 'N', 'yg-node.yaml'),
    `name: N\ntype: service\ndescription: test node\nmapping:\n  - src/a.ts\naspects:\n  - touches-a\n`,
  );
  writeFileSync(
    path.join(ygg, 'aspects', 'touches-a', 'yg-aspect.yaml'),
    `name: TouchesA\ndescription: reads src/a.ts\nreviewer:\n  type: deterministic\nstatus: enforced\n`,
  );
  writeFileSync(
    path.join(ygg, 'aspects', 'touches-a', 'check.mjs'),
    `export function check(ctx) { ctx.fs.read('src/a.ts'); return []; }\n`,
  );
}

/**
 * The verification state lives in the 5.1.0 lock triad
 * (nondeterministic/logs/deterministic). Merge them into the unified
 * { version, verdicts, nodes } shape via the real store reader.
 */
function readLock(root: string): {
  version: number;
  verdicts: Record<string, Record<string, { verdict: string; hash: string; touched?: Array<[string, string]> }>>;
  nodes: Record<string, { source?: string }>;
} {
  return readTriadLock(path.join(root, '.yggdrasil'));
}

describe.skipIf(!distExists)('deterministic aspect lock lifecycle', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'yg-lock-lifecycle-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('cold start → fill → verified → edit → unverified → re-fill → verified', () => {
    // 1. Lay out a minimal repo with one enforced deterministic aspect.
    layout(root);

    // 2. Cold check: the pair has no lock entry → unverified (error, exit 1).
    //    Plain check executes nothing and writes nothing.
    const coldCheck = run(['check'], root);
    expect(coldCheck.status).toBe(1);
    expect(coldCheck.stdout.toLowerCase()).toContain('unverified');
    // Plain check writes nothing — none of the lock-triad files exist yet.
    const ygg = path.join(root, '.yggdrasil');
    expect(existsSync(path.join(ygg, LOCK_NONDET_FILE_NAME))).toBe(false);
    expect(existsSync(path.join(ygg, LOCK_LOGS_FILE_NAME))).toBe(false);
    expect(existsSync(path.join(ygg, LOCK_DET_FILE_NAME))).toBe(false);

    // 3. yg check --approve: fills the deterministic pair locally (free), writes the lock.
    const fill = run(['check', '--approve'], root);
    expect(fill.status).toBe(0);
    // The pre-dispatch header (fill progress) goes to STDERR.
    expect(fill.stderr).toMatch(/1 deterministic/);

    // 4. The lock records an approved verdict for (touches-a, node:N) and N's
    //    source fingerprint at positive closure.
    const lock = readLock(root);
    const entry = lock.verdicts['touches-a']?.['node:N'];
    expect(entry).toBeDefined();
    expect(entry!.verdict).toBe('approved');
    expect(typeof entry!.hash).toBe('string');
    // N is not log_required, so closure records no source fingerprint for it.
    expect(lock.nodes['N']?.source).toBeUndefined();

    // 5. Clean check after fill — the recomputed hash matches → verified (exit 0).
    const cleanCheck = run(['check'], root);
    expect(cleanCheck.status).toBe(0);

    // 6. Edit the subject file — the file hash folds into the pair input, so the
    //    stored verdict no longer matches: the pair degrades to unverified.
    writeFileSync(path.join(root, 'src', 'a.ts'), 'export const x = 2;\n');

    const driftCheck = run(['check'], root);
    expect(driftCheck.status).toBe(1);
    expect(driftCheck.stdout.toLowerCase()).toContain('unverified');

    // 7. Re-fill clears the unverified pair (deterministic re-run, free).
    const reFill = run(['check', '--approve'], root);
    expect(reFill.status).toBe(0);

    // 8. Clean check → verified again (exit 0).
    const cleanAgain = run(['check'], root);
    expect(cleanAgain.status).toBe(0);
  });
});
