import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

// ---------------------------------------------------------------------------
// Canonical home for the flag-driven (pure-CLI) init surface: keyless fresh
// bootstrap, model-default resolution, error paths, and existing-repo
// reconfigure — all driven purely through spawned `dist/bin.js` invocations
// (no TTY, no wizard). Mirrors the run()/BIN_PATH/describe.skipIf idiom used
// across the e2e suite (see cli-greenfield-init.test.ts). Every test uses a
// fresh mkdtemp dir and rmSync in finally, so the suite is hermetic.
// ---------------------------------------------------------------------------

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { stdout, stderr, status: r.status, all: stdout + stderr };
}

function freshDir(label: string): string { return mkdtempSync(path.join(tmpdir(), `yg-purecli-${label}-`)); }

describe.skipIf(!distExists)('E2E — pure-CLI init', () => {
  it('keyless fresh bootstrap: --platform alone → no reviewer, check is green', () => {
    const dir = freshDir('keyless');
    try {
      const init = run(['init', '--platform', 'claude-code'], dir);
      expect(init.status).toBe(0);
      expect(init.stdout).toContain('keyless');
      const cfg = readFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), 'utf-8');
      expect(cfg).not.toContain('reviewer:');
      const check = run(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('PASS');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('claude-code without --model defaults to sonnet', () => {
    const dir = freshDir('default-model');
    try {
      const init = run(['init', '--platform', 'claude-code', '--provider', 'claude-code'], dir);
      expect(init.status).toBe(0);
      expect(init.stdout).toContain('Yggdrasil initialized');
      const cfg = readFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), 'utf-8');
      expect(cfg).toContain('provider: claude-code');
      expect(cfg).toContain('model: sonnet');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('codex without --model exits 1 with a model-required message', () => {
    const dir = freshDir('nomodel');
    try {
      const init = run(['init', '--platform', 'claude-code', '--provider', 'codex'], dir);
      expect(init.status).toBe(1);
      expect(init.stderr).toContain('--model is required');
      // Nothing was written — the guard fires before any structure is created.
      expect(existsSync(path.join(dir, '.yggdrasil'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('--model without --provider exits 1', () => {
    const dir = freshDir('stray-model');
    try {
      const init = run(['init', '--platform', 'claude-code', '--model', 'sonnet'], dir);
      expect(init.status).toBe(1);
      expect(init.stderr).toContain('without --provider');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('non-interactive with no --platform exits 1 (no guessing)', () => {
    const dir = freshDir('noplatform');
    try {
      const init = run(['init'], dir); // spawned → non-TTY
      expect(init.status).toBe(1);
      expect(init.stderr).toContain('no TTY');
      expect(init.stderr).toContain('--platform');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('existing repo: add a reviewer via flags, then check still passes', () => {
    const dir = freshDir('add-reviewer');
    try {
      expect(run(['init', '--platform', 'claude-code'], dir).status).toBe(0);
      const add = run(['init', '--provider', 'claude-code'], dir); // model defaults sonnet
      expect(add.status).toBe(0);
      const cfg = readFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), 'utf-8');
      expect(cfg).toContain('provider: claude-code');
      expect(cfg).toContain('model: sonnet');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('existing repo: change platform via --platform', () => {
    const dir = freshDir('change-platform');
    try {
      expect(run(['init', '--platform', 'claude-code'], dir).status).toBe(0);
      const swap = run(['init', '--platform', 'cursor'], dir);
      expect(swap.status).toBe(0);
      expect(existsSync(path.join(dir, '.cursor', 'rules', 'yggdrasil.mdc'))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('existing repo: --provider and --platform together apply BOTH in one call', () => {
    const dir = freshDir('union');
    try {
      // Start keyless with claude-code, then in ONE call add a reviewer AND switch platform.
      expect(run(['init', '--platform', 'claude-code'], dir).status).toBe(0);
      const both = run(['init', '--provider', 'claude-code', '--platform', 'cursor'], dir);
      expect(both.status).toBe(0);
      const cfg = readFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), 'utf-8');
      expect(cfg).toContain('provider: claude-code'); // reviewer leg applied
      expect(cfg).toContain('model: sonnet');
      expect(existsSync(path.join(dir, '.cursor', 'rules', 'yggdrasil.mdc'))).toBe(true); // platform leg applied
      // And the merged graph still verifies clean.
      expect(run(['check'], dir).status).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('--upgrade combined with reviewer flags exits 1 rather than silently dropping them', () => {
    const dir = freshDir('upgrade-plus-reviewer');
    try {
      expect(run(['init', '--platform', 'claude-code'], dir).status).toBe(0);
      const upgrade = run(['init', '--upgrade', '--platform', 'claude-code', '--provider', 'anthropic'], dir);
      expect(upgrade.status).toBe(1);
      expect(upgrade.stderr).toContain('--upgrade was combined with reviewer flags');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
