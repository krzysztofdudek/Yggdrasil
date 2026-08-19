import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import path from 'node:path';

// NOTE on architecture layering: the layer rules (which directory may import
// which) live in .yggdrasil/yg-architecture.yaml as the source of truth and are
// kept legal structurally by where files live. An eslint-plugin-boundaries setup
// was trialled to enforce them in the linter but never worked — its import
// resolver would not map our `.js` specifiers to their `.ts` sources under flat
// config (tried plugin v5/v6, resolver v3/v4, multiple settings), so the rules
// silently passed everything. It was removed rather than left as dead config.

// =============================================================================
// `local/roots-genericity-fence` — a NARROWER, resolver-free stand-in for the
// architecture graph's layer rules, scoped only to `src/roots/**` (below).
//
// WHY THIS RULE EXISTS AND WHY IT IS NOT A GRAPH ASPECT: the roots mining
// engine must stay genuinely generic across every supported grammar — it may
// never special-case a language by importing a specific grammar package or
// switching on a file extension itself; both belong exclusively to
// `utils/language-registry.ts`. A checker aspect encoding this fence directly
// in the architecture graph (as a `src/roots/**`-scoped `check.mjs`) would be
// the more natural home, but every new aspect id needs the maintainer's own
// approval before it is authored — until that approval and the aspect exist,
// this rule lives here, inline in the plain eslint config, as the
// enforcement.
//
// WHY NO MODULE RESOLUTION: the note above this block records a real failure
// — a resolver-based rule silently no-opped rather than erroring, because the
// resolver could not map this repo's relative `.js`-suffixed specifiers
// (e.g. `'../utils/language-registry.js'`, see `ast/parser.ts`) back to their
// `.ts` sources. This rule never resolves anything. For a RELATIVE specifier
// it does pure string arithmetic instead — `path.posix.join` the specifier
// onto the importing file's own repo-relative directory — and compares the
// result against a fixed allowlist of directory prefixes. No filesystem
// access, no module graph, nothing that can silently stop matching a real
// specifier shape the way the resolver did.
//
// THE ALLOWLIST (repo-relative to `source/cli/`, i.e. this config's own cwd):
//   - `src/roots/`   — the roots-engine self edge (a roots file importing a
//                      sibling roots file).
//   - `src/ast/`     — ast-adapter: the shared parser pool (`ast/parser.ts`),
//                      the node-types disk loader, and `ast/types.ts`'s
//                      re-exported web-tree-sitter types (roots never imports
//                      the `web-tree-sitter` package directly — see the
//                      banned-specifier check below).
//   - `src/utils/`   — DELIBERATELY COARSE: the architecture graph's `utility`
//                      edge is the fine-grained fence for this layer, and
//                      roots code legitimately needs more of `utils/` than
//                      just the grammar registry — `source-hygiene`'s implied
//                      `no-direct-minimatch` child mandates routing every
//                      exclusion-glob match through `utils/mapping-path.js`'s
//                      `globMatch`, and the POSIX path helpers roots needs
//                      live there too.
//   - `src/io/`      — DELIBERATELY COARSE for the identical reason: engine
//                      code may call persistence-adapter helpers (repo
//                      scanning, atomic writes) but never the `*-parser.ts`
//                      files classified as parser-adapter — the graph's own
//                      `calls` list is the fine fence for that split; this
//                      allowlist only tracks the directory.
//   - `src/model/`   — the `RootsConfig`/`SeedEntry` etc. shared types.
//   - `node:` builtins.
//
// DELIBERATELY ABSENT: `src/formatters/`. Roots-engine's architecture-type
// `calls` list carries no `formatter` edge — engine code returns structured
// data or throws typed errors, and only the (later) CLI command layer formats
// them via `buildIssueMessage` — so this lint allowlist must not be more
// permissive than the graph it stands in for.
//
// THE BANNED-SPECIFIER CHECK fires on ANY specifier (relative or not)
// matching `/tree-sitter|\.wasm/` — this is what catches a bare
// `import ... from 'web-tree-sitter'` (which the allowlist walk above would
// never even reach, since it is not a relative specifier and not `node:`,
// but the message this produces is specific rather than the generic
// catch-all). Roots code gets AST node types only via `ast/types.ts`'s
// re-exports, never from the package itself, and grammar assets only via the
// registry — never a `.wasm` path literal anywhere in `src/roots/**`.
//
// This same banned-specifier regex is ALSO applied to every plain string
// literal in scope (inside the `Literal` visitor, alongside the
// extension-literal check below) and to a `TSImportType`'s source literal
// specifically (`import('web-tree-sitter').Tree` as a *type*, which carries
// no `ImportDeclaration`/`ImportExpression` node for the walk above to ever
// see) — otherwise `'./grammars/tree-sitter-python.wasm'` written as an
// ordinary string (never imported) or `import('web-tree-sitter').Tree` used
// only as a type position would both pass every check above untouched. A
// bare `'tree-sitter-python'` string with no path around it is caught the
// same way. Template literals are consciously OUT OF SCOPE for this check —
// the plan names "string literal" and a `Literal` visitor only ever sees a
// plain string/template-less literal; a grammar name assembled through
// template interpolation is not something this fence catches.
//
// THE EXTENSION-LITERAL CHECK bans a string literal matching
// `/^\.(ts|tsx|js|py|java|go|rs|cs|c|cpp|php|rb|kt)$/` anywhere in a
// `src/roots/**` file — the shape of a hand-rolled per-language switch this
// engine must never contain (extension → grammar mapping is
// `utils/language-registry.ts`'s job alone, and the rule's own file-glob
// scope keeps it from ever firing on that file). This is DELIBERATELY
// NARROWER than a "flag any identifier or string literal that names a
// programming language" heuristic would be: that broader check false-positives
// on ordinary English words (a variable named `go`, a doc comment mentioning
// "java" the coffee) far too often to be a usable gate. The extension-literal
// shape is the concrete, low-noise instance of the same smell that is
// actually worth failing a build over.
// =============================================================================

const GENERICITY_ALLOWED_IMPORT_PREFIXES = ['src/roots/', 'src/ast/', 'src/utils/', 'src/io/', 'src/model/'];
const GENERICITY_BANNED_SPECIFIER_RE = /tree-sitter|\.wasm/;
const GENERICITY_BANNED_EXTENSION_LITERAL_RE = /^\.(ts|tsx|js|py|java|go|rs|cs|c|cpp|php|rb|kt)$/;

/**
 * Repo-relative (to this config's own cwd — `source/cli/`) directory of the
 * file currently being linted, POSIX-separated regardless of host OS.
 */
function importingDirOf(context) {
  const cwd = context.cwd ?? process.cwd();
  const filename = context.filename ?? context.getFilename();
  const rel = path.relative(cwd, filename).split(path.sep).join('/');
  return path.posix.dirname(rel);
}

const rootsGenericityFenceRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'src/roots/** may import only from the roots-genericity allowlist (src/roots/, src/ast/, src/utils/, src/io/, src/model/, node: builtins), never a grammar package/wasm asset directly, and may never switch on a per-language file-extension literal.',
    },
    schema: [],
    messages: {
      bannedGrammarImport:
        "src/roots/** must not import a grammar package or .wasm asset directly ('{{specifier}}') — parsers come only from ast/parser.ts's shared pool, and grammar AST types only from ast/types.ts's re-exports.",
      outsideAllowlist:
        "src/roots/** may import only from src/roots/, src/ast/, src/utils/, src/io/, src/model/, or a node: builtin — '{{resolved}}' is outside that allowlist.",
      extensionLiteral:
        "src/roots/** must not switch on a per-language file-extension literal ('{{value}}') — extension-to-grammar mapping belongs only to utils/language-registry.ts.",
    },
  },
  create(context) {
    function checkSpecifier(sourceNode) {
      const specifier = sourceNode.value;
      if (typeof specifier !== 'string') return;
      if (GENERICITY_BANNED_SPECIFIER_RE.test(specifier)) {
        context.report({ node: sourceNode, messageId: 'bannedGrammarImport', data: { specifier } });
        return;
      }
      if (specifier.startsWith('node:')) return;
      if (!specifier.startsWith('.')) {
        context.report({ node: sourceNode, messageId: 'outsideAllowlist', data: { resolved: specifier } });
        return;
      }
      // Pure string arithmetic — no resolver, no filesystem access. This is
      // the normalization step the header comment above describes: join the
      // relative specifier onto the importing file's own repo-relative
      // directory, then compare the result's prefix against the allowlist.
      const resolved = path.posix.normalize(path.posix.join(importingDirOf(context), specifier));
      if (GENERICITY_ALLOWED_IMPORT_PREFIXES.some((prefix) => resolved.startsWith(prefix))) return;
      context.report({ node: sourceNode, messageId: 'outsideAllowlist', data: { resolved } });
    }

    return {
      ImportDeclaration(node) {
        checkSpecifier(node.source);
      },
      ImportExpression(node) {
        if (node.source && node.source.type === 'Literal') checkSpecifier(node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.source) checkSpecifier(node.source);
      },
      ExportAllDeclaration(node) {
        if (node.source) checkSpecifier(node.source);
      },
      // `import('web-tree-sitter').Tree` used purely as a TYPE carries no
      // ImportDeclaration/ImportExpression node — TSImportType is its own AST
      // shape with a `source` Literal — so without this visitor that form
      // would pass every check above untouched.
      TSImportType(node) {
        if (node.source && node.source.type === 'Literal') checkSpecifier(node.source);
      },
      Literal(node) {
        if (typeof node.value !== 'string') return;
        // Same banned-specifier regex as checkSpecifier above, applied here to
        // ANY string literal in scope — not just import specifiers — so a
        // `.wasm` path or a bare grammar-package name written as a plain
        // string (never imported) is caught too.
        if (GENERICITY_BANNED_SPECIFIER_RE.test(node.value)) {
          context.report({ node, messageId: 'bannedGrammarImport', data: { specifier: node.value } });
          return;
        }
        if (GENERICITY_BANNED_EXTENSION_LITERAL_RE.test(node.value)) {
          context.report({ node, messageId: 'extensionLiteral', data: { value: node.value } });
        }
      },
    };
  },
};

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      // Error (not warn): repo-check does not fail on warnings, so a `warn` here
      // let future `any`-leaks pass CI silently. The codebase is `any`-free today.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // The test tree (unit / integration / e2e specs + Playwright portal specs and
    // the sample-project fixtures) is linted by the same gate as src, but two rules
    // are legitimately relaxed here — nowhere else:
    //   - no-explicit-any: tests use `any` freely for mock shapes, error-object casts
    //     in catch clauses, and reaching into internals; forcing precise types on those
    //     sites is high-churn, low-value, and standard practice for a test suite.
    //   - no-empty-pattern: Playwright/vitest worker fixtures take an empty
    //     object-destructure first parameter (`async ({}, use) => …`) — the runner
    //     introspects that pattern to build its fixture dependency graph, so the empty
    //     `{}` is required, not accidental.
    // Every other rule (unused vars, useless assignments, regex clarity, cause-on-rethrow)
    // stays fully enforced across tests.
    files: ['tests/**/*.ts', 'tests/**/*.tsx', 'tests/**/*.js', 'tests/**/*.mjs', 'tests/**/*.cjs'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty-pattern': 'off',
    },
  },
  {
    // See the `local/roots-genericity-fence` block's own header comment above
    // for what this enforces and why it lives here rather than as a graph
    // aspect. Scoped to src/roots/** only — the rule's file-glob scope is
    // itself part of the contract: an eslint invocation from any cwd other
    // than source/cli/ (where this config file is found) or a stdin
    // `--stdin-filename` value not already relative to that cwd makes the
    // scope match nothing, which is exactly the silent-no-op failure mode
    // this repo has hit once already (see the top-of-file note) — proven not
    // to recur here by tests/unit/roots/genericity-lint.test.ts.
    files: ['src/roots/**/*.ts'],
    plugins: { local: { rules: { 'roots-genericity-fence': rootsGenericityFenceRule } } },
    rules: { 'local/roots-genericity-fence': 'error' },
  },
  {
    // The portal frontend assets (templates/portal/js + vendor) are committed BROWSER
    // code, not Node/TS source: they legitimately use browser globals (document, window)
    // and, for the vendored layout library, are taken as-shipped. They are enforced by the
    // portal frontend aspects (no-node-imports-in-frontend / no-cdn-no-network /
    // no-network-egress / no-secrets-strings / focused-file-size), not by the Node eslint
    // config, whose environment cannot model the browser.
    ignores: [
      'dist/',
      'build/',
      'coverage/',
      'node_modules/',
      '*.config.*',
      '*.min.js',
      'src/templates/portal/js/',
      'src/templates/portal/vendor/',
    ],
  },
);
