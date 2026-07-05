// DRILL — expected verdict: SATISFIED (No violations).
// A function named parseFile imported from an UNRELATED module is fine — the
// rule is specific to the AST parser module, not to the name parseFile.
import { parseFile } from './csv-parser.js';

export function rows(source: string): string[][] {
  return parseFile(source);
}
