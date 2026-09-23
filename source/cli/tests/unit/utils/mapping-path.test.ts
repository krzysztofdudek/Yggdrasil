import { describe, it, expect } from 'vitest';
import { normalizeMappingPath, mappingEntryMatchesFile } from '../../../src/utils/mapping-path.js';

describe('normalizeMappingPath', () => {
  it('strips leading ./', () => {
    expect(normalizeMappingPath('./src/a.ts')).toBe('src/a.ts');
  });
  it('trims surrounding whitespace', () => {
    expect(normalizeMappingPath('  src/a.ts  ')).toBe('src/a.ts');
  });
  it('converts backslashes to forward slashes', () => {
    expect(normalizeMappingPath('src\\foo')).toBe('src/foo');
  });
  it('strips trailing slashes', () => {
    expect(normalizeMappingPath('src/foo/')).toBe('src/foo');
  });
  it('combines all rules — trims, converts, strips ./, strips trailing', () => {
    expect(normalizeMappingPath('  ./src\\foo/  ')).toBe('src/foo');
  });
  it('returns empty string for empty input', () => {
    expect(normalizeMappingPath('')).toBe('');
  });
  it('returns empty string for whitespace-only input', () => {
    expect(normalizeMappingPath('   ')).toBe('');
  });
  // The file-system side (stat, path.join) resolves these spellings, so the text
  // side (owner, coverage, prefix matching) must see the same canonical entry.
  it('collapses doubled slashes, ./ segments and a/../a detours', () => {
    expect(normalizeMappingPath('src//app')).toBe('src/app');
    expect(normalizeMappingPath('src/./app')).toBe('src/app');
    expect(normalizeMappingPath('src/lib/../app/')).toBe('src/app');
    expect(normalizeMappingPath('././src/a.ts')).toBe('src/a.ts');
    expect(normalizeMappingPath('src/**/*.ts')).toBe('src/**/*.ts');
  });
  it('keeps a leading .. that climbs above the root, for the escape check to refuse', () => {
    expect(normalizeMappingPath('src/../../etc')).toBe('../etc');
  });
  it('a non-canonical entry matches the files the canonical one does', () => {
    expect(mappingEntryMatchesFile('src//app', 'src/app/ok.ts')).toBe(true);
    expect(mappingEntryMatchesFile('src/./app', 'src/app/ok.ts')).toBe(true);
  });
});
