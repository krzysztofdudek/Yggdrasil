// =============================================================================
// Unit — the local cache of what each package source was last seen to publish.
//
// Knowledge about somebody else's repository, deliberately kept out of the
// installation record. What is pinned:
//
//   1. round trip  — written deterministically, read back unchanged
//   2. tolerance   — absent, unparseable, or unknown-schema all read as EMPTY
//   3. folding     — only what was reached is updated; the rest is left alone
//   4. never committed — the writer self-ensures its own gitignore line
//
// Tolerance is the interesting one. It would be wrong for the installation
// record, where reading a corrupted file as "nothing installed" would silently
// stop checking every copied rule. Here the worst a lost cache can do is leave
// the attention feed quiet until the next listing, so refusing would let a stale
// convenience block commands that have nothing to do with it.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PACKAGE_VERSIONS_CACHE_FILENAME,
  emptyPackageVersionsCache,
  readPackageVersionsCache,
  recordObservedVersions,
  renderPackageVersionsCache,
  writePackageVersionsCache,
} from '../../../src/io/package-versions-cache.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A `.yggdrasil/` graph root, which is what every function here addresses. */
function yggRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'yg-versions-cache-'));
  tempDirs.push(root);
  const ygg = path.join(root, '.yggdrasil');
  mkdirSync(ygg, { recursive: true });
  return ygg;
}

function cacheText(ygg: string): string {
  return readFileSync(path.join(ygg, PACKAGE_VERSIONS_CACHE_FILENAME), 'utf-8');
}

describe('writing down what a source publishes', () => {
  it('round-trips through the reader unchanged', async () => {
    const ygg = yggRoot();
    const cache = {
      schema: 'yg-package-versions/1' as const,
      packages: { demo: { published: ['0.1.0', '0.2.0'], checked_at: '2026-09-10T00:00:00.000Z' } },
    };
    await writePackageVersionsCache(ygg, cache);
    expect(await readPackageVersionsCache(ygg)).toEqual(cache);
  });

  it('renders deterministically, so it stops changing once the answer does', () => {
    const a = renderPackageVersionsCache({
      schema: 'yg-package-versions/1',
      packages: {
        zeta: { published: ['2.0.0', '1.0.0'], checked_at: 'T' },
        alpha: { published: ['1.0.0'], checked_at: 'T' },
      },
    });
    const b = renderPackageVersionsCache({
      schema: 'yg-package-versions/1',
      packages: {
        alpha: { published: ['1.0.0'], checked_at: 'T' },
        zeta: { published: ['1.0.0', '2.0.0'], checked_at: 'T' },
      },
    });
    expect(a).toBe(b);
    expect(a.indexOf('alpha')).toBeLessThan(a.indexOf('zeta'));
  });

  it('never lets itself be committed', async () => {
    // Self-ensured as a backstop, so a repository set up by an older build still
    // never commits this file.
    const ygg = yggRoot();
    await writePackageVersionsCache(ygg, emptyPackageVersionsCache());
    expect(readFileSync(path.join(ygg, '.gitignore'), 'utf-8')).toContain(PACKAGE_VERSIONS_CACHE_FILENAME);
  });

  it('does not duplicate its gitignore line on a second write', async () => {
    const ygg = yggRoot();
    await writePackageVersionsCache(ygg, emptyPackageVersionsCache());
    await writePackageVersionsCache(ygg, emptyPackageVersionsCache());
    const lines = readFileSync(path.join(ygg, '.gitignore'), 'utf-8')
      .split('\n')
      .filter((l) => l.trim() === PACKAGE_VERSIONS_CACHE_FILENAME);
    expect(lines).toHaveLength(1);
  });
});

describe('reading a cache that is not there or not right', () => {
  it('reads an absent cache as empty', async () => {
    expect(await readPackageVersionsCache(yggRoot())).toEqual(emptyPackageVersionsCache());
  });

  it.each([
    ['unparseable', 'not json at all'],
    ['a list', '[1, 2, 3]'],
    ['a schema this build does not know', '{"schema":"yg-package-versions/9","packages":{}}'],
    ['packages that is not a mapping', '{"schema":"yg-package-versions/1","packages":[]}'],
  ])('reads %s as empty rather than refusing', async (_label, body) => {
    const ygg = yggRoot();
    writeFileSync(path.join(ygg, PACKAGE_VERSIONS_CACHE_FILENAME), body, 'utf-8');
    expect(await readPackageVersionsCache(ygg)).toEqual(emptyPackageVersionsCache());
  });

  it('drops a malformed entry and keeps the sound ones beside it', async () => {
    const ygg = yggRoot();
    writeFileSync(
      path.join(ygg, PACKAGE_VERSIONS_CACHE_FILENAME),
      JSON.stringify({
        schema: 'yg-package-versions/1',
        packages: {
          good: { published: ['1.0.0'], checked_at: '2026-09-10T00:00:00.000Z' },
          noVersions: { checked_at: '2026-09-10T00:00:00.000Z' },
          notStrings: { published: [1, 2], checked_at: '2026-09-10T00:00:00.000Z' },
          noTimestamp: { published: ['1.0.0'] },
        },
      }),
      'utf-8',
    );
    const cache = await readPackageVersionsCache(ygg);
    expect(Object.keys(cache.packages)).toEqual(['good']);
  });
});

describe('folding in what a listing just saw', () => {
  it('updates only what was reached, and leaves the rest as it was', async () => {
    // A source that did not answer keeps whatever was last recorded: a failed
    // reach is not evidence that anything changed.
    const ygg = yggRoot();
    await writePackageVersionsCache(ygg, {
      schema: 'yg-package-versions/1',
      packages: {
        reached: { published: ['1.0.0'], checked_at: '2026-01-01T00:00:00.000Z' },
        silent: { published: ['3.0.0'], checked_at: '2026-01-01T00:00:00.000Z' },
      },
    });

    await recordObservedVersions(ygg, { reached: ['1.0.0', '1.1.0'] }, '2026-09-10T00:00:00.000Z');

    const cache = await readPackageVersionsCache(ygg);
    expect(cache.packages.reached).toEqual({
      published: ['1.0.0', '1.1.0'],
      checked_at: '2026-09-10T00:00:00.000Z',
    });
    expect(cache.packages.silent).toEqual({
      published: ['3.0.0'],
      checked_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('records a source that now publishes nothing as publishing nothing', async () => {
    // Distinct from never having been asked: an empty list is an answer, and the
    // feed treats a package it has an answer for differently from one it does not.
    const ygg = yggRoot();
    await recordObservedVersions(ygg, { demo: [] }, '2026-09-10T00:00:00.000Z');
    const cache = await readPackageVersionsCache(ygg);
    expect(cache.packages.demo.published).toEqual([]);
  });

  it('starts a cache from nothing when there was none', async () => {
    const ygg = yggRoot();
    expect(existsSync(path.join(ygg, PACKAGE_VERSIONS_CACHE_FILENAME))).toBe(false);
    await recordObservedVersions(ygg, { demo: ['1.0.0'] }, '2026-09-10T00:00:00.000Z');
    expect(cacheText(ygg)).toContain('"1.0.0"');
  });
});
