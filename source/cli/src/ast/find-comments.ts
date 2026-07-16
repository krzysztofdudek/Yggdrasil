import { extname } from 'node:path';
import type { Tree, Node } from 'web-tree-sitter';
import { LANGUAGES, getLanguageForExtension } from '../utils/language-registry.js';

export type FindCommentsTarget =
  // SourceFile form — a `ctx.files` element `{ path, content, ast }`; the
  // language is derived from the file's path extension. This is the form the
  // authoring docs use: `findComments(file)`.
  | { path: string; ast: Tree }
  // Explicit forms — language stated directly (used for a bare subtree node, or
  // when the language is not derivable from a path).
  | { ast: Tree; language: string }
  | { rootNode: Node; language: string };

export function findComments(target: FindCommentsTarget): Node[] {
  const hasAst = 'ast' in target;
  const hasRootNode = 'rootNode' in target;
  if (hasAst && hasRootNode) {
    throw new Error('AST_FINDCOMMENTS_AMBIGUOUS_TARGET: pass either ast or rootNode, not both');
  }
  // Resolve the language: an explicit `language` wins; otherwise derive it from
  // the SourceFile `path` extension (the `findComments(file)` form).
  let language: string | undefined =
    'language' in target ? (target as { language: string }).language : undefined;
  if (language === undefined && 'path' in target) {
    language = getLanguageForExtension(extname((target as { path: string }).path)) ?? undefined;
  }
  if (language === undefined) {
    throw new Error(
      'AST_FINDCOMMENTS_NO_LANGUAGE: pass a SourceFile whose path has a known extension, or an explicit { language }',
    );
  }
  const def = LANGUAGES[language];
  if (def === undefined) {
    throw new Error(`AST_FINDCOMMENTS_UNKNOWN_LANGUAGE: '${language}' not in registry`);
  }
  const root: Node = hasAst
    ? (target as { ast: Tree }).ast.rootNode
    : (target as { rootNode: Node }).rootNode;
  const out: Node[] = [];
  for (const type of def.commentTypes) {
    out.push(...root.descendantsOfType(type));
  }
  return out;
}
