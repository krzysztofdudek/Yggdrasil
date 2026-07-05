import { describe, it, expect } from 'vitest';
import { report } from '../../../src/ast/report.js';
import { withParsedFile } from '../../../src/ast/parser.js';

describe('ast.report', () => {
  it('builds Violation with 1-based line', async () => {
    await withParsedFile('foo.ts', '\nconst x = 1;', (tree) => {
      const node = tree.rootNode.descendantsOfType('lexical_declaration')[0];
      const file = { path: 'src/foo.ts', content: '\nconst x = 1;', ast: tree };
      const v = report(file, node, 'forbidden');
      expect(v).toEqual({ file: 'src/foo.ts', line: 2, column: 0, message: 'forbidden' });
    });
  });
});

describe('report column', () => {
  it('includes 0-based column from node.startPosition', async () => {
    const src = '  const x = 1;';
    await withParsedFile('test.ts', src, (tree) => {
      const decl = tree.rootNode.child(0)!;
      const v = report({ path: 'test.ts', content: src, ast: tree }, decl, 'msg');
      expect(v.column).toBe(2);
    });
  });
});
