import { describe, it, expect } from 'vitest';
import { enrichFilesWithAst, prewarmupAstCache } from '../../../src/structure/ctx-parsers.js';
import type { ParseCache } from '@chrisdudek/runes/ast';
import type { File } from '../../../src/structure/types.js';

describe('enrichFilesWithAst', () => {
  it('attaches ast + language to a known-extension file, leaves unknown-extension files bare', async () => {
    const astCache: ParseCache = new Map();
    const files: File[] = [
      { path: 'src/a.ts', content: '// hi\nconst x = 1;' },
      { path: 'src/data.bin', content: 'rawbytes' },
    ];
    await prewarmupAstCache({ astCache, projectRoot: process.cwd(), files });
    const enriched = enrichFilesWithAst(files, astCache);
    const ts = enriched.find(f => f.path === 'src/a.ts')!;
    expect(ts.language).toBe('typescript');
    expect(ts.ast).toBeDefined();
    const bin = enriched.find(f => f.path === 'src/data.bin')!;
    expect(bin.language).toBeUndefined();
    expect(bin.ast).toBeUndefined();
  });

  it('attaches the error-bearing tree of a broken known-extension file (does not null it)', async () => {
    const astCache: ParseCache = new Map();
    const files: File[] = [{ path: 'src/broken.ts', content: 'const x = ;' }];
    await prewarmupAstCache({ astCache, projectRoot: process.cwd(), files });
    const enriched = enrichFilesWithAst(files, astCache);
    expect(enriched[0].language).toBe('typescript');
    expect(enriched[0].ast).toBeDefined();
  });
});
