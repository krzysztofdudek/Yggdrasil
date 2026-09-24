import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolvePhpFqn,
  parsePsr4,
  parseComposerAutoload,
  type ComposerAutoload,
  type PhpResolveDeps,
} from '../../../../src/relations/extractors/php-resolve.js';
import { makeResolvePathToFile } from '../../../../src/relations/resolve-path.js';

// ---------------------------------------------------------------------------
// resolvePhpFqn against a fixed, pure resolution universe.
// PSR-4 map: App\ → src/, App\Tests\ → tests/ (nested prefix → longest-match).
// ---------------------------------------------------------------------------
const files = new Set([
  'src/Payment/Gateway.php',
  'src/Order/Handler.php',
  'tests/Unit/GatewayTest.php',
]);

const psr4 = new Map<string, string[]>([
  ['App\\', ['src']],
  ['App\\Tests\\', ['tests']],
]);

const deps: PhpResolveDeps = {
  psr4For: () => psr4,
  exists: (p) => files.has(p),
};

const FROM = 'src/Order/Handler.php';

describe('resolvePhpFqn — FQN → file via PSR-4', () => {
  it('resolves an FQN under the App\\ prefix to src/', () => {
    expect(resolvePhpFqn('App\\Payment\\Gateway', FROM, deps)).toBe('src/Payment/Gateway.php');
  });

  it('honors the longest matching prefix (App\\Tests\\ over App\\)', () => {
    expect(resolvePhpFqn('App\\Tests\\Unit\\GatewayTest', FROM, deps)).toBe(
      'tests/Unit/GatewayTest.php',
    );
  });

  it('strips a leading backslash before resolving', () => {
    expect(resolvePhpFqn('\\App\\Payment\\Gateway', FROM, deps)).toBe('src/Payment/Gateway.php');
  });

  it('returns undefined for a vendor FQN with no matching prefix', () => {
    expect(resolvePhpFqn('Psr\\Log\\LoggerInterface', FROM, deps)).toBeUndefined();
  });

  it('returns undefined when the prefix matches but the file is absent', () => {
    expect(resolvePhpFqn('App\\Nope\\Missing', FROM, deps)).toBeUndefined();
  });

  it('does not match a prefix that is only a string-prefix, not a namespace boundary', () => {
    // `Apple\X` must NOT match the `App\` prefix.
    expect(resolvePhpFqn('Apple\\Thing', FROM, deps)).toBeUndefined();
  });

  it('returns undefined when the PSR-4 map is empty (no composer.json)', () => {
    const empty: PhpResolveDeps = { psr4For: () => new Map(), exists: () => true };
    expect(resolvePhpFqn('App\\Payment\\Gateway', FROM, empty)).toBeUndefined();
  });

  it('returns undefined for a specifier that is only a leading backslash', () => {
    // `\` strips to the empty string before any prefix lookup.
    expect(resolvePhpFqn('\\', FROM, deps)).toBeUndefined();
  });

  it('resolves under a PSR-4 prefix whose base directory is the repo root ("")', () => {
    // baseDir '' means the class file sits at the repo root sub-path directly.
    const rootDeps: PhpResolveDeps = {
      psr4For: () => new Map([['Root\\', ['']]]),
      exists: (p) => p === 'Lib/Thing.php',
    };
    expect(resolvePhpFqn('Root\\Lib\\Thing', FROM, rootDeps)).toBe('Lib/Thing.php');
  });

  describe('exclusion awareness', () => {
    // One prefix, two base directories, the same class file present under both —
    // a genuine PSR-4 ambiguity (2 hits) that stays silent when nothing is
    // excluded. Marking one hit as graph-excluded must drop it from the ambiguity
    // count BEFORE the exactly-one-hit decision, the same drop-then-decide rule
    // the Go/Java package resolvers already apply to a split package's file list.
    const twoRootPsr4 = new Map<string, string[]>([['App\\', ['src1', 'src2']]]);
    const twoRootFiles = new Set(['src1/Svc/S1.php', 'src2/Svc/S1.php']);

    it('control: with nothing excluded, two distinct roots stay ambiguous — silent', () => {
      const deps: PhpResolveDeps = { psr4For: () => twoRootPsr4, exists: (p) => twoRootFiles.has(p) };
      expect(resolvePhpFqn('App\\Svc\\S1', FROM, deps)).toBeUndefined();
    });

    it('excluding the root that sorts FIRST resolves to the survivor', () => {
      // 'src1/Svc/S1.php' < 'src2/Svc/S1.php' lexicographically.
      const deps: PhpResolveDeps = {
        psr4For: () => twoRootPsr4,
        exists: (p) => twoRootFiles.has(p),
        isExcluded: (p) => p === 'src1/Svc/S1.php',
      };
      expect(resolvePhpFqn('App\\Svc\\S1', FROM, deps)).toBe('src2/Svc/S1.php');
    });

    it('excluding the root that sorts LAST resolves to the survivor', () => {
      const deps: PhpResolveDeps = {
        psr4For: () => twoRootPsr4,
        exists: (p) => twoRootFiles.has(p),
        isExcluded: (p) => p === 'src2/Svc/S1.php',
      };
      expect(resolvePhpFqn('App\\Svc\\S1', FROM, deps)).toBe('src1/Svc/S1.php');
    });

    it('excluding an UNRELATED file elsewhere leaves a genuinely ambiguous resolution silent', () => {
      const deps: PhpResolveDeps = {
        psr4For: () => twoRootPsr4,
        exists: (p) => twoRootFiles.has(p),
        isExcluded: (p) => p === 'somewhere/else/entirely.php',
      };
      expect(resolvePhpFqn('App\\Svc\\S1', FROM, deps)).toBeUndefined();
    });
  });

  it('keeps the longest prefix even when a shorter one is encountered after it', () => {
    // Iteration order puts the longer prefix first, then the shorter — the shorter
    // must NOT overwrite the already-chosen longer best.
    const ordered: PhpResolveDeps = {
      psr4For: () =>
        new Map([
          ['App\\Tests\\', ['tests']],
          ['App\\', ['src']],
        ]),
      exists: (p) => p === 'tests/Unit/GatewayTest.php',
    };
    expect(resolvePhpFqn('App\\Tests\\Unit\\GatewayTest', FROM, ordered)).toBe(
      'tests/Unit/GatewayTest.php',
    );
  });
});

describe('parsePsr4', () => {
  it('parses autoload.psr-4 with directories relative to the composer dir', () => {
    const map = parsePsr4('{ "autoload": { "psr-4": { "App\\\\": "src/" } } }', '');
    expect([...map.entries()]).toEqual([['App\\', ['src']]]);
  });

  it('includes autoload-dev and an array of directories', () => {
    const map = parsePsr4(
      '{ "autoload": { "psr-4": { "App\\\\": ["src/", "lib/"] } }, "autoload-dev": { "psr-4": { "App\\\\Tests\\\\": "tests/" } } }',
      '',
    );
    expect(map.get('App\\')).toEqual(['src', 'lib']);
    expect(map.get('App\\Tests\\')).toEqual(['tests']);
  });

  it('rebases directories under a non-root composer dir', () => {
    const map = parsePsr4('{ "autoload": { "psr-4": { "App\\\\": "src/" } } }', 'packages/core');
    expect(map.get('App\\')).toEqual(['packages/core/src']);
  });

  it('returns an empty map for malformed JSON', () => {
    expect(parsePsr4('{ not json', '').size).toBe(0);
  });

  it('returns an empty map for a classmap-only composer.json (no psr-4)', () => {
    expect(parsePsr4('{ "autoload": { "classmap": ["src/"] } }', '').size).toBe(0);
  });

  it('returns an empty map when the JSON is not an object (e.g. `null`)', () => {
    expect(parsePsr4('null', '').size).toBe(0);
    expect(parsePsr4('42', '').size).toBe(0);
  });

  it('keeps an empty prefix key (Composer\'s fallback directory)', () => {
    expect(parsePsr4('{ "autoload": { "psr-4": { "": "src/" } } }', '').get('')).toEqual(['src']);
  });

  it('skips a non-string directory value inside the array', () => {
    const map = parsePsr4(
      '{ "autoload": { "psr-4": { "App\\\\": ["src/", 123, null] } } }',
      '',
    );
    expect(map.get('App\\')).toEqual(['src']);
  });

  it('unions directories across autoload and autoload-dev without duplicating', () => {
    // The same prefix maps to "src/" in both sections — the result keeps one entry.
    const map = parsePsr4(
      '{ "autoload": { "psr-4": { "App\\\\": "src/" } }, "autoload-dev": { "psr-4": { "App\\\\": "src/" } } }',
      '',
    );
    expect(map.get('App\\')).toEqual(['src']);
  });

  it('normalizes a "." directory to the composer dir itself', () => {
    expect(parsePsr4('{ "autoload": { "psr-4": { "App\\\\": "." } } }', '').get('App\\')).toEqual([
      '',
    ]);
    expect(
      parsePsr4('{ "autoload": { "psr-4": { "App\\\\": "." } } }', 'packages/core').get('App\\'),
    ).toEqual(['packages/core']);
  });

  it('normalizes a directory that resolves back to the composer dir to "" ', () => {
    // "sub/.." normalizes to "." → the repo root, rendered as the empty string.
    expect(parsePsr4('{ "autoload": { "psr-4": { "App\\\\": "sub/.." } } }', '').get('App\\')).toEqual(
      [''],
    );
  });

  it('ignores an autoload value that is not an object', () => {
    expect(parsePsr4('{ "autoload": "nope" }', '').size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration through the disk-backed makeResolvePathToFile factory:
// a real temp dir with a composer.json + a class file.
// ---------------------------------------------------------------------------
describe('makeResolvePathToFile — php branch (disk-backed)', () => {
  function tempRepo(withComposer: boolean): string {
    const root = mkdtempSync(path.join(tmpdir(), 'yg-php-resolve-'));
    mkdirSync(path.join(root, 'src', 'Payment'), { recursive: true });
    writeFileSync(
      path.join(root, 'src', 'Payment', 'Gateway.php'),
      '<?php\nnamespace App\\Payment;\nclass Gateway {}\n',
    );
    if (withComposer) {
      writeFileSync(
        path.join(root, 'composer.json'),
        JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'src/' } } }),
      );
    }
    return root;
  }

  it('resolves an FQN to a class file when composer.json psr-4 maps the namespace', () => {
    const root = tempRepo(true);
    try {
      const resolve = makeResolvePathToFile(root);
      expect(resolve('App\\Payment\\Gateway', 'src/Order/Handler.php', 'php')).toBe(
        'src/Payment/Gateway.php',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns undefined when there is no composer.json', () => {
    const root = tempRepo(false);
    try {
      const resolve = makeResolvePathToFile(root);
      expect(resolve('App\\Payment\\Gateway', 'src/Order/Handler.php', 'php')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns undefined for an FQN whose namespace is not in the psr-4 map', () => {
    const root = tempRepo(true);
    try {
      const resolve = makeResolvePathToFile(root);
      expect(resolve('Vendor\\Lib\\Thing', 'src/Order/Handler.php', 'php')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolvePhpFqn — fallbacks, the repo-wide union, file paths', () => {
  const map = (psr4: [string, string[]][], psr0: [string, string[]][] = []): ComposerAutoload => ({
    psr4: new Map(psr4),
    psr0: new Map(psr0),
  });

  it('tries the empty PSR-4 prefix only after the named prefixes', () => {
    const files = new Set(['src/Payment/Gateway.php', 'fallback/App/Payment/Gateway.php', 'fallback/Other/X.php']);
    const nearest = map([['App\\', ['src']], ['', ['fallback']]]);
    const d: PhpResolveDeps = { psr4For: () => nearest.psr4, exists: (p) => files.has(p) };
    expect(resolvePhpFqn('App\\Payment\\Gateway', 'x.php', d)).toBe('src/Payment/Gateway.php');
    expect(resolvePhpFqn('Other\\X', 'x.php', d)).toBe('fallback/Other/X.php');
  });

  it('maps PSR-0 with the whole FQN and `_` in the class name as a directory', () => {
    const files = new Set(['lib/Twig/Loader/Array.php', 'lib/App/Model/Id.php']);
    const nearest = map([], [['Twig_', ['lib']], ['App\\', ['lib']]]);
    const d: PhpResolveDeps = { psr4For: () => nearest.psr4, psr0For: () => nearest.psr0, exists: (p) => files.has(p) };
    expect(resolvePhpFqn('Twig_Loader_Array', 'x.php', d)).toBe('lib/Twig/Loader/Array.php');
    expect(resolvePhpFqn('App\\Model\\Id', 'x.php', d)).toBe('lib/App/Model/Id.php');
  });

  it('falls back to the union only when the nearest map resolves nothing', () => {
    const files = new Set(['a/src/Thing.php', 'b/src/Thing.php', 'b/src/Other.php']);
    const nearest = map([['Acme\\A\\', ['a/src']]]);
    const all = [nearest, map([['Acme\\B\\', ['b/src']]])];
    const d: PhpResolveDeps = { psr4For: () => nearest.psr4, allMaps: () => all, exists: (p) => files.has(p) };
    expect(resolvePhpFqn('Acme\\A\\Thing', 'a/src/X.php', d)).toBe('a/src/Thing.php');
    expect(resolvePhpFqn('Acme\\B\\Other', 'a/src/X.php', d)).toBe('b/src/Other.php');
    expect(resolvePhpFqn('Acme\\C\\Other', 'a/src/X.php', d)).toBeUndefined();
  });

  it('silences two distinct hits across the union, but not one file named twice', () => {
    const files = new Set(['b/src/Thing.php', 'c/src/Thing.php']);
    const nearest = map([]);
    const twoPackages: PhpResolveDeps = {
      psr4For: () => nearest.psr4,
      allMaps: () => [map([['S\\', ['b/src']]]), map([['S\\', ['c/src']]])],
      exists: (p) => files.has(p),
    };
    expect(resolvePhpFqn('S\\Thing', 'a/X.php', twoPackages)).toBeUndefined();
    const sameFileTwice: PhpResolveDeps = {
      psr4For: () => nearest.psr4,
      allMaps: () => [map([['S\\', ['b/src']]]), map([['S\\B\\', ['b/src/B']], ['S\\', ['b/src']]])],
      exists: (p) => files.has(p),
    };
    expect(resolvePhpFqn('S\\Thing', 'a/X.php', sameFileTwice)).toBe('b/src/Thing.php');
  });

  it('does not fall back past an ambiguous nearest map', () => {
    const files = new Set(['src/X.php', 'lib/X.php', 'other/X.php']);
    const nearest = map([['App\\', ['src', 'lib']]]);
    const d: PhpResolveDeps = {
      psr4For: () => nearest.psr4,
      allMaps: () => [map([['App\\', ['other']]])],
      exists: (p) => files.has(p),
    };
    expect(resolvePhpFqn('App\\X', 'a.php', d)).toBeUndefined();
  });

  it('resolves a file-relative include path and refuses one escaping the repository', () => {
    const files = new Set(['app/lib/helpers.php']);
    const d: PhpResolveDeps = { psr4For: () => new Map(), exists: (p) => files.has(p) };
    expect(resolvePhpFqn('./../lib/helpers.php', 'app/legacy/index.php', d)).toBe('app/lib/helpers.php');
    expect(resolvePhpFqn('./../../../x.php', 'app/legacy/index.php', d)).toBeUndefined();
    expect(resolvePhpFqn('./missing.php', 'app/legacy/index.php', d)).toBeUndefined();
    const excluded: PhpResolveDeps = { ...d, isExcluded: () => true };
    expect(resolvePhpFqn('./../lib/helpers.php', 'app/legacy/index.php', excluded)).toBeUndefined();
  });

  it('parses psr-0 beside psr-4', () => {
    const parsed = parseComposerAutoload('{ "autoload": { "psr-4": { "A\\\\": "src" }, "psr-0": { "B_": "lib/" } } }', 'pkg');
    expect(parsed.psr4.get('A\\')).toEqual(['pkg/src']);
    expect(parsed.psr0.get('B_')).toEqual(['pkg/lib']);
  });
});

describe('makeResolvePathToFile — composer.json union on disk', () => {
  it('finds a sibling package map and skips vendor/', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'php-union-'));
    try {
      const write = (rel: string, text: string): void => {
        mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        writeFileSync(path.join(root, rel), text, 'utf-8');
      };
      write('packages/a/composer.json', '{ "autoload": { "psr-4": { "Acme\\\\A\\\\": "src/" } } }');
      write('packages/b/composer.json', '{ "autoload": { "psr-4": { "Acme\\\\B\\\\": "src/" } } }');
      write('vendor/x/y/composer.json', '{ "autoload": { "psr-4": { "Acme\\\\V\\\\": "src/" } } }');
      write('packages/b/src/Thing.php', '<?php');
      write('vendor/x/y/src/Thing.php', '<?php');
      const resolve = makeResolvePathToFile(root);
      expect(resolve('Acme\\B\\Thing', 'packages/a/src/Svc.php', 'php')).toBe('packages/b/src/Thing.php');
      expect(resolve('Acme\\V\\Thing', 'packages/a/src/Svc.php', 'php')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
