// DRILL — expected verdict: SATISFIED (No violations).
// The lifecycle-safe pattern: withParsedFile owns the WASM tree and guarantees
// tree.delete() in a finally block, so the caller never touches parseFile.
import { withParsedFile } from '../../../../../source/cli/src/ast/parser.js';

export function countNodes(source: string): number {
  return withParsedFile(source, 'typescript', (tree) => tree.rootNode.childCount);
}
