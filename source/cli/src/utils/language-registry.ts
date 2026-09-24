export interface LanguageDef {
  id: string;
  extensions: string[];
  wasmFile: string;
  wasmPackage: string;
  grammarRepo: string;
  grammarCommit: string;
  treeSitterCliVersion: string;
  externalScanner: boolean;
  commentTypes: string[];
  commentDelimiters: string[];
}

// Tier 0 (TypeScript/TSX/JavaScript) + Tier 1 (Python, Go, Rust, Java, C#, C,
// C++, PHP, Ruby) + JSON. Each grammar ships a prebuilt `.wasm` in its per-language
// npm package (devDep); tsup copies it to dist/grammars/<wasmFile> and the parser
// resolves it by that name. `commentTypes` (the grammar's AST node-type names for
// comments) and `commentDelimiters` were verified by parsing a sample with each
// grammar — they drive findComments() and the yg-suppress scanner, so a wrong
// value silently breaks comment-based rules for that language.
//
// Pin/scanner fields (grammarCommit, treeSitterCliVersion) are empty for now —
// the build pipeline populates them later (the determinism-pin enhancement).
export const LANGUAGES: Record<string, LanguageDef> = {
  typescript: {
    id: 'typescript',
    extensions: ['.ts', '.mts', '.cts'],
    wasmFile: 'tree-sitter-typescript.wasm',
    wasmPackage: 'tree-sitter-typescript',
    grammarRepo: 'https://github.com/tree-sitter/tree-sitter-typescript',
    grammarCommit: '',
    treeSitterCliVersion: '',
    externalScanner: false,
    commentTypes: ['comment'],
    commentDelimiters: ['//', '/*'],
  },
  tsx: {
    id: 'tsx',
    extensions: ['.tsx'],
    wasmFile: 'tree-sitter-tsx.wasm',
    wasmPackage: 'tree-sitter-typescript',
    grammarRepo: 'https://github.com/tree-sitter/tree-sitter-typescript',
    grammarCommit: '',
    treeSitterCliVersion: '',
    externalScanner: false,
    commentTypes: ['comment'],
    commentDelimiters: ['//', '/*'],
  },
  javascript: {
    id: 'javascript',
    extensions: ['.js', '.mjs', '.cjs', '.jsx'],
    wasmFile: 'tree-sitter-javascript.wasm',
    wasmPackage: 'tree-sitter-javascript',
    grammarRepo: 'https://github.com/tree-sitter/tree-sitter-javascript',
    grammarCommit: '',
    treeSitterCliVersion: '',
    externalScanner: false,
    commentTypes: ['comment'],
    commentDelimiters: ['//', '/*'],
  },
  python: {
    id: 'python',
    extensions: ['.py'],
    wasmFile: 'tree-sitter-python.wasm',
    wasmPackage: 'tree-sitter-python',
    grammarRepo: 'https://github.com/tree-sitter/tree-sitter-python',
    grammarCommit: '',
    treeSitterCliVersion: '',
    externalScanner: false,
    commentTypes: ['comment'],
    commentDelimiters: ['#'],
  },
  go: {
    id: 'go',
    extensions: ['.go'],
    wasmFile: 'tree-sitter-go.wasm',
    wasmPackage: 'tree-sitter-go',
    grammarRepo: 'https://github.com/tree-sitter/tree-sitter-go',
    grammarCommit: '',
    treeSitterCliVersion: '',
    externalScanner: false,
    commentTypes: ['comment'],
    commentDelimiters: ['//', '/*'],
  },
  rust: {
    id: 'rust',
    extensions: ['.rs'],
    wasmFile: 'tree-sitter-rust.wasm',
    wasmPackage: 'tree-sitter-rust',
    grammarRepo: 'https://github.com/tree-sitter/tree-sitter-rust',
    grammarCommit: '',
    treeSitterCliVersion: '',
    externalScanner: false,
    commentTypes: ['line_comment', 'block_comment'],
    commentDelimiters: ['//', '/*'],
  },
  java: {
    id: 'java',
    extensions: ['.java'],
    wasmFile: 'tree-sitter-java.wasm',
    wasmPackage: 'tree-sitter-java',
    grammarRepo: 'https://github.com/tree-sitter/tree-sitter-java',
    grammarCommit: '',
    treeSitterCliVersion: '',
    externalScanner: false,
    commentTypes: ['line_comment', 'block_comment'],
    commentDelimiters: ['//', '/*'],
  },
  csharp: {
    id: 'csharp',
    extensions: ['.cs'],
    wasmFile: 'tree-sitter-c_sharp.wasm',
    wasmPackage: 'tree-sitter-c-sharp',
    grammarRepo: 'https://github.com/tree-sitter/tree-sitter-c-sharp',
    grammarCommit: '',
    treeSitterCliVersion: '',
    externalScanner: false,
    commentTypes: ['comment'],
    commentDelimiters: ['//', '/*'],
  },
  c: {
    id: 'c',
    extensions: ['.c', '.h'],
    wasmFile: 'tree-sitter-c.wasm',
    wasmPackage: 'tree-sitter-c',
    grammarRepo: 'https://github.com/tree-sitter/tree-sitter-c',
    grammarCommit: '',
    treeSitterCliVersion: '',
    externalScanner: false,
    commentTypes: ['comment'],
    commentDelimiters: ['//', '/*'],
  },
  cpp: {
    id: 'cpp',
    // Besides sources and headers: C++20 module interface units (.cppm Clang/CMake, .ixx
    // MSVC, .mpp) and template-implementation files (.ipp/.inl/.tpp/.txx), which are C++ and
    // carry real #include dependencies; .c++/.h++ are rarer spellings of the same.
    extensions: ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h++', '.cppm', '.ixx', '.mpp', '.ipp', '.inl', '.tpp', '.txx'],
    wasmFile: 'tree-sitter-cpp.wasm',
    wasmPackage: 'tree-sitter-cpp',
    grammarRepo: 'https://github.com/tree-sitter/tree-sitter-cpp',
    grammarCommit: '',
    treeSitterCliVersion: '',
    externalScanner: false,
    commentTypes: ['comment'],
    commentDelimiters: ['//', '/*'],
  },
  php: {
    id: 'php',
    extensions: ['.php'],
    wasmFile: 'tree-sitter-php_only.wasm',
    wasmPackage: 'tree-sitter-php',
    grammarRepo: 'https://github.com/tree-sitter/tree-sitter-php',
    grammarCommit: '',
    treeSitterCliVersion: '',
    externalScanner: false,
    commentTypes: ['comment'],
    commentDelimiters: ['//', '#', '/*'],
  },
  ruby: {
    id: 'ruby',
    // `.rake` task files, `.gemspec` specs and Rack's `config.ru` are plain Ruby; the
    // extension-less Ruby files (Rakefile, Gemfile, …) are mapped by basename below.
    extensions: ['.rb', '.rake', '.gemspec', '.ru'],
    wasmFile: 'tree-sitter-ruby.wasm',
    wasmPackage: 'tree-sitter-ruby',
    grammarRepo: 'https://github.com/tree-sitter/tree-sitter-ruby',
    grammarCommit: '',
    treeSitterCliVersion: '',
    externalScanner: false,
    commentTypes: ['comment'],
    commentDelimiters: ['#'],
  },
  json: {
    id: 'json',
    extensions: ['.json'],
    wasmFile: 'tree-sitter-json.wasm',
    wasmPackage: 'tree-sitter-json',
    grammarRepo: 'https://github.com/tree-sitter/tree-sitter-json',
    grammarCommit: '',
    treeSitterCliVersion: '',
    externalScanner: false,
    commentTypes: [],
    commentDelimiters: [],
  },
  kotlin: {
    id: 'kotlin',
    extensions: ['.kt', '.kts'],
    wasmFile: 'tree-sitter-kotlin.wasm',
    wasmPackage: '@tree-sitter-grammars/tree-sitter-kotlin',
    grammarRepo: 'https://github.com/tree-sitter-grammars/tree-sitter-kotlin',
    grammarCommit: '',
    treeSitterCliVersion: '',
    externalScanner: false,
    commentTypes: ['line_comment', 'block_comment'],
    commentDelimiters: ['//', '/*'],
  },
  yaml: {
    id: 'yaml',
    extensions: ['.yaml', '.yml'],
    wasmFile: 'tree-sitter-yaml.wasm',
    wasmPackage: '@tree-sitter-grammars/tree-sitter-yaml',
    grammarRepo: 'https://github.com/tree-sitter-grammars/tree-sitter-yaml',
    grammarCommit: '',
    treeSitterCliVersion: '',
    externalScanner: false,
    commentTypes: ['comment'],
    commentDelimiters: ['#'],
  },
  toml: {
    id: 'toml',
    extensions: ['.toml'],
    wasmFile: 'tree-sitter-toml.wasm',
    wasmPackage: '@tree-sitter-grammars/tree-sitter-toml',
    grammarRepo: 'https://github.com/tree-sitter-grammars/tree-sitter-toml',
    grammarCommit: '',
    treeSitterCliVersion: '',
    externalScanner: false,
    commentTypes: ['comment'],
    commentDelimiters: ['#'],
  },
};

export const EXTENSION_TO_LANGUAGE: Record<string, string> = Object.fromEntries(
  Object.values(LANGUAGES).flatMap(def => def.extensions.map(ext => [ext, def.id])),
);

/** Extension-less files that are Ruby source by convention, mapped to the Ruby grammar. */
const RUBY_BASENAMES: ReadonlySet<string> = new Set(['Rakefile', 'Gemfile', 'Guardfile', 'Capfile', 'Brewfile']);

/**
 * The extension that selects a file's grammar: its own extension, or `.rb` for the
 * extension-less Ruby files (Rakefile, Gemfile, Guardfile, Capfile, Brewfile) that carry no
 * extension to look up. Callers that pick a grammar or a relation extractor for a whole path
 * use this instead of `path.extname`.
 */
export function grammarExtensionForPath(filePath: string): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  if (RUBY_BASENAMES.has(base)) return '.rb';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot);
}

export function getLanguageForExtension(ext: string, overrides?: Record<string, string>): string | null {
  // Normalize casing here — the registry keys are all lowercase and the sibling
  // getGrammarForExtension already lowercases, so every caller may rely on a
  // case-insensitive lookup. Without this, an uppercase/mixed-case extension
  // (`Foo.PY`, `Foo.H`) missed here even though the file WAS parsed (the
  // parse-decision paths lowercase first), dropping the tree and, for the
  // suppress scan, honoring a marker that only lives inside a string literal.
  const normalized = ext.toLowerCase();
  if (overrides && normalized in overrides) return overrides[normalized];
  return EXTENSION_TO_LANGUAGE[normalized] ?? null;
}

/**
 * The language of a file for RELATION extraction, which may differ from its extension's
 * default in one place: a `.h` header. `.h` is used for both C and C++ headers (the Google
 * C++ style default), and the extension alone binds it to C. A `.h` is routed to C++ when
 * its own directory holds a C++ file (any cpp extension) and no `.c` file — the sibling
 * sources say which language the directory is written in. `siblingNames` lists the file
 * names in the header's directory; it is called only for a `.h`.
 *
 * Only the relation pass uses this routing. Deterministic AST rules (`ctx.parseAst`) keep
 * the extension's grammar, because their verdicts are keyed on the file's bytes and would
 * not notice a grammar switch caused by a sibling file appearing or disappearing.
 */
export function relationLanguageForPath(filePath: string, siblingNames: () => Iterable<string>): string | null {
  const ext = grammarExtensionForPath(filePath);
  const language = getLanguageForExtension(ext);
  if (language !== 'c' || ext.toLowerCase() !== '.h') return language;
  let sawCpp = false;
  for (const name of siblingNames()) {
    const d = name.lastIndexOf('.');
    if (d <= 0) continue;
    const sibExt = name.slice(d).toLowerCase();
    if (sibExt === '.c') return 'c';
    if (EXTENSION_TO_LANGUAGE[sibExt] === 'cpp') sawCpp = true;
  }
  return sawCpp ? 'cpp' : 'c';
}

/** The canonical (first) extension of a language, used to pick its grammar when a file is
 *  parsed under a language other than its extension's (see relationLanguageForPath). */
export function primaryExtensionForLanguage(language: string): string | undefined {
  const def = Object.hasOwn(LANGUAGES, language) ? LANGUAGES[language] : undefined;
  return def?.extensions[0];
}

export function getGrammarForExtension(ext: string): { wasmFile: string; wasmPackage: string } | null {
  const lang = getLanguageForExtension(ext.toLowerCase());
  if (lang === null) return null;
  // Own-property guard: a reserved key inherited from Object.prototype
  // ('constructor', 'toString', '__proto__', …) resolves to an inherited value
  // on LANGUAGES, which would slip past `if (!def)` and then read `def.wasmFile`
  // off a non-LanguageDef. Treat a non-own key as absent — the same not-found
  // return an unknown language already takes.
  const def = Object.hasOwn(LANGUAGES, lang) ? LANGUAGES[lang] : undefined;
  if (!def) return null;
  return { wasmFile: def.wasmFile, wasmPackage: def.wasmPackage };
}

/**
 * Extractor-language ids whose human display name is NOT a simple capitalization
 * of the id. Everything not listed capitalizes its first letter (see
 * {@link getLanguageDisplayName}).
 */
const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  typescript: 'TypeScript',
  tsx: 'TSX',
  javascript: 'JavaScript',
  csharp: 'C#',
  cpp: 'C++',
  php: 'PHP',
  json: 'JSON',
  yaml: 'YAML',
  toml: 'TOML',
};

/**
 * Human-readable display name for an extractor-language id — the single place
 * that decides how a language is shown in user-facing text (e.g. `typescript` →
 * "TypeScript", `csharp` → "C#", `python` → "Python"). Ids whose casing is more
 * than a first-letter capitalization are listed in {@link LANGUAGE_DISPLAY_NAMES};
 * every other id (including an unrecognized one) capitalizes its first letter, so
 * the function is total and never throws.
 */
export function getLanguageDisplayName(languageId: string): string {
  // Own-property guard: a reserved key inherited from Object.prototype
  // ('constructor', 'toString', '__proto__', …) resolves to an inherited value
  // on LANGUAGE_DISPLAY_NAMES, which would slip past `!== undefined` and be
  // returned as a "display name". Treat a non-own key as absent — the same
  // first-letter-capitalization fallback an unlisted id already takes.
  const explicit = Object.hasOwn(LANGUAGE_DISPLAY_NAMES, languageId)
    ? LANGUAGE_DISPLAY_NAMES[languageId]
    : undefined;
  if (explicit !== undefined) return explicit;
  if (languageId.length === 0) return languageId;
  return languageId.charAt(0).toUpperCase() + languageId.slice(1);
}
