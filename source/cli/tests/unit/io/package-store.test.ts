// =============================================================================
// Unit — the package store: copying a package in, the adapt stub written beside
// each rule, the record of what was copied, the lock that keeps two pack
// commands from writing that record at once, and reading an installed copy back.
//
// Everything runs against real directories under the OS temp dir; nothing is
// mocked. Permission-based failures (a read-only directory) are skipped when the
// suite runs as root, which ignores the permission bits being relied on.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, symlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  acquirePackCommandLock,
  hashAspectsRelativeFile,
  hashPackageTree,
  installPackage,
  listAllPackageFiles,
  listInstalledFiles,
  listPackageAspectDirs,
  PackCommandBusyError,
  readInstalledAdapts,
  removePackageFiles,
  renderAdaptStub,
  renderPackagesLock,
  sweepFetchStagingDirs,
} from '../../../src/io/package-store.js';
import type { PackageManifest, PackagesLock } from '../../../src/model/packages.js';

const IS_ROOT = process.getuid?.() === 0;
const POSIX = process.platform !== 'win32';

const dirs: string[] = [];
const toRestore: string[] = [];
afterEach(() => {
  for (const d of toRestore.splice(0)) chmodSync(d, 0o755);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-store-${label}-`));
  dirs.push(dir);
  return dir;
}

function readOnly(dir: string): void {
  chmodSync(dir, 0o555);
  toRestore.push(dir);
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, ...rel.split('/'));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

const EMPTY_LOCK: PackagesLock = { schema: 'yg-packages/1', packages: {} };

/** A package with one rule of each kind: deterministic, LLM-judged, and aggregate. */
function packageSource(): string {
  const src = scratch('src');
  write(src, 'yg-package.yaml', 'schema: yg-package/1\n');
  write(src, 'det-rule/yg-aspect.yaml', 'name: det\n');
  write(src, 'det-rule/check.mjs', 'export default () => [];\n');
  write(src, 'det-rule/drills/case-1/input.ts', 'x\n');
  write(src, 'llm-rule/yg-aspect.yaml', 'name: llm\n');
  write(src, 'llm-rule/content.md', 'Judge it.\n');
  write(src, 'agg-rule/yg-aspect.yaml', 'name: agg\nimplies: [det-rule, llm-rule]\n');
  write(src, '.git/HEAD', 'ref: refs/heads/main\n');
  write(src, 'llm-rule/.notes', 'author scratch\n');
  return src;
}

const MANIFEST: PackageManifest = {
  schema: 'yg-package/1',
  name: 'demo',
  version: '1.2.0',
  requires: { yg: '6.x' },
  aspects: ['agg-rule', 'det-rule', 'llm-rule'],
  config: { 'llm-rule': { threshold: { type: 'number', default: 3 } } },
};

function install(root: string, src: string, extra: Partial<Parameters<typeof installPackage>[0]> = {}) {
  return installPackage({
    projectRoot: root,
    installId: 'acme/law/demo',
    packageRootAbs: src,
    manifest: MANIFEST,
    source: 'https://example.test/acme/law.git',
    installedAt: '2026-09-10T00:00:00.000Z',
    currentLock: EMPTY_LOCK,
    ...extra,
  });
}

const DEMO = ['.yggdrasil', 'aspects', 'packages', 'acme', 'law', 'demo'];

describe('the adapt stub offers only the keys that mean something for the rule', () => {
  it('an LLM rule offers the reviewer, references and companion', () => {
    const stub = renderAdaptStub('demo', 'llm-rule', undefined, 'llm');
    for (const key of ['scope:', 'reviewer:', 'references:', 'companion:', 'review_by:', 'status:']) expect(stub).toContain(`#   ${key}`);
    expect(stub).toContain('# This rule reads no configuration.');
    expect(stub).not.toContain('#   config:');
  });

  it('a deterministic rule offers scope but none of the reviewer-only keys', () => {
    const stub = renderAdaptStub('demo', 'det-rule', {}, 'deterministic');
    expect(stub).toContain('#   scope:');
    for (const key of ['reviewer:', 'references:', 'companion:']) expect(stub).not.toContain(`#   ${key}`);
  });

  it('an aggregate offers neither scope nor any reviewer key', () => {
    const stub = renderAdaptStub('demo', 'agg-rule', undefined, 'aggregate');
    expect(stub).not.toContain('#   scope:');
    expect(stub).not.toContain('#   reviewer:');
    expect(stub).toContain('#   status:');
  });

  it('lists every configuration key commented out at its default, sorted, typed and quoted by kind', () => {
    const stub = renderAdaptStub('demo', 'llm-rule', {
      'max-depth': { type: 'number', default: 4 },
      banner: { type: 'string', default: 'say "hi"' },
      strict: { type: 'boolean', default: false },
    });
    expect(stub).toContain('#   config:     the settings below');
    const lines = stub.split('\n');
    expect(lines.slice(lines.indexOf('# config:') + 1)).toEqual([
      '#   banner: "say \\"hi\\""    # string',
      '#   max-depth: 4    # number',
      '#   strict: false    # boolean',
      '',
    ]);
  });
});

describe('installing a package', () => {
  it('writes a stub fitted to each rule\'s kind, skips dot-entries, and records only what the package shipped', async () => {
    const root = scratch('proj');
    const result = await install(root, packageSource(), { provenance: { requested: 'latest', tag: 'pack/demo@1.2.0', commit: 'abc123' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.files).sort()).toEqual([
      'packages/acme/law/demo/agg-rule/yg-aspect.yaml',
      'packages/acme/law/demo/det-rule/check.mjs',
      'packages/acme/law/demo/det-rule/drills/case-1/input.ts',
      'packages/acme/law/demo/det-rule/yg-aspect.yaml',
      'packages/acme/law/demo/llm-rule/content.md',
      'packages/acme/law/demo/llm-rule/yg-aspect.yaml',
      'packages/acme/law/demo/yg-package.yaml',
    ]);
    expect(result.value).toMatchObject({ requested: 'latest', tag: 'pack/demo@1.2.0', commit: 'abc123', version: '1.2.0' });
    const demo = path.join(root, ...DEMO);
    expect(existsSync(path.join(demo, '.git'))).toBe(false);
    expect(existsSync(path.join(demo, 'llm-rule', '.notes'))).toBe(false);
    expect(readFileSync(path.join(demo, 'llm-rule', 'yg-aspect.adapt.yaml'), 'utf-8')).toContain('#   reviewer:');
    expect(readFileSync(path.join(demo, 'llm-rule', 'yg-aspect.adapt.yaml'), 'utf-8')).toContain('#   threshold: 3    # number');
    expect(readFileSync(path.join(demo, 'det-rule', 'yg-aspect.adapt.yaml'), 'utf-8')).not.toContain('#   reviewer:');
    expect(readFileSync(path.join(demo, 'agg-rule', 'yg-aspect.adapt.yaml'), 'utf-8')).not.toContain('#   scope:');
    // No staging or set-aside directory is left beside the copy.
    expect(readdirSync(path.join(root, '.yggdrasil', 'aspects', 'packages')).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('carries the consumer\'s rule history across a reinstall and removes the replaced copy', async () => {
    const root = scratch('proj');
    const first = packageSource();
    write(first, 'det-rule/old-only.md', 'dropped in the next version\n');
    expect((await install(root, first)).ok).toBe(true);
    const history = '## [2026-09-11T00:00:00.000Z]\nraised the threshold.\n';
    const result = await install(root, packageSource(), {
      preserveAdaptLogs: new Map([['llm-rule', history]]),
      preserveAdapts: new Map([['llm-rule', 'status: advisory\n']]),
    });
    expect(result.ok).toBe(true);
    const demo = path.join(root, ...DEMO);
    expect(readFileSync(path.join(demo, 'llm-rule', 'yg-aspect.adapt.log.md'), 'utf-8')).toBe(history);
    expect(readFileSync(path.join(demo, 'llm-rule', 'yg-aspect.adapt.yaml'), 'utf-8')).toBe('status: advisory\n');
    expect(existsSync(path.join(demo, 'det-rule', 'old-only.md'))).toBe(false);
    expect(existsSync(path.join(demo, 'det-rule', 'yg-aspect.adapt.log.md'))).toBe(false);
    expect(readdirSync(path.join(root, '.yggdrasil', 'aspects', 'packages')).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it.skipIf(IS_ROOT || !POSIX)('says which files must be writable when the record cannot be written, and leaves no copy', async () => {
    const root = scratch('proj');
    mkdirSync(path.join(root, '.yggdrasil', 'aspects', 'packages'), { recursive: true });
    readOnly(path.join(root, '.yggdrasil'));
    const result = await install(root, packageSource());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('package-install-failed');
    expect(result.messageData.why).toContain('one of them is not writable');
    expect(result.messageData.next).toContain('writable, then run the install again');
    expect(readdirSync(path.join(root, '.yggdrasil', 'aspects', 'packages'))).toEqual([]);
  });

  it.skipIf(IS_ROOT || !POSIX)('puts the record back when the previous copy cannot be set aside', async () => {
    const root = scratch('proj');
    expect((await install(root, packageSource())).ok).toBe(true);
    const before = readFileSync(path.join(root, '.yggdrasil', 'yg-packages.yaml'), 'utf-8');
    const priorLock: PackagesLock = { schema: 'yg-packages/1', packages: {} };
    // The owner/repo directory is read-only: the old copy cannot be renamed out of it.
    readOnly(path.join(root, '.yggdrasil', 'aspects', 'packages', 'acme', 'law'));
    const result = await install(root, packageSource(), { currentLock: priorLock });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.messageData.why).toContain('not writable');
    // The record is the one handed in as current, not the half-written new one.
    expect(readFileSync(path.join(root, '.yggdrasil', 'yg-packages.yaml'), 'utf-8')).toBe(renderPackagesLock(priorLock));
    expect(before).not.toBe(renderPackagesLock(priorLock));
    // The previous copy is still in place, and no staging tree survives.
    expect(existsSync(path.join(root, ...DEMO, 'det-rule', 'check.mjs'))).toBe(true);
    expect(readdirSync(path.join(root, '.yggdrasil', 'aspects', 'packages')).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('reports a failure that is not about permissions with the generic remedy', async () => {
    const root = scratch('proj');
    // The record's path is a directory, so writing it fails with EISDIR-like errors, not EACCES.
    mkdirSync(path.join(root, '.yggdrasil', 'yg-packages.yaml'), { recursive: true });
    const result = await install(root, packageSource());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.messageData.what).toContain("The package 'demo' could not be installed");
    expect(result.messageData.next).toBe('Fix the reported cause and run the install again — nothing was left behind.');
    expect(existsSync(path.join(root, ...DEMO))).toBe(false);
  });
});

describe('hashing a package tree without installing it', () => {
  it('records exactly what an install would, keyed under the install directory', async () => {
    const src = packageSource();
    const tree = await hashPackageTree(src, 'acme/law/demo');
    expect(tree.ok).toBe(true);
    const root = scratch('proj');
    const installed = await install(root, src);
    if (!tree.ok || !installed.ok) throw new Error('expected both to succeed');
    expect(tree.value).toEqual(installed.value.files);
  });

  it.skipIf(!POSIX)('refuses a symbolic link inside the package', async () => {
    const src = packageSource();
    symlinkSync('/etc/passwd', path.join(src, 'det-rule', 'secrets.txt'));
    const tree = await hashPackageTree(src, 'acme/law/demo');
    expect(tree.ok).toBe(false);
    if (!tree.ok) {
      expect(tree.code).toBe('package-symlink-refused');
      expect(tree.messageData.what).toContain("'det-rule/secrets.txt'");
    }
  });
});

describe('the aspect directories a package carries', () => {
  it('lists directories only, dot-entries skipped, sorted', async () => {
    const src = packageSource();
    expect(await listPackageAspectDirs(src)).toEqual(['agg-rule', 'det-rule', 'llm-rule']);
  });
});

describe('sweeping fetch directories a killed command left behind', () => {
  it('removes only the directories a fetch makes', async () => {
    const root = scratch('proj');
    mkdirSync(path.join(root, '.yggdrasil', 'pack-fetch-0123456789ab.tmp', 'x'), { recursive: true });
    mkdirSync(path.join(root, '.yggdrasil', 'pack-fetch-short.tmp'), { recursive: true });
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
    await sweepFetchStagingDirs(root);
    expect(readdirSync(path.join(root, '.yggdrasil')).sort()).toEqual(['model', 'pack-fetch-short.tmp']);
  });

  it('is quiet on a repository with no graph directory', async () => {
    const root = scratch('proj');
    await expect(sweepFetchStagingDirs(root)).resolves.toBeUndefined();
  });
});

describe('the lock that lets one pack command at a time change the record', () => {
  const lockFile = (root: string) => path.join(root, '.yggdrasil', 'pack-command.lock.tmp');

  it('is taken with this process\'s id and released again', async () => {
    const root = scratch('proj');
    const release = await acquirePackCommandLock(root);
    expect(readFileSync(lockFile(root), 'utf-8')).toBe(String(process.pid));
    await release();
    expect(existsSync(lockFile(root))).toBe(false);
    // Releasing twice is harmless.
    await expect(release()).resolves.toBeUndefined();
  });

  it('refuses while a running process holds it, naming that process', async () => {
    const root = scratch('proj');
    mkdirSync(path.join(root, '.yggdrasil'), { recursive: true });
    writeFileSync(lockFile(root), String(process.pid), 'utf-8');
    const err = await acquirePackCommandLock(root).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PackCommandBusyError);
    expect((err as PackCommandBusyError).holderPid).toBe(process.pid);
  });

  it.each([
    ['a process that is gone', '2147483646'],
    ['unreadable text', 'not-a-pid'],
  ])('takes over a lock left by %s', async (_label, content) => {
    const root = scratch('proj');
    mkdirSync(path.join(root, '.yggdrasil'), { recursive: true });
    writeFileSync(lockFile(root), content, 'utf-8');
    const release = await acquirePackCommandLock(root);
    expect(readFileSync(lockFile(root), 'utf-8')).toBe(String(process.pid));
    await release();
  });

  it('gives up with no holder named when the stale lock cannot be removed', async () => {
    const root = scratch('proj');
    // A directory where the lock file goes: it exists, reads as nothing, and cannot be unlinked.
    mkdirSync(lockFile(root), { recursive: true });
    const err = await acquirePackCommandLock(root).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PackCommandBusyError);
    expect((err as PackCommandBusyError).holderPid).toBeNull();
  });

  it.skipIf(IS_ROOT || !POSIX)('passes through a failure that is not contention', async () => {
    const root = scratch('proj');
    mkdirSync(path.join(root, '.yggdrasil'), { recursive: true });
    readOnly(path.join(root, '.yggdrasil'));
    const err = await acquirePackCommandLock(root).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PackCommandBusyError);
    expect((err as NodeJS.ErrnoException).code).toBe('EACCES');
  });
});

describe('removing an installed package', () => {
  it('keeps the publisher directories while a sibling package still lives there', async () => {
    const root = scratch('proj');
    const packages = path.join(root, '.yggdrasil', 'aspects', 'packages');
    write(packages, 'acme/law/demo/r/yg-aspect.yaml', 'x\n');
    write(packages, 'acme/law/other/r/yg-aspect.yaml', 'x\n');
    await removePackageFiles(root, 'acme/law/demo');
    expect(readdirSync(path.join(packages, 'acme', 'law'))).toEqual(['other']);
  });

  it('removes publisher directories left empty, stopping at packages/', async () => {
    const root = scratch('proj');
    const packages = path.join(root, '.yggdrasil', 'aspects', 'packages');
    write(packages, 'acme/law/demo/r/yg-aspect.yaml', 'x\n');
    write(packages, 'other/lib/x/r/yg-aspect.yaml', 'x\n');
    await removePackageFiles(root, 'acme/law/demo');
    expect(readdirSync(packages)).toEqual(['other']);
  });

  it('is quiet when the package was never there', async () => {
    const root = scratch('proj');
    await expect(removePackageFiles(root, 'acme/law/demo')).resolves.toBeUndefined();
  });
});

describe('reading an installed copy back', () => {
  it('reads the adapt files present and skips the rules that have none', async () => {
    const root = scratch('proj');
    write(root, [...DEMO, 'a/yg-aspect.adapt.yaml'].join('/'), 'status: advisory\n');
    mkdirSync(path.join(root, ...DEMO, 'b'), { recursive: true });
    const found = await readInstalledAdapts(root, 'acme/law/demo', ['a', 'b']);
    expect([...found.entries()]).toEqual([['a', 'status: advisory\n']]);
  });

  it('lists a package that is not there as nothing, not as an error', async () => {
    expect(await listInstalledFiles(scratch('proj'), 'acme/law/demo')).toEqual([]);
    expect(await listAllPackageFiles(scratch('proj'))).toEqual([]);
  });

  it('lists every file under the packages area, sorted, skipping dot-entries and links', async () => {
    const root = scratch('proj');
    const packages = path.join(root, '.yggdrasil', 'aspects', 'packages');
    write(packages, 'zeta/law/p/r/yg-aspect.yaml', 'x\n');
    write(packages, 'acme/law/demo/r/yg-aspect.yaml', 'x\n');
    write(packages, 'acme/law/demo/r/.hidden', 'x\n');
    write(packages, '.staging-demo-00/r/yg-aspect.yaml', 'x\n');
    if (POSIX) symlinkSync(path.join(packages, 'acme'), path.join(packages, 'acme', 'law', 'demo', 'loop'));
    expect(await listAllPackageFiles(root)).toEqual([
      'packages/acme/law/demo/r/yg-aspect.yaml',
      'packages/zeta/law/p/r/yg-aspect.yaml',
    ]);
    expect(await listInstalledFiles(root, 'acme/law/demo')).toEqual(['packages/acme/law/demo/r/yg-aspect.yaml']);
  });

  it('hashes a file addressed relative to aspects/, and reads a missing one as null', async () => {
    const root = scratch('proj');
    write(root, '.yggdrasil/aspects/packages/acme/law/demo/r/a.md', 'a\n');
    expect(await hashAspectsRelativeFile(root, 'packages/acme/law/demo/r/a.md')).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashAspectsRelativeFile(root, 'packages/acme/law/demo/r/missing.md')).toBeNull();
  });
});

describe('the record of what was installed', () => {
  it('reads an empty record as an empty map', () => {
    expect(renderPackagesLock(EMPTY_LOCK).endsWith('schema: yg-packages/1\npackages: {}\n')).toBe(true);
  });

  it('sorts packages and files, writes every provenance field present, and an empty file map inline', () => {
    const lock: PackagesLock = {
      schema: 'yg-packages/1',
      packages: {
        zeta: {
          source: 'https://example.test/z.git',
          package: 'z/z/zeta',
          version: '2.0.0',
          installed_at: '2026-09-10T00:00:00.000Z',
          files: { 'packages/z/z/zeta/b.md': 'bb', 'packages/z/z/zeta/a.md': 'aa' },
        },
        alpha: {
          source: '../marketplace',
          package: 'acme/law/alpha',
          version: '1.0.0',
          requested: '1.0.0',
          tag: 'pack/alpha@1.0.0',
          commit: 'c0ffee',
          identity: 'given',
          installed_at: '2026-09-10T00:00:00.000Z',
          files: {},
        },
      },
    };
    const text = renderPackagesLock(lock);
    const body = text.slice(text.indexOf('packages:'));
    expect(body).toBe(
      [
        'packages:',
        '  "alpha":',
        '    source: "../marketplace"',
        '    package: "acme/law/alpha"',
        '    version: "1.0.0"',
        '    requested: "1.0.0"',
        '    tag: "pack/alpha@1.0.0"',
        '    commit: "c0ffee"',
        '    identity: "given"',
        '    installed_at: "2026-09-10T00:00:00.000Z"',
        '    files: {}',
        '  "zeta":',
        '    source: "https://example.test/z.git"',
        '    package: "z/z/zeta"',
        '    version: "2.0.0"',
        '    installed_at: "2026-09-10T00:00:00.000Z"',
        '    files:',
        '      "packages/z/z/zeta/a.md": "aa"',
        '      "packages/z/z/zeta/b.md": "bb"',
        '',
      ].join('\n'),
    );
  });
});
