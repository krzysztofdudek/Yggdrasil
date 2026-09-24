// =============================================================================
// An unknown top-level configuration key — in the committed yg-config.yaml or
// in the local, gitignored yg-secrets.yaml — is reported as a blocking
// `config-unknown-key` error that names the file, the key and the key it
// probably meant, while the REST of the configuration stays in effect.
//
// Before, the key made the whole configuration fall back to its defaults: the
// coverage exclusions vanished (false `unmapped` errors), the reviewer vanished
// (a false "no reviewer configured"), recorded LLM verdicts stopped counting,
// and `next:` sent the user to map files. In the local overlay nobody else could
// reproduce any of it, because CI never sees that file.
//
// Drives the built binary against a copy of examples/passing (two mapped
// components, a claude-code tier, one committed LLM verdict).
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const REPO_ROOT = path.join(CLI_ROOT, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const EXAMPLE = path.join(REPO_ROOT, 'examples', 'passing');

interface Issue { code: string; severity: string; what: string; why: string; next: string }
interface CheckDoc {
  exit: { code: number };
  issues: Issue[];
  pairs: Array<{ aspect: string; verdict: string }>;
  next: { text: string };
}

let dir: string;

function git(...args: string[]): void {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

function yg(...args: string[]): { out: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd: dir, encoding: 'utf-8', env: { ...process.env, CI: '' } });
  return { out: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}

function checkJson(): CheckDoc {
  const r = spawnSync('node', [BIN_PATH, 'check', '--no-approve', '--json'], { cwd: dir, encoding: 'utf-8' });
  return JSON.parse(r.stdout) as CheckDoc;
}

function appendToConfig(text: string): void {
  const p = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  writeFileSync(p, readFileSync(p, 'utf-8') + text, 'utf-8');
}

describe.skipIf(!existsSync(BIN_PATH))('config-unknown-key keeps the rest of the configuration', () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'yg-cfgkey-'));
    cpSync(EXAMPLE, dir, { recursive: true });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'init');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('baseline: the example passes', () => {
    const doc = checkJson();
    expect(doc.exit.code).toBe(0);
  });

  it('a typo key in the local yg-secrets.yaml is the only finding, and next: names it', () => {
    writeFileSync(path.join(dir, '.yggdrasil', 'yg-secrets.yaml'), 'reviwer:\n  tiers: {}\n', 'utf-8');
    const doc = checkJson();
    expect(doc.exit.code).toBe(1);
    expect(doc.issues.map((i) => i.code)).toEqual(['config-unknown-key']);
    const issue = doc.issues[0];
    expect(issue.what).toContain('.yggdrasil/yg-secrets.yaml');
    expect(issue.what).toContain("'reviwer'");
    expect(issue.next).toContain("Did you mean 'reviewer'?");
    // The recorded LLM verdict still counts: the reviewer configuration held.
    expect(doc.pairs.map((p) => p.verdict)).toEqual(['approved']);
    expect(doc.next.text).toContain('reviwer');
    expect(doc.next.text).toContain('yg-secrets.yaml');
  });

  it('a typo key in the committed yg-config.yaml is reported the same way', () => {
    appendToConfig('\nparalel: 4\n');
    const doc = checkJson();
    expect(doc.issues.map((i) => i.code)).toEqual(['config-unknown-key']);
    expect(doc.issues[0].what).toContain('.yggdrasil/yg-config.yaml');
    expect(doc.issues[0].next).toContain("Did you mean 'parallel'?");
    expect(doc.pairs.map((p) => p.verdict)).toEqual(['approved']);
    expect(doc.next.text).toContain('paralel');
  });

  it('reports every unknown key in both files, one finding each', () => {
    appendToConfig('\nparalel: 4\n');
    writeFileSync(path.join(dir, '.yggdrasil', 'yg-secrets.yaml'), 'reviwer: {}\ncustom_thing: 1\n', 'utf-8');
    const doc = checkJson();
    const whats = doc.issues.filter((i) => i.code === 'config-unknown-key').map((i) => i.what);
    expect(whats).toHaveLength(3);
    expect(whats.join('\n')).toMatch(/yg-config\.yaml.*'paralel'/);
    expect(whats.join('\n')).toMatch(/yg-secrets\.yaml.*'reviwer'/);
    expect(whats.join('\n')).toMatch(/yg-secrets\.yaml.*'custom_thing'/);
    expect(doc.issues.map((i) => i.code).every((c) => c === 'config-unknown-key')).toBe(true);
  });

  it('a config that does not load still ranks first in next:, ahead of the unmapped files it causes', () => {
    appendToConfig('\nparallel: -1\n');
    const doc = checkJson();
    const codes = doc.issues.map((i) => i.code);
    expect(codes).toContain('config-invalid');
    expect(doc.next.text).toContain(doc.issues.find((i) => i.code === 'config-invalid')!.next.split('\n')[0]);
  });

  it('a sub-block config error (unknown tier key) ranks first in next: too', () => {
    const p = path.join(dir, '.yggdrasil', 'yg-config.yaml');
    writeFileSync(p, readFileSync(p, 'utf-8').replace('consensus: 1', 'consensus: 1\n      concensus: 2'), 'utf-8');
    const doc = checkJson();
    const cfg = doc.issues.find((i) => i.code === 'config-tier-unknown-key');
    expect(cfg).toBeDefined();
    expect(doc.next.text).toContain(cfg!.next.split('\n')[0]);
  });

  it('yg context resolves against the kept configuration and names the key', () => {
    writeFileSync(path.join(dir, '.yggdrasil', 'yg-secrets.yaml'), 'reviwer: {}\n', 'utf-8');
    const excluded = yg('context', '--file', 'AGENTS.md');
    expect(excluded.out).toContain('excluded from graph coverage');
    expect(excluded.out).not.toContain('has no graph coverage');
    const node = yg('context', '--node', 'payments');
    expect(node.out).toContain("'reviwer'");
    expect(node.out).toContain('yg-secrets.yaml');
  });

  it('yg init --upgrade reports unknown keys in both files and no false coverage warning', () => {
    appendToConfig('\nparalel: 4\n');
    writeFileSync(path.join(dir, '.yggdrasil', 'yg-secrets.yaml'), 'reviwer: {}\n', 'utf-8');
    const r = yg('init', '--upgrade');
    expect(r.out).toMatch(/yg-config\.yaml.*'paralel'/);
    expect(r.out).toMatch(/yg-secrets\.yaml.*'reviwer'/);
    expect(r.out).toContain("Did you mean 'parallel'?");
    expect(r.out).toContain("Did you mean 'reviewer'?");
    expect(r.out).not.toContain('belong to none');
  });
});
