// =============================================================================
// Unit — the git half of installing law from another repository.
//
// Every source here is a local git repository built in the test. NOTHING here
// touches a socket: the one scenario that must — a source that does not answer —
// lives in the e2e suite, which owns the single deliberate probe at a port
// nothing listens on. Reaching for one here as well would make this file depend
// on a specific port being closed on whatever machine runs it, which is exactly
// the ambient state a test must not rest on; the refusal path is exercised here
// through a local path that is no repository, which takes the same branch.
//
// What is pinned:
//   1. clone      — a tag is checked out; a tag that is not there says so
//   2. classify   — "the ref is missing" is told apart from "I could not get there"
//   3. detail     — git's fatal line, never the advisory noise printed before it
//   4. identity   — an origin url read back, and absence read as absence
//   5. tags       — versions published for one package; unreachable is null,
//                   which is DISTINCT from an empty list
// =============================================================================

import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  clonePackageSource,
  listPackageVersionTags,
  packageVersionTag,
  readOriginUrl,
} from '../../../src/utils/git-pack-fetch.js';
import { runGitFixture } from '../../support/git-fixture.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-gitfetch-${label}-`));
  tempDirs.push(dir);
  return dir;
}

/** A repository publishing two versions of one package as tags. Built once. */
let source = '';

beforeAll(() => {
  source = mkdtempSync(path.join(tmpdir(), 'yg-gitfetch-source-'));
  runGitFixture(source, ['init', '-q', '-b', 'main']);
  writeFileSync(path.join(source, 'yg-marketplace.yaml'), 'schema: yg-marketplace/1\npackages: []\n', 'utf-8');
  runGitFixture(source, ['add', '-A']);
  runGitFixture(source, ['commit', '-qm', 'one']);
  runGitFixture(source, ['tag', 'pack/demo@0.1.0']);
  writeFileSync(path.join(source, 'second.txt'), 'two\n', 'utf-8');
  runGitFixture(source, ['add', '-A']);
  runGitFixture(source, ['commit', '-qm', 'two']);
  runGitFixture(source, ['tag', 'pack/demo@0.2.0']);
  // A tag for a DIFFERENT package, so the version listing has something to ignore.
  runGitFixture(source, ['tag', 'pack/other@9.9.9']);
  runGitFixture(source, ['remote', 'add', 'origin', 'https://example.test/acme/law.git']);
});

afterAll(() => {
  if (source !== '') rmSync(source, { recursive: true, force: true });
});

describe('fetching a marketplace', () => {
  it('checks out the tag it was asked for', async () => {
    const dest = path.join(scratch('at-tag'), 'clone');
    const result = await clonePackageSource(source, dest, packageVersionTag('demo', '0.1.0'));
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(dest, 'yg-marketplace.yaml'))).toBe(true);
    // 0.1.0 predates the second file.
    expect(existsSync(path.join(dest, 'second.txt'))).toBe(false);
  });

  it('takes the default branch when no version is asked for', async () => {
    const dest = path.join(scratch('default'), 'clone');
    expect((await clonePackageSource(source, dest)).ok).toBe(true);
    expect(existsSync(path.join(dest, 'second.txt'))).toBe(true);
  });

  it('says the ref is missing rather than that it could not get there', async () => {
    const dest = path.join(scratch('no-tag'), 'clone');
    const result = await clonePackageSource(source, dest, packageVersionTag('demo', '9.9.9'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ref-missing');
    // git's FATAL line, not the `warning: --depth is ignored in local clones`
    // it prints first — taking the first line would report the warning as the
    // reason a missing tag failed.
    expect(result.detail).toContain('fatal:');
    expect(result.detail).not.toContain('--depth is ignored');
  });

  it('says a path that is no repository could not be reached', async () => {
    const result = await clonePackageSource(scratch('empty'), path.join(scratch('dest'), 'clone'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unreachable');
  });

  it('never returns a stack, and bounds what it quotes', async () => {
    const result = await clonePackageSource(scratch('empty2'), path.join(scratch('dest2'), 'clone'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).not.toContain('\n');
    expect(result.detail.length).toBeLessThanOrEqual(201);
  });

});

describe('who published a local checkout', () => {
  it('reads the origin url back', async () => {
    expect(await readOriginUrl(source)).toBe('https://example.test/acme/law.git');
  });

  it('reads a directory with no origin as having none', async () => {
    const bare = scratch('no-origin');
    runGitFixture(bare, ['init', '-q', '-b', 'main']);
    expect(await readOriginUrl(bare)).toBeNull();
  });

  it('reads a directory that is not a repository as having none', async () => {
    expect(await readOriginUrl(scratch('not-a-repo'))).toBeNull();
  });
});

describe('which versions a source publishes', () => {
  it('lists the versions of the package asked about, and only those', async () => {
    const versions = await listPackageVersionTags(source, 'demo');
    expect(versions).not.toBeNull();
    expect([...(versions ?? [])].sort()).toEqual(['0.1.0', '0.2.0']);
  });

  it('reads a package with no tags as an empty list, not as silence', async () => {
    expect(await listPackageVersionTags(source, 'never-published')).toEqual([]);
  });

  it('reads an unreachable source as SILENCE — null, never an empty list', async () => {
    // The distinction the attention feed depends on: an offline source knows
    // nothing, and an empty list would be rendered as "you are up to date".
    expect(await listPackageVersionTags(scratch('nope'), 'demo')).toBeNull();
  });

  it('names a version tag the way a marketplace publishes it', () => {
    expect(packageVersionTag('demo', '1.2.3')).toBe('pack/demo@1.2.3');
  });
});

describe('a name that a shell would treat as a command', () => {
  it('is passed to git as one argument, never interpreted', async () => {
    // git runs through an argument array, so this reaches git as a literal ref
    // name and fails as a missing ref — it never becomes a command.
    const canary = path.join(scratch('canary'), 'EXECUTED');
    const result = await clonePackageSource(
      source,
      path.join(scratch('inject'), 'clone'),
      `pack/demo@$(touch ${canary})`,
    );
    expect(result.ok).toBe(false);
    expect(existsSync(canary)).toBe(false);
  });
});
