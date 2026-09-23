import { describe, it, expect } from 'vitest';
import {
  isGlobPattern,
  globMatch,
  mappingEntryMatchesFile,
  normalizeMappingPath,
} from '../../../src/utils/mapping-path.js';

// ---------------------------------------------------------------------------
// isGlobPattern — ONLY `*` triggers glob; ? [ ] { } are LITERAL path chars.
// ---------------------------------------------------------------------------
describe('isGlobPattern — only * triggers glob', () => {
  it('single * is a glob', () => {
    expect(isGlobPattern('src/*Repository.cs')).toBe(true);
  });
  it('double ** is a glob', () => {
    expect(isGlobPattern('src/**/*.ts')).toBe(true);
  });
  it('a lone * is a glob', () => {
    expect(isGlobPattern('*')).toBe(true);
  });
  it('** alone is a glob', () => {
    expect(isGlobPattern('**')).toBe(true);
  });
  it('* anywhere in the string is a glob (start)', () => {
    expect(isGlobPattern('*foo')).toBe(true);
  });
  it('* anywhere in the string is a glob (end)', () => {
    expect(isGlobPattern('foo*')).toBe(true);
  });
  it('* anywhere in the string is a glob (middle)', () => {
    expect(isGlobPattern('foo*bar')).toBe(true);
  });

  // The whole point: other minimatch metacharacters are literal.
  it('? is NOT a glob (literal)', () => {
    expect(isGlobPattern('src/a?.ts')).toBe(false);
  });
  it('[ ] char-class brackets are NOT a glob (literal)', () => {
    expect(isGlobPattern('app/[id]/page.tsx')).toBe(false);
  });
  it('a lone [ is NOT a glob', () => {
    expect(isGlobPattern('src/[.ts')).toBe(false);
  });
  it('a lone ] is NOT a glob', () => {
    expect(isGlobPattern('src/].ts')).toBe(false);
  });
  it('{ } braces are NOT a glob (literal)', () => {
    expect(isGlobPattern('src/{a,b}.ts')).toBe(false);
  });
  it('a lone { is NOT a glob', () => {
    expect(isGlobPattern('src/{.ts')).toBe(false);
  });
  it('! negation char is NOT a glob (no *)', () => {
    expect(isGlobPattern('src/!foo.ts')).toBe(false);
  });
  it('+ extglob char is NOT a glob (no *)', () => {
    expect(isGlobPattern('src/+(foo).ts')).toBe(false);
  });
  it('@ extglob char is NOT a glob (no *)', () => {
    expect(isGlobPattern('src/@(foo).ts')).toBe(false);
  });

  it('plain file path is NOT a glob', () => {
    expect(isGlobPattern('src/index.ts')).toBe(false);
  });
  it('plain directory path is NOT a glob', () => {
    expect(isGlobPattern('src/handlers')).toBe(false);
  });
  it('empty string is NOT a glob', () => {
    expect(isGlobPattern('')).toBe(false);
  });
  it('a name combining brackets AND a star IS a glob (star opts in)', () => {
    expect(isGlobPattern('app/[id]/*.tsx')).toBe(true);
  });
  it('a name combining braces AND a star IS a glob (star opts in)', () => {
    expect(isGlobPattern('src/{a,b}*.ts')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// globMatch — the single minimatch primitive. dot:true; * within segment,
// ** across segments.
// ---------------------------------------------------------------------------
describe('globMatch — segment-aware glob primitive', () => {
  it('single * matches within one segment', () => {
    expect(globMatch('src/foo.ts', 'src/*.ts')).toBe(true);
  });
  it('single * does NOT cross a path separator', () => {
    expect(globMatch('src/a/foo.ts', 'src/*.ts')).toBe(false);
  });
  it('single * at the start of a segment matches', () => {
    expect(globMatch('foo/bar.ts', '*/bar.ts')).toBe(true);
  });
  it('single * as a leading segment does NOT cross separators', () => {
    expect(globMatch('foo/baz/bar.ts', '*/bar.ts')).toBe(false);
  });
  it('* matches the empty string (zero chars) — prefix wildcard', () => {
    expect(globMatch('Source/Database/Repository.cs', 'Source/Database/*Repository.cs')).toBe(true);
  });
  it('** crosses path separators', () => {
    expect(globMatch('foo/baz/bar.ts', '**/bar.ts')).toBe(true);
  });
  it('** matches zero segments (collapses)', () => {
    expect(globMatch('bar.ts', '**/bar.ts')).toBe(true);
  });
  it('trailing /** requires at least one descendant segment', () => {
    expect(globMatch('a/b/c.ts', 'a/**')).toBe(true);
    expect(globMatch('a', 'a/**')).toBe(false);
  });
  it('dotfile matches a leading-dot name with dot:true', () => {
    expect(globMatch('.env', '*')).toBe(true);
  });
  it('dot segment in the middle matches with dot:true', () => {
    expect(globMatch('src/.hidden/x.ts', 'src/*/x.ts')).toBe(true);
  });

  // When a star is present, the OTHER metachars are interpreted by minimatch.
  it('char class is interpreted when combined with a star (match)', () => {
    expect(globMatch('src/a.ts', 'src/[ab]*.ts')).toBe(true);
  });
  it('char class is interpreted when combined with a star (non-match)', () => {
    expect(globMatch('src/z.ts', 'src/[ab]*.ts')).toBe(false);
  });
  it('brace expansion is interpreted when combined with a star (match)', () => {
    expect(globMatch('src/a.ts', 'src/{a,b}*.ts')).toBe(true);
    expect(globMatch('src/b.ts', 'src/{a,b}*.ts')).toBe(true);
  });
  it('brace expansion is interpreted when combined with a star (non-match)', () => {
    expect(globMatch('src/c.ts', 'src/{a,b}*.ts')).toBe(false);
  });
  it('? matches exactly one char when combined with a star', () => {
    expect(globMatch('src/ab.ts', 'src/a?*.ts')).toBe(true);
    expect(globMatch('src/a.ts', 'src/a?*.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mappingEntryMatchesFile — glob entries
// ---------------------------------------------------------------------------
describe('mappingEntryMatchesFile — glob entries', () => {
  it('matches a file satisfying a single-segment * glob', () => {
    expect(mappingEntryMatchesFile('Source/Database/*Repository.cs', 'Source/Database/FooRepository.cs')).toBe(true);
  });
  it('does NOT match a file failing the * glob', () => {
    expect(mappingEntryMatchesFile('Source/Database/*Repository.cs', 'Source/Database/Helper.cs')).toBe(false);
  });
  it('* does not cross path separators', () => {
    expect(mappingEntryMatchesFile('Source/Database/*Repository.cs', 'Source/Database/sub/FooRepository.cs')).toBe(false);
  });
  it('** crosses path separators (nested)', () => {
    expect(mappingEntryMatchesFile('src/**/*.ts', 'src/a/b/c.ts')).toBe(true);
  });
  it('** matches a top-level file too', () => {
    expect(mappingEntryMatchesFile('src/**/*.ts', 'src/index.ts')).toBe(true);
  });
  it('** does not match a file under a different root', () => {
    expect(mappingEntryMatchesFile('src/**/*.ts', 'lib/index.ts')).toBe(false);
  });
  it('dotfiles match under a ** glob (dot:true)', () => {
    expect(mappingEntryMatchesFile('src/**/*.ts', 'src/.hidden/file.ts')).toBe(true);
  });
  it('a leading-dot top-level file matches a * glob (dot:true)', () => {
    expect(mappingEntryMatchesFile('*', '.gitignore')).toBe(true);
  });
  it('empty entry returns false even with a glob-like file arg', () => {
    expect(mappingEntryMatchesFile('', 'src/*.ts')).toBe(false);
  });

  // A glob containing brackets DOES interpret them as a char class.
  it('a *-glob with brackets interprets the brackets as a char class (match)', () => {
    expect(mappingEntryMatchesFile('src/[ab]*.ts', 'src/apple.ts')).toBe(true);
  });
  it('a *-glob with brackets interprets the brackets as a char class (non-match)', () => {
    expect(mappingEntryMatchesFile('src/[ab]*.ts', 'src/zebra.ts')).toBe(false);
  });
  it('a *-glob with braces interprets the braces as alternation', () => {
    expect(mappingEntryMatchesFile('src/{handlers,services}/**/*.ts', 'src/handlers/a.ts')).toBe(true);
    expect(mappingEntryMatchesFile('src/{handlers,services}/**/*.ts', 'src/services/x/y.ts')).toBe(true);
    expect(mappingEntryMatchesFile('src/{handlers,services}/**/*.ts', 'src/models/a.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mappingEntryMatchesFile — plain (non-glob) entries: exact vs dir-prefix
// ---------------------------------------------------------------------------
describe('mappingEntryMatchesFile — plain entries', () => {
  it('exact file match', () => {
    expect(mappingEntryMatchesFile('src/index.ts', 'src/index.ts')).toBe(true);
  });
  it('directory-prefix match for an immediate child', () => {
    expect(mappingEntryMatchesFile('src/handlers', 'src/handlers/order.ts')).toBe(true);
  });
  it('directory-prefix match for a deeply nested file', () => {
    expect(mappingEntryMatchesFile('src', 'src/a/b/c.ts')).toBe(true);
  });
  it('unrelated path does not match', () => {
    expect(mappingEntryMatchesFile('src/handlers', 'lib/util.ts')).toBe(false);
  });
  it('a non-boundary prefix does NOT match (src/handle vs src/handlers/..)', () => {
    expect(mappingEntryMatchesFile('src/handle', 'src/handlers/order.ts')).toBe(false);
  });
  it('a file that is a strict prefix of the entry does not match', () => {
    // entry is a deeper path than the file
    expect(mappingEntryMatchesFile('src/handlers/order.ts', 'src/handlers')).toBe(false);
  });
  it('empty entry returns false', () => {
    expect(mappingEntryMatchesFile('', 'src/a.ts')).toBe(false);
  });
  it('a directory entry does not match a sibling sharing a name prefix', () => {
    expect(mappingEntryMatchesFile('src/api', 'src/apiv2/x.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Normalization: leading ./, trailing /, backslashes, whitespace.
// ---------------------------------------------------------------------------
describe('mappingEntryMatchesFile — normalization of both args', () => {
  it('normalizes leading ./ in the entry', () => {
    expect(mappingEntryMatchesFile('./src/index.ts', 'src/index.ts')).toBe(true);
  });
  it('normalizes leading ./ in the file', () => {
    expect(mappingEntryMatchesFile('src/index.ts', './src/index.ts')).toBe(true);
  });
  it('normalizes a trailing slash on a directory entry', () => {
    expect(mappingEntryMatchesFile('src/handlers/', 'src/handlers/order.ts')).toBe(true);
  });
  it('normalizes a trailing slash on the file arg', () => {
    expect(mappingEntryMatchesFile('src/handlers', 'src/handlers/')).toBe(true);
  });
  it('an entry that is just "./" normalizes to empty and returns false', () => {
    expect(mappingEntryMatchesFile('./', 'src/a.ts')).toBe(false);
  });
  it('a whitespace-only entry normalizes to empty and returns false', () => {
    expect(mappingEntryMatchesFile('   ', 'src/a.ts')).toBe(false);
  });
  it('normalizes backslashes in the entry', () => {
    expect(mappingEntryMatchesFile('src\\handlers', 'src/handlers/order.ts')).toBe(true);
  });
  it('normalizes surrounding whitespace before matching', () => {
    expect(mappingEntryMatchesFile('  src/index.ts  ', 'src/index.ts')).toBe(true);
  });
  it('trailing slash on a glob entry is normalized away before matching', () => {
    // 'src/**/' -> 'src/**' which requires a descendant segment
    expect(mappingEntryMatchesFile('src/**/', 'src/a/b.ts')).toBe(true);
    expect(mappingEntryMatchesFile('src/**/', 'src')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Next.js-style literal bracket names — the headline edge case.
// A bracketed name with NO star is treated literally (exact / dir-prefix),
// NOT as a glob char class.
// ---------------------------------------------------------------------------
describe('mappingEntryMatchesFile — literal bracket (Next.js route) names', () => {
  it('a bracket filename matches itself literally', () => {
    expect(mappingEntryMatchesFile('app/[id]/page.tsx', 'app/[id]/page.tsx')).toBe(true);
  });
  it('a bracket directory entry covers its children literally', () => {
    expect(mappingEntryMatchesFile('app/[id]', 'app/[id]/page.tsx')).toBe(true);
  });
  it('a bracket filename does NOT behave like a char class', () => {
    // char-class semantics would have let 'app/i/page.tsx' match — it must not.
    expect(mappingEntryMatchesFile('app/[id]/page.tsx', 'app/i/page.tsx')).toBe(false);
  });
  it('a bracket directory entry only matches the literal bracket path', () => {
    expect(mappingEntryMatchesFile('app/[id]', 'app/i')).toBe(false);
  });
  it('a catch-all-style literal bracket dir is treated literally', () => {
    expect(mappingEntryMatchesFile('app/[...slug]', 'app/[...slug]/page.tsx')).toBe(true);
  });
  it('a literal brace filename matches itself exactly (NOT brace-expanded)', () => {
    // isGlobPattern is false for braces, so this goes through exact-match —
    // crucially NOT through minimatch (which would brace-expand and fail to
    // match the literal string).
    expect(mappingEntryMatchesFile('src/{a,b}.ts', 'src/{a,b}.ts')).toBe(true);
  });
  it('a literal brace filename does NOT match a brace-expanded alternative', () => {
    expect(mappingEntryMatchesFile('src/{a,b}.ts', 'src/a.ts')).toBe(false);
  });
  it('a literal ? filename matches itself exactly (NOT single-char wildcard)', () => {
    expect(mappingEntryMatchesFile('src/a?.ts', 'src/a?.ts')).toBe(true);
    expect(mappingEntryMatchesFile('src/a?.ts', 'src/ab.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeMappingPath — direct unit checks (sanity, supports the above).
// ---------------------------------------------------------------------------
describe('normalizeMappingPath', () => {
  it('strips a single leading ./', () => {
    expect(normalizeMappingPath('./src/a.ts')).toBe('src/a.ts');
  });
  it('collapses every leading ./ (POSIX normalization, as the filesystem resolves it)', () => {
    expect(normalizeMappingPath('././src/a.ts')).toBe('src/a.ts');
  });
  it('strips all trailing slashes', () => {
    expect(normalizeMappingPath('src/foo///')).toBe('src/foo');
  });
  it('converts every backslash to a forward slash', () => {
    expect(normalizeMappingPath('a\\b\\c')).toBe('a/b/c');
  });
  it('trims surrounding whitespace', () => {
    expect(normalizeMappingPath('  src/a.ts  ')).toBe('src/a.ts');
  });
  it('applies the documented order (trim, backslash, ./, trailing-slash)', () => {
    expect(normalizeMappingPath('  .\\src\\foo/  ')).toBe('src/foo');
  });
  it('empty string stays empty', () => {
    expect(normalizeMappingPath('')).toBe('');
  });
  it('whitespace-only becomes empty', () => {
    expect(normalizeMappingPath('   ')).toBe('');
  });
});
