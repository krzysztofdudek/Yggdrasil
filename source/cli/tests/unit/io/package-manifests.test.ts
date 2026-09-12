// =============================================================================
// Unit — the three documents a repository needs to run law published elsewhere.
//
// A marketplace's manifest of what it publishes, a package's own manifest, and
// the consuming repository's record of what it copied in. What is pinned here is
// less the parsing than the JUDGEMENT each document gets:
//
//   1. marketplace  → schema, entry shape, one-segment names, no path escape
//   2. package      → semver, requires.yg, aspects declared BOTH ways, config
//   3. requires.yg  → asked at install time, never while loading a graph
//   4. lock         → absent is the empty state; present-but-broken is refused
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkPackageRequires,
  parseMarketplaceManifest,
  parsePackageManifest,
  parsePackagesLock,
} from '../../../src/io/package-manifest-parser.js';
import type { PackageManifest } from '../../../src/model/packages.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yg-package-manifest-'));
  tempDirs.push(dir);
  return dir;
}

/** Write `content` as the named file in a fresh directory and return its path. */
function fileWith(name: string, content: string): string {
  const dir = tempDir();
  const p = join(dir, name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

/** The `errors[0].messageData` of a refusal, or a failure if it parsed. */
function refusal(result: { ok: boolean; errors?: Array<{ code: string; messageData: { what: string; why: string; next: string } }> }): {
  code: string;
  what: string;
  why: string;
  next: string;
} {
  expect(result.ok).toBe(false);
  const first = result.errors?.[0];
  expect(first).toBeDefined();
  return { code: first!.code, ...first!.messageData };
}

const SHA = 'a'.repeat(64);

// ---------------------------------------------------------------------------
// 1. yg-marketplace/1
// ---------------------------------------------------------------------------

describe('the manifest a marketplace publishes', () => {
  it('reads a well-formed manifest', async () => {
    const p = fileWith(
      'yg-marketplace.yaml',
      `schema: yg-marketplace/1
packages:
  - name: demo
    path: packages/demo
    version: 1.2.3
`,
    );
    const result = await parseMarketplaceManifest(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.packages).toEqual([{ name: 'demo', path: 'packages/demo', version: '1.2.3' }]);
  });

  it('accepts a marketplace that publishes nothing yet', async () => {
    // Legal on purpose: an empty repository is the starting point, and refusing
    // it would make the first commit of a marketplace unusable.
    const p = fileWith('yg-marketplace.yaml', 'schema: yg-marketplace/1\npackages: []\n');
    const result = await parseMarketplaceManifest(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.packages).toEqual([]);
  });

  it('names the missing file when there is no manifest at all', async () => {
    const missing = join(tempDir(), 'yg-marketplace.yaml');
    const r = refusal(await parseMarketplaceManifest(missing));
    expect(r.code).toBe('marketplace-manifest-missing');
    expect(r.what).toContain(missing);
  });

  it('refuses a manifest with no schema line', async () => {
    const p = fileWith('yg-marketplace.yaml', 'packages: []\n');
    expect(refusal(await parseMarketplaceManifest(p)).code).toBe('marketplace-schema-missing');
  });

  it('refuses a schema this build does not know, quoting it', async () => {
    const p = fileWith('yg-marketplace.yaml', 'schema: yg-marketplace/99\npackages: []\n');
    const r = refusal(await parseMarketplaceManifest(p));
    expect(r.code).toBe('marketplace-schema-unknown');
    expect(r.what).toContain('yg-marketplace/99');
  });

  it('refuses packages: that is not a list', async () => {
    const p = fileWith('yg-marketplace.yaml', 'schema: yg-marketplace/1\npackages: nope\n');
    expect(refusal(await parseMarketplaceManifest(p)).code).toBe('marketplace-packages-invalid');
  });

  it.each(['name', 'path', 'version'])('refuses an entry with no %s', async (field) => {
    const fields: Record<string, string> = { name: 'demo', path: 'packages/demo', version: '1.0.0' };
    delete fields[field];
    const body = Object.entries(fields)
      .map(([k, v], i) => `${i === 0 ? '  - ' : '    '}${k}: ${v}`)
      .join('\n');
    const p = fileWith('yg-marketplace.yaml', `schema: yg-marketplace/1\npackages:\n${body}\n`);
    const r = refusal(await parseMarketplaceManifest(p));
    expect(r.code).toBe('marketplace-entry-invalid');
    expect(r.what).toContain(field);
  });

  it('refuses a version that is not semver, quoting it', async () => {
    const p = fileWith(
      'yg-marketplace.yaml',
      'schema: yg-marketplace/1\npackages:\n  - name: demo\n    path: p\n    version: latest\n',
    );
    const r = refusal(await parseMarketplaceManifest(p));
    expect(r.code).toBe('marketplace-entry-version-invalid');
    expect(r.what).toContain('latest');
  });

  it('refuses the same package name twice — the name would be ambiguous', async () => {
    const p = fileWith(
      'yg-marketplace.yaml',
      `schema: yg-marketplace/1
packages:
  - { name: demo, path: a, version: 1.0.0 }
  - { name: demo, path: b, version: 2.0.0 }
`,
    );
    const r = refusal(await parseMarketplaceManifest(p));
    expect(r.code).toBe('marketplace-entry-duplicate');
    expect(r.what).toContain('demo');
  });

  it.each(['../elsewhere', '/etc/passwd', '~/law'])('refuses the escaping path %s', async (bad) => {
    const p = fileWith(
      'yg-marketplace.yaml',
      `schema: yg-marketplace/1\npackages:\n  - { name: demo, path: "${bad}", version: 1.0.0 }\n`,
    );
    const r = refusal(await parseMarketplaceManifest(p));
    expect(r.code).toBe('marketplace-entry-escape');
    expect(r.what).toContain(bad);
  });

  it('refuses a package name carrying a separator', async () => {
    const p = fileWith(
      'yg-marketplace.yaml',
      'schema: yg-marketplace/1\npackages:\n  - { name: acme/demo, path: p, version: 1.0.0 }\n',
    );
    const r = refusal(await parseMarketplaceManifest(p));
    expect(r.code).toBe('marketplace-entry-invalid');
    expect(r.what).toContain('acme/demo');
  });

  it('names the file when the YAML itself will not parse', async () => {
    // A literal tab is the classic cause; YAML indentation is spaces only.
    const p = fileWith('yg-marketplace.yaml', 'schema: yg-marketplace/1\npackages:\n\t- name: demo\n');
    const r = refusal(await parseMarketplaceManifest(p));
    expect(r.code).toBe('package-manifest-invalid');
    expect(r.what).toContain(p);
    expect(r.next).toContain('tab');
  });

  it('refuses a document that is a sequence rather than a mapping', async () => {
    const p = fileWith('yg-marketplace.yaml', '- one\n- two\n');
    expect(refusal(await parseMarketplaceManifest(p)).code).toBe('package-manifest-invalid');
  });
});

// ---------------------------------------------------------------------------
// 2. yg-package/1
// ---------------------------------------------------------------------------

const COMPLETE_PACKAGE = `schema: yg-package/1
name: demo
version: 0.1.0
requires:
  yg: ">=5.0.0"
aspects:
  - rule-a
config:
  rule-a:
    threshold:
      type: number
      default: 3
`;

describe("a package's own manifest", () => {
  it('reads a complete manifest', async () => {
    const p = fileWith('yg-package.yaml', COMPLETE_PACKAGE);
    const result = await parsePackageManifest(p, ['rule-a']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('demo');
    expect(result.value.version).toBe('0.1.0');
    expect(result.value.requires.yg).toBe('>=5.0.0');
    expect(result.value.aspects).toEqual(['rule-a']);
    expect(result.value.config?.['rule-a'].threshold).toEqual({ type: 'number', default: 3 });
  });

  it('names the missing file when there is no manifest', async () => {
    const missing = join(tempDir(), 'yg-package.yaml');
    const r = refusal(await parsePackageManifest(missing));
    expect(r.code).toBe('package-manifest-missing');
    expect(r.what).toContain(missing);
  });

  it('refuses a manifest with no requires.yg', async () => {
    const p = fileWith(
      'yg-package.yaml',
      'schema: yg-package/1\nname: demo\nversion: 0.1.0\naspects: []\n',
    );
    expect(refusal(await parsePackageManifest(p)).code).toBe('package-requires-missing');
  });

  it('accepts a package with no rules at all', async () => {
    // Legal: it installs and contributes nothing. A package can legitimately be
    // an empty shell for a version or two.
    const p = fileWith(
      'yg-package.yaml',
      'schema: yg-package/1\nname: demo\nversion: 0.1.0\nrequires: { yg: ">=1.0.0" }\naspects: []\n',
    );
    const result = await parsePackageManifest(p, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.aspects).toEqual([]);
  });

  it('refuses a name carrying a separator — a package name is one segment', async () => {
    const p = fileWith(
      'yg-package.yaml',
      'schema: yg-package/1\nname: acme/demo\nversion: 0.1.0\nrequires: { yg: ">=1.0.0" }\naspects: []\n',
    );
    const r = refusal(await parsePackageManifest(p));
    expect(r.code).toBe('package-name-invalid');
    expect(r.what).toContain('acme/demo');
  });

  it('accepts a name with unicode and a space', async () => {
    const p = fileWith(
      'yg-package.yaml',
      'schema: yg-package/1\nname: "règles maison"\nversion: 0.1.0\nrequires: { yg: ">=1.0.0" }\naspects: []\n',
    );
    const result = await parsePackageManifest(p, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('règles maison');
  });

  it('refuses a declared rule directory that is not there', async () => {
    const p = fileWith('yg-package.yaml', COMPLETE_PACKAGE);
    const r = refusal(await parsePackageManifest(p, []));
    expect(r.code).toBe('package-aspect-dir-missing');
    expect(r.what).toContain('rule-a');
  });

  it('refuses a rule directory that is there but undeclared', async () => {
    // The one that matters: an undeclared directory is copied into the consumer
    // like everything else, so it would arrive as law nobody announced.
    const p = fileWith('yg-package.yaml', COMPLETE_PACKAGE);
    const r = refusal(await parsePackageManifest(p, ['rule-a', 'smuggled']));
    expect(r.code).toBe('package-aspect-dir-undeclared');
    expect(r.what).toContain('smuggled');
  });

  it('refuses a config key with no declared type', async () => {
    const p = fileWith(
      'yg-package.yaml',
      `schema: yg-package/1
name: demo
version: 0.1.0
requires: { yg: ">=1.0.0" }
aspects: [rule-a]
config:
  rule-a:
    threshold:
      default: 3
`,
    );
    const r = refusal(await parsePackageManifest(p, ['rule-a']));
    expect(r.code).toBe('package-config-key-type-missing');
    expect(r.what).toContain('threshold');
  });

  it('refuses a default that does not satisfy its own declared type', async () => {
    const p = fileWith(
      'yg-package.yaml',
      `schema: yg-package/1
name: demo
version: 0.1.0
requires: { yg: ">=1.0.0" }
aspects: [rule-a]
config:
  rule-a:
    threshold:
      type: number
      default: "three"
`,
    );
    const r = refusal(await parsePackageManifest(p, ['rule-a']));
    expect(r.code).toBe('package-config-default-type-mismatch');
    expect(r.what).toContain('threshold');
    expect(r.what).toContain('number');
  });

  it('refuses config for a rule the package does not carry', async () => {
    const p = fileWith(
      'yg-package.yaml',
      `schema: yg-package/1
name: demo
version: 0.1.0
requires: { yg: ">=1.0.0" }
aspects: [rule-a]
config:
  rule-z:
    threshold: { type: number, default: 3 }
`,
    );
    const r = refusal(await parsePackageManifest(p, ['rule-a']));
    expect(r.code).toBe('package-config-schema-unknown-aspect');
    expect(r.what).toContain('rule-z');
  });

  it('refuses a version that is not semver', async () => {
    const p = fileWith(
      'yg-package.yaml',
      'schema: yg-package/1\nname: demo\nversion: v1\nrequires: { yg: ">=1.0.0" }\naspects: []\n',
    );
    expect(refusal(await parsePackageManifest(p)).code).toBe('package-version-invalid');
  });
});

// ---------------------------------------------------------------------------
// 3. requires.yg — asked at install time only
// ---------------------------------------------------------------------------

describe('the version of Yggdrasil a package asks for', () => {
  const manifest = (range: string): PackageManifest => ({
    schema: 'yg-package/1',
    name: 'demo',
    version: '0.1.0',
    requires: { yg: range },
    aspects: [],
  });

  it('accepts a running build inside the range', () => {
    expect(checkPackageRequires(manifest('>=5.0.0'), '5.9.0').ok).toBe(true);
  });

  it('refuses a build too old, naming BOTH versions', () => {
    const r = refusal(checkPackageRequires(manifest('>=99.0.0'), '5.9.0'));
    expect(r.code).toBe('package-requires-unsatisfied');
    expect(r.what).toContain('>=99.0.0');
    expect(r.what).toContain('5.9.0');
  });

  it('is NOT asked while a manifest is being read', async () => {
    // Deliberate split: judging it at load time would strand an installed
    // package as unloadable — and therefore un-removable — after an upgrade.
    const p = fileWith(
      'yg-package.yaml',
      'schema: yg-package/1\nname: demo\nversion: 0.1.0\nrequires: { yg: ">=99.0.0" }\naspects: []\n',
    );
    expect((await parsePackageManifest(p, [])).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. yg-packages/1 — the consuming repository's record
// ---------------------------------------------------------------------------

const LOCK = `schema: yg-packages/1
packages:
  demo:
    source: https://example.test/acme/law.git
    package: acme/law/demo
    version: 0.1.0
    installed_at: 2026-09-10T00:00:00.000Z
    files:
      packages/acme/law/demo/rule-a/check.mjs: ${SHA}
`;

describe("the record of what a repository installed", () => {
  it('reads a complete record', async () => {
    const p = fileWith('yg-packages.yaml', LOCK);
    const result = await parsePackagesLock(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.value.packages.demo;
    expect(entry.package).toBe('acme/law/demo');
    expect(entry.version).toBe('0.1.0');
    expect(Date.parse(entry.installed_at)).not.toBeNaN();
    expect(entry.files['packages/acme/law/demo/rule-a/check.mjs']).toBe(SHA);
  });

  it('reads an absent record as an empty one', async () => {
    // The optional-state case: almost every repository has no packages, and
    // making them all carry an empty file would be ceremony.
    const result = await parsePackagesLock(join(tempDir(), 'yg-packages.yaml'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.packages).toEqual({});
  });

  it('reads a comment-only record as an empty one', async () => {
    const p = fileWith('yg-packages.yaml', '# nothing installed\n');
    const result = await parsePackagesLock(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.packages).toEqual({});
  });

  it('accepts a package that installed no files', async () => {
    const p = fileWith(
      'yg-packages.yaml',
      `schema: yg-packages/1
packages:
  demo:
    source: s
    package: o/r/demo
    version: 0.1.0
    installed_at: 2026-09-10T00:00:00.000Z
    files: {}
`,
    );
    const result = await parsePackagesLock(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.packages.demo.files).toEqual({});
  });

  it('refuses a hash that is not a sha256 digest, naming the file', async () => {
    // A value that is not a digest can never match, so every check would report
    // tampering. Refusing loudly beats reporting a permanent false alarm.
    const p = fileWith('yg-packages.yaml', LOCK.replace(SHA, 'deadbeef'));
    const r = refusal(await parsePackagesLock(p));
    expect(r.code).toBe('packages-lock-hash-invalid');
    expect(r.what).toContain('check.mjs');
  });

  it('refuses a recorded file outside its own install directory', async () => {
    const p = fileWith(
      'yg-packages.yaml',
      LOCK.replace('packages/acme/law/demo/rule-a/check.mjs', 'packages/other/law/demo/rule-a/check.mjs'),
    );
    const r = refusal(await parsePackagesLock(p));
    expect(r.code).toBe('packages-lock-path-escape');
    expect(r.what).toContain('packages/other/law/demo/rule-a/check.mjs');
  });

  it.each(['source', 'package', 'version', 'installed_at'])(
    'refuses a record with no %s',
    async (field) => {
      const p = fileWith('yg-packages.yaml', LOCK.split('\n').filter((l) => !l.trim().startsWith(`${field}:`)).join('\n'));
      const r = refusal(await parsePackagesLock(p));
      expect(r.code).toBe('packages-lock-entry-incomplete');
      expect(r.what).toContain(field);
    },
  );

  it('refuses a schema this build does not know', async () => {
    const p = fileWith('yg-packages.yaml', LOCK.replace('yg-packages/1', 'yg-packages/9'));
    expect(refusal(await parsePackagesLock(p)).code).toBe('packages-lock-schema-unknown');
  });

  it('refuses a record that is present but not a mapping', async () => {
    const p = fileWith('yg-packages.yaml', 'schema: yg-packages/1\npackages: [one, two]\n');
    expect(refusal(await parsePackagesLock(p)).code).toBe('packages-lock-invalid');
  });
});

// ---------------------------------------------------------------------------
// A directory of a package, read the way the loader reads it
// ---------------------------------------------------------------------------

describe('reading a package directory as it sits on disk', () => {
  it('agrees with what is actually beside the manifest', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'rule-a'));
    writeFileSync(join(dir, 'yg-package.yaml'), COMPLETE_PACKAGE, 'utf-8');
    const result = await parsePackageManifest(join(dir, 'yg-package.yaml'), ['rule-a']);
    expect(result.ok).toBe(true);
  });
});
