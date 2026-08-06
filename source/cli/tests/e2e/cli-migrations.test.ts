import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
// e2e-lifecycle is a complete v5 graph (config + architecture + model nodes +
// aspects). We reuse it for the scenarios that need `yg check` / `yg tree` to
// resolve a real graph root, and we build minimal v4 layouts from scratch for
// the migration-input scenarios.
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

function run(
  args: string[],
  cwd: string,
): {
  stdout: string;
  stderr: string;
  status: number | null;
  all: string;
} {
  const result = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the complete e2e-lifecycle fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-mig-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Build a minimal pre-5.1.0 `.yggdrasil` layout from scratch in a fresh temp dir.
 * The migration runner (`yg init --upgrade`) only needs a `version:` field;
 * aspects are optional and added per-scenario. The to-5.1.0 migration DELETES
 * schemas/ (it no longer needs to exist as a precondition).
 * Everything here is written into mkdtemp — the committed fixture is never
 * touched.
 */
const configPath = (dir: string) =>
  path.join(dir, '.yggdrasil', 'yg-config.yaml');

// ---------------------------------------------------------------------------
// Migration paths (pre-5.1.0 → 5.1.0) NOT already covered by cli-lifecycle.test.ts.
// Fully hermetic: no network, no LLM, no real endpoints, fresh mkdtemp per test.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — schema migrations (version-guard + idempotency)', () => {
  // --- 1. DELETED: v4.x config-content migration (bare-provider → tiers) ---
  // The legacy migration files were removed in the verdict-lock redesign
  // (src/migrations/index.ts: `MIGRATIONS` now contains only the to-5.1.0 entry).
  // `yg init --upgrade` bumps the on-disk `version:` field to 5.1.0 and removes
  // the schemas/ directory via the to-5.1.0 migration — it no longer TRANSFORMS a
  // v4 bare-provider reviewer block into the tier shape. The original M1 asserted
  // that transform produced `tiers:` / `provider: ollama` from a bare-provider
  // config; that transform no longer exists, so the assertion tests a removed
  // surface and is deleted. (The surviving "older than this CLI" guard for a
  // still-legacy config is exercised by M3 below; v5.1.0 upgrade idempotency by M2.)

  // --- 2. Idempotency on an already-v5 repo ---

  it('M2: upgrading an already-v5 repo twice is a no-op — config byte-identical between runs', () => {
    const dir = copyFixture('m2');
    try {
      // First upgrade on the v5 fixture: nothing to migrate (5.2.0 is the
      // latest target), so the config must be left untouched.
      const first = run(['init', '--upgrade', '--platform', 'generic'], dir);
      expect(first.status).toBe(0);
      const afterFirst = readFileSync(configPath(dir), 'utf-8');

      // Second upgrade: must produce a byte-identical config.
      const second = run(['init', '--upgrade', '--platform', 'generic'], dir);
      expect(second.status).toBe(0);
      const afterSecond = readFileSync(configPath(dir), 'utf-8');

      expect(afterSecond).toBe(afterFirst);
      // And it is genuinely the v5 shape, not some degenerate empty file.
      expect(afterSecond).toContain('version: "5.2.0"');
      expect(afterSecond).toContain('tiers:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 3. Version-too-OLD guard (a still-legacy config blocks every graph command) ---

  it('M3: a still-legacy (sub-5.0.0) config blocks `yg check` with the older-than-CLI guard and the upgrade hint', () => {
    // RE-POINTED: the original M3 asserted the now-removed "Migration withheld"
    // path of `yg init --upgrade` on a multi-provider config. That migration is
    // gone — `yg init --upgrade` now simply bumps the version field. What SURVIVES
    // (and is the real enforcement the original test's tail proved) is the
    // version-too-OLD guard in the graph loader: any config whose `version:` is
    // below the CLI's 5.0.0 is refused by every command that loads the graph, with
    // a clear "older than this CLI" message pointing at `yg init --upgrade`. We
    // build this on the complete e2e-lifecycle fixture so `yg check` resolves a
    // real graph root, and only lower its version field. (The too-NEW direction is
    // M5.)
    const dir = copyFixture('m3');
    try {
      const original = readFileSync(configPath(dir), 'utf-8');
      const lowered = original.match(/^version:\s/m)
        ? original.replace(/^version:\s.*$/m, 'version: "4.3.0"')
        : 'version: "4.3.0"\n' + original;
      writeFileSync(configPath(dir), lowered, 'utf-8');

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('older than this CLI');
      expect(check.all).toContain('yg init --upgrade');

      // The same guard blocks any other graph-loading command (e.g. `yg tree`).
      const tree = run(['tree'], dir);
      expect(tree.status).toBe(1);
      expect(tree.all).toContain('older than this CLI');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 4. DELETED: aspect reviewer field migration (string → mapping) ---
  // The aspect-reviewer migration (`reviewer: ast` → { type: deterministic },
  // absent → { type: llm }) was removed with the rest of the legacy migration
  // content (`MIGRATIONS` is empty). `yg init --upgrade` no longer walks or
  // rewrites aspect reviewer fields, so the original M4 transform assertions test
  // a removed surface and are deleted. (The current aspect reviewer-kind contract
  // — inferred from which rule-source file is present — is enforced by the aspect
  // parser and covered by the validation suites.)

  // --- 5. Version-too-new guard (config schema newer than the CLI supports) ---

  it('M5: a config version newer than the CLI supports blocks `yg check` and `yg tree` (exit 1)', () => {
    // CLI_SUPPORTED_SCHEMA in graph-loader.ts is 5.2.0; a config at 99.0.0 must
    // be refused by every command that loads the graph. We keep the v5 reviewer
    // shape intact and only raise the version field.
    const dir = copyFixture('m5');
    try {
      const original = readFileSync(configPath(dir), 'utf-8');
      const bumped = original.replace(/^version:\s.*$/m, 'version: "99.0.0"');
      writeFileSync(configPath(dir), bumped, 'utf-8');

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('newer than this CLI supports');
      expect(check.all).toContain('max: 5.2.0');
      // A newer-than-CLI config is an expected USER error (upgrade your CLI),
      // not an internal bug — it must NOT be wrapped as "please file an issue".
      expect(check.all).not.toContain('file an issue');
      expect(check.all).not.toContain('This is a bug');

      const tree = run(['tree'], dir);
      expect(tree.status).toBe(1);
      expect(tree.all).toContain('newer than this CLI supports');
      expect(tree.all).toContain('max: 5.2.0');
      expect(tree.all).not.toContain('file an issue');
      expect(tree.all).not.toContain('This is a bug');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 6. DELETED: drift-state baseline migration (flat synthetic-key → typed) ---
  // The `.yggdrasil/.drift-state/` directory and its per-node baseline files are
  // gone in the verdict-lock redesign — verification state now lives in a single
  // `.yggdrasil/yg-lock.json`. The `to-5.0.0` drift-state re-key migration (and
  // the command wiring that walked `.drift-state/` and gated the version bump on
  // its outcome) was removed with the rest of the legacy migration content. The
  // four cases here (flat→typed re-key with approved-synthesis, verdict
  // preservation, unparseable-baseline deletion + withheld bump, re-key
  // idempotency) all exercised that removed `.drift-state/` machinery, so they
  // are deleted. A stale lock entry for an absent node is now simply GC-pruned by
  // the next fill, not migrated.

  // --- 7. The 5.1.0 lock split: a legacy single yg-lock.json → committed/gitignored triad ---

  it('M7: `yg init --upgrade` splits a legacy yg-lock.json into the triad, preserving every verdict by kind and gitignoring the cache', () => {
    const dir = copyFixture('lock-split');
    const ygg = path.join(dir, '.yggdrasil');
    try {
      // Downgrade the on-disk version so the to-5.1.0 migration (incl. the split step) runs.
      writeFileSync(
        configPath(dir),
        readFileSync(configPath(dir), 'utf-8').replace(/version:\s*["'][\d.]+["']/, 'version: "5.0.0"'),
      );
      // Plant a LEGACY single lock: one deterministic verdict (no-todo-comments ships check.mjs)
      // and one LLM verdict (has-doc-comment ships content.md), plus a per-node baseline.
      const legacy = {
        version: 1,
        verdicts: {
          'no-todo-comments': { 'node:services/orders': { verdict: 'approved', hash: 'det-hash', touched: [] } },
          'has-doc-comment': { 'node:services/orders': { verdict: 'approved', hash: 'llm-hash' } },
        },
        nodes: { 'services/orders': { source: 'fp-orders' } },
      };
      writeFileSync(path.join(ygg, 'yg-lock.json'), JSON.stringify(legacy), 'utf-8');

      const up = run(['init', '--upgrade', '--platform', 'generic'], dir);
      expect(up.status).toBe(0);

      // The legacy single file is gone; the triad is present.
      expect(existsSync(path.join(ygg, 'yg-lock.json'))).toBe(false);
      const det = JSON.parse(readFileSync(path.join(ygg, '.yg-lock.deterministic.json'), 'utf-8'));
      const nondet = JSON.parse(readFileSync(path.join(ygg, 'yg-lock.nondeterministic.json'), 'utf-8'));
      const logs = JSON.parse(readFileSync(path.join(ygg, 'yg-lock.logs.json'), 'utf-8'));

      // Verdicts relocated by KIND and byte-preserved (no re-verification).
      expect(det.verdicts['no-todo-comments']['node:services/orders']).toEqual({
        verdict: 'approved',
        hash: 'det-hash',
        touched: [],
      });
      expect(nondet.verdicts['has-doc-comment']['node:services/orders']).toEqual({
        verdict: 'approved',
        hash: 'llm-hash',
      });
      expect(det.verdicts['has-doc-comment']).toBeUndefined();
      expect(nondet.verdicts['no-todo-comments']).toBeUndefined();
      expect(logs.nodes['services/orders']).toEqual({ source: 'fp-orders' });

      // The gitignored cache was added to .yggdrasil/.gitignore, and the version advanced
      // to 5.2.0 (the to-5.1.0 migration's split step runs, then the version-lift
      // fallback carries the rest of the way since no migration exists past 5.1.0).
      expect(readFileSync(path.join(ygg, '.gitignore'), 'utf-8')).toContain('.yg-lock.deterministic.json');
      expect(readFileSync(configPath(dir), 'utf-8')).toContain('5.2.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
