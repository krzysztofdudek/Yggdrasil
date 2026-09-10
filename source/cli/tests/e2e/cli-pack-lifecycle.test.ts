// =============================================================================
// CLI E2E — `yg pack`: add, update, list, remove.
//
// Law published by one repository, installed into another, kept exactly as
// published, and tuned beside the copy. Every scenario drives the real binary.
// ZERO NETWORK: every source is a local directory or a local git repository
// built here at test time, except scenario 21, which names a host under the
// reserved `.invalid` top-level domain — guaranteed by RFC 2606 never to resolve
// anywhere — to prove an unreachable source fails fast and leaves nothing behind.
// A closed port would have done the same job while resting on which ports happen
// to be closed on whatever machine runs this; a name that cannot resolve rests on
// nothing local at all.
//
//   Installing
//    1. add from a local directory  → copies, a record with a hash per file, a stub per rule
//    2. attach by full name, then fill  → exit 0, the pair recorded
//   The copy is a copy
//    3. edit a copied file          → blocked, naming the file and the adaptation
//    4. delete a copied file        → blocked, a different message
//    5. add your own file beside it → blocked
//   Settings
//    6. change one the rule READS   → back to unverified, and the answer changes
//    7. change one it ignores       → nothing re-opens
//    8. a setting the package never declared → refused at load, by name
//    9. a key that is not adaptable → refused at load, by name
//   Updating
//   10. copy untouched              → replaced, record rewritten, adaptation byte-identical
//   11. copy edited                 → refused, listing the files, nothing replaced
//   12. a version that is not there → refused, naming the tag, record untouched
//   13. a setting the new version dropped → refused at load, by name
//   Listing and removing
//   14. list                        → names, versions, whether each copy is untouched
//   15. remove while attached       → refused, listing what still names it
//   Refusals at the boundary
//   16. installing twice            → refused, pointing at update
//   17. a package needing a newer Yggdrasil → refused, naming both versions
//   18. a package with no rules     → installs, and contributes nothing
//   19. implies reaching outside    → refused at load, naming both
//   20. a name already taken        → refused, naming it
//   21. an unreachable source       → refused fast, nothing left behind
//   22. a directory that is not a marketplace → refused, naming the missing file
//   23. a local source with no identity → refused, saying how to give one
//   24. --as                        → copies land under the identity given
//   25. a space and unicode in the name → installs, and every surface prints it
//   Edges worth pinning
//   26. CRLF in the working tree    → the recorded hash still matches
//   27. the packages area as a symlink → the observed behaviour, pinned
//   28. a read-only record          → refused, and no half-install
//   29. a partial copy left behind  → the next attempt ends clean, not mixed
//   30. twenty rules, two hundred files → within the stated bounds
//   31. advise                      → a newer version, quoted, from what pack list
//                                     recorded; silent until asked; the feed itself
//                                     never reaches outside the repository
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  statSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGitFixture } from '../support/git-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURES = path.join(CLI_ROOT, 'tests', 'fixtures');
const MARKET_V1 = path.join(FIXTURES, 'marketplace-demo');
const MARKET_V2 = path.join(FIXTURES, 'marketplace-demo-v2');
const CONSUMER = path.join(FIXTURES, 'pack-consumer');
const distExists = existsSync(BIN_PATH);

const INSTALL = 'packages/acme/law/demo';
const RULE_A = `${INSTALL}/rule-a`;
const ADAPT_A = path.join('.yggdrasil', 'aspects', ...RULE_A.split('/'), 'yg-aspect.adapt.yaml');
const CHECK_A = path.join('.yggdrasil', 'aspects', ...RULE_A.split('/'), 'check.mjs');
const LOCK = path.join('.yggdrasil', 'yg-packages.yaml');
/** The local cache of what each source was last seen to publish. Never committed. */
const VERSIONS_CACHE = path.join('.yggdrasil', '.yg-packages-versions.json');

/**
 * A source that cannot exist anywhere. `.invalid` is reserved by RFC 2606 and is
 * guaranteed never to resolve, on any machine and any network — which is what
 * makes it a deterministic stand-in for "unreachable", where a port number would
 * only be one on machines where that port happens to be closed.
 */
const UNREACHABLE_SOURCE = 'http://yg-nothing-here.invalid/acme/law.git';

interface Run {
  stdout: string;
  stderr: string;
  status: number | null;
  all: string;
}

function run(args: string[], cwd: string): Run {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { stdout, stderr, status: r.status, all: stdout + stderr };
}

/** A fresh consumer repository. */
function consumer(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-pack-${label}-`));
  cpSync(CONSUMER, dir, { recursive: true });
  return dir;
}

/** Read a file in a repository as text. */
function read(dir: string, rel: string): string {
  return readFileSync(path.join(dir, rel), 'utf-8');
}

/** Rewrite a file in a repository. */
function write(dir: string, rel: string, text: string): void {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text, 'utf-8');
}

/** Attach an installed rule to the consumer's one component. */
function attach(dir: string, aspectId: string): void {
  const rel = path.join('.yggdrasil', 'model', 'app', 'yg-node.yaml');
  write(dir, rel, read(dir, rel).replace('type: app\n', `type: app\naspects:\n  - ${aspectId}\n`));
}

/** Detach every rule from the consumer's component. */
function detach(dir: string): void {
  const rel = path.join('.yggdrasil', 'model', 'app', 'yg-node.yaml');
  write(dir, rel, read(dir, rel).replace(/aspects:\n(?: {2}- .*\n)+/, ''));
}

/** Set a setting in rule-a's adaptation, in place. */
function setSetting(dir: string, key: string, value: string): void {
  const text = read(dir, ADAPT_A);
  const next = text.replace(new RegExp(`^  ${key}: .*$`, 'm'), `  ${key}: ${value}`);
  expect(next, `adaptation should already carry '${key}'`).not.toBe(text);
  write(dir, ADAPT_A, next);
}

// ---------------------------------------------------------------------------
// A local git marketplace, built here — never a committed .git directory.
// ---------------------------------------------------------------------------

/** Built once: a git repository publishing demo 0.1.0 and 0.2.0 as tags. */
let gitMarket = '';

beforeAll(() => {
  if (!distExists) return;
  gitMarket = mkdtempSync(path.join(tmpdir(), 'yg-pack-market-'));
  runGitFixture(gitMarket, ['init', '-q', '-b', 'main']);
  cpSync(MARKET_V1, gitMarket, { recursive: true });
  runGitFixture(gitMarket, ['add', '-A']);
  runGitFixture(gitMarket, ['commit', '-qm', 'demo 0.1.0']);
  runGitFixture(gitMarket, ['tag', 'pack/demo@0.1.0']);

  rmSync(path.join(gitMarket, 'packages'), { recursive: true, force: true });
  cpSync(MARKET_V2, gitMarket, { recursive: true });
  runGitFixture(gitMarket, ['add', '-A']);
  runGitFixture(gitMarket, ['commit', '-qm', 'demo 0.2.0']);
  runGitFixture(gitMarket, ['tag', 'pack/demo@0.2.0']);
  // An origin, so a package installed from this directory gets its identity the
  // way a real checkout would rather than needing --as.
  runGitFixture(gitMarket, ['remote', 'add', 'origin', 'https://example.test/acme/law.git']);
});

afterAll(() => {
  if (gitMarket !== '') rmSync(gitMarket, { recursive: true, force: true });
});

describe.skipIf(!distExists)('CLI E2E — yg pack: add, update, list, remove', () => {
  // -------------------------------------------------------------------------
  // Installing
  // -------------------------------------------------------------------------

  it('1: add copies the rules in, records a hash per file, and writes a stub beside each', () => {
    const dir = consumer('add');
    try {
      const added = run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir);
      expect(added.status).toBe(0);
      expect(added.stdout).toContain("Installed 'demo' 0.1.0");
      // The security boundary is stated where the person installing reads it.
      expect(added.all).toContain("author's code");

      const base = path.join(dir, '.yggdrasil', 'aspects', ...INSTALL.split('/'));
      expect(readdirSync(base).sort()).toEqual(['rule-a', 'rule-b', 'rule-c', 'yg-package.yaml']);

      const lock = read(dir, LOCK);
      expect(lock).toContain('schema: yg-packages/1');
      expect(lock).toContain('package: "acme/law/demo"');
      for (const f of ['rule-a/check.mjs', 'rule-b/content.md', 'rule-c/yg-aspect.yaml']) {
        expect(lock).toMatch(new RegExp(`${INSTALL}/${f}": "[0-9a-f]{64}"`));
      }
      // installed_at is only ever checked as a parseable instant — never compared.
      const installedAt = /installed_at: "([^"]+)"/.exec(lock)?.[1] ?? '';
      expect(Number.isNaN(Date.parse(installedAt))).toBe(false);

      for (const rule of ['rule-a', 'rule-b', 'rule-c']) {
        const stub = read(dir, path.join('.yggdrasil', 'aspects', ...INSTALL.split('/'), rule, 'yg-aspect.adapt.yaml'));
        expect(stub).toContain('Not adaptable: name, implies, errs, when');
        expect(stub).toContain('#   status:');
      }
      // The package's own default, live and editable, only where a rule reads one.
      expect(read(dir, ADAPT_A)).toContain('threshold: 3');
      // And the adaptation is never one of the RECORDED files — it is the
      // consumer's own writing. (The record's header names it on purpose, as the
      // place to make a change instead of editing a copy.)
      const recorded = lock.split('\n').filter((l) => /^ {6}"/.test(l));
      expect(recorded.length).toBeGreaterThan(0);
      expect(recorded.some((l) => l.includes('yg-aspect.adapt.yaml'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2: an installed rule attaches by its full name and fills like any other', () => {
    const dir = consumer('attach');
    try {
      run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir);
      setSetting(dir, 'threshold', '50');
      attach(dir, RULE_A);

      const filled = run(['check', '--approve', '--only-deterministic'], dir);
      expect(filled.status).toBe(0);
      expect(filled.all).toContain('deterministic (no cost)');
      // The recorded verdict is this rule's, and it holds on a plain check.
      const plain = run(['check'], dir);
      expect(plain.status).toBe(0);
      expect(plain.stdout).toContain('2 verified');
      expect(run(['aspects'], dir).stdout).toContain(RULE_A);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // The copy is a copy
  // -------------------------------------------------------------------------

  it('3: editing a copied file is blocked, naming the file and the adaptation', () => {
    const dir = consumer('edit');
    try {
      run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir);
      write(dir, CHECK_A, `${read(dir, CHECK_A)}\n// mine\n`);

      const checked = run(['check'], dir);
      expect(checked.status).toBe(1);
      expect(checked.all).toContain('package-file-modified');
      expect(checked.all).toContain(`.yggdrasil/aspects/${RULE_A}/check.mjs`);
      expect(checked.all).toContain('yg-aspect.adapt.yaml');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4: deleting a copied file is blocked, with a different message', () => {
    const dir = consumer('delete');
    try {
      run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir);
      rmSync(path.join(dir, CHECK_A));

      const checked = run(['check'], dir);
      expect(checked.status).toBe(1);
      expect(checked.all).toContain('package-file-modified');
      expect(checked.all).toContain('is missing');
      expect(checked.all).not.toContain('has been edited');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5: dropping your own file among the copies is blocked', () => {
    const dir = consumer('smuggle');
    try {
      run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir);
      write(dir, path.join('.yggdrasil', 'aspects', ...RULE_A.split('/'), 'mine.mjs'), 'export const x = 1;\n');

      const checked = run(['check'], dir);
      expect(checked.status).toBe(1);
      expect(checked.all).toContain('no installed package put it there');
      expect(checked.all).toContain('mine.mjs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  it('6: changing a setting the rule reads re-opens its verdict, and changes its answer', () => {
    const dir = consumer('setting-read');
    try {
      run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir);
      setSetting(dir, 'threshold', '50');
      attach(dir, RULE_A);
      expect(run(['check', '--approve', '--only-deterministic'], dir).status).toBe(0);

      // A limit the consumer's file breaks.
      setSetting(dir, 'threshold', '2');
      const stale = run(['check'], dir);
      expect(stale.status).toBe(1);
      expect(stale.all).toContain('unverified');

      const refilled = run(['check', '--approve', '--only-deterministic'], dir);
      expect(refilled.status).toBe(1);
      expect(refilled.all).toContain('this repository allows 2');

      // And back up again: the same rule, the same file, a different answer.
      setSetting(dir, 'threshold', '50');
      expect(run(['check', '--approve', '--only-deterministic'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('7: changing a setting no rule reads re-opens nothing', () => {
    const dir = consumer('setting-unread');
    try {
      run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir);
      setSetting(dir, 'threshold', '50');
      attach(dir, RULE_A);
      expect(run(['check', '--approve', '--only-deterministic'], dir).status).toBe(0);

      setSetting(dir, 'label', '"ours"');
      const after = run(['check'], dir);
      expect(after.status).toBe(0);
      expect(after.all).not.toContain('unverified');
      expect(after.stdout).toContain('2 verified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('8: a setting the package never declared is refused at load, by name', () => {
    const dir = consumer('setting-unknown');
    try {
      run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir);
      write(dir, ADAPT_A, `${read(dir, ADAPT_A)}  treshold: 40\n`);

      const checked = run(['check'], dir);
      expect(checked.status).toBe(1);
      expect(checked.all).toContain('treshold');
      expect(checked.all).toContain('demo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('9: a key that is not adaptable is refused at load, by name', () => {
    const dir = consumer('key-fixed');
    try {
      run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir);
      write(dir, ADAPT_A, `name: MyOwnRule\n${read(dir, ADAPT_A)}`);

      const checked = run(['check'], dir);
      expect(checked.status).toBe(1);
      expect(checked.all).toContain("'name'");
      expect(checked.all).toContain('not adaptable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Updating
  // -------------------------------------------------------------------------

  it('10: an untouched copy updates, and the adaptation survives byte for byte', () => {
    const dir = consumer('update');
    try {
      run(['pack', 'add', `${gitMarket}#demo@0.1.0`], dir);
      setSetting(dir, 'threshold', '50');
      attach(dir, RULE_A);
      expect(run(['check', '--approve', '--only-deterministic'], dir).status).toBe(0);

      const adaptBefore = read(dir, ADAPT_A);
      const updated = run(['pack', 'update', 'demo'], dir);
      expect(updated.status).toBe(0);
      expect(updated.stdout).toContain('0.1.0 → 0.2.0');

      expect(read(dir, ADAPT_A)).toBe(adaptBefore);
      expect(read(dir, LOCK)).toContain('version: "0.2.0"');
      // The rule script changed in 0.2.0, so its verdict is back for judging.
      expect(read(dir, CHECK_A)).toContain('countBlankLines');
      const after = run(['check'], dir);
      expect(after.status).toBe(1);
      expect(after.all).toContain('unverified');
      // And nothing is wrong with the copy itself.
      expect(after.all).not.toContain('package-file-modified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('11: an edited copy refuses to update, listing the files, replacing nothing', () => {
    const dir = consumer('update-dirty');
    try {
      run(['pack', 'add', `${gitMarket}#demo@0.1.0`], dir);
      const before = read(dir, CHECK_A);
      write(dir, CHECK_A, `${before}\n// mine\n`);

      const updated = run(['pack', 'update', 'demo'], dir);
      expect(updated.status).toBe(1);
      expect(updated.all).toContain(`.yggdrasil/aspects/${RULE_A}/check.mjs`);
      expect(updated.all).toContain('Nothing was updated');
      // Untouched: still the edited 0.1.0 file, and still recorded at 0.1.0.
      expect(read(dir, CHECK_A)).toBe(`${before}\n// mine\n`);
      expect(read(dir, LOCK)).toContain('version: "0.1.0"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('12: a version the source does not publish is refused, naming the tag', () => {
    const dir = consumer('update-notag');
    try {
      run(['pack', 'add', `${gitMarket}#demo@0.1.0`], dir);
      const lockBefore = read(dir, LOCK);

      const updated = run(['pack', 'update', 'demo', '--to', '9.9.9'], dir);
      expect(updated.status).toBe(1);
      expect(updated.all).toContain('pack/demo@9.9.9');
      // git's own noise never reaches the reader as the reason.
      expect(updated.all).not.toContain('--depth is ignored');
      expect(updated.all).not.toContain('at Object.');
      expect(read(dir, LOCK)).toBe(lockBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('13: a setting the new version dropped is refused at load, by name', () => {
    // Built the other way round from the update above: install 0.2.0, set the
    // setting only 0.2.0 declares, then go back to 0.1.0, which never knew it.
    const dir = consumer('update-setting-gone');
    try {
      run(['pack', 'add', `${gitMarket}#demo@0.2.0`], dir);
      setSetting(dir, 'countBlankLines', 'false');
      expect(run(['check'], dir).all).not.toContain('countBlankLines');

      const downgraded = run(['pack', 'update', 'demo', '--to', '0.1.0'], dir);
      expect(downgraded.status).toBe(0);

      const checked = run(['check'], dir);
      expect(checked.status).toBe(1);
      expect(checked.all).toContain('countBlankLines');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Listing and removing
  // -------------------------------------------------------------------------

  it('14: list names what is installed and whether each copy is still untouched', () => {
    const dir = consumer('list');
    try {
      run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir);
      const clean = run(['pack', 'list'], dir);
      expect(clean.status).toBe(0);
      expect(clean.stdout).toContain('demo');
      expect(clean.stdout).toContain('0.1.0');
      expect(clean.stdout).toContain('copy untouched');

      write(dir, CHECK_A, `${read(dir, CHECK_A)}\n// mine\n`);
      const dirty = run(['pack', 'list'], dir);
      expect(dirty.stdout).toContain('copy changed');
      expect(dirty.stdout).not.toContain('copy untouched');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('15: remove refuses while something still names a rule, and works once nothing does', () => {
    const dir = consumer('remove');
    try {
      run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir);
      setSetting(dir, 'threshold', '50');
      attach(dir, RULE_A);

      const refused = run(['pack', 'remove', 'demo'], dir);
      expect(refused.status).toBe(1);
      expect(refused.all).toContain('component app');
      expect(refused.all).toContain('.yggdrasil/model/app/yg-node.yaml');
      expect(existsSync(path.join(dir, CHECK_A))).toBe(true);

      detach(dir);
      const removed = run(['pack', 'remove', 'demo'], dir);
      expect(removed.status).toBe(0);
      expect(existsSync(path.join(dir, '.yggdrasil', 'aspects', 'packages', 'acme'))).toBe(false);
      expect(read(dir, LOCK)).toContain('packages: {}');
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Refusals at the boundary
  // -------------------------------------------------------------------------

  it('16: installing the same package twice is refused, pointing at update', () => {
    // The decision, pinned: a second `add` would overwrite the copy, and someone
    // typing it usually means the newer version — which is the other command,
    // the one that checks the copy first and keeps the adaptations.
    const dir = consumer('twice');
    try {
      expect(run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir).status).toBe(0);
      const again = run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir);
      expect(again.status).toBe(1);
      expect(again.all).toContain('already installed');
      expect(again.all).toContain('yg pack update demo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('17: a package needing a newer Yggdrasil is refused, naming both versions', () => {
    const dir = consumer('too-new');
    const market = mkdtempSync(path.join(tmpdir(), 'yg-pack-toonew-'));
    try {
      cpSync(MARKET_V1, market, { recursive: true });
      const manifest = path.join(market, 'packages', 'demo', 'yg-package.yaml');
      writeFileSync(manifest, readFileSync(manifest, 'utf-8').replace(/yg: ".*"/, 'yg: ">=99.0.0"'), 'utf-8');

      const added = run(['pack', 'add', `${market}#demo`, '--as', 'acme/law'], dir);
      expect(added.status).toBe(1);
      expect(added.all).toContain('>=99.0.0');
      expect(added.all).toMatch(/this one is \d+\.\d+\.\d+/);
      expect(existsSync(path.join(dir, LOCK))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(market, { recursive: true, force: true });
    }
  });

  it('18: a package with no rules installs and contributes nothing', () => {
    const dir = consumer('empty-pkg');
    const market = mkdtempSync(path.join(tmpdir(), 'yg-pack-empty-'));
    try {
      mkdirSync(path.join(market, 'packages', 'empty'), { recursive: true });
      writeFileSync(
        path.join(market, 'yg-marketplace.yaml'),
        'schema: yg-marketplace/1\npackages:\n  - { name: empty, path: packages/empty, version: 0.1.0 }\n',
        'utf-8',
      );
      writeFileSync(
        path.join(market, 'packages', 'empty', 'yg-package.yaml'),
        'schema: yg-package/1\nname: empty\nversion: 0.1.0\nrequires: { yg: ">=1.0.0" }\naspects: []\n',
        'utf-8',
      );

      const added = run(['pack', 'add', `${market}#empty`, '--as', 'acme/law'], dir);
      expect(added.status).toBe(0);
      const lock = read(dir, LOCK);
      // The manifest is recorded; no rule file is, because there are none.
      expect(lock).toContain('packages/acme/law/empty/yg-package.yaml');
      expect(lock).not.toContain('check.mjs');
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(market, { recursive: true, force: true });
    }
  });

  it('19: a rule implying something outside its package is refused at load, naming both', () => {
    const dir = consumer('implies-out');
    const market = mkdtempSync(path.join(tmpdir(), 'yg-pack-impl-'));
    try {
      cpSync(MARKET_V1, market, { recursive: true });
      const ruleC = path.join(market, 'packages', 'demo', 'rule-c', 'yg-aspect.yaml');
      writeFileSync(ruleC, readFileSync(ruleC, 'utf-8').replace('  - rule-a', '  - some-local-rule'), 'utf-8');

      expect(run(['pack', 'add', `${market}#demo`, '--as', 'acme/law'], dir).status).toBe(0);
      const checked = run(['check'], dir);
      expect(checked.status).toBe(1);
      expect(checked.all).toContain('rule-c');
      expect(checked.all).toContain('some-local-rule');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(market, { recursive: true, force: true });
    }
  });

  it('20: a rule name this repository already has is refused, naming it', () => {
    const dir = consumer('dup-id');
    try {
      // A package already sitting where this one would land, and READABLE — an
      // install whose record was lost, say. Debris the loader cannot read as a
      // package is a different case: scenario 29 covers it, and it is cleaned up.
      write(dir, path.join('.yggdrasil', 'aspects', ...INSTALL.split('/'), 'yg-package.yaml'),
        'schema: yg-package/1\nname: demo\nversion: 0.0.1\nrequires: { yg: ">=1.0.0" }\naspects: [rule-a]\n');
      write(dir, path.join('.yggdrasil', 'aspects', ...RULE_A.split('/'), 'yg-aspect.yaml'), 'name: Mine\nreviewer: { type: llm }\n');
      write(dir, path.join('.yggdrasil', 'aspects', ...RULE_A.split('/'), 'content.md'), '# Mine\n');

      const added = run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir);
      expect(added.status).toBe(1);
      expect(added.all).toContain(RULE_A);
      expect(added.all).toContain('already has one by that name');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    '21: an unreachable source is refused fast, and leaves nothing behind',
    () => {
      const dir = consumer('unreachable');
      try {
        // The ten-second bound is the it timeout below, not a measured duration:
        // a wall-clock assertion inside the test would flake under load while
        // proving the same thing the timeout already proves.
        const added = run(['pack', 'add', `${UNREACHABLE_SOURCE}#demo`], dir);

        expect(added.status).toBe(1);
        expect(added.all).toContain('Could not reach');
        expect(added.all).toContain('Nothing was installed');
        // Not a stack, and not a bare line of git output with no sentence around it.
        expect(added.all).not.toContain('at Object.');
        expect(added.all).not.toContain('\n    at ');

        // No temp directory survives the failure.
        const leftovers = readdirSync(path.join(dir, '.yggdrasil')).filter((n) => n.includes('pack-fetch'));
        expect(leftovers).toEqual([]);
        expect(existsSync(path.join(dir, LOCK))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it('a package whose own name disagrees with the marketplace is refused, naming both', () => {
    // Every later command addresses a package by name, so the two documents have
    // to agree on what that name is before anything is filed under one of them.
    const dir = consumer('name-mismatch');
    const market = mkdtempSync(path.join(tmpdir(), 'yg-pack-mismatch-'));
    try {
      cpSync(MARKET_V1, market, { recursive: true });
      const manifest = path.join(market, 'packages', 'demo', 'yg-package.yaml');
      writeFileSync(manifest, readFileSync(manifest, 'utf-8').replace('name: demo', 'name: something-else'), 'utf-8');

      const added = run(['pack', 'add', `${market}#demo`, '--as', 'acme/law'], dir);
      expect(added.status).toBe(1);
      expect(added.all).toContain("'demo'");
      expect(added.all).toContain("'something-else'");
      expect(existsSync(path.join(dir, LOCK))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(market, { recursive: true, force: true });
    }
  });

  it('22: a directory that is not a marketplace is refused, naming the missing file', () => {
    const dir = consumer('not-a-market');
    const empty = mkdtempSync(path.join(tmpdir(), 'yg-pack-plain-'));
    try {
      const added = run(['pack', 'add', `${empty}#demo`, '--as', 'acme/law'], dir);
      expect(added.status).toBe(1);
      expect(added.all).toContain('yg-marketplace.yaml');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('23: a local source with no identity is refused, saying how to give one', () => {
    const dir = consumer('no-identity');
    try {
      const added = run(['pack', 'add', `${MARKET_V1}#demo`], dir);
      expect(added.status).toBe(1);
      expect(added.all).toContain('who published');
      expect(added.all).toContain('--as <owner>/<repo>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('24: --as puts the copy under the identity given', () => {
    const dir = consumer('as-flag');
    try {
      expect(run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'o/r'], dir).status).toBe(0);
      expect(existsSync(path.join(dir, '.yggdrasil', 'aspects', 'packages', 'o', 'r', 'demo', 'rule-a'))).toBe(true);
      expect(run(['aspects'], dir).stdout).toContain('packages/o/r/demo/rule-a');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('25: a space and unicode in a package name survive every surface', () => {
    const dir = consumer('unicode');
    const market = mkdtempSync(path.join(tmpdir(), 'yg-pack-uni-'));
    const NAME = 'règles maison';
    try {
      cpSync(MARKET_V1, market, { recursive: true });
      writeFileSync(
        path.join(market, 'yg-marketplace.yaml'),
        `schema: yg-marketplace/1\npackages:\n  - { name: "${NAME}", path: packages/demo, version: 0.1.0 }\n`,
        'utf-8',
      );
      const manifest = path.join(market, 'packages', 'demo', 'yg-package.yaml');
      writeFileSync(manifest, readFileSync(manifest, 'utf-8').replace('name: demo', `name: "${NAME}"`), 'utf-8');

      const added = run(['pack', 'add', `${market}#${NAME}`, '--as', 'acme/law'], dir);
      expect(added.status).toBe(0);
      const id = `packages/acme/law/${NAME}/rule-a`;
      expect(existsSync(path.join(dir, '.yggdrasil', 'aspects', 'packages', 'acme', 'law', NAME, 'rule-a'))).toBe(true);
      expect(run(['aspects'], dir).stdout).toContain(id);

      attach(dir, id);
      const context = run(['context', '--node', 'app'], dir);
      expect(context.status).toBe(0);
      expect(context.stdout).toContain(id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(market, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Edges worth pinning
  // -------------------------------------------------------------------------

  it(
    '26: a copied file checked out with CRLF still matches what was recorded',
    () => {
      // The recorded hash normalizes line endings, exactly as every other content
      // hash in the tool does. Were it over raw bytes, the same package cloned on
      // a machine with autocrlf on would read as tampered with on every check.
      const dir = consumer('crlf');
      try {
        run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir);
        expect(run(['check'], dir).status).toBe(0);

        const lf = read(dir, CHECK_A);
        expect(lf).not.toContain('\r\n');
        write(dir, CHECK_A, lf.replace(/\n/g, '\r\n'));

        const afterCrlf = run(['check'], dir);
        expect(afterCrlf.status).toBe(0);
        expect(afterCrlf.all).not.toContain('package-file-modified');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.skipIf(platform() === 'win32')('27: the packages area may be a symlink — the observed behaviour, pinned', () => {
    // Nothing here resolves links itself; the copy, the record and the check all
    // go through ordinary path operations, which follow a symlinked directory.
    // Pinned so a future change to any of the three has to say so out loud.
    const dir = consumer('symlink');
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'yg-pack-elsewhere-'));
    try {
      mkdirSync(path.join(dir, '.yggdrasil', 'aspects'), { recursive: true });
      symlinkSync(elsewhere, path.join(dir, '.yggdrasil', 'aspects', 'packages'), 'dir');

      const added = run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir);
      expect(added.status).toBe(0);
      // The copy really landed on the other side of the link.
      expect(existsSync(path.join(elsewhere, 'acme', 'law', 'demo', 'rule-a', 'check.mjs'))).toBe(true);
      expect(statSync(path.join(dir, '.yggdrasil', 'aspects', 'packages')).isDirectory()).toBe(true);
      // And the check reads it back through the link without complaint.
      expect(run(['check'], dir).all).not.toContain('package-file-modified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it.skipIf(platform() === 'win32')('28: a record that cannot be written refuses, and leaves no half-install', () => {
    const dir = consumer('readonly-lock');
    try {
      write(dir, LOCK, 'schema: yg-packages/1\npackages: {}\n');
      // The record is written atomically — a temp file beside it, then a rename —
      // and a rename depends on the DIRECTORY being writable, not the file. So
      // chmod on the file alone would not stop the write at all; the directory is
      // what has to be read-only for this to be the failure it is meant to be.
      chmodSync(path.join(dir, '.yggdrasil'), 0o555);

      const added = run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir);
      expect(added.status).toBe(1);
      expect(added.all).toContain('yg-packages.yaml');
      // The copy is written out of sight and only moved into place after the
      // record is safely written, so a failure here leaves nothing behind.
      expect(existsSync(path.join(dir, '.yggdrasil', 'aspects', 'packages', 'acme'))).toBe(false);
      expect(read(dir, LOCK)).toContain('packages: {}');
    } finally {
      chmodSync(path.join(dir, '.yggdrasil'), 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('29: a half-installed copy left by an interrupted run gives way to a clean one', () => {
    const dir = consumer('partial');
    try {
      // What an install killed between its copy and its record leaves behind.
      write(dir, path.join('.yggdrasil', 'aspects', ...RULE_A.split('/'), 'check.mjs'), '// truncated\n');
      write(dir, path.join('.yggdrasil', 'aspects', ...INSTALL.split('/'), 'leftover.txt'), 'debris\n');

      const added = run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir);
      expect(added.status).toBe(0);

      // The result is this install's tree, not a merge of the two.
      expect(read(dir, CHECK_A)).not.toContain('truncated');
      expect(existsSync(path.join(dir, '.yggdrasil', 'aspects', ...INSTALL.split('/'), 'leftover.txt'))).toBe(false);
      expect(run(['check'], dir).all).not.toContain('package-file-modified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    '30: twenty rules and two hundred files stay within the stated bounds',
    () => {
      // A bound, not a benchmark: it exists to catch an accidental quadratic, not
      // to measure this machine.
      const dir = consumer('big');
      const market = mkdtempSync(path.join(tmpdir(), 'yg-pack-big-'));
      try {
        const pkg = path.join(market, 'packages', 'big');
        mkdirSync(pkg, { recursive: true });
        const names = Array.from({ length: 20 }, (_, i) => `rule-${String(i).padStart(2, '0')}`);
        writeFileSync(
          path.join(market, 'yg-marketplace.yaml'),
          'schema: yg-marketplace/1\npackages:\n  - { name: big, path: packages/big, version: 0.1.0 }\n',
          'utf-8',
        );
        writeFileSync(
          path.join(pkg, 'yg-package.yaml'),
          `schema: yg-package/1\nname: big\nversion: 0.1.0\nrequires: { yg: ">=1.0.0" }\naspects:\n${names.map((n) => `  - ${n}`).join('\n')}\n`,
          'utf-8',
        );
        for (const name of names) {
          mkdirSync(path.join(pkg, name, 'drills'), { recursive: true });
          writeFileSync(path.join(pkg, name, 'yg-aspect.yaml'), `name: ${name}\ndescription: One of many.\nreviewer: { type: deterministic }\nstatus: draft\n`, 'utf-8');
          writeFileSync(path.join(pkg, name, 'check.mjs'), 'export function check() { return []; }\n', 'utf-8');
          for (let i = 0; i < 8; i++) {
            writeFileSync(path.join(pkg, name, 'drills', `case-${i}.txt`), `case ${i}\n`, 'utf-8');
          }
        }

        // Both bounds are the it timeout below — thirty seconds to install plus
        // sixty to check. Measuring them here instead would put this machine's
        // load into the pass/fail decision.
        expect(run(['pack', 'add', `${market}#big`, '--as', 'acme/law'], dir).status).toBe(0);
        expect(run(['check'], dir).status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(market, { recursive: true, force: true });
      }
    },
    90_000,
  );

  // -------------------------------------------------------------------------
  // The attention feed
  // -------------------------------------------------------------------------

  it('31: advise names a newer version as quoted data, and says nothing when the source is unreachable', () => {
    const dir = consumer('advise');
    try {
      run(['pack', 'add', `${gitMarket}#demo@0.1.0`], dir);

      // Before anyone has asked about packages, the feed says nothing: it reads
      // what a reachable source was recorded as saying, and nobody has asked yet.
      // The feed itself never reaches outside the repository — an agent runs it
      // every session, and every other signal in it is derived from here alone.
      const beforeAsking = run(['advise', '--all'], dir);
      expect(beforeAsking.status).toBe(0);
      expect(beforeAsking.stdout).not.toContain('is installed at version');

      // Asking about packages is what records it — in a cache of its own, never
      // in the installation record, which is about integrity and must not churn
      // every time somebody runs a listing.
      expect(run(['pack', 'list'], dir).stdout).toContain('also publishes: 0.2.0');
      const cached = JSON.parse(read(dir, VERSIONS_CACHE)) as {
        schema: string;
        packages: Record<string, { published: string[]; checked_at: string }>;
      };
      expect(cached.schema).toBe('yg-package-versions/1');
      expect(cached.packages.demo.published.sort()).toEqual(['0.1.0', '0.2.0']);
      expect(Number.isNaN(Date.parse(cached.packages.demo.checked_at))).toBe(false);
      // The installation record is untouched by the asking.
      expect(read(dir, LOCK)).not.toContain('published');
      // And the cache never enters the repository.
      expect(read(dir, path.join('.yggdrasil', '.gitignore'))).toContain('.yg-packages-versions.json');

      const feed = run(['advise', '--all'], dir);
      expect(feed.status).toBe(0);
      expect(feed.stdout).toContain('The package "demo" is installed at version "0.1.0"');
      expect(feed.stdout).toContain('"0.2.0"');
      // Written as the source's own words, never as the tool's finding.
      expect(feed.stdout).toContain("that source's own words");
      expect(feed.stdout).toContain('yg pack update demo');

      // A source that stops answering keeps what was last recorded — a failed
      // reach is not evidence that anything changed — so the listing says nothing
      // new while the feed still reports what it was told before.
      write(dir, LOCK, read(dir, LOCK).replace(/source: "[^"]*"/, `source: ${JSON.stringify(UNREACHABLE_SOURCE)}`));
      const stillQuiet = run(['pack', 'list'], dir);
      expect(stillQuiet.status).toBe(0);
      expect(stillQuiet.stdout).not.toContain('also publishes');
      expect(run(['advise', '--all'], dir).stdout).toContain('is installed at version');

      // And a repository that has never asked hears nothing at all, however
      // reachable its source is — silence is "never checked", not "up to date".
      rmSync(path.join(dir, VERSIONS_CACHE));
      expect(run(['advise', '--all'], dir).stdout).not.toContain('is installed at version');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
