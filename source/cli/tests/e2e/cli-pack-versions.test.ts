// =============================================================================
// CLI E2E — `yg pack` beyond one package at the root: versions, provenance,
// repair, and every command run from somewhere other than the repository root.
//
// The lifecycle suite drives one package from one local directory at the root.
// This one builds real git marketplaces here at test time — a BARE repository
// holding real `pack/<name>@<version>` tags on TWO branches, with unreleased work
// on the default branch — and pins what installing, updating, verifying and
// removing do with them. ZERO NETWORK: every source is a directory or a
// repository made here.
//
//   Versions
//    V1. latest is the highest published tag, even on another branch; the
//        default branch's unreleased HEAD is never installed; the record names
//        the tag, the commit and what was asked for
//    V2. a local checkout installs committed, tagged content — never its
//        uncommitted working tree
//    V3. a pin stays put; --to moves it; --to latest follows again; going back
//        needs --allow-downgrade
//    V4. a tag whose manifest names another version is refused
//    V5. a git source that publishes no version is refused, not read at HEAD
//    V6. verify: a copy matching its tag passes; a moved tag fails, and a
//        reinstall refuses to take what the moved tag now names
//   Where a command runs
//    W1. from a subdirectory: add, list, remove and prime work on the root's
//        record, a typed relative path resolves from where it was typed, and
//        the record stores it relative to the root
//   Updating several packages
//    U1. a refusal for a later package leaves an earlier one untouched
//    U2. a rule the new version drops while the graph attaches it is refused;
//        once detached the update says what went and what changed
//   Repair and provenance
//    R1. an edited copy is repaired with --reinstall, keeping the adaptation,
//        and every hint points there
//    R2. a source that no longer says who it is under the recorded identity is
//        refused
//    R3. a missing local source is named as a missing path, not a network error
//   The copy and what runs from it
//    C1. a helper module check.mjs imports is part of the verdict
//    C2. a change of standing made in the adaptation is logged beside it, and
//        the copy stays clean
//    C3. drills run a rule that reads ctx.config and ctx.subject
//    C4. files are copied byte for byte, including bytes that are not UTF-8
//   Boundaries
//    B1. remove refuses while another rule implies one of the package's rules,
//        or a port names one
//    B2. a second package of the same name from another publisher is refused,
//        saying why
//    B3. a pack command already running holds the record; a stale lock does not
//    B4. a rule of your own under aspects/packages/ is named as reserved
//    B5. references: in the adaptation of a script rule names the adaptation
//    B6. no fetch directory survives a refusal or a successful install
//   Records written by an earlier release
//    E1. the next plain update records the tag and commit, even at the newest
//        version, and asks for no re-judging when no rule changed
//    E2. a package installed from an untagged source does not stop update-all;
//        verify names that cause and a next step that works
//    E3. a re-used version number is named as such; only --reinstall
//        --accept-republished takes it, keeping the adaptation
//    E4. --accept-republished only goes with --reinstall
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGitFixture, FIXTURE_RM_OPTIONS } from '../support/git-fixture.js';

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
const RULE_A_DIR = path.join('.yggdrasil', 'aspects', ...RULE_A.split('/'));
const ADAPT_A = path.join(RULE_A_DIR, 'yg-aspect.adapt.yaml');
const CHECK_A = path.join(RULE_A_DIR, 'check.mjs');
const LOCK = path.join('.yggdrasil', 'yg-packages.yaml');

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

const made: string[] = [];
function temp(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-packv-${label}-`));
  made.push(dir);
  return dir;
}

function consumer(label: string): string {
  const dir = temp(label);
  cpSync(CONSUMER, dir, { recursive: true });
  return dir;
}

function read(dir: string, rel: string): string {
  return readFileSync(path.join(dir, rel), 'utf-8');
}

function write(dir: string, rel: string, text: string): void {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text, 'utf-8');
}

function attach(dir: string, aspectId: string): void {
  const rel = path.join('.yggdrasil', 'model', 'app', 'yg-node.yaml');
  write(dir, rel, read(dir, rel).replace('type: app\n', `type: app\naspects:\n  - ${aspectId}\n`));
}

function detach(dir: string): void {
  const rel = path.join('.yggdrasil', 'model', 'app', 'yg-node.yaml');
  write(dir, rel, read(dir, rel).replace(/aspects:\n(?: {2}- .*\n)+/, ''));
}

function setSetting(dir: string, key: string, value: string): void {
  const text = read(dir, ADAPT_A).replace(/^# config:$/m, 'config:');
  write(dir, ADAPT_A, text.replace(new RegExp(`^(?:#   |  )${key}: .*$`, 'm'), `  ${key}: ${value}`));
}

function git(dir: string, args: string[]): string {
  const r = runGitFixture(dir, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** Set the version `demo` is published at, in both manifests that say it. */
function bump(work: string, version: string): void {
  for (const rel of ['yg-marketplace.yaml', path.join('packages', 'demo', 'yg-package.yaml')]) {
    const file = path.join(work, rel);
    writeFileSync(file, readFileSync(file, 'utf-8').replace(/^( *version: ).*$/m, `$1${version}`), 'utf-8');
  }
}

/** Replace the marketplace tree in `work` with `from`, publishing it as `version`. */
function publish(work: string, from: string, version: string): void {
  rmSync(path.join(work, 'packages'), FIXTURE_RM_OPTIONS);
  cpSync(from, work, { recursive: true });
  bump(work, version);
}

/** Make the record look like one an earlier release wrote: no requested, tag or commit. */
function asEarlierRelease(dir: string): void {
  write(dir, LOCK, read(dir, LOCK).replace(/^ {4}(?:requested|tag|commit): .*\n/gm, ''));
}

/**
 * Publish the named packages of a two-package marketplace (alpha, zulu) at
 * `version`, each tagged; the other keeps whatever version it already had.
 */
function writeTwoPackages(src: string, version: string, which: string[]): void {
  const versions: Record<string, string> = {};
  const market = path.join(src, 'yg-marketplace.yaml');
  if (existsSync(market)) {
    for (const m of readFileSync(market, 'utf-8').matchAll(/- name: (\w+)\n.*\n {4}version: (.*)\n/g)) versions[m[1]] = m[2];
  }
  for (const name of which) {
    versions[name] = version;
    rmSync(path.join(src, 'packages', name), FIXTURE_RM_OPTIONS);
    cpSync(path.join(MARKET_V1, 'packages', 'demo'), path.join(src, 'packages', name), { recursive: true });
    const manifest = path.join(src, 'packages', name, 'yg-package.yaml');
    writeFileSync(manifest, readFileSync(manifest, 'utf-8').replace('name: demo', `name: ${name}`).replace(/^version: .*$/m, `version: ${version}`), 'utf-8');
    const check = path.join(src, 'packages', name, 'rule-a', 'check.mjs');
    writeFileSync(check, `${readFileSync(check, 'utf-8')}// ${name} ${version}\n`, 'utf-8');
  }
  writeFileSync(
    market,
    'schema: yg-marketplace/1\npackages:\n' +
      Object.keys(versions).sort().map((n) => `  - name: ${n}\n    path: packages/${n}\n    version: ${versions[n]}\n`).join(''),
    'utf-8',
  );
  git(src, ['add', '-A']);
  git(src, ['commit', '-qm', `${which.join(', ')} ${version}`]);
  for (const name of which) git(src, ['tag', `pack/${name}@${version}`]);
}

function leftovers(dir: string): string[] {
  return readdirSync(path.join(dir, '.yggdrasil')).filter((n) => n.startsWith('pack-fetch-') || n.startsWith('pack-command'));
}

/**
 * A marketplace published the way a real one is: 0.1.0 tagged on `main`, 0.2.0
 * tagged on a `release-0.2` branch, and unreleased 0.6.0 work committed on
 * `main` with no tag. Pushed, branches and tags, into a BARE repository.
 */
interface Market {
  work: string;
  bare: string;
}
function versionedMarket(): Market {
  const root = temp('market');
  const work = path.join(root, 'work');
  mkdirSync(work);
  git(work, ['init', '-q', '-b', 'main']);
  publish(work, MARKET_V1, '0.1.0');
  git(work, ['add', '-A']);
  git(work, ['commit', '-qm', 'demo 0.1.0']);
  git(work, ['tag', 'pack/demo@0.1.0']);
  git(work, ['checkout', '-q', '-b', 'release-0.2']);
  publish(work, MARKET_V2, '0.2.0');
  git(work, ['add', '-A']);
  git(work, ['commit', '-qm', 'demo 0.2.0']);
  git(work, ['tag', 'pack/demo@0.2.0']);
  git(work, ['checkout', '-q', 'main']);
  publish(work, MARKET_V2, '0.6.0');
  const check = path.join(work, 'packages', 'demo', 'rule-a', 'check.mjs');
  writeFileSync(check, `${readFileSync(check, 'utf-8')}// unreleased WIP\n`, 'utf-8');
  git(work, ['add', '-A']);
  git(work, ['commit', '-qm', 'work in progress']);
  git(work, ['remote', 'add', 'origin', 'https://example.test/acme/law.git']);

  // A bare repository has no work tree, so it is made outside the fixture
  // helper (which pins one); the environment is scrubbed of every inherited
  // GIT_* variable so it cannot reach any other repository either.
  const bare = path.join(root, 'bare.git');
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const init = spawnSync('git', ['init', '-q', '--bare', bare], { cwd: root, encoding: 'utf-8', env });
  if (init.status !== 0) throw new Error(`git init --bare failed: ${init.stderr}`);
  git(work, ['push', '-q', bare, 'main', 'release-0.2']);
  git(work, ['push', '-q', bare, '--tags']);
  return { work, bare };
}

let market: Market;

beforeAll(() => {
  if (!distExists) return;
  market = versionedMarket();
});

afterAll(() => {
  for (const d of made.splice(0)) rmSync(d, FIXTURE_RM_OPTIONS);
});

describe.skipIf(!distExists)('CLI E2E — yg pack: versions, provenance, repair, and where commands run', () => {
  // -------------------------------------------------------------------------
  // Versions
  // -------------------------------------------------------------------------

  it('V1: latest is the highest published tag, even on another branch — never the unreleased HEAD', () => {
    const dir = consumer('latest');
    const added = run(['pack', 'add', `${market.bare}#demo`, '--as', 'acme/law'], dir);
    expect(added.status, added.all).toBe(0);
    expect(added.stdout).toContain("Installed 'demo' 0.2.0 from pack/demo@0.2.0");
    expect(read(dir, CHECK_A)).not.toContain('unreleased WIP');

    const lock = read(dir, LOCK);
    expect(lock).toContain('version: "0.2.0"');
    expect(lock).toContain('requested: "latest"');
    expect(lock).toContain('tag: "pack/demo@0.2.0"');
    expect(lock).toMatch(/commit: "[0-9a-f]{40}"/);
    expect(lock).toContain('identity: "given"');
    expect(leftovers(dir)).toEqual([]);
  }, 60_000);

  it('V2: a local checkout installs committed, tagged content — never its uncommitted working tree', () => {
    const dir = consumer('checkout');
    const check = path.join(market.work, 'packages', 'demo', 'rule-a', 'check.mjs');
    const clean = readFileSync(check, 'utf-8');
    writeFileSync(check, `${clean}// uncommitted edit\n`, 'utf-8');
    try {
      const added = run(['pack', 'add', `${market.work}#demo`], dir);
      expect(added.status, added.all).toBe(0);
      // The identity comes from the checkout's origin; the content from the tag.
      expect(added.stdout).toContain("Installed 'demo' 0.2.0 from pack/demo@0.2.0");
      expect(read(dir, CHECK_A)).not.toContain('uncommitted edit');
      expect(read(dir, CHECK_A)).not.toContain('unreleased WIP');
      expect(read(dir, LOCK)).not.toContain('identity:');
    } finally {
      writeFileSync(check, clean, 'utf-8');
    }
  }, 60_000);

  it('V3: a pin stays put; --to moves it; --to latest follows again; going back needs --allow-downgrade', () => {
    const dir = consumer('pin');
    expect(run(['pack', 'add', `${market.bare}#demo@0.1.0`, '--as', 'acme/law'], dir).status).toBe(0);
    expect(read(dir, LOCK)).toContain('requested: "0.1.0"');

    const plain = run(['pack', 'update', 'demo'], dir);
    expect(plain.status, plain.all).toBe(0);
    expect(plain.stdout).toContain("'demo' is pinned at 0.1.0");
    expect(plain.stdout).toContain('yg pack update demo --to 0.2.0');
    expect(read(dir, LOCK)).toContain('version: "0.1.0"');

    const follow = run(['pack', 'update', 'demo', '--to', 'latest'], dir);
    expect(follow.status, follow.all).toBe(0);
    expect(follow.stdout).toContain('0.1.0 → 0.2.0');
    expect(read(dir, LOCK)).toContain('requested: "latest"');

    const back = run(['pack', 'update', 'demo', '--to', '0.1.0'], dir);
    expect(back.status).toBe(1);
    expect(back.all).toContain('older than the installed 0.2.0');
    expect(read(dir, LOCK)).toContain('version: "0.2.0"');
  }, 90_000);

  it('V4: a tag whose manifest names another version is refused, naming all three', () => {
    const odd = temp('odd');
    const work = path.join(odd, 'w');
    cpSync(market.work, work, { recursive: true });
    git(work, ['checkout', '-q', 'pack/demo@0.1.0']);
    publish(work, MARKET_V1, '0.3.0');
    git(work, ['add', '-A']);
    git(work, ['commit', '-qm', 'says 0.3.0']);
    git(work, ['tag', 'pack/demo@0.9.0']);

    const dir = consumer('mismatch');
    const added = run(['pack', 'add', `${work}#demo@0.9.0`], dir);
    expect(added.status).toBe(1);
    expect(added.all).toContain('pack/demo@0.9.0');
    expect(added.all).toContain('yg-package.yaml says 0.3.0');
    expect(existsSync(path.join(dir, LOCK))).toBe(false);
  }, 60_000);

  it('V5: a git source that publishes no version is refused rather than read at its default branch', () => {
    const src = temp('untagged');
    git(src, ['init', '-q', '-b', 'main']);
    cpSync(MARKET_V1, src, { recursive: true });
    git(src, ['add', '-A']);
    git(src, ['commit', '-qm', 'no tag yet']);

    const dir = consumer('untagged');
    const added = run(['pack', 'add', `${src}#demo`, '--as', 'acme/law'], dir);
    expect(added.status).toBe(1);
    expect(added.all).toContain("publishes no version of 'demo'");
    expect(added.all).toContain('pack/demo@<version>');
    expect(existsSync(path.join(dir, LOCK))).toBe(false);
    expect(leftovers(dir)).toEqual([]);
  }, 60_000);

  it('V6: verify passes a copy matching its tag, fails a moved tag, and a reinstall will not take the moved one', () => {
    const own = temp('moved');
    const work = path.join(own, 'w');
    cpSync(market.work, work, { recursive: true });
    const dir = consumer('verify');
    expect(run(['pack', 'add', `${work}#demo`], dir).status).toBe(0);

    const ok = run(['pack', 'verify'], dir);
    expect(ok.status, ok.all).toBe(0);
    expect(ok.stdout).toContain("'demo' 0.2.0 — the copy is exactly pack/demo@0.2.0");

    // The publisher moves the tag to a different commit.
    git(work, ['checkout', '-q', 'release-0.2']);
    const check = path.join(work, 'packages', 'demo', 'rule-a', 'check.mjs');
    writeFileSync(check, `${readFileSync(check, 'utf-8')}// retagged\n`, 'utf-8');
    git(work, ['commit', '-qam', 'moved']);
    git(work, ['tag', '-f', 'pack/demo@0.2.0']);

    const moved = run(['pack', 'verify', 'demo'], dir);
    expect(moved.status).toBe(1);
    expect(moved.stdout).toContain('now points at commit');
    expect(moved.stdout).toContain('rule-a/check.mjs is not what the source publishes');

    write(dir, CHECK_A, `${read(dir, CHECK_A)}// mine\n`);
    const reinstall = run(['pack', 'update', 'demo', '--reinstall'], dir);
    expect(reinstall.status).toBe(1);
    expect(reinstall.all).toContain('now points at commit');
    expect(read(dir, CHECK_A)).toContain('// mine');
  }, 90_000);

  // -------------------------------------------------------------------------
  // Where a command runs
  // -------------------------------------------------------------------------

  it('W1: from a subdirectory, every pack command works on the root record', () => {
    const dir = consumer('nested');
    const sub = path.join(dir, 'src', 'sub');
    mkdirSync(sub, { recursive: true });
    const typed = path.relative(sub, MARKET_V1);

    const added = run(['pack', 'add', `${typed}#demo`, '--as', 'acme/law'], sub);
    expect(added.status, added.all).toBe(0);
    expect(existsSync(path.join(sub, '.yggdrasil'))).toBe(false);
    expect(existsSync(path.join(dir, CHECK_A))).toBe(true);
    // Recorded relative to the repository root, so it means the same thing from
    // anywhere in it.
    const expected = path.relative(dir, MARKET_V1).split(path.sep).join('/');
    expect(read(dir, LOCK)).toContain(`source: ${JSON.stringify(expected)}`);

    const listed = run(['pack', 'list'], sub);
    expect(listed.stdout).toContain('1 installed');
    expect(listed.stdout).toContain('demo');
    expect(run(['prime'], sub).stdout).toContain('packages-and-marketplaces');

    const again = run(['pack', 'add', `${typed}#demo`, '--as', 'acme/law'], sub);
    expect(again.status).toBe(1);
    expect(again.all).toContain('already installed');

    const removed = run(['pack', 'remove', 'demo'], sub);
    expect(removed.status, removed.all).toBe(0);
    expect(existsSync(path.join(dir, CHECK_A))).toBe(false);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Updating several packages
  // -------------------------------------------------------------------------

  it('U1: a refusal for a later package leaves an earlier one untouched, and says nothing was updated', () => {
    const src = temp('two');
    git(src, ['init', '-q', '-b', 'main']);
    const writeTwo = (version: string, zuluRequires: string): void => {
      rmSync(path.join(src, 'packages'), FIXTURE_RM_OPTIONS);
      for (const name of ['alpha', 'zulu']) {
        cpSync(path.join(MARKET_V1, 'packages', 'demo'), path.join(src, 'packages', name), { recursive: true });
        const manifest = path.join(src, 'packages', name, 'yg-package.yaml');
        let text = readFileSync(manifest, 'utf-8').replace('name: demo', `name: ${name}`).replace(/^version: .*$/m, `version: ${version}`);
        if (name === 'zulu') text = text.replace(/yg: ".*"/, `yg: "${zuluRequires}"`);
        writeFileSync(manifest, text, 'utf-8');
      }
      writeFileSync(
        path.join(src, 'yg-marketplace.yaml'),
        'schema: yg-marketplace/1\npackages:\n' +
          ['alpha', 'zulu'].map((n) => `  - name: ${n}\n    path: packages/${n}\n    version: ${version}\n`).join(''),
        'utf-8',
      );
      git(src, ['add', '-A']);
      git(src, ['commit', '-qm', version]);
      git(src, ['tag', `pack/alpha@${version}`]);
      git(src, ['tag', `pack/zulu@${version}`]);
    };
    writeTwo('0.1.0', '>=1.0.0');
    git(src, ['remote', 'add', 'origin', 'https://example.test/acme/law.git']);

    const dir = consumer('update-all');
    expect(run(['pack', 'add', `${src}#alpha`], dir).status).toBe(0);
    expect(run(['pack', 'add', `${src}#zulu`], dir).status).toBe(0);
    const lockBefore = read(dir, LOCK);
    const alphaCheck = path.join('.yggdrasil', 'aspects', 'packages', 'acme', 'law', 'alpha', 'rule-a', 'check.mjs');
    const alphaBefore = read(dir, alphaCheck);

    // 0.2.0 of alpha is fine; 0.2.0 of zulu needs a Yggdrasil nobody has.
    writeTwo('0.2.0', '>=99.0.0');

    const updated = run(['pack', 'update'], dir);
    expect(updated.status).toBe(1);
    expect(updated.all).toContain('>=99.0.0');
    expect(updated.all).not.toContain("Updated 'alpha'");
    expect(read(dir, LOCK)).toBe(lockBefore);
    expect(read(dir, alphaCheck)).toBe(alphaBefore);
    expect(leftovers(dir)).toEqual([]);
  }, 90_000);

  it('U2: dropping a rule the graph attaches is refused; once detached the update says what went and what changed', () => {
    const src = temp('drop');
    git(src, ['init', '-q', '-b', 'main']);
    publish(src, MARKET_V1, '0.1.0');
    git(src, ['add', '-A']);
    git(src, ['commit', '-qm', '0.1.0']);
    git(src, ['tag', 'pack/demo@0.1.0']);
    git(src, ['remote', 'add', 'origin', 'https://example.test/acme/law.git']);

    const dir = consumer('drop');
    expect(run(['pack', 'add', `${src}#demo`], dir).status).toBe(0);
    attach(dir, `${INSTALL}/rule-b`);

    // 0.2.0 drops rule-b and promotes the rule-c bundle from draft to enforced.
    rmSync(path.join(src, 'packages', 'demo', 'rule-b'), FIXTURE_RM_OPTIONS);
    const manifest = path.join(src, 'packages', 'demo', 'yg-package.yaml');
    writeFileSync(manifest, readFileSync(manifest, 'utf-8').replace('  - rule-b\n', ''), 'utf-8');
    const ruleC = path.join(src, 'packages', 'demo', 'rule-c', 'yg-aspect.yaml');
    writeFileSync(ruleC, readFileSync(ruleC, 'utf-8').replace('status: draft', 'status: enforced'), 'utf-8');
    bump(src, '0.2.0');
    git(src, ['add', '-A']);
    git(src, ['commit', '-qm', '0.2.0']);
    git(src, ['tag', 'pack/demo@0.2.0']);

    const lockBefore = read(dir, LOCK);
    const refused = run(['pack', 'update', 'demo'], dir);
    expect(refused.status).toBe(1);
    expect(refused.all).toContain("no longer ships 'rule-b'");
    expect(refused.all).toContain('component app');
    expect(read(dir, LOCK)).toBe(lockBefore);

    detach(dir);
    const updated = run(['pack', 'update', 'demo'], dir);
    expect(updated.status, updated.all).toBe(0);
    expect(updated.stdout).toContain('rules no longer shipped, removed with their adaptations: rule-b');
    expect(updated.stdout).toContain('rule-c: status draft → enforced');
  }, 90_000);

  // -------------------------------------------------------------------------
  // Repair and provenance
  // -------------------------------------------------------------------------

  it('R1: an edited copy is repaired with --reinstall, keeping the adaptation — and every hint points there', () => {
    const dir = consumer('reinstall');
    expect(run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir).status).toBe(0);
    setSetting(dir, 'threshold', '50');
    const adapt = read(dir, ADAPT_A);
    const original = read(dir, CHECK_A);
    write(dir, CHECK_A, `${original}// mine\n`);

    const checked = run(['check'], dir);
    expect(checked.status).toBe(1);
    expect(checked.all).toContain('yg pack update demo --reinstall');
    rmSync(path.join(dir, RULE_A_DIR, 'yg-aspect.yaml'));
    const plain = run(['pack', 'update', 'demo'], dir);
    expect(plain.status).toBe(1);
    expect(plain.all).toContain('yg pack update demo --reinstall');

    const repaired = run(['pack', 'update', 'demo', '--reinstall'], dir);
    expect(repaired.status, repaired.all).toBe(0);
    expect(repaired.stdout).toContain("Reinstalled 'demo' 0.1.0");
    expect(read(dir, CHECK_A)).toBe(original);
    expect(existsSync(path.join(dir, RULE_A_DIR, 'yg-aspect.yaml'))).toBe(true);
    expect(read(dir, ADAPT_A)).toBe(adapt);
    expect(run(['check'], dir).all).not.toContain('package-file-modified');
  }, 60_000);

  it('R2: a source that no longer is who the record says is refused', () => {
    const dir = consumer('identity');
    expect(run(['pack', 'add', `${market.work}#demo`], dir).status).toBe(0);
    write(dir, LOCK, read(dir, LOCK).replace(/source: "[^"]*"/, 'source: "https://example.test/evil/law.git"'));
    const updated = run(['pack', 'update', 'demo'], dir);
    expect(updated.status).toBe(1);
    expect(updated.all).toContain("published by acme/law, but its source 'https://example.test/evil/law.git' is evil/law's");
  }, 60_000);

  it('R3: a local source that is gone is named as a missing path, not as a network failure', () => {
    const src = temp('gone');
    cpSync(MARKET_V1, src, { recursive: true });
    const dir = consumer('gone');
    expect(run(['pack', 'add', `${src}#demo`, '--as', 'acme/law'], dir).status).toBe(0);
    rmSync(src, FIXTURE_RM_OPTIONS);

    const updated = run(['pack', 'update', 'demo'], dir);
    expect(updated.status).toBe(1);
    expect(updated.all).toContain('is a path on this machine');
    expect(updated.all).not.toContain('Could not reach');
  });

  // -------------------------------------------------------------------------
  // The copy and what runs from it
  // -------------------------------------------------------------------------

  it('C1: a helper module check.mjs imports is part of the verdict — changing only it re-opens the rule', () => {
    const src = temp('helper');
    cpSync(MARKET_V1, src, { recursive: true });
    const rule = path.join(src, 'packages', 'demo', 'rule-a');
    writeFileSync(path.join(rule, 'limit.mjs'), 'export function allowed(limit) { return limit; }\n', 'utf-8');
    const check = path.join(rule, 'check.mjs');
    writeFileSync(
      check,
      `import { allowed } from './limit.mjs';\n${readFileSync(check, 'utf-8').replace('const limit = ctx.config.threshold;', 'const limit = allowed(ctx.config.threshold);')}`,
      'utf-8',
    );

    const dir = consumer('helper');
    expect(run(['pack', 'add', `${src}#demo`, '--as', 'acme/law'], dir).status).toBe(0);
    setSetting(dir, 'threshold', '50');
    attach(dir, RULE_A);
    expect(run(['check', '--approve', '--only-deterministic'], dir).status).toBe(0);
    expect(run(['check'], dir).status).toBe(0);

    // 0.2.0 changes nothing but the helper: now every file is too long.
    writeFileSync(path.join(rule, 'limit.mjs'), 'export function allowed() { return 0; }\n', 'utf-8');
    bump(src, '0.2.0');
    const updated = run(['pack', 'update', 'demo'], dir);
    expect(updated.status, updated.all).toBe(0);
    expect(updated.stdout).toContain('rule-a: changed limit.mjs');

    const stale = run(['check'], dir);
    expect(stale.status).toBe(1);
    expect(stale.all).toContain('unverified');
    const refilled = run(['check', '--approve', '--only-deterministic'], dir);
    expect(refilled.status).toBe(1);
    expect(refilled.all).toContain('this repository allows 0');
  }, 90_000);

  it('C2: a change of standing made in the adaptation is logged beside it, and the copy stays clean', () => {
    const dir = consumer('standing');
    expect(run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir).status).toBe(0);
    setSetting(dir, 'threshold', '50');
    attach(dir, RULE_A);
    expect(run(['check', '--approve', '--only-deterministic'], dir).status).toBe(0);

    write(dir, ADAPT_A, `status: advisory\n${read(dir, ADAPT_A)}`);
    // The free step writes no committed file, the adaptation's log included.
    const free = run(['check', '--approve', '--only-deterministic'], dir);
    expect(free.status, free.all).toBe(0);
    expect(existsSync(path.join(dir, RULE_A_DIR, 'yg-aspect.adapt.log.md'))).toBe(false);
    // A full fill (this project has script rules only, so it needs no reviewer) writes it.
    const moved = run(['check', '--approve'], dir);
    expect(moved.status, moved.all).toBe(0);
    expect(moved.all).toContain('now stands at advisory');
    expect(existsSync(path.join(dir, RULE_A_DIR, 'log.md'))).toBe(false);
    expect(read(dir, path.join(RULE_A_DIR, 'yg-aspect.adapt.log.md'))).toContain('advisory');

    const after = run(['check'], dir);
    expect(after.all).not.toContain('package-file-modified');
    expect(after.status).toBe(0);

    // A reinstall carries the history across with the adaptation.
    write(dir, CHECK_A, `${read(dir, CHECK_A)}// mine\n`);
    expect(run(['pack', 'update', 'demo', '--reinstall'], dir).status).toBe(0);
    expect(read(dir, path.join(RULE_A_DIR, 'yg-aspect.adapt.log.md'))).toContain('advisory');
  }, 90_000);

  it('C3: drills run a rule that reads ctx.config and ctx.subject', () => {
    const dir = consumer('drill');
    expect(run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir).status).toBe(0);
    const drilled = run(['drill', '--aspect', RULE_A], dir);
    expect(drilled.status, drilled.all).toBe(0);
    // It used to be `unrun`, exit 2: the drill handed the rule no ctx.config.
    expect(drilled.all).toContain('2 pass · 0 MISS · 0 FALSE-ALARM · 0 unrun · 0 unsupported');
  }, 60_000);

  it('C4: files are copied byte for byte, including bytes that are not UTF-8', () => {
    const src = temp('bytes');
    cpSync(MARKET_V1, src, { recursive: true });
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café" in Latin-1
    writeFileSync(path.join(src, 'packages', 'demo', 'rule-b', 'notes.txt'), latin1);

    const dir = consumer('bytes');
    expect(run(['pack', 'add', `${src}#demo`, '--as', 'acme/law'], dir).status).toBe(0);
    const copied = readFileSync(path.join(dir, '.yggdrasil', 'aspects', ...INSTALL.split('/'), 'rule-b', 'notes.txt'));
    expect(copied.equals(latin1)).toBe(true);
    expect(run(['check'], dir).all).not.toContain('package-file-modified');
  });

  // -------------------------------------------------------------------------
  // Boundaries
  // -------------------------------------------------------------------------

  it('B1: remove refuses while another rule implies one of its rules, or a port names one', () => {
    const dir = consumer('implied');
    expect(run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir).status).toBe(0);
    write(dir, '.yggdrasil/aspects/bundle/yg-aspect.yaml', `name: Bundle\ndescription: Ours.\nimplies:\n  - ${RULE_A}\n`);

    const implied = run(['pack', 'remove', 'demo'], dir);
    expect(implied.status).toBe(1);
    expect(implied.all).toContain('rule bundle implies it');
    expect(existsSync(path.join(dir, CHECK_A))).toBe(true);

    rmSync(path.join(dir, '.yggdrasil', 'aspects', 'bundle'), FIXTURE_RM_OPTIONS);
    const node = path.join('.yggdrasil', 'model', 'app', 'yg-node.yaml');
    write(dir, node, `${read(dir, node)}ports:\n  api:\n    description: The entry.\n    aspects:\n      - ${RULE_A}\n`);
    const ported = run(['pack', 'remove', 'demo'], dir);
    expect(ported.status).toBe(1);
    expect(ported.all).toContain('port api of component app');

    write(dir, node, read(dir, node).replace(/ports:\n[\s\S]*$/, ''));
    const removed = run(['pack', 'remove', 'demo'], dir);
    expect(removed.status, removed.all).toBe(0);
    expect(removed.stdout).toContain('adaptations (yg-aspect.adapt.yaml) went with it');
  });

  it('B2: a second package of the same name from another publisher is refused, saying why', () => {
    const dir = consumer('same-name');
    expect(run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir).status).toBe(0);
    const other = run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'other/law'], dir);
    expect(other.status).toBe(1);
    expect(other.all).toContain('already installed from acme/law');
    expect(other.all).toContain('published by other/law');
    expect(other.all).toContain('one package of a given name at a time');
  });

  it('B3: a pack command already running holds the record; a stale lock is taken over', () => {
    const dir = consumer('busy');
    const lockFile = path.join(dir, '.yggdrasil', 'pack-command.lock.tmp');
    writeFileSync(lockFile, String(process.pid), 'utf-8');
    const busy = run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir);
    expect(busy.status).toBe(1);
    expect(busy.all).toContain('Another yg pack command');
    expect(existsSync(path.join(dir, LOCK))).toBe(false);

    writeFileSync(lockFile, '2147483646', 'utf-8');
    const stale = run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir);
    expect(stale.status, stale.all).toBe(0);
    expect(existsSync(lockFile)).toBe(false);
  });

  it('B4: a rule of your own under aspects/packages/ is named as reserved, not only as undefined', () => {
    const dir = consumer('reserved');
    write(dir, '.yggdrasil/aspects/packages/mine/yg-aspect.yaml', 'name: Mine\ndescription: Mine.\n');
    write(dir, '.yggdrasil/aspects/packages/mine/check.mjs', 'export function check() { return []; }\n');
    const checked = run(['check'], dir);
    expect(checked.status).toBe(1);
    expect(checked.all).toContain('aspect-packages-dir-reserved');
    expect(checked.all).toContain('is not an installed package');
  });

  it('B5: references: in the adaptation of a script rule is refused naming the adaptation, not the copy', () => {
    const dir = consumer('refs');
    expect(run(['pack', 'add', `${MARKET_V1}#demo`, '--as', 'acme/law'], dir).status).toBe(0);
    expect(read(dir, ADAPT_A)).not.toContain('#   references:');
    write(dir, ADAPT_A, `references:\n  - src/a.ts\n${read(dir, ADAPT_A)}`);
    const checked = run(['check'], dir);
    expect(checked.status).toBe(1);
    expect(checked.all).toContain('aspect-references-on-deterministic');
    expect(checked.all).toContain('yg-aspect.adapt.yaml — the adaptation beside the installed copy');
  });

  it('B6: no fetch directory survives a refusal, or a successful install from a repository', () => {
    const dir = consumer('debris');
    const refused = run(['pack', 'add', `${market.bare}#demo@9.9.9`, '--as', 'acme/law'], dir);
    expect(refused.status).toBe(1);
    expect(refused.all).toContain('pack/demo@9.9.9');
    expect(leftovers(dir)).toEqual([]);
    expect(run(['pack', 'add', `${market.bare}#demo`, '--as', 'acme/law'], dir).status).toBe(0);
    expect(leftovers(dir)).toEqual([]);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Records written by an earlier release
  // -------------------------------------------------------------------------

  it('E1: a record from an earlier release gets its tag and commit from the next plain update, even at the newest version', () => {
    const dir = consumer('backfill');
    expect(run(['pack', 'add', `${market.bare}#demo`, '--as', 'acme/law'], dir).status).toBe(0);
    asEarlierRelease(dir);
    expect(read(dir, LOCK)).not.toContain('tag:');

    const verified = run(['pack', 'verify', 'demo'], dir);
    expect(verified.status, verified.all).toBe(0);
    expect(verified.stdout).toContain('the next yg pack update demo records the tag and commit');

    const updated = run(['pack', 'update'], dir);
    expect(updated.status, updated.all).toBe(0);
    expect(updated.stdout).toContain("'demo' is already at 0.2.0; recorded its tag pack/demo@0.2.0 and commit");
    expect(updated.stdout).not.toContain('need judging again');
    const lock = read(dir, LOCK);
    expect(lock).toContain('requested: "latest"');
    expect(lock).toContain('tag: "pack/demo@0.2.0"');
    expect(lock).toMatch(/commit: "[0-9a-f]{40}"/);

    // Once recorded, a plain update has nothing to write.
    const again = run(['pack', 'update', 'demo'], dir);
    expect(again.stdout).toContain("'demo' is already at 0.2.0.");
    expect(read(dir, LOCK)).toBe(lock);

    // A reinstall of an untouched copy changes no rule, so it asks for no re-judging.
    const reinstalled = run(['pack', 'update', 'demo', '--reinstall'], dir);
    expect(reinstalled.status, reinstalled.all).toBe(0);
    expect(reinstalled.stdout).not.toContain('need judging again');
  }, 90_000);

  it('E2: a package an earlier release installed from an untagged source does not stop the others from updating', () => {
    const src = temp('untagged-one');
    git(src, ['init', '-q', '-b', 'main']);
    writeTwoPackages(src, '0.1.0', ['alpha', 'zulu']);
    git(src, ['remote', 'add', 'origin', 'https://example.test/acme/law.git']);

    const dir = consumer('untagged-one');
    expect(run(['pack', 'add', `${src}#alpha`], dir).status).toBe(0);
    expect(run(['pack', 'add', `${src}#zulu`], dir).status).toBe(0);
    // What an earlier release left: no tag recorded, and the source never
    // tagged 'zulu' (that release read its default branch).
    asEarlierRelease(dir);
    git(src, ['tag', '-d', 'pack/zulu@0.1.0']);
    writeTwoPackages(src, '0.2.0', ['alpha']);

    const updated = run(['pack', 'update'], dir);
    expect(updated.status).toBe(1);
    expect(updated.stdout).toContain("Updated 'alpha' 0.1.0 → 0.2.0");
    expect(updated.all).toContain("'zulu' was not updated");
    expect(updated.all).toContain('installed from an untagged source by an earlier release');
    expect(updated.all).not.toContain('Nothing was installed or changed');
    expect(read(dir, LOCK)).toContain('tag: "pack/alpha@0.2.0"');

    const verified = run(['pack', 'verify', 'zulu'], dir);
    expect(verified.status).toBe(1);
    expect(verified.stdout).toContain("'zulu' 0.1.0 was installed from an untagged source by an earlier release");
    expect(verified.stdout).not.toContain('--reinstall');
    expect(verified.stdout).toContain('yg pack remove zulu');

    // The author tags a version: the step verify named now works.
    writeTwoPackages(src, '0.3.0', ['zulu']);
    const hinted = run(['pack', 'verify', 'zulu'], dir);
    expect(hinted.status).toBe(1);
    expect(hinted.stdout).toContain('take a published version: yg pack update zulu');
    const taken = run(['pack', 'update', 'zulu'], dir);
    expect(taken.status, taken.all).toBe(0);
    expect(taken.stdout).toContain("Updated 'zulu' 0.1.0 → 0.3.0");
    expect(run(['pack', 'verify'], dir).status).toBe(0);
  }, 120_000);

  it('E3: a version number the publisher re-used is named as such, and taken only when asked, keeping the adaptation', () => {
    const src = temp('reused');
    git(src, ['init', '-q', '-b', 'main']);
    publish(src, MARKET_V1, '0.1.0');
    git(src, ['add', '-A']);
    git(src, ['commit', '-qm', '0.1.0']);
    git(src, ['tag', 'pack/demo@0.1.0']);
    git(src, ['remote', 'add', 'origin', 'https://example.test/acme/law.git']);

    const dir = consumer('reused');
    expect(run(['pack', 'add', `${src}#demo`], dir).status).toBe(0);
    asEarlierRelease(dir);
    setSetting(dir, 'threshold', '50');
    const adapt = read(dir, ADAPT_A);
    const lockBefore = read(dir, LOCK);

    // The publisher changes the package and tags it 0.1.0 again.
    const check = path.join(src, 'packages', 'demo', 'rule-a', 'check.mjs');
    writeFileSync(check, `${readFileSync(check, 'utf-8')}// republished\n`, 'utf-8');
    git(src, ['commit', '-qam', 'same number, new content']);
    git(src, ['tag', '-f', 'pack/demo@0.1.0']);

    const verified = run(['pack', 'verify', 'demo'], dir);
    expect(verified.status).toBe(1);
    expect(verified.stdout).toContain('the publisher re-used the version number 0.1.0');
    expect(verified.stdout).toContain('yg pack update demo --reinstall --accept-republished');
    expect(verified.stdout).not.toContain('edited copy');
    expect(verified.stdout).not.toContain('tag that moved');

    const plain = run(['pack', 'update', 'demo'], dir);
    expect(plain.status, plain.all).toBe(0);
    expect(plain.stdout).not.toContain('already at');
    expect(plain.stdout).toContain('re-used the version number 0.1.0');
    expect(read(dir, LOCK)).toBe(lockBefore);

    const pinned = run(['pack', 'update', 'demo', '--to', '0.1.0'], dir);
    expect(pinned.status).toBe(1);
    expect(pinned.all).not.toContain('now pinned there');
    expect(pinned.all).toContain('re-used the version number 0.1.0');
    expect(read(dir, LOCK)).toBe(lockBefore);

    const reinstall = run(['pack', 'update', 'demo', '--reinstall'], dir);
    expect(reinstall.status).toBe(1);
    expect(reinstall.all).toContain('re-used the version number 0.1.0');
    expect(reinstall.all).toContain('--accept-republished');
    expect(read(dir, LOCK)).toBe(lockBefore);

    const accepted = run(['pack', 'update', 'demo', '--reinstall', '--accept-republished'], dir);
    expect(accepted.status, accepted.all).toBe(0);
    expect(accepted.stdout).toContain("Reinstalled 'demo' 0.1.0 (pack/demo@0.1.0, commit");
    expect(accepted.stdout).toContain('rule-a: changed check.mjs');
    expect(accepted.stdout).toContain('need judging again');
    expect(read(dir, CHECK_A)).toContain('// republished');
    expect(read(dir, ADAPT_A)).toBe(adapt);
    expect(read(dir, LOCK)).toContain('tag: "pack/demo@0.1.0"');
    expect(run(['pack', 'verify', 'demo'], dir).status).toBe(0);
  }, 120_000);

  it('E4: --accept-republished only goes with --reinstall', () => {
    const dir = consumer('accept-alone');
    expect(run(['pack', 'add', `${market.bare}#demo`, '--as', 'acme/law'], dir).status).toBe(0);
    const alone = run(['pack', 'update', 'demo', '--accept-republished'], dir);
    expect(alone.status).toBe(1);
    expect(alone.all).toContain('--accept-republished only goes with --reinstall');
  }, 60_000);
});
