/**
 * Where a shipped grammar's `.wasm` comes from. The build (tsup.config.ts →
 * scripts/grammars.ts) materializes it from this source and refuses to ship it
 * unless its bytes match {@link GrammarPin.wasmSha256}.
 *
 * - `npm`: the prebuilt wasm inside an npm devDependency, exactly as published.
 *   The installed package version must equal {@link GrammarPin.version}.
 * - `github-release`: a wasm asset of an upstream GitHub release that never
 *   reached npm. node-types.json is read from the repository at `commit`.
 * - `source`: built here from the repository at `commit` with tree-sitter-cli
 *   {@link GrammarPin.cli}. `dir` is the grammar directory inside the repository;
 *   `generate` regenerates parser.c from grammar.js first (needed when patches
 *   change the grammar); `patches` are applied in order from
 *   source/cli/scripts/grammar-patches/; `deps` are other grammar repositories checked
 *   out at a pinned commit under `path` (a grammar.js that `require`s another one).
 */
export type GrammarSource =
  | { kind: 'npm'; package: string; wasmPath: string; nodeTypesPath: string }
  | { kind: 'github-release'; wasmUrl: string }
  | {
      kind: 'source';
      dir: string;
      generate: boolean;
      patches?: string[];
      deps?: Array<{ path: string; repo: string; commit: string }>;
    };

/**
 * The pin of one shipped grammar: what it is (repository, commit, version), what
 * produced it (the tree-sitter CLI, the parser ABI it reports), and the sha256 of
 * the two files that ship (the wasm and its node-types.json). A grammar change is
 * a change to this pin, so it is reviewed as a diff here, and the build fails when
 * the bytes it produced or downloaded differ from the pin.
 */
export interface GrammarPin {
  repo: string;
  /** 40-hex commit of `repo` the wasm was built from (the release tag's commit for a release). */
  commit: string;
  /** Human-readable version: the release, or which unreleased master it is. */
  version: string;
  /** tree-sitter-cli that produced the wasm: exact for builds made here, the upstream's declared range for prebuilt ones. */
  cli: string;
  /** Parser ABI the loaded Language reports (`Language.abiVersion`). */
  abi: number;
  wasmSha256: string;
  nodeTypesSha256: string;
  source: GrammarSource;
}

export interface LanguageDef {
  id: string;
  extensions: string[];
  wasmFile: string;
  /** True when the grammar has an external scanner (src/scanner.c). */
  externalScanner: boolean;
  grammar: GrammarPin;
  commentTypes: string[];
  commentDelimiters: string[];
}

// Tier 0 (TypeScript/TSX/JavaScript) + Tier 1 (Python, Go, Rust, Java, C#, C,
// C++, PHP, Ruby) + JSON, Kotlin, YAML, TOML. The build copies each grammar to
// dist/grammars/<wasmFile> (with <name>.node-types.json beside it) and the parser
// resolves it by that name. `commentTypes` (the grammar's AST node-type names for
// comments) and `commentDelimiters` were verified by parsing a sample with each
// grammar — they drive findComments() and the yg-suppress scanner, so a wrong
// value silently breaks comment-based rules for that language.
export const LANGUAGES: Record<string, LanguageDef> = {
  typescript: {
    id: 'typescript',
    extensions: ['.ts', '.mts', '.cts'],
    wasmFile: 'tree-sitter-typescript.wasm',
    externalScanner: true,
    grammar: {
      repo: 'https://github.com/tree-sitter/tree-sitter-typescript',
      commit: '75b3874edb2dc714fb1fd77a32013d0f8699989f',
      version: 'v0.23.2 + upstream PRs #357 #358 #364 #365, regenerated',
      cli: '0.27.0',
      abi: 15,
      wasmSha256: '9372e129ff96136fc856dd9dd9316e5e7c3bcb1436427c34bc521eb240f17977',
      nodeTypesSha256: '3634f24a2a9e44ecff1cd3c518365396c2e3d1e0d8742b492d2560013e9b3d30',
      source: { kind: 'source', dir: 'typescript', generate: true, patches: ['tree-sitter-typescript-357-using-js-0.25.patch', 'tree-sitter-typescript-358-export-type-star.patch', 'tree-sitter-typescript-364-variance-annotations.patch', 'tree-sitter-typescript-365-import-type-arguments.patch'], deps: [{ path: 'node_modules/tree-sitter-javascript', repo: 'https://github.com/tree-sitter/tree-sitter-javascript', commit: '44c892e0be055ac465d5eeddae6d3e194424e7de' }] },
    },
    commentTypes: ['comment'],
    commentDelimiters: ['//', '/*'],
  },
  tsx: {
    id: 'tsx',
    extensions: ['.tsx'],
    wasmFile: 'tree-sitter-tsx.wasm',
    externalScanner: true,
    grammar: {
      repo: 'https://github.com/tree-sitter/tree-sitter-typescript',
      commit: '75b3874edb2dc714fb1fd77a32013d0f8699989f',
      version: 'v0.23.2 + upstream PRs #357 #358 #364 #365, regenerated',
      cli: '0.27.0',
      abi: 15,
      wasmSha256: '605d5c125b7291a388ea408ef86150876fceae6d623d0810692f85c1ec34d799',
      nodeTypesSha256: 'e065917f791d8e627846dced7bed6b10e490cda9fbee01bf6afcbc564351cced',
      source: { kind: 'source', dir: 'tsx', generate: true, patches: ['tree-sitter-typescript-357-using-js-0.25.patch', 'tree-sitter-typescript-358-export-type-star.patch', 'tree-sitter-typescript-364-variance-annotations.patch', 'tree-sitter-typescript-365-import-type-arguments.patch'], deps: [{ path: 'node_modules/tree-sitter-javascript', repo: 'https://github.com/tree-sitter/tree-sitter-javascript', commit: '44c892e0be055ac465d5eeddae6d3e194424e7de' }] },
    },
    commentTypes: ['comment'],
    commentDelimiters: ['//', '/*'],
  },
  javascript: {
    id: 'javascript',
    extensions: ['.js', '.mjs', '.cjs', '.jsx'],
    wasmFile: 'tree-sitter-javascript.wasm',
    externalScanner: true,
    grammar: {
      repo: 'https://github.com/tree-sitter/tree-sitter-javascript',
      commit: '44c892e0be055ac465d5eeddae6d3e194424e7de',
      version: '0.25.0',
      cli: '^0.25.8 (declared upstream)',
      abi: 15,
      wasmSha256: '5fb488d0cabb4775a594bab85682de5ad6ce83c0d6ac997a9f82dd084d571240',
      nodeTypesSha256: '188a8baa97018edaf63bf7ece372c07bc0d74d1301004bc8f211eb7dee5a6e70',
      source: { kind: 'npm', package: 'tree-sitter-javascript', wasmPath: 'tree-sitter-javascript.wasm', nodeTypesPath: 'src/node-types.json' },
    },
    commentTypes: ['comment'],
    commentDelimiters: ['//', '/*'],
  },
  python: {
    id: 'python',
    extensions: ['.py'],
    wasmFile: 'tree-sitter-python.wasm',
    externalScanner: true,
    grammar: {
      repo: 'https://github.com/tree-sitter/tree-sitter-python',
      commit: '293fdc02038ee2bf0e2e206711b69c90ac0d413f',
      version: '0.25.0',
      cli: '^0.25.9 (declared upstream)',
      abi: 15,
      wasmSha256: '16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47',
      nodeTypesSha256: 'a2456847bea3adff5b2222b2f7b03a870159470d8908622204e6eb29ee2fe45e',
      source: { kind: 'npm', package: 'tree-sitter-python', wasmPath: 'tree-sitter-python.wasm', nodeTypesPath: 'src/node-types.json' },
    },
    commentTypes: ['comment'],
    commentDelimiters: ['#'],
  },
  go: {
    id: 'go',
    extensions: ['.go'],
    wasmFile: 'tree-sitter-go.wasm',
    externalScanner: false,
    grammar: {
      repo: 'https://github.com/tree-sitter/tree-sitter-go',
      commit: '1547678a9da59885853f5f5cc8a99cc203fa2e2c',
      version: '0.25.0',
      cli: '^0.25.8 (declared upstream)',
      abi: 15,
      wasmSha256: '9504573f352b20be7f2f1911754d710622aedc15afff16d5ed8fb5645681aee7',
      nodeTypesSha256: '8d77e723df0f0dfccb66d4571a5c3c17ecfb6c90959044c0992146b21f383bff',
      source: { kind: 'npm', package: 'tree-sitter-go', wasmPath: 'tree-sitter-go.wasm', nodeTypesPath: 'src/node-types.json' },
    },
    commentTypes: ['comment'],
    commentDelimiters: ['//', '/*'],
  },
  rust: {
    id: 'rust',
    extensions: ['.rs'],
    wasmFile: 'tree-sitter-rust.wasm',
    externalScanner: true,
    grammar: {
      repo: 'https://github.com/tree-sitter/tree-sitter-rust',
      commit: '77a3747266f4d621d0757825e6b11edcbf991ca5',
      version: '0.24.2',
      cli: '^0.26.7 (declared upstream)',
      abi: 15,
      wasmSha256: '24c89bd9252255e4aebbcbd7d2d308bd92c86dd95a130fdc80efa49577b8d738',
      nodeTypesSha256: '4b73a1248978340336100db455bf0731c23f9190568c9ae62265fa4a80a327d5',
      source: { kind: 'github-release', wasmUrl: 'https://github.com/tree-sitter/tree-sitter-rust/releases/download/v0.24.2/tree-sitter-rust.wasm' },
    },
    commentTypes: ['line_comment', 'block_comment'],
    commentDelimiters: ['//', '/*'],
  },
  java: {
    id: 'java',
    extensions: ['.java'],
    wasmFile: 'tree-sitter-java.wasm',
    externalScanner: false,
    grammar: {
      repo: 'https://github.com/tree-sitter/tree-sitter-java',
      commit: '94703d5a6bed02b98e438d7cad1136c01a60ba2c',
      version: '0.23.5',
      cli: '0.27.0',
      abi: 14,
      wasmSha256: '6476728734128931bd50de2d1e5e9c75c506b51e278f54eaf709836a0de35759',
      nodeTypesSha256: '19c46facc653381c337ff6cad75dd8b052524179a366c80825d6d0010520eef2',
      source: { kind: 'source', dir: '.', generate: false },
    },
    commentTypes: ['line_comment', 'block_comment'],
    commentDelimiters: ['//', '/*'],
  },
  csharp: {
    id: 'csharp',
    extensions: ['.cs'],
    wasmFile: 'tree-sitter-c_sharp.wasm',
    externalScanner: true,
    grammar: {
      repo: 'https://github.com/tree-sitter/tree-sitter-c-sharp',
      commit: '9150f7d56bb47f1a809fa23623f1ba1413e93fa9',
      version: 'master after 0.23.5 (unreleased): C# 14',
      cli: '0.27.0',
      abi: 15,
      wasmSha256: '315d54ed50bb56940e978ea75c75b74743407fa113c3c98b87aad72c919aaf18',
      nodeTypesSha256: '54bf9fa925bac6fcdc05e0221ae8d4a62c155eb43ccd72b5bc2a4bdbebb7997e',
      source: { kind: 'source', dir: '.', generate: false },
    },
    commentTypes: ['comment'],
    commentDelimiters: ['//', '/*'],
  },
  c: {
    id: 'c',
    extensions: ['.c', '.h'],
    wasmFile: 'tree-sitter-c.wasm',
    externalScanner: false,
    grammar: {
      repo: 'https://github.com/tree-sitter/tree-sitter-c',
      commit: 'b780e47fc780ddc8da13afa35a3f4ed5c157823d',
      version: '0.24.2',
      cli: '^0.25.0 (declared upstream)',
      abi: 15,
      wasmSha256: '83e8d7902b9d7f8c7c5cd4bd9acb5c7eb5faf42c09f85546b183964d3b5f48f9',
      nodeTypesSha256: '23e819ef1eefd357bb6eba844f47f8492f6a88da3e5046b06ec4acd4da8a9fd6',
      source: { kind: 'github-release', wasmUrl: 'https://github.com/tree-sitter/tree-sitter-c/releases/download/v0.24.2/tree-sitter-c.wasm' },
    },
    commentTypes: ['comment'],
    commentDelimiters: ['//', '/*'],
  },
  cpp: {
    id: 'cpp',
    extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'],
    wasmFile: 'tree-sitter-cpp.wasm',
    externalScanner: true,
    grammar: {
      repo: 'https://github.com/tree-sitter/tree-sitter-cpp',
      commit: 'c009222808634c1014f82438d4883753516a2c24',
      version: 'master after 0.23.4 (unreleased)',
      cli: '0.27.0',
      abi: 15,
      wasmSha256: 'ab9e891709f5dc88fd6b1b4d33f110fb23e5ddc5e64296caf4a41d0a3e585ebe',
      nodeTypesSha256: 'bc49c50d6b8af62df4cfda2675e5142bfba85bc1790ff2693aa0ca1286d5c7fe',
      source: { kind: 'source', dir: '.', generate: false },
    },
    commentTypes: ['comment'],
    commentDelimiters: ['//', '/*'],
  },
  php: {
    id: 'php',
    extensions: ['.php'],
    wasmFile: 'tree-sitter-php_only.wasm',
    externalScanner: true,
    grammar: {
      repo: 'https://github.com/tree-sitter/tree-sitter-php',
      commit: '3fda2fb9577166c6399834917f9844f30370beea',
      version: 'master after 0.24.2 (unreleased)',
      cli: '0.27.0',
      abi: 15,
      wasmSha256: '9d58a7421f345b621728362102b424f409416c032dcd0fa4da0d5b0fb4d73054',
      nodeTypesSha256: '01add2ef26adb5d69fb041761b07a6f32520cfedacf9339328ca8a72ed440c28',
      source: { kind: 'source', dir: 'php_only', generate: false },
    },
    commentTypes: ['comment'],
    commentDelimiters: ['//', '#', '/*'],
  },
  ruby: {
    id: 'ruby',
    // `.rake` task files, `.gemspec` specs and Rack's `config.ru` are plain Ruby; the
    // extension-less Ruby files (Rakefile, Gemfile, …) are mapped by basename below.
    extensions: ['.rb', '.rake', '.gemspec', '.ru'],
    wasmFile: 'tree-sitter-ruby.wasm',
    externalScanner: true,
    grammar: {
      repo: 'https://github.com/tree-sitter/tree-sitter-ruby',
      commit: 'ad907a69da0c8a4f7a943a7fe012712208da6dee',
      version: 'master after 0.23.1 (unreleased)',
      cli: '0.27.0',
      abi: 14,
      wasmSha256: 'e255f2dd39812e9730a824f85e4f5c8660426bd8e8d9a4790e8e7e6e41da3761',
      nodeTypesSha256: '9683f80e7be3dd93f1d6f575800de3f3445cda8af1f313f1f80003229c328e8b',
      source: { kind: 'source', dir: '.', generate: false },
    },
    commentTypes: ['comment'],
    commentDelimiters: ['#'],
  },
  json: {
    id: 'json',
    extensions: ['.json'],
    wasmFile: 'tree-sitter-json.wasm',
    externalScanner: false,
    grammar: {
      repo: 'https://github.com/tree-sitter/tree-sitter-json',
      commit: 'ee35a6ebefcef0c5c416c0d1ccec7370cfca5a24',
      version: '0.24.8',
      cli: '0.27.0',
      abi: 14,
      wasmSha256: '564e489724cbcf9b4563cd758a7fb7f355f896b11127819ae9e8ef71e7c15e60',
      nodeTypesSha256: '620b6f5d38676a97526e9d128972d4b156ddbdf6e130cd7e6b9c35e6823e943f',
      source: { kind: 'source', dir: '.', generate: false },
    },
    commentTypes: [],
    commentDelimiters: [],
  },
  kotlin: {
    id: 'kotlin',
    extensions: ['.kt', '.kts'],
    wasmFile: 'tree-sitter-kotlin.wasm',
    externalScanner: true,
    grammar: {
      repo: 'https://github.com/tree-sitter-grammars/tree-sitter-kotlin',
      commit: '77dd60ea0a9003ce062c9728a513ffe1aaff8c82',
      version: '1.1.0',
      cli: '0.27.0',
      abi: 14,
      wasmSha256: '5d44eef5c02b4546f01ddc376ed237294b18604f727b192a832a5ce08a040e8f',
      nodeTypesSha256: '0f21509031ad37902dc05d5828f178fed3545c466ffcf38ef30d969cb64e8e9d',
      source: { kind: 'source', dir: '.', generate: false },
    },
    commentTypes: ['line_comment', 'block_comment'],
    commentDelimiters: ['//', '/*'],
  },
  yaml: {
    id: 'yaml',
    extensions: ['.yaml', '.yml'],
    wasmFile: 'tree-sitter-yaml.wasm',
    externalScanner: true,
    grammar: {
      repo: 'https://github.com/tree-sitter-grammars/tree-sitter-yaml',
      commit: '7708026449bed86239b1cd5bce6e3c34dbca6415',
      version: '0.7.2',
      cli: '0.27.0',
      abi: 14,
      wasmSha256: 'f89cf2a8ccd4f29292e502f1c37efb4f1dead281246605e0a890c697d4db88c7',
      nodeTypesSha256: '1238b6c89fc6afb9723b6463a365843aa87e478025490660e5acfc9adaaf809b',
      source: { kind: 'source', dir: '.', generate: false },
    },
    commentTypes: ['comment'],
    commentDelimiters: ['#'],
  },
  toml: {
    id: 'toml',
    extensions: ['.toml'],
    wasmFile: 'tree-sitter-toml.wasm',
    externalScanner: true,
    grammar: {
      repo: 'https://github.com/tree-sitter-grammars/tree-sitter-toml',
      commit: '64b56832c2cffe41758f28e05c756a3a98d16f41',
      version: '0.7.0',
      cli: '0.27.0',
      abi: 14,
      wasmSha256: '057f48e81072cb0eb5969632a7cf032fc6d33cd4ba3198c3f58227346c012d97',
      nodeTypesSha256: 'db9ba87309dd4b5a3fe107ddb20858f869cf40c199cad3ae9d99029240ccf419',
      source: { kind: 'source', dir: '.', generate: false },
    },
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

export function getGrammarForExtension(ext: string): { wasmFile: string } | null {
  const lang = getLanguageForExtension(ext.toLowerCase());
  if (lang === null) return null;
  // Own-property guard: a reserved key inherited from Object.prototype
  // ('constructor', 'toString', '__proto__', …) resolves to an inherited value
  // on LANGUAGES, which would slip past `if (!def)` and then read `def.wasmFile`
  // off a non-LanguageDef. Treat a non-own key as absent — the same not-found
  // return an unknown language already takes.
  const def = Object.hasOwn(LANGUAGES, lang) ? LANGUAGES[lang] : undefined;
  if (!def) return null;
  return { wasmFile: def.wasmFile };
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
