// Unit tests for `yg pack` — the command's registration shape, and the two pure
// pieces of judgement it makes before anything is fetched or written: how a
// package's record is rendered back to disk, and what the adaptation stub beside
// a copied rule says.
//
// Nothing here runs git or reaches a network. The fetch, the install and the
// refusals live in the e2e suite, which drives the real binary against a local
// bare repository built at test time.

import { describe, it, expect, afterEach } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerPackCommand } from '../../../src/cli/pack.js';
import {
  aspectsRoot,
  createFetchStagingDir,
  hashAspectsRelativeFile,
  installDirRelative,
  installPackage,
  isIgnoredPackageEntry,
  listAllPackageFiles,
  listInstalledFiles,
  listPackageAspectDirs,
  packagesLockPath,
  readInstalledAdapts,
  removeDirectory,
  renderAdaptStub,
  renderPackagesLock,
  removePackageFiles,
  writePackagesLock,
} from '../../../src/io/package-store.js';
import { parsePackagesLock } from '../../../src/io/package-manifest-parser.js';
import type { PackageManifest, PackagesLock } from '../../../src/model/packages.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'yg-pack-unit-'));
  tempDirs.push(root);
  mkdirSync(path.join(root, '.yggdrasil'), { recursive: true });
  return root;
}

const LOCK: PackagesLock = {
  schema: 'yg-packages/1',
  packages: {
    demo: {
      source: 'https://example.test/acme/law.git',
      package: 'acme/law/demo',
      version: '0.1.0',
      installed_at: '2026-09-10T00:00:00.000Z',
      files: {
        'packages/acme/law/demo/rule-a/yg-aspect.yaml': 'b'.repeat(64),
        'packages/acme/law/demo/rule-a/check.mjs': 'a'.repeat(64),
      },
    },
  },
};

describe('yg pack — what the command exposes', () => {
  it('registers the four subcommands', () => {
    const program = new Command();
    registerPackCommand(program);
    const pack = program.commands.find((c) => c.name() === 'pack');
    expect(pack).toBeDefined();
    expect(pack!.commands.map((c) => c.name()).sort()).toEqual(['add', 'list', 'remove', 'update']);
  });

  it('says in its own description that installing runs someone else\'s code', () => {
    // Stated where a person choosing the command reads it, not only in docs.
    const program = new Command();
    registerPackCommand(program);
    const pack = program.commands.find((c) => c.name() === 'pack');
    expect(pack!.description()).toContain("author's code");
  });

  it('takes the identity override on add, and the version override on update', () => {
    const program = new Command();
    registerPackCommand(program);
    const pack = program.commands.find((c) => c.name() === 'pack')!;
    const flags = (name: string): string[] =>
      pack.commands.find((c) => c.name() === name)!.options.map((o) => o.long ?? '');
    expect(flags('add')).toContain('--as');
    expect(flags('update')).toContain('--to');
  });
});

describe('the record written back to disk', () => {
  it('sorts packages and file paths, so two installs of the same set are byte-identical', () => {
    const rendered = renderPackagesLock(LOCK);
    const paths = rendered
      .split('\n')
      .filter((l) => l.includes('packages/acme/law/demo/'))
      .map((l) => l.trim().split(':')[0]);
    expect(paths).toEqual([...paths].sort());
    expect(renderPackagesLock(LOCK)).toBe(rendered);
  });

  it('round-trips through the reader unchanged', async () => {
    const root = newRepo();
    await writePackagesLock(root, LOCK);
    const read = await parsePackagesLock(packagesLockPath(root));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toEqual(LOCK);
  });

  it('renders an empty record rather than omitting the key', async () => {
    const root = newRepo();
    await writePackagesLock(root, { schema: 'yg-packages/1', packages: {} });
    expect(readFileSync(packagesLockPath(root), 'utf-8')).toContain('packages: {}');
  });
});

describe('the adaptation stub written beside a copied rule', () => {
  const stub = renderAdaptStub('demo', 'rule-a', {
    threshold: { type: 'number', default: 3 },
    label: { type: 'string', default: 'house' },
  });

  it('names the rule and the package it came from', () => {
    expect(stub).toContain("'rule-a'");
    expect(stub).toContain("'demo'");
  });

  it('lists every adaptable key as a comment', () => {
    for (const key of ['scope', 'reviewer', 'review_by', 'references', 'status', 'companion', 'config']) {
      expect(stub).toContain(`#   ${key}:`);
    }
  });

  it('says which keys are not adaptable, and why', () => {
    expect(stub).toContain('Not adaptable: name, implies, errs, when');
    expect(stub).toContain('the rule IS');
  });

  it('carries the package defaults as live YAML, not as comments', () => {
    // A setting someone has to discover before they can change it is a setting
    // nobody changes.
    expect(stub).toContain('config:');
    expect(stub).toContain('  threshold: 3');
    expect(stub).toContain('  label: "house"');
  });

  it('says so plainly when a rule reads no settings at all', () => {
    const none = renderAdaptStub('demo', 'rule-b', undefined);
    expect(none).toContain('reads no configuration');
    expect(none).not.toContain('\nconfig:');
  });

  it('points at the record and at the refusal, so the reader knows why the copy is off limits', () => {
    expect(stub).toContain('yg-packages.yaml');
    expect(stub).toContain('refuses any edit');
  });
});

describe('reading an installed package back off disk', () => {
  it('skips dot-prefixed entries everywhere', () => {
    // One predicate for the copy walk, the record walk and the rail's walk, so
    // the three can never disagree about whether a file belongs to a package.
    expect(isIgnoredPackageEntry('.git')).toBe(true);
    expect(isIgnoredPackageEntry('drills')).toBe(false);
  });

  it('lists the files under one install, relative to the rules directory', async () => {
    const root = newRepo();
    const dir = path.join(root, '.yggdrasil', 'aspects', ...installDirRelative('acme/law/demo').split('/'), 'rule-a');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'check.mjs'), 'x\n', 'utf-8');
    mkdirSync(path.join(dir, '.hidden'), { recursive: true });
    writeFileSync(path.join(dir, '.hidden', 'nope.mjs'), 'x\n', 'utf-8');

    expect(await listInstalledFiles(root, 'acme/law/demo')).toEqual([
      'packages/acme/law/demo/rule-a/check.mjs',
    ]);
  });

  it('reads an install that is not there as nothing, not as an error', async () => {
    expect(await listInstalledFiles(newRepo(), 'acme/law/absent')).toEqual([]);
  });

  it('removing an install takes the empty publisher directories with it', async () => {
    // Leaving packages/acme/law/ standing says a package from that publisher is
    // still installed when none is.
    const root = newRepo();
    const dir = path.join(root, '.yggdrasil', 'aspects', ...installDirRelative('acme/law/demo').split('/'), 'rule-a');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'check.mjs'), 'x\n', 'utf-8');

    await removePackageFiles(root, 'acme/law/demo');
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(root, '.yggdrasil', 'aspects', 'packages', 'acme'))).toBe(false);
    expect(existsSync(path.join(root, '.yggdrasil', 'aspects', 'packages'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Installing, in process — the same code the command runs, without the command.
// ---------------------------------------------------------------------------

const MANIFEST: PackageManifest = {
  schema: 'yg-package/1',
  name: 'demo',
  version: '0.1.0',
  requires: { yg: '>=1.0.0' },
  aspects: ['rule-a'],
  config: { 'rule-a': { threshold: { type: 'number', default: 3 } } },
};

const EMPTY_LOCK: PackagesLock = { schema: 'yg-packages/1', packages: {} };

/** A package on disk, ready to be installed from. */
function packageSource(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'yg-pack-src-'));
  tempDirs.push(root);
  mkdirSync(path.join(root, 'rule-a'), { recursive: true });
  writeFileSync(path.join(root, 'yg-package.yaml'), 'schema: yg-package/1\n', 'utf-8');
  writeFileSync(path.join(root, 'rule-a', 'yg-aspect.yaml'), 'name: RuleA\n', 'utf-8');
  writeFileSync(path.join(root, 'rule-a', 'check.mjs'), 'export function check() { return []; }\n', 'utf-8');
  for (const [rel, body] of Object.entries(extra)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body, 'utf-8');
  }
  return root;
}

async function install(root: string, source: string, lock: PackagesLock = EMPTY_LOCK, preserveAdapts?: Map<string, string>) {
  return installPackage({
    projectRoot: root,
    installId: 'acme/law/demo',
    packageRootAbs: source,
    manifest: MANIFEST,
    source: 'https://example.test/acme/law.git',
    installedAt: '2026-09-10T00:00:00.000Z',
    currentLock: lock,
    ...(preserveAdapts !== undefined && { preserveAdapts }),
  });
}

describe('installing a package', () => {
  it('copies every file, records a hash for each, and writes a stub per rule', async () => {
    const root = newRepo();
    const result = await install(root, packageSource());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.keys(result.value.files).sort()).toEqual([
      'packages/acme/law/demo/rule-a/check.mjs',
      'packages/acme/law/demo/rule-a/yg-aspect.yaml',
      'packages/acme/law/demo/yg-package.yaml',
    ]);
    // Every recorded hash matches the file as WRITTEN, which is what the rail
    // later compares against.
    for (const [rel, sha] of Object.entries(result.value.files)) {
      expect(await hashAspectsRelativeFile(root, rel)).toBe(sha);
    }
    // The stub is beside the rule and is NOT recorded.
    const stub = path.join(aspectsRoot(root), 'packages', 'acme', 'law', 'demo', 'rule-a', 'yg-aspect.adapt.yaml');
    expect(readFileSync(stub, 'utf-8')).toContain('threshold: 3');
    expect(Object.keys(result.value.files).some((k) => k.includes('adapt'))).toBe(false);
    // And the record on disk now names the package.
    expect(readFileSync(packagesLockPath(root), 'utf-8')).toContain('"demo"');
  });

  it('carries an existing adaptation across instead of writing a fresh stub', async () => {
    const root = newRepo();
    await install(root, packageSource());
    const mine = 'status: advisory\nconfig:\n  threshold: 99\n';

    const again = await install(root, packageSource(), EMPTY_LOCK, new Map([['rule-a', mine]]));
    expect(again.ok).toBe(true);
    const stub = path.join(aspectsRoot(root), 'packages', 'acme', 'law', 'demo', 'rule-a', 'yg-aspect.adapt.yaml');
    expect(readFileSync(stub, 'utf-8')).toBe(mine);
  });

  it('reads back the adaptations sitting beside an install', async () => {
    const root = newRepo();
    await install(root, packageSource());
    const found = await readInstalledAdapts(root, 'acme/law/demo', ['rule-a', 'absent']);
    expect(found.get('rule-a')).toContain('threshold: 3');
    // A rule with no adaptation is simply not in the map — the caller writes a stub.
    expect(found.has('absent')).toBe(false);
  });

  it('refuses a symbolic link rather than copying or following it', async () => {
    // A link published by someone else resolves against YOUR filesystem once
    // copied in, so it could reach any file on this machine.
    const source = packageSource();
    const { symlinkSync } = await import('node:fs');
    symlinkSync('/etc/hosts', path.join(source, 'rule-a', 'linked.txt'));

    const root = newRepo();
    const result = await install(root, source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('package-symlink-refused');
    expect(result.messageData.what).toContain('linked.txt');
    // Nothing was left behind.
    expect(await listAllPackageFiles(root)).toEqual([]);
  });

  it('refuses a binary rather than mangling it through a text round-trip', async () => {
    const source = packageSource({ 'rule-a/blob.bin': 'a\u0000b' });
    const root = newRepo();
    const result = await install(root, source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('package-binary-file-refused');
    expect(result.messageData.what).toContain('blob.bin');
    // Refused mid-copy still leaves nothing behind — including the staging tree
    // the copy was being built in, which this refusal returns past.
    expect(await listAllPackageFiles(root)).toEqual([]);
    const { readdirSync, existsSync } = await import('node:fs');
    const packagesDir = path.join(aspectsRoot(root), 'packages');
    expect(existsSync(packagesDir) ? readdirSync(packagesDir) : []).toEqual([]);
  });

  it('replaces debris from an install that died, rather than merging with it', async () => {
    const root = newRepo();
    const stale = path.join(aspectsRoot(root), 'packages', 'acme', 'law', 'demo');
    mkdirSync(path.join(stale, 'rule-a'), { recursive: true });
    writeFileSync(path.join(stale, 'leftover.txt'), 'debris\n', 'utf-8');

    const result = await install(root, packageSource());
    expect(result.ok).toBe(true);
    expect(await listAllPackageFiles(root)).not.toContain('packages/acme/law/demo/leftover.txt');
  });

  it('leaves no copy at all when the record cannot be written', async () => {
    // The order the install commits in: the copy is staged out of sight, the
    // record is written next, and only then does the staging become real. So the
    // step that can actually fail cannot leave a half-installed rule set behind.
    const root = newRepo();
    const { chmodSync } = await import('node:fs');
    chmodSync(path.join(root, '.yggdrasil'), 0o555);
    try {
      const result = await install(root, packageSource());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('package-install-failed');
      expect(result.messageData.why).toContain('writable');
      expect(await listAllPackageFiles(root)).toEqual([]);
    } finally {
      chmodSync(path.join(root, '.yggdrasil'), 0o755);
    }
  });

  it('lists a package\'s rule directories, skipping dot-prefixed ones', async () => {
    const source = packageSource();
    mkdirSync(path.join(source, '.git'), { recursive: true });
    expect(await listPackageAspectDirs(source)).toEqual(['rule-a']);
  });

  it('gives a fetch a throwaway directory the graph already ignores, and takes it away again', async () => {
    const root = newRepo();
    const staging = await createFetchStagingDir(root);
    expect(path.basename(staging)).toMatch(/^pack-fetch-[0-9a-f]{12}\.tmp$/);
    expect(path.dirname(staging)).toBe(path.join(root, '.yggdrasil'));
    await removeDirectory(staging);
    const { existsSync } = await import('node:fs');
    expect(existsSync(staging)).toBe(false);
    // Removing something already gone is not an error.
    await removeDirectory(staging);
  });

  it('reads a file that is not there as nothing, not as a throw', async () => {
    expect(await hashAspectsRelativeFile(newRepo(), 'packages/a/b/c/none.mjs')).toBeNull();
  });
});
