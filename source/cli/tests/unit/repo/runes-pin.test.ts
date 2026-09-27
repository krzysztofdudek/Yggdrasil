/**
 * Yggdrasil takes its relation extractors, parser host and grammar recipe from @chrisdudek/runes,
 * installed at one exact version and never bundled. The installed version must be the pin: the
 * version package.json names, the lock records and the code actually loads. And the build must
 * leave Runes external, or a bumped pin would ship the old copy inside dist/.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { version as RUNES_RELATIONS_VERSION } from '@chrisdudek/runes/relations';
import { version as RUNES_AST_VERSION } from '@chrisdudek/runes/ast';
import { version as RUNES_GRAMMARS_VERSION } from '@chrisdudek/runes/grammars';
// @ts-expect-error — plain ESM build script, no type declarations.
import { runesPinProblems } from '../../../scripts/runes-pin.mjs';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PKG = '@chrisdudek/runes';
const COMMIT = 'a'.repeat(40);
const ARCHIVE = `https://codeload.github.com/krzysztofdudek/Runes/tar.gz/${COMMIT}`;
const REGISTRY = (v: string) => `https://registry.npmjs.org/${PKG}/-/runes-${v}.tgz`;

describe('the Runes pin of this package', () => {
  it('holds: exact version in package.json, the same in the lock, installed, and loaded', () => {
    expect(runesPinProblems(CLI_ROOT, { runtimeVersion: RUNES_RELATIONS_VERSION })).toEqual([]);
    const pinned = JSON.parse(readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8')).dependencies[PKG];
    // one version covers every subpath Yggdrasil imports
    expect([RUNES_RELATIONS_VERSION, RUNES_AST_VERSION, RUNES_GRAMMARS_VERSION]).toEqual([pinned, pinned, pinned]);
  });

  const bin = path.join(CLI_ROOT, 'dist/bin.js');
  it.skipIf(!existsSync(bin))('is not bundled: the built CLI imports Runes and carries no copy of it', () => {
    for (const entry of ['bin.js', 'ast.js', 'structure.js', 'det-worker.js']) {
      const code = readFileSync(path.join(CLI_ROOT, 'dist', entry), 'utf8');
      expect(code, entry).not.toMatch(/function createParserHost\b/);
      expect(code, entry).not.toMatch(/class SymbolTable\b/);
    }
    expect(readFileSync(bin, 'utf8')).toMatch(/from ["']@chrisdudek\/runes\/relations["']/);
    expect(readFileSync(bin, 'utf8')).toMatch(/from ["']@chrisdudek\/runes\/ast["']/);
  });
});

describe('runesPinProblems', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'yg-runes-pin-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function fixture(o: { spec?: string; rootSpec?: string; locked?: string; resolved?: string; integrity?: string | null; installed?: string | null; dev?: boolean }) {
    const spec = o.spec ?? '1.2.3';
    rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
    const pkg: Record<string, unknown> = { name: 'x', dependencies: { [PKG]: spec } };
    if (o.dev) pkg.devDependencies = { [PKG]: spec };
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    const entry: Record<string, unknown> = { version: o.locked ?? '1.2.3', resolved: o.resolved ?? ARCHIVE };
    if (o.integrity !== null) entry.integrity = o.integrity ?? 'sha512-abc';
    writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
      packages: { '': { dependencies: { [PKG]: o.rootSpec ?? spec } }, [`node_modules/${PKG}`]: entry },
    }));
    if (o.installed !== null) {
      mkdirSync(path.join(dir, 'node_modules', PKG), { recursive: true });
      writeFileSync(path.join(dir, 'node_modules', PKG, 'package.json'), JSON.stringify({ name: PKG, version: o.installed ?? '1.2.3' }));
    }
  }

  it('passes the GitHub archive of a commit before Runes is on npm, and the registry tarball after', () => {
    fixture({});
    expect(runesPinProblems(dir, { runtimeVersion: '1.2.3' })).toEqual([]);
    fixture({ resolved: REGISTRY('1.2.3') });
    expect(runesPinProblems(dir, { runtimeVersion: '1.2.3', publish: true })).toEqual([]);
  });

  it('refuses to publish while the lock still takes Runes from the GitHub archive', () => {
    fixture({});
    expect(runesPinProblems(dir, { publish: true }).join('\n')).toMatch(/publish Runes 1\.2\.3 to npm first/);
  });

  it('refuses a range, a lock or an install at another version, and a loaded copy at another version', () => {
    fixture({ spec: '^1.2.3', rootSpec: '^1.2.3' });
    expect(runesPinProblems(dir).join('\n')).toMatch(/not an exact version/);
    fixture({ locked: '1.2.4' });
    expect(runesPinProblems(dir).join('\n')).toMatch(/locks @chrisdudek\/runes 1\.2\.4, package\.json pins 1\.2\.3/);
    fixture({ rootSpec: '1.2.4' });
    expect(runesPinProblems(dir).join('\n')).toMatch(/records @chrisdudek\/runes "1\.2\.4" for the root/);
    fixture({ installed: '1.2.2' });
    expect(runesPinProblems(dir).join('\n')).toMatch(/node_modules holds @chrisdudek\/runes 1\.2\.2/);
    fixture({ installed: null });
    expect(runesPinProblems(dir).join('\n')).toMatch(/is not installed/);
    fixture({});
    expect(runesPinProblems(dir, { runtimeVersion: '1.2.2' }).join('\n')).toMatch(/the code loads @chrisdudek\/runes 1\.2\.2/);
  });

  it('refuses any other source, a missing integrity hash, and a second listing', () => {
    fixture({ resolved: 'https://codeload.github.com/someone-else/Runes/tar.gz/' + COMMIT });
    expect(runesPinProblems(dir).join('\n')).toMatch(/only the npm registry tarball/);
    fixture({ resolved: REGISTRY('1.2.2') });
    expect(runesPinProblems(dir).join('\n')).toMatch(/only the npm registry tarball of 1\.2\.3/);
    fixture({ integrity: null });
    expect(runesPinProblems(dir).join('\n')).toMatch(/no sha512 integrity/);
    fixture({ dev: true });
    expect(runesPinProblems(dir).join('\n')).toMatch(/in devDependencies as well/);
  });
});
