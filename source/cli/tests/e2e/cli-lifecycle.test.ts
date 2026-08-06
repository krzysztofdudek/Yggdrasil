import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const PKG_VERSION = JSON.parse(readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf-8')).version;
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');

const distExists = existsSync(BIN_PATH);

function run(
  args: string[],
  cwd = FIXTURE,
): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const result = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

// NOTE: the `yg approve` command and `.drift-state/` are removed surface in the
// verdict-lock model — verification now happens via `yg check --approve` (fill)
// against `.yggdrasil/yg-lock.json`. The mock-driven fill/verdict/consensus
// behaviors live in cli-llm-reviewer-mock*.test.ts; this omnibus suite keeps the
// surface that survived (log, platform install, init/upgrade, version) and
// re-points the former `deterministic-test` diagnostics onto `yg aspect-test`.
describe.skipIf(!distExists)('CLI E2E — lifecycle (log, aspect-test, platform, init)', () => {
  // --- platform installation (black-box: drive `yg init --upgrade --platform <x>`) ---
  //
  // Per-platform installers are RETIRED: every agent now reads the SAME three
  // universal artifacts (AGENTS.md digest block + CLAUDE.md @AGENTS.md import
  // + .clinerules/yggdrasil.md), installed identically regardless of platform.
  // `--platform <x>` is still ACCEPTED for every one of the thirteen retired
  // names, purely for backward compatibility — it prints a deprecation notice
  // and otherwise changes nothing about what gets installed. Each case below
  // seeds a tmpDir with a minimal valid .yggdrasil/yg-config.yaml, spawns the
  // real binary, and asserts a clean exit, the notice, and the SAME universal
  // artifacts on disk — the same "no import of the internal install module"
  // black-box discipline the old per-platform matrix followed.
  //
  // DEPRECATED_PLATFORM_NAMES below is a hand-maintained MIRROR of
  // `DEPRECATED_PLATFORMS` in src/templates/platform.ts — an e2e test must
  // not import src/** (the enforced e2e-public-surface rule), so it cannot
  // read the list itself. Keep the two in sync by hand when a name is added
  // or removed there.

  /** Seed a tmpDir with a minimal upgradeable graph and return it. Caller owns cleanup. */
  function upgradeableRepo(label: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), `yg-e2e-platform-${label}-`));
    mkdirSync(path.join(dir, '.yggdrasil'), { recursive: true });
    writeFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), 'version: "1.0.0"\n', 'utf-8');
    return dir;
  }

  // Every retired per-platform name, still accepted for backward compatibility.
  const DEPRECATED_PLATFORM_NAMES = [
    'cursor', 'claude-code', 'copilot', 'cline', 'roocode', 'codex',
    'windsurf', 'aider', 'gemini', 'amp', 'opencode', 'codebuddy', 'generic',
  ];

  it.each(DEPRECATED_PLATFORM_NAMES)(
    'init --upgrade --platform %s prints a deprecation notice and installs the universal artifacts (exit 0)',
    (platform) => {
      const tmpDir = upgradeableRepo(platform);
      try {
        const { status, stdout } = run(['init', '--upgrade', '--platform', platform], tmpDir);
        expect(status).toBe(0);
        expect(stdout).toContain(`--platform ${platform} is deprecated and was ignored`);
        expect(existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(true);
        expect(existsSync(path.join(tmpDir, 'CLAUDE.md'))).toBe(true);
        expect(existsSync(path.join(tmpDir, '.clinerules', 'yggdrasil.md'))).toBe(true);
        // No platform-specific artifact ever lands — e.g. cursor's old
        // .cursor/rules/yggdrasil.mdc, or the shared .yggdrasil/agent-rules.md.
        expect(existsSync(path.join(tmpDir, '.cursor', 'rules', 'yggdrasil.mdc'))).toBe(false);
        expect(existsSync(path.join(tmpDir, '.yggdrasil', 'agent-rules.md'))).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it('init --upgrade advances an outdated config version and removes the legacy schemas/ dir', () => {
    // The migration framework advances an outdated graph version forward and runs
    // its data migrations (the to-5.1.0 step deletes the legacy schemas/ directory).
    // Public-surface assertions only: clean exit, version no longer the seeded
    // "1.0.0", the new version is a valid semver, schemas/ is gone, and a second
    // upgrade is idempotent (the version does not move again). The exact-equality
    // assertion against the CLI-supported schema constant lives in the unit suite
    // (tests/unit/core/graph-loader-supported-schema.test.ts) where importing the
    // constant is legitimate — e2e never imports an internal module.
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-upgrade-version-'));
    const yggDir = path.join(tmpDir, '.yggdrasil');
    mkdirSync(path.join(yggDir, 'schemas'), { recursive: true });
    writeFileSync(path.join(yggDir, 'yg-config.yaml'), 'version: "1.0.0"\n', 'utf-8');

    try {
      const first = run(['init', '--upgrade', '--platform', 'generic'], tmpDir);
      expect(first.status).toBe(0);

      const advanced = readFileSync(path.join(yggDir, 'yg-config.yaml'), 'utf-8');
      const versionMatch = advanced.match(/version:\s*"([^"]+)"/);
      expect(versionMatch).not.toBeNull();
      const advancedVersion = versionMatch![1];
      expect(advancedVersion).not.toBe('1.0.0');
      expect(advancedVersion).toMatch(/^\d+\.\d+\.\d+$/);
      // The to-5.1.0 migration must have deleted the legacy schemas/ directory.
      expect(existsSync(path.join(yggDir, 'schemas'))).toBe(false);

      // Idempotence: a second upgrade leaves the version untouched (already current).
      const second = run(['init', '--upgrade', '--platform', 'generic'], tmpDir);
      expect(second.status).toBe(0);
      const after = readFileSync(path.join(yggDir, 'yg-config.yaml'), 'utf-8');
      expect(after.match(/version:\s*"([^"]+)"/)?.[1]).toBe(advancedVersion);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('getCliVersion reads version from package.json', async () => {
    // PKG_VERSION reflects the CLI package version (independent from the
    // graph schema version, which the migration framework manages).
    expect(PKG_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  // --- log ---

  it('yg log add appends an entry to the node log', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-log-add-'));
    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      const { status, stdout } = run(
        ['log', 'add', '--node', 'orders/order-service', '--reason', 'E2E test entry'],
        tmpDir,
      );
      expect(status).toBe(0);
      expect(stdout).toContain('Added log entry');
      expect(stdout).toContain('orders/order-service');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg log read returns entries written by log add', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-log-read-'));
    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      run(['log', 'add', '--node', 'orders/order-service', '--reason', 'Readable entry'], tmpDir);
      const { status, stdout } = run(
        ['log', 'read', '--node', 'orders/order-service'],
        tmpDir,
      );
      expect(status).toBe(0);
      expect(stdout).toContain('Readable entry');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg log read --all returns full history including multiple entries', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-log-read-all-'));
    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      run(['log', 'add', '--node', 'orders/order-service', '--reason', 'Alpha entry'], tmpDir);
      run(['log', 'add', '--node', 'orders/order-service', '--reason', 'Beta entry'], tmpDir);
      const { status, stdout } = run(
        ['log', 'read', '--node', 'orders/order-service', '--all'],
        tmpDir,
      );
      expect(status).toBe(0);
      expect(stdout).toContain('Alpha entry');
      expect(stdout).toContain('Beta entry');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg log add without --reason returns exit 1', () => {
    const { status, stderr } = run(['log', 'add', '--node', 'orders/order-service']);
    expect(status).toBe(1);
    expect(stderr).toContain('reason');
  });

  it('yg log read without --node returns exit 1', () => {
    const { status, stderr } = run(['log', 'read']);
    expect(status).toBe(1);
    expect(stderr).toContain('node');
  });

  // --- aspect-test (replaces the removed `deterministic-test`) ---

  it('yg aspect-test with unknown aspect returns exit 1', () => {
    const { status, stderr } = run(['aspect-test', '--aspect', 'nonexistent-aspect-xyz', '--node', 'orders/order-service']);
    expect(status).toBe(1);
    expect(stderr).toContain('not found');
  });

  it('yg aspect-test on an LLM aspect with no reachable reviewer returns exit 1', () => {
    // requires-audit is an LLM aspect; the sample-project reviewer endpoint is
    // unreachable, so the diagnostic run fails closed.
    const { status, stderr } = run(['aspect-test', '--aspect', 'requires-audit', '--node', 'orders/order-service']);
    expect(status).toBe(1);
    expect(stderr).toContain('unreachable');
  });

  it('yg aspect-test runs the check and reports no violations on clean code', () => {
    // Use the dogfood project which has real deterministic aspects and a proper node_modules tree
    const WORKSPACE_ROOT = path.resolve(CLI_ROOT, '../..');
    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'no-direct-console', '--node', 'cli/formatters'],
      WORKSPACE_ROOT,
    );
    expect(status).toBe(0);
    expect(stdout).toContain('No violations');
  });

  // --- init edge cases ---

  // Retired: `yg init --upgrade` with no `--platform` used to be rejected —
  // that guard is gone (--platform is fully optional everywhere now, see the
  // deprecation-notice matrix above). A bare `--upgrade` on a repo whose
  // config carries a version now either upgrades cleanly or refreshes the
  // universal artifacts, already covered by "bare init --upgrade scaffolds
  // the universal artifacts on a bare repo (exit 0)" in
  // cli-greenfield-init.test.ts and the deprecation-notice matrix above — no
  // replacement case is added here.

  it('yg init --upgrade without .yggdrasil returns exit 1', () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-init-no-ygg-'));
    try {
      const { status, stderr } = run(['init', '--upgrade', '--platform', 'generic'], emptyDir);
      expect(status).toBe(1);
      expect(stderr).toContain('No .yggdrasil/');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // The three non-interactive fresh-init flag-combination cases formerly here
  // (bare `init` with no flags → exit 1 asking for --platform; --platform
  // alone → keyless bootstrap; --model without --provider → exit 1) moved to
  // the dedicated pure-CLI init e2e suite (cli-init-pure-cli.test.ts), which
  // is now their canonical home — every assertion (the "no TTY" and
  // "--platform" stderr substrings, the "keyless" stdout message, and the
  // config's missing `reviewer:` block) is preserved there.

  // --- log extended ---

  it('yg log add without --node returns exit 1', () => {
    const { status, stderr } = run(['log', 'add', '--reason', 'test']);
    expect(status).toBe(1);
    expect(stderr).toContain('--node');
  });

  it('yg log add for nonexistent node returns exit 1', () => {
    const { status, stderr } = run(['log', 'add', '--node', 'nonexistent/node', '--reason', 'test']);
    expect(status).toBe(1);
    expect(stderr).toContain('Node not found');
  });

  it('yg log add with --reason-file appends entry from file', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-log-reason-file-'));
    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      const reasonFile = path.join(tmpDir, 'reason.txt');
      writeFileSync(reasonFile, 'Entry from reason-file', 'utf-8');
      const { status, stdout } = run(
        ['log', 'add', '--node', 'orders/order-service', '--reason-file', reasonFile],
        tmpDir,
      );
      expect(status).toBe(0);
      expect(stdout).toContain('Added log entry');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg log read --top 1 returns only the latest entry', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-log-top-'));
    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      run(['log', 'add', '--node', 'orders/order-service', '--reason', 'Older entry'], tmpDir);
      run(['log', 'add', '--node', 'orders/order-service', '--reason', 'Newer entry'], tmpDir);
      const { status, stdout } = run(
        ['log', 'read', '--node', 'orders/order-service', '--top', '1'],
        tmpDir,
      );
      expect(status).toBe(0);
      expect(stdout).toContain('Newer entry');
      expect(stdout).not.toContain('Older entry');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg log read for nonexistent node returns exit 1', () => {
    const { status, stderr } = run(['log', 'read', '--node', 'nonexistent/node']);
    expect(status).toBe(1);
    expect(stderr).toContain('Node not found');
  });

  it('yg log merge-resolve without --node returns exit 1', () => {
    const { status, stderr } = run(['log', 'merge-resolve']);
    expect(status).toBe(1);
    expect(stderr).toContain('--node');
  });

  it('yg log without subcommand shows usage and returns exit 1', () => {
    const { status, stdout, stderr } = run(['log']);
    expect(status).toBe(1);
    expect(stdout + stderr).toContain('Usage: yg log');
  });

  // --- aspect-test extended ---

  it('yg aspect-test without --aspect returns exit 1', () => {
    const { status, stderr } = run(['aspect-test']);
    expect(status).toBe(1);
    expect(stderr).toContain('--aspect');
  });

  it('yg aspect-test with valid aspect but no --files or --node returns exit 1', () => {
    const WORKSPACE_ROOT = path.resolve(CLI_ROOT, '../..');
    const { status, stderr } = run(
      ['aspect-test', '--aspect', 'no-direct-console'],
      WORKSPACE_ROOT,
    );
    expect(status).toBe(1);
    // --node/--file/--files are a three-way exactly-one-mode contract.
    expect(stderr).toContain('None of --node, --file, --files was provided');
  });

  it('yg aspect-test with --files runs check against specific files', () => {
    const WORKSPACE_ROOT = path.resolve(CLI_ROOT, '../..');
    const { stdout, status } = run(
      [
        'aspect-test',
        '--aspect', 'no-direct-console',
        '--files', 'source/cli/src/formatters/message-builder.ts',
      ],
      WORKSPACE_ROOT,
    );
    expect(status).toBe(0);
    expect(stdout).toContain('No violations');
  });

  // --- legacy graph-version guard ---

  it('yg check rejects an outdated graph version with a migration hint', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-legacy-config-'));
    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      writeFileSync(
        path.join(tmpDir, '.yggdrasil', 'yg-config.yaml'),
        'version: "4.3.0"\nreviewer:\n  ollama:\n    model: qwen3\n    endpoint: http://localhost:11434\n',
        'utf-8',
      );
      const { status, stderr } = run(['check'], tmpDir);
      expect(status).toBe(1);
      expect(stderr).toContain('older than this CLI');
      expect(stderr).toContain('yg init --upgrade');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // DELETED (removed surface, verdict-lock redesign):
  //   - every `yg approve` invocation test (`approve` with/without `--node`,
  //     nonexistent node, `--aspect`, `--flow`, `--dry-run`, multi-target
  //     "Multiple targets specified", batch `--node --node`): the `approve`
  //     command and `.drift-state/` no longer exist — fill/verdict/consensus/
  //     batch behavior is now covered by cli-llm-reviewer-mock*.test.ts via
  //     `yg check --approve`.
  //   - `yg deterministic-test` tests: command renamed to `yg aspect-test`
  //     (re-pointed above; the unknown-aspect, clean-run, missing-flag, and
  //     --files cases are preserved against the new command).
  //   - `yg approve --dry-run` / `yg approve --dry-run with v5 tiers`: dry-run
  //     prompt preview moved to `yg aspect-test --dry-run`, exercised in
  //     cli-llm-reviewer-mock.test.ts (#11).
  //   - `yg init --upgrade migrates v4 reviewer config to v5 tiers`: the v4→v5
  //     reviewer-shape migration was removed in the B4 migration-deletion sweep
  //     (MIGRATIONS is now empty). `init --upgrade` lifts the version directly;
  //     that version-bump behavior is covered by the "advances config version"
  //     test above.
});
