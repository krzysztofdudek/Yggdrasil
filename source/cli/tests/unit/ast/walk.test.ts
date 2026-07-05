import { describe, it, expect } from 'vitest';
import { closest, walk } from '../../../src/ast/walk.js';
import { withParsedFile } from '../../../src/ast/parser.js';

describe('ast.closest', () => {
  it('returns nearest ancestor of given type', async () => {
    await withParsedFile('x.ts', 'class Foo { method() { const x = 1; } }', (tree) => {
      const decl = tree.rootNode.descendantsOfType('lexical_declaration')[0];
      expect(closest(decl, 'class_declaration')?.type).toBe('class_declaration');
      expect(closest(decl, ['method_definition', 'function_declaration'])?.type).toBe('method_definition');
      expect(closest(decl, 'enum_declaration')).toBeNull();
    });
  });
});


describe('ast.walk', () => {
  it('visits root then children in document order', async () => {
    await withParsedFile('test.ts', 'const x = 1; const y = 2;', (tree) => {
      const types: string[] = [];
      walk(tree.rootNode, (node) => { types.push(node.type); });
      expect(types[0]).toBe('program');
      expect(types.filter(t => t === 'lexical_declaration').length).toBe(2);
    });
  });

  it('returning false skips subtree but continues siblings', async () => {
    await withParsedFile('test.ts', 'function f() { const x = 1; } const y = 2;', (tree) => {
      const visited: string[] = [];
      walk(tree.rootNode, (node) => {
        visited.push(node.type);
        if (node.type === 'function_declaration') return false;
      });
      expect(visited).toContain('function_declaration');
      expect(visited.filter(t => t === 'variable_declarator').length).toBe(1);
    });
  });

  it('returning undefined descends normally', async () => {
    await withParsedFile('test.ts', 'function f() { const x = 1; }', (tree) => {
      const visited: string[] = [];
      walk(tree.rootNode, (node) => { visited.push(node.type); });
      expect(visited).toContain('variable_declarator');
    });
  });

  it('returning true descends (only false stops)', async () => {
    await withParsedFile('test.ts', 'function f() { const x = 1; }', (tree) => {
      const visited: string[] = [];
      walk(tree.rootNode, (node) => { visited.push(node.type); return true; });
      expect(visited).toContain('variable_declarator');
    });
  });
});
