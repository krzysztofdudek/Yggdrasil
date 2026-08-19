import type { Tree } from 'web-tree-sitter';

// Re-exported so `src/roots/**` (and any other caller) can name these types
// without importing the `web-tree-sitter` package directly — the roots
// genericity fence (`eslint.config.js`'s `local/roots-genericity-fence`) bans
// exactly that import, on the theory that AST node/tree types come only from
// this adapter layer's own barrel, never the underlying parser package.
// Mirrors `ast/index.ts`'s existing `Node as SyntaxNode` re-export naming.
export type { Tree, Node as SyntaxNode } from 'web-tree-sitter';

export interface SourceFile {
  /** Project-relative POSIX path */
  path: string;
  /** Raw source code */
  content: string;
  /**
   * Parsed tree-sitter Tree, or `undefined` for a file whose extension has no
   * registered grammar (e.g. `.md`, `.sh`, `.json`). Such files are still
   * delivered to `check()` so content/regex rules can iterate them; rules that
   * touch `file.ast` must guard with `if (!file.ast) continue;`.
   */
  ast?: Tree;
}

export interface CheckContext {
  files: SourceFile[];
}

export interface Violation {
  /** Project-relative POSIX path */
  file: string;
  /** 1-based line number */
  line: number;
  /** 0-based column number */
  column: number;
  message: string;
}

