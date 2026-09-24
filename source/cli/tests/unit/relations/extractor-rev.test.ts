import { describe, it, expect } from 'vitest';
import { extractorForLanguage } from '../../../src/relations/extractors/registry.js';

describe('extractor rev', () => {
  it('every extractor declares an integer rev', () => {
    for (const lang of ['typescript','python','go','java','php','kotlin','rust','c','cpp','csharp','ruby']) {
      const e = extractorForLanguage(lang)!;
      expect(Number.isInteger(e.rev)).toBe(true);
    }
  });
  it('seeds preserve current history', () => {
    expect(extractorForLanguage('java')!.rev).toBe(3);
    expect(extractorForLanguage('csharp')!.rev).toBe(3);
    expect(extractorForLanguage('typescript')!.rev).toBe(2); // 2: type-position import() silent, bare/#//-rooted specifiers, recovery (6.1.0)
  });
});
