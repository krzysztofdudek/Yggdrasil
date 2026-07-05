// DRILL — expected verdict: REFUSED (1 violation).
// A direct import of parseFile from the AST parser module. parseFile hands back
// a WASM-heap tree that JS GC cannot reclaim, so every caller outside the few
// ownership-managing modules must use withParsedFile instead.
import { parseFile } from '../../../../../source/cli/src/ast/parser.js';

export function countNodes(source: string): number {
  const tree = parseFile(source, 'typescript');
  return tree.rootNode.childCount;
}
