import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLock } from './support/read-lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');

const distExists = existsSync(BIN_PATH);

// ---------------------------------------------------------------------------
// Harness — spawn the real dist/bin.js. Mirrors the run() helper from
// cli-deterministic-lifecycle.test.ts (spawnSync, captured stdout/stderr, the
// combined `all` stream) and the describe.skipIf(!distExists) gate. Every test
// uses a fresh mkdtemp dir and rmSync in finally, so the suite is hermetic:
// no committed fixtures, no shared state, no network host/port, no clock or
// random in any assertion.
// ---------------------------------------------------------------------------

function run(
  args: string[],
  cwd: string,
): {
  stdout: string;
  stderr: string;
  status: number | null;
  all: string;
} {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/**
 * Minimal v5 config. The reviewer endpoint points at the dead loopback port 1
 * (no listener on any machine) — but the graphs below carry only deterministic
 * aspects, so the reviewer is never invoked. Including it keeps the config
 * schema-valid without introducing any external dependency.
 */
const MINIMAL_CONFIG = `version: "5.2.0"
quality:
  max_direct_relations: 10
reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config:
        model: "qwen2.5-coder:0.5b"
        endpoint: "http://127.0.0.1:1"
`;

/**
 * Hand-author a minimal, fully deterministic greenfield graph in a fresh
 * mkdtemp dir: config, architecture with one mapping node type + an
 * organizational parent, two nodes (parent module + child
 * widget), one deterministic aspect (no-todo-comments check.mjs), and one
 * source file. Returns the project root. Caller owns cleanup.
 */
function greenfieldGraph(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-greenfield-${label}-`));
  const yggRoot = path.join(dir, '.yggdrasil');
  mkdirSync(path.join(yggRoot, 'model', 'widgets', 'widget'), { recursive: true });
  mkdirSync(path.join(yggRoot, 'aspects', 'no-todo-comments'), { recursive: true });
  mkdirSync(path.join(yggRoot, 'flows'), { recursive: true });
  mkdirSync(path.join(dir, 'src', 'widgets'), { recursive: true });

  writeFileSync(path.join(yggRoot, 'yg-config.yaml'), MINIMAL_CONFIG, 'utf-8');

  writeFileSync(
    path.join(yggRoot, 'yg-architecture.yaml'),
    `node_types:
  module:
    description: 'Organizational grouping. Parent-only — no file mapping.'
    log_required: false
  widget:
    description: 'A widget implemented as a single source file under src/widgets/.'
    log_required: false
    when:
      path: "src/widgets/**"
    parents: [module]
    aspects:
      - no-todo-comments
`,
    'utf-8',
  );

  // Deterministic aspect: flags any line containing the token TODO. Pure text
  // scan, no AST, no network — the same shape the e2e-lifecycle fixture uses.
  writeFileSync(
    path.join(yggRoot, 'aspects', 'no-todo-comments', 'yg-aspect.yaml'),
    `name: NoTodoComments
description: Source files must not contain TODO comments.
reviewer:
  type: deterministic
status: enforced
`,
    'utf-8',
  );
  writeFileSync(
    path.join(yggRoot, 'aspects', 'no-todo-comments', 'check.mjs'),
    `export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    const lines = file.content.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('TODO')) {
        violations.push({ file: file.path, line: i + 1, column: 0, message: 'TODO found.' });
      }
    }
  }
  return violations;
}
`,
    'utf-8',
  );

  writeFileSync(
    path.join(yggRoot, 'model', 'widgets', 'yg-node.yaml'),
    `name: Widgets
description: Organizational parent grouping the application's widgets.
type: module
`,
    'utf-8',
  );
  writeFileSync(
    path.join(yggRoot, 'model', 'widgets', 'widget', 'yg-node.yaml'),
    `name: Widget
description: A single widget unit.
type: widget
mapping:
  - src/widgets/widget.ts
`,
    'utf-8',
  );

  writeFileSync(
    path.join(dir, 'src', 'widgets', 'widget.ts'),
    `export function widget() {
  return 'ok';
}
`,
    'utf-8',
  );

  return dir;
}

/**
 * A bare repo for the --upgrade scaffold path: just .yggdrasil/yg-config.yaml
 * carrying a version field (the minimum --upgrade needs to detect a version and
 * refresh rules). No nodes, no architecture.
 */
function bareUpgradeRepo(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-upg-${label}-`));
  const yggRoot = path.join(dir, '.yggdrasil');
  mkdirSync(yggRoot, { recursive: true });
  writeFileSync(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.2.0"\n', 'utf-8');
  return dir;
}

describe.skipIf(!distExists)('CLI E2E — greenfield / init / platform-install', () => {
  // -------------------------------------------------------------------------
  // 1. Universal install via --upgrade on a bare repo (headless path).
  //
  // The thirteen per-platform installers (and their platform-specific
  // artifacts — .cursor/rules/yggdrasil.mdc, GEMINI.md, .yggdrasil/agent-
  // rules.md, ...) are RETIRED. Every agent now reads the SAME three
  // artifacts: an AGENTS.md digest block, a CLAUDE.md @AGENTS.md import, and
  // .clinerules/yggdrasil.md — so there is no platform matrix left to drive.
  // `--platform` is still ACCEPTED for backward compatibility (any value,
  // including a name from the retired matrix): it only prints a deprecation
  // notice and otherwise changes nothing about what gets installed. The full
  // E1-E9/E12 matrix (fresh/upgrade/CRLF/duplicated-block/staleness-gate/prime)
  // lives in cli-universal-install.test.ts; these two scenarios keep this
  // suite's own bare-repo --upgrade coverage.
  // -------------------------------------------------------------------------

  it('bare init --upgrade scaffolds the universal artifacts on a bare repo (exit 0)', () => {
    const dir = bareUpgradeRepo('universal-scaffold');
    try {
      const { status, stdout } = run(['init', '--upgrade'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Agent rules installed/updated: AGENTS.md, CLAUDE.md, .clinerules/yggdrasil.md');
      expect(existsSync(path.join(dir, 'AGENTS.md'))).toBe(true);
      expect(existsSync(path.join(dir, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(path.join(dir, '.clinerules', 'yggdrasil.md'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the ignore rules a real init installs actually hide a rotated verdict-events sidecar from git', () => {
    // The local sidecar keeps a refusal's full reason text, which the committed
    // stream deliberately strips — so a rotated copy of it must never become
    // committable in a project that installed these rules.
    //
    // Asking git itself, rather than matching the installed file's text, is what
    // makes this worth having: a pattern can be written correctly and still fail
    // to match, and it is the matching that the shipped configuration manual
    // promises. Both the live name and its rotation are checked, because only
    // the rotation distinguishes a bare filename from a covering pattern.
    const dir = bareUpgradeRepo('gitignore-effect');
    try {
      expect(run(['init', '--upgrade'], dir).status).toBe(0);
      spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf-8' });

      for (const name of ['.yg-events.jsonl', '.yg-events.jsonl.1']) {
        writeFileSync(path.join(dir, '.yggdrasil', name), '{}\n', 'utf-8');
        const probe = spawnSync('git', ['check-ignore', '-q', path.join('.yggdrasil', name)], { cwd: dir });
        expect(probe.status, `${name} must be ignored by the installed rules`).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('init --upgrade --platform codex prints a deprecation notice and still writes the SAME universal artifacts (no per-platform file)', () => {
    const dir = bareUpgradeRepo('deprecated-platform');
    try {
      const { status, stdout } = run(['init', '--upgrade', '--platform', 'codex'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('--platform codex is deprecated and was ignored');
      expect(existsSync(path.join(dir, 'AGENTS.md'))).toBe(true);
      expect(existsSync(path.join(dir, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(path.join(dir, '.clinerules', 'yggdrasil.md'))).toBe(true);
      // No per-platform artifact — codex used to get its own embedded block
      // with no shared rules file; now every agent reads the same files.
      expect(existsSync(path.join(dir, '.yggdrasil', 'agent-rules.md'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 3. Greenfield lifecycle: graph before verification, through the real binary.
  //    A hand-authored deterministic graph proves the unverified -> fill ->
  //    verified progression without any LLM call. Verification now happens via
  //    `yg check --approve` (the fill), and state lives in the 5.1.0 lock triad
  //    (deterministic verdicts in the gitignored
  //    `.yggdrasil/.yg-lock.deterministic.json`; the per-node `.drift-state/`
  //    files are gone).
  // -------------------------------------------------------------------------

  it('G7: greenfield check reports the node as unverified, then fill -> check clean', () => {
    const dir = greenfieldGraph('lifecycle');
    try {
      // (a) Never filled -> exit 1, the deterministic pair reported as
      // `unverified` with guidance pointing at the fill.
      const before = run(['check'], dir);
      expect(before.status).toBe(1);
      expect(before.stdout).toContain('unverified (not yet reviewed)');
      expect(before.stdout).toContain('widgets/widget');
      // Grouped view: the unverified pair surfaces as a group for the aspect with
      // the node listed and the fill command as the fix.
      expect(before.stdout).toContain("aspect 'no-todo-comments'");
      expect(before.stdout).toContain('- widgets/widget');
      expect(before.stdout).toContain('yg check --approve');

      // (b) Fill -> exit 0, the deterministic verdict recorded into the lock.
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      // Fill-time progress ([det] line) goes to STDERR; final report to STDOUT.
      expect(fill.stdout).toContain('yg check: PASS');
      // The deterministic verdict lands in the gitignored det file of the 5.1.0
      // triad, and the merged lock (readLock) carries it as an `approved` verdict.
      expect(existsSync(path.join(dir, '.yggdrasil', '.yg-lock.deterministic.json'))).toBe(true);
      const lock = readLock(path.join(dir, '.yggdrasil'));
      expect(lock.verdicts['no-todo-comments']?.['node:widgets/widget']?.verdict).toBe('approved');

      // (c) Re-check -> clean (exit 0), verdict held.
      const after = run(['check'], dir);
      expect(after.status).toBe(0);
      expect(after.stdout).toContain('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('G8: a TODO introduced after a clean fill refuses the enforced aspect at re-fill (exit 1)', () => {
    const dir = greenfieldGraph('todo-refuse');
    try {
      // First fill records a clean (approved) verdict.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      // Introduce the deterministic violation, invalidating the verdict.
      const src = path.join(dir, 'src', 'widgets', 'widget.ts');
      writeFileSync(src, readFileSync(src, 'utf-8') + '\n// TODO: revisit\n', 'utf-8');
      // Re-fill: the deterministic check now refuses the enforced aspect.
      const refused = run(['check', '--approve'], dir);
      expect(refused.status).toBe(1);
      // Fill-time progress ([det] line) goes to STDERR; grouped report to STDOUT.
      expect(refused.stderr).toContain('[det] no-todo-comments on node:widgets/widget — refused');
      // Grouped view: an enforced refusal group for the aspect; the per-member
      // `Violations:` tail (FULL_WHAT detail) is retained and names the TODO site.
      expect(refused.stdout).toContain("enforced  1 pairs  1 nodes  aspect 'no-todo-comments'");
      expect(refused.stdout).toContain('A deterministic check recorded these violations');
      expect(refused.stdout).toContain('- widgets/widget  Violations:');
      expect(refused.stdout).toContain('TODO found.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 4. Empty / no-node repo: config + architecture but ZERO nodes.
  //    Documented behavior: yg check passes clean (nothing to verify), does
  //    NOT crash. Asserted as exit 0 with a "0 nodes" summary.
  // -------------------------------------------------------------------------

  it('G9: a repo with config + architecture but no nodes passes check cleanly (exit 0)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-empty-graph-'));
    const yggRoot = path.join(dir, '.yggdrasil');
    try {
      mkdirSync(path.join(yggRoot, 'model'), { recursive: true });
      mkdirSync(path.join(yggRoot, 'aspects'), { recursive: true });
      mkdirSync(path.join(yggRoot, 'flows'), { recursive: true });
      writeFileSync(path.join(yggRoot, 'yg-config.yaml'), MINIMAL_CONFIG, 'utf-8');
      writeFileSync(
        path.join(yggRoot, 'yg-architecture.yaml'),
        `node_types:
  module:
    description: 'Organizational grouping. Parent-only.'
    log_required: false
`,
        'utf-8',
      );

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('PASS');
      expect(stdout).toContain('0 nodes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 5. Init guards (headless). cli-lifecycle already covers `--upgrade` with no
  //    --platform, `--upgrade` with no .yggdrasil/, and fresh `yg init` in a
  //    non-TTY. These EXTEND with the cases it does not:
  //      - an unknown --platform value
  //      - --upgrade against a config with no `version:` field
  // -------------------------------------------------------------------------

  it('G10: init --upgrade with an unrecognized --platform value is accepted — deprecation notice, upgrade proceeds (retired: used to be rejected)', () => {
    const dir = bareUpgradeRepo('bad-platform');
    try {
      const { status, stdout } = run(['init', '--upgrade', '--platform', 'bogus-xyz'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('--platform bogus-xyz is deprecated and was ignored');
      expect(existsSync(path.join(dir, 'AGENTS.md'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('G11: init --upgrade on a config with no version field is rejected (exit 1)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-no-version-'));
    const yggRoot = path.join(dir, '.yggdrasil');
    try {
      mkdirSync(yggRoot, { recursive: true });
      // Config present but missing the `version:` field.
      writeFileSync(
        path.join(yggRoot, 'yg-config.yaml'),
        'quality:\n  max_direct_relations: 10\n',
        'utf-8',
      );
      const { status, stderr } = run(['init', '--upgrade', '--platform', 'generic'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain('No graph version detected');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 6. Non-interactive fresh init (Docker / devcontainer / CI bootstrap).
  //    A fresh empty dir + --provider routes to the prompt-free write-path
  //    (the wizard hard-fails in a non-TTY, which spawnSync is). These drive
  //    the FULL headless bootstrap and the green-from-first-check contract
  //    through the real binary.
  // -------------------------------------------------------------------------

  it('G12: non-interactive fresh init writes a require-nothing config and the first check is green', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-noninteractive-'));
    try {
      const init = run(['init', '--platform', 'claude-code', '--provider', 'claude-code', '--model', 'haiku'], dir);
      expect(init.status).toBe(0);
      expect(init.stdout).toContain('Yggdrasil initialized');
      const cfg = readFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), 'utf-8');
      // Fresh config opts into require-nothing coverage and records the named tier.
      expect(cfg).toContain('coverage:');
      expect(cfg).toMatch(/required:\s*\[\]/);
      expect(cfg).toContain('provider: claude-code');
      expect(cfg).toContain('model: haiku');
      // The very first check on the untouched repo is GREEN (unmapped files are
      // non-blocking warnings, not blocking errors).
      const check = run(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('PASS');
      expect(check.stdout).toContain('uncovered');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // G13 ("claude-code without --model defaults to sonnet") and G13b ("codex
  // without --model is rejected") moved to the dedicated pure-CLI init e2e
  // suite (cli-init-pure-cli.test.ts), which is now their canonical home —
  // every assertion from both cases (stdout message, provider/model written,
  // and the "nothing written on rejection" check) is preserved there.

  it('G14: non-interactive init with --provider but no --platform now succeeds standalone (retired: used to require --platform)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-noninteractive-noplatform-'));
    try {
      const { status, stdout } = run(['init', '--provider', 'claude-code', '--model', 'haiku'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Yggdrasil initialized');
      const cfg = readFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), 'utf-8');
      expect(cfg).toContain('provider: claude-code');
      expect(cfg).toContain('model: haiku');
      // The universal artifacts are installed too — no --platform required.
      expect(existsSync(path.join(dir, 'AGENTS.md'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('G15: non-interactive init with an unknown --provider is rejected (exit 1)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-noninteractive-badprovider-'));
    try {
      const { status, stderr } = run(['init', '--platform', 'claude-code', '--provider', 'bogus-xyz', '--model', 'x'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain("Unknown provider 'bogus-xyz'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
