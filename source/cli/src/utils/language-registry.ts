/**
 * The language table: which file extensions a language owns, the grammar file it parses
 * with, and the syntax-node types of its comments (they drive findComments() and the
 * yg-suppress scanner, so a wrong value silently breaks comment-based rules for that
 * language). It comes from `@chrisdudek/runes/grammars`, the one table Yggdrasil and Grain
 * share, so both tools read a file with the same grammar. The grammar pins themselves
 * (repository, commit, sha256, how each grammar is built) live in the Runes grammar
 * manifest, which the build (scripts/grammars.mjs) materializes into dist/grammars/.
 */
export {
  LANGUAGES,
  EXTENSION_TO_LANGUAGE,
  grammarExtensionForPath,
  getLanguageForExtension,
  relationLanguageForPath,
  primaryExtensionForLanguage,
  getGrammarForExtension,
  getLanguageDisplayName,
  type LanguageDef,
} from '@chrisdudek/runes/grammars';
