import { hashString } from '../io/hash.js';
import { getGrammarForExtension } from '../utils/language-registry.js';

export function fingerprint(extension: string): string {
  const grammar = getGrammarForExtension(extension);
  return hashString(grammar ? grammar.wasmFile : extension);
}
