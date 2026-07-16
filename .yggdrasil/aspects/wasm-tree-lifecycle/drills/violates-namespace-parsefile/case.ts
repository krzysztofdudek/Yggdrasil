import * as parser from '../ast/parser.js';
export function bad(path: string): void {
  const tree = parser.parseFile(path);
  void tree;
}
