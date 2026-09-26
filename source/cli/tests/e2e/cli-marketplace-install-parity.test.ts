// =============================================================================
// CLI E2E — `yg marketplace check` passes ⇒ `yg pack add` installs.
//
// The check is what a publisher runs before anyone installs, so it is only worth
// something if a package it passes is a package that installs. This suite holds
// the two commands to that as a property over a matrix of packages, each broken
// in one way an install cares about: for every variant, when the check exits 0
// the install must exit 0 too. Each malformed variant is also asserted to fail
// BOTH commands, so the property is never satisfied vacuously by a check that
// happens to refuse everything, or by an install that happens to accept it.
//
// ZERO NETWORK: every marketplace is a plain directory built here, installed
// from by path with --as, into a fresh copy of the pack-consumer fixture.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, cpSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_RM_OPTIONS, runGitFixture } from '../support/git-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const CONSUMER = path.join(CLI_ROOT, 'tests', 'fixtures', 'pack-consumer');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { status: number | null; all: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  return { status: r.status, all: (r.stdout ?? '') + (r.stderr ?? '') };
}

/** A marketplace publishing one package, `demo`, with one deterministic rule and its two cases. */
const GOOD: Record<string, string> = {
  'yg-marketplace.yaml': 'schema: yg-marketplace/1\npackages:\n  - name: demo\n    path: packages/demo\n    version: 1.0.0\n',
  'packages/demo/yg-package.yaml':
    'schema: yg-package/1\nname: demo\nversion: 1.0.0\nrequires:\n  yg: ">=6.0.0"\naspects:\n  - rule\n',
  'packages/demo/rule/yg-aspect.yaml':
    'name: TheRule\ndescription: A rule that refuses nothing, so the test is about everything else.\nreviewer:\n  type: deterministic\n',
  'packages/demo/rule/check.mjs': 'export function check(ctx) {\n  return [];\n}\n',
  'packages/demo/rule/drills/violates-bad/src/a.ts': 'export const a = 1;\n',
  'packages/demo/rule/drills/satisfies-good/src/a.ts': 'export const a = 2;\n',
};

interface Variant {
  name: string;
  /** Files to add or replace; null removes one. */
  patch?: Record<string, string | null>;
  /** Anything a text patch cannot express, done to the built marketplace. */
  after?: (dir: string) => void;
  /**
   * How git holds the marketplace: not at all (the default), as the root of a
   * repository with the version tagged — what `pack add` clones — or nested
   * inside another repository's working tree, which `pack add` copies from disk.
   */
  git?: 'root' | 'nested';
  /** Whether the package is sound (both commands pass) or broken (both refuse). */
  sound: boolean;
}

const VARIANTS: Variant[] = [
  { name: 'nothing wrong', sound: true },
  { name: 'a dot-directory beside the rules', patch: { 'packages/demo/.cache/state.json': '{}\n' }, sound: true },
  {
    name: 'versions that disagree',
    patch: { 'yg-marketplace.yaml': GOOD['yg-marketplace.yaml'].replace('version: 1.0.0', 'version: 1.0.1') },
    sound: false,
  },
  {
    name: 'a Yggdrasil the package does not accept',
    patch: { 'packages/demo/yg-package.yaml': GOOD['packages/demo/yg-package.yaml'].replace('>=6.0.0', '>=99.0.0') },
    sound: false,
  },
  {
    name: 'a binary file',
    after: (dir) => writeFileSync(path.join(dir, 'packages', 'demo', 'rule', 'blob.bin'), Buffer.from([0x50, 0x00, 0x4b])),
    sound: false,
  },
  ...(platform() === 'win32'
    ? []
    : [{
        name: 'a symbolic link',
        after: (dir: string): void => symlinkSync('check.mjs', path.join(dir, 'packages', 'demo', 'rule', 'linked.mjs')),
        sound: false,
      }]),
  { name: 'a node_modules directory', patch: { 'packages/demo/node_modules/dep/index.js': 'export {};\n' }, sound: false },
  { name: 'a directory the manifest does not declare', patch: { 'packages/demo/extra/notes.txt': 'x\n' }, sound: false },
  {
    // Git ignores the directory and the install clones the tag, so the binary
    // inside it never reaches a consumer.
    name: 'an ignored node_modules at the root of a git repository',
    patch: { '.gitignore': 'node_modules/\n' },
    after: (dir) => {
      mkdirSync(path.join(dir, 'packages', 'demo', 'node_modules', 'dep'), { recursive: true });
      writeFileSync(path.join(dir, 'packages', 'demo', 'node_modules', 'dep', 'blob.bin'), Buffer.from([0x50, 0x00]));
    },
    git: 'root',
    sound: true,
  },
  {
    // The same ignored directory, but the marketplace sits INSIDE another
    // repository: pack add copies it from disk, node_modules and all.
    name: 'an ignored node_modules in a marketplace nested inside a repository',
    after: (dir) => {
      mkdirSync(path.join(dir, 'packages', 'demo', 'node_modules', 'dep'), { recursive: true });
      writeFileSync(path.join(dir, 'packages', 'demo', 'node_modules', 'dep', 'blob.bin'), Buffer.from([0x50, 0x00]));
    },
    git: 'nested',
    sound: false,
  },
  {
    name: 'a name the two manifests disagree on',
    patch: { 'packages/demo/yg-package.yaml': GOOD['packages/demo/yg-package.yaml'].replace('name: demo', 'name: other') },
    sound: false,
  },
  {
    name: 'a declared rule directory that is not there',
    patch: { 'packages/demo/yg-package.yaml': GOOD['packages/demo/yg-package.yaml'].replace('  - rule\n', '  - rule\n  - ghost\n') },
    sound: false,
  },
];

/** Build the variant's marketplace; returns the directory to remove afterwards and the marketplace inside it. */
function build(variant: Variant): { cleanup: string; market: string } {
  const cleanup = mkdtempSync(path.join(tmpdir(), 'yg-mkt-parity-'));
  const dir = variant.git === 'nested' ? path.join(cleanup, 'market') : cleanup;
  const files: Record<string, string | null> = { ...GOOD, ...(variant.patch ?? {}) };
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) continue;
    const abs = path.join(dir, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf-8');
  }
  variant.after?.(dir);
  if (variant.git === 'root') {
    for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'publish'], ['tag', 'pack/demo@1.0.0']]) {
      expect(runGitFixture(dir, args).status).toBe(0);
    }
  } else if (variant.git === 'nested') {
    writeFileSync(path.join(cleanup, '.gitignore'), 'node_modules/\n', 'utf-8');
    expect(runGitFixture(cleanup, ['init', '-q']).status).toBe(0);
  }
  return { cleanup, market: dir };
}

describe.skipIf(!distExists)('CLI E2E — marketplace check passes ⇒ pack add installs', () => {
  for (const variant of VARIANTS) {
    it(`${variant.sound ? 'installs' : 'refused by both'}: ${variant.name}`, () => {
      const { cleanup, market } = build(variant);
      const consumer = mkdtempSync(path.join(tmpdir(), 'yg-mkt-parity-consumer-'));
      try {
        cpSync(CONSUMER, consumer, { recursive: true });
        const checked = run(['marketplace', 'check'], market);
        const added = run(['pack', 'add', `${market}#demo`, '--as', 'acme/law'], consumer);

        // The property: a package the check passes is one that installs.
        if (checked.status === 0) expect({ variant: variant.name, add: added.status, said: added.all }).toMatchObject({ add: 0 });

        // And the variant is what it claims to be, so the property is not vacuous.
        expect({ variant: variant.name, check: checked.status, said: checked.all }).toMatchObject({ check: variant.sound ? 0 : 1 });
        expect({ variant: variant.name, add: added.status, said: added.all }).toMatchObject({ add: variant.sound ? 0 : 1 });
      } finally {
        rmSync(cleanup, FIXTURE_RM_OPTIONS);
        rmSync(consumer, FIXTURE_RM_OPTIONS);
      }
    });
  }
});
