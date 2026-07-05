import { describe, it, expect } from 'vitest';
import { findComments } from '../../../src/ast/find-comments.js';
import { withParsedFile } from '../../../src/ast/parser.js';

describe('findComments', () => {
  it('file form returns all comments', async () => {
    const src = '// hi\nconst x = 1; /* bye */';
    await withParsedFile('test.ts', src, (tree) => {
      const comments = findComments({ ast: tree, language: 'typescript' });
      expect(comments.length).toBe(2);
      expect(comments[0].text).toBe('// hi');
      expect(comments[1].text).toBe('/* bye */');
    });
  });

  it('subtree form scopes search', async () => {
    await withParsedFile('test.ts', '// outside\nfunction f() { /* inside */ return 1; }', (tree) => {
      const fn = tree.rootNode.namedChildren.find(c => c.type === 'function_declaration')!;
      const comments = findComments({ rootNode: fn, language: 'typescript' });
      expect(comments.length).toBe(1);
      expect(comments[0].text).toBe('/* inside */');
    });
  });

  it('both ast and rootNode throws AST_FINDCOMMENTS_AMBIGUOUS_TARGET', async () => {
    await withParsedFile('test.ts', '// x', (tree) => {
      expect(() => findComments({ ast: tree, rootNode: tree.rootNode, language: 'typescript' } as any))
        .toThrow(/AST_FINDCOMMENTS_AMBIGUOUS_TARGET/);
    });
  });

  it('unknown language throws', async () => {
    await withParsedFile('test.ts', '// x', (tree) => {
      expect(() => findComments({ ast: tree, language: 'martian' }))
        .toThrow();
    });
  });

  it('SourceFile form (a ctx.files element) derives the language from the path extension', async () => {
    await withParsedFile('test.ts', '// hi\nconst x = 1; /* bye */', (tree) => {
      // ctx.files elements are { path, content, ast } — no language field.
      const file = { path: 'src/foo.ts', content: '// hi\nconst x = 1; /* bye */', ast: tree };
      const comments = findComments(file);
      expect(comments.length).toBe(2);
      expect(comments[0].text).toBe('// hi');
    });
  });

  it('SourceFile form with an unknown extension throws a clear error', async () => {
    await withParsedFile('test.ts', '// x', (tree) => {
      expect(() => findComments({ path: 'src/foo.weird', ast: tree }))
        .toThrow(/AST_FINDCOMMENTS/);
    });
  });
});
