// DRILL — expected verdict: REFUSED (1 violation).
// Aliasing parseFile on import does not hide it — the rule keys on the original
// exported name, so `parseFile as parse` is caught exactly like the plain form.
import { parseFile as parse } from '../../../../../source/cli/src/ast/parser.js';

export function countNodes(source: string): number {
  const tree = parse(source, 'typescript');
  return tree.rootNode.childCount;
}
