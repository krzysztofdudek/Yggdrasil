import { describe, it, expect, beforeAll } from 'vitest';
import { withParsedFile, getParser, grammarWasmHash } from '../../../src/ast/parser.js';
import { findComments } from '../../../src/ast/find-comments.js';

describe('ast/parser', () => {
  beforeAll(async () => {
    await getParser('.ts');
  });

  it('parses .ts files with tree-sitter-typescript', async () => {
    await withParsedFile('foo.ts', 'const x = 1;', (tree) => {
      expect(tree).toBeDefined();
      expect(tree.rootNode.type).toBe('program');
    });
  });

  it('parses .tsx files', async () => {
    await withParsedFile('foo.tsx', 'const X = () => <div />;', (tree) => {
      expect(tree).toBeDefined();
      expect(tree.rootNode.type).toBe('program');
    });
  });

  it('parses .js files', async () => {
    await withParsedFile('foo.js', 'const x = 1;', (tree) => {
      expect(tree).toBeDefined();
      expect(tree.rootNode.type).toBe('program');
    });
  });

  // Tier-1 languages + JSON. Each grammar must load and parse a clean sample, and
  // — where the language has comments — findComments must locate the comment,
  // which validates the registry's `commentTypes` for that language (a wrong value
  // would silently break comment-based rules and the yg-suppress scanner).
  const CASES: { ext: string; lang: string; src: string; comments: number }[] = [
    { ext: '.py', lang: 'python', src: '# a comment\nx = 1  # trailing\n', comments: 2 },
    { ext: '.go', lang: 'go', src: 'package main\n// line\n/* block */\nfunc main() {}\n', comments: 2 },
    { ext: '.rs', lang: 'rust', src: '// line\n/* block */\nfn main() {}\n', comments: 2 },
    { ext: '.java', lang: 'java', src: '// line\n/* block */\nclass A {}\n', comments: 2 },
    { ext: '.cs', lang: 'csharp', src: '// line\n/* block */\nclass A {}\n', comments: 2 },
    { ext: '.c', lang: 'c', src: '// line\n/* block */\nint main() { return 0; }\n', comments: 2 },
    { ext: '.cpp', lang: 'cpp', src: '// line\n/* block */\nint main() { return 0; }\n', comments: 2 },
    { ext: '.php', lang: 'php', src: '<?php\n// line\n# hash\n/* block */\n$x = 1;\n', comments: 3 },
    { ext: '.rb', lang: 'ruby', src: '# a comment\nx = 1\n', comments: 1 },
    { ext: '.json', lang: 'json', src: '{"a": 1}\n', comments: 0 },
    { ext: '.kt', lang: 'kotlin', src: '// line\n/* block */\nfun main() {}\n', comments: 2 },
    { ext: '.yaml', lang: 'yaml', src: '# a comment\nkey: value\n', comments: 1 },
    { ext: '.toml', lang: 'toml', src: '# a comment\nkey = "value"\n', comments: 1 },
  ];

  for (const { ext, lang, src, comments } of CASES) {
    it(`parses ${ext} (${lang}) and locates ${comments} comment(s)`, async () => {
      await withParsedFile(`foo${ext}`, src, (tree) => {
        expect(tree).toBeDefined();
        // A clean sample parses into a non-empty tree (not just a bare ERROR node).
        expect(tree.rootNode.childCount).toBeGreaterThan(0);
        // commentTypes validation: findComments resolves the registry's node-type
        // names for this language and must find exactly the planted comments.
        const found = findComments({ ast: tree, language: lang });
        expect(found.length).toBe(comments);
      });
    });
  }

  it('throws on a still-unsupported extension', async () => {
    await expect(withParsedFile('foo.swift', 'let x = 1', () => {})).rejects.toThrow(/no parser for extension/);
  });

  describe('grammarWasmHash', () => {
    it('returns a stable sha256 hex digest, memoized on a second call for the same extension', () => {
      const first = grammarWasmHash('.py');
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      // Second call for the SAME extension hits the memoization cache (same value,
      // no re-read of the wasm bytes).
      const second = grammarWasmHash('.py');
      expect(second).toBe(first);
    });

    it('throws for an extension with no registered grammar', () => {
      expect(() => grammarWasmHash('.swift')).toThrow(/no grammar for extension/);
    });
  });
});
