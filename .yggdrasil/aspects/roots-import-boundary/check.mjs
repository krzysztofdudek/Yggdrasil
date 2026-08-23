import { walk, report } from '@chrisdudek/yg/ast';

/**
 * Roots-engine extraction boundary — freezes THE CORE's `../` import surface
 * NOW, before either future package (the parsing layer or the roots engine)
 * is actually pulled out of this CLI.
 *
 * This aspect binds (via `when:`) to the `roots-engine` and `roots-store`
 * graph node types, so in production `ctx.files` here is exactly those two
 * nodes' own mapped files — THE CORE (binding, extract, enumerate, roles,
 * mine, mine-stages, config, weights, partitions, history, history-resume,
 * history-replay, history-cochange, stores, pipeline, model, index).
 * Deliberately no additional file-path filter is applied inside `check()`:
 * the `when:` binding is the sole subject-selection mechanism (matching how
 * `no-direct-fs` / `atomic-write-contract` / `read-or-default-via-helper`
 * trust their own type-scoped bindings). An internal exact-path allowlist
 * would also make this check un-drillable — `yg drill` delivers each case
 * file at its REAL location under this aspect's own `drills/` directory,
 * never at a synthetic `source/cli/src/roots/*.ts` path, so gating on that
 * path would make every drill case (violates-* included) silently pass.
 *
 * ALL of THE CORE's files live flat in one directory (`src/roots/`, no
 * nesting), so a `../` import from any of them always crosses into exactly
 * one more path segment (`ast/…`, `utils/…`, `io/…`, `model/…`) — that
 * segment is fully determined by the SPECIFIER TEXT alone, with no
 * dependency on which file is doing the importing or where it physically
 * sits. So, like `events-reader-boundary` and `no-direct-fs`, this check
 * matches on the specifier text itself rather than resolving a real
 * filesystem path — the same design choice, for the same reason: a
 * resolver-based check silently stopped matching this repo's `.js`-suffixed
 * relative specifiers once tried here (see `local/roots-genericity-fence`'s
 * header comment in `eslint.config.js`), and pure string matching also
 * happens to be exactly what makes this check drillable.
 *
 * NORMALIZATION (closes an earlier evasion): the specifier is segment-
 * normalized BEFORE any classification decision is made — collapsing `.`
 * segments and resolving `..` segments against what precedes them — so
 * `'./../core/graph-loader.js'` normalizes to the same string as
 * `'../core/graph-loader.js'` before either is looked at. TypeScript and
 * Node resolve those two specifiers to the identical file; treating the
 * first as an always-allowed "sibling" merely because its RAW text happens
 * to start with `./` would let any `../` crossing evade this check by
 * prefixing an inert `./`. The classification below is therefore driven
 * entirely by the NORMALIZED text, never the raw one — this is what makes
 * "the target of a `../` import is fully determined by the specifier text
 * alone" actually true; it was false of the RAW text (see the fixed
 * `violates-dot-slash-escape` drill).
 *
 * A normalized specifier that stays inside `src/roots/` (no leading `..`
 * segment survives normalization) is always allowed — this fences the
 * boundary AROUND src/roots/, never movement within it. A `node:` builtin
 * or a non-relative bare-package specifier is out of this check's scope
 * entirely — `no-direct-fs` and the `local/roots-genericity-fence` ESLint
 * rule already police those; this check owns only the `../` crossing.
 *
 * Unlike most import-fence aspects in this repo (`no-direct-fs`,
 * `events-reader-boundary`, `instrument-import-fence`), a statement-level
 * `import type … from` / `export type … from` is NOT exempt here: those
 * aspects exempt type-only imports because they are erased at compile time
 * and create no RUNTIME dependency, which is what each of them actually cares
 * about. This aspect cares about the EXTRACTION boundary — a type crossing it
 * still has to be resolved (published or duplicated) once the roots engine
 * ships as its own package, so a type-only crossing is exactly as much a
 * violation as a value one.
 *
 * DYNAMIC ESCAPES: a `call_expression` whose callee is a dynamic `import(...)`
 * or `require(...)` with a statically-resolvable string/no-substitution-
 * template argument is checked exactly like a static import/export specifier
 * (same normalization, same allowlist). An interpolated/computed argument is
 * not a static fact this check can read and is silently skipped, mirroring
 * the relations extractor's own `specifierFromCallArg` — this is a stated
 * scope limitation, not a gap this check pretends not to have (see the
 * `errs census` row in `.yggdrasil/aspects/README.md`).
 *
 * NOT COVERED, BY DESIGN: this check only ever looks at the DIRECT specifier
 * text of an import/export/dynamic-import in a core file. A module that is
 * itself on THE ALLOWLIST but re-exports something outside it (e.g. an
 * allowlisted helper adding `export * from '../core/graph-loader.js'`)
 * silently widens every core file's real reachable surface without this
 * check ever seeing a disallowed specifier — because the disallowed specifier
 * never appears in a core file at all. This is inherent to any per-file
 * import fence, not a defect in this one: growing an allowlisted module's own
 * re-export set is itself the reviewed decision this check cannot substitute
 * for. See the `errs census` row for the same statement in the canonical
 * location.
 */

/**
 * THE ALLOWLIST — the only modules a core file may reach with a single `../`
 * relative import, as the specifier's OWN text reads once normalized, its
 * leading `../` stripped, and its trailing extension stripped (e.g.
 * `'../io/hash.js'` → `'io/hash'`). This is exactly THE CORE's real external
 * dependency surface today (13 specifiers) — nothing reserved, nothing
 * aspirational: `formatters/message-builder` and `io/roots-build-lock-store`
 * were removed from an earlier draft of this list because neither is
 * actually imported by any core file (grep-verified), and the former is
 * architecturally illegal for `roots-engine`/`roots-store` to import at all
 * (`relations.calls` for both types omits `formatter` entirely) — the
 * allowlist sanctioning it was itself a bug this aspect would never have
 * caught, since satisfying THIS check by reaching for an allowlisted-but-
 * illegal module would still fail `yg check`'s relation pass with no legal
 * remedy short of an architecture edit.
 */
const ALLOWED_RESOLVED = new Set([
  'ast/parser',
  'ast/types',
  'ast/node-types',
  'utils/language-registry',
  'utils/git-history',
  'utils/debug-log',
  'utils/mapping-path',
  'io/hash',
  'io/atomic-write',
  'io/read-or-default',
  'io/repo-scanner',
  'io/roots-blob-cache',
  'io/roots-history-store',
]);

/** Extract the literal string value of an import/export `source` node (no template substitutions). */
function stringValue(node) {
  if (!node) return undefined;
  if (node.type !== 'string' && node.type !== 'template_string') return undefined;
  if (
    node.type === 'template_string' &&
    node.namedChildren.some((c) => c.type === 'template_substitution')
  ) {
    return undefined;
  }
  const frag = node.namedChildren.find((c) => c.type === 'string_fragment');
  if (frag) return frag.text;
  const t = node.text;
  return t.length >= 2 ? t.slice(1, -1) : '';
}

/** First named argument of a call_expression, or null. Mirrors relations/extractors/typescript.ts's firstArgument. */
function firstArgument(call) {
  const args = call.childForFieldName('arguments');
  if (args === null) return null;
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (arg !== null) return arg;
  }
  return null;
}

/**
 * Segment-normalize a relative specifier: drop `.` segments, resolve `..`
 * segments against whatever precedes them (never past the specifier's own
 * start), and drop empty segments (a `//` typo). The caller has already
 * confirmed `spec` starts with `.`. Returns the normalized specifier with NO
 * leading `./` — a specifier that stays inside the importing directory comes
 * back with no leading `..` at all (e.g. `'./../model.js'` → `'model.js'`,
 * `'./../core/graph-loader.js'` → `'../core/graph-loader.js'`).
 */
function normalizeRelativeSpecifier(spec) {
  const segs = [];
  for (const s of spec.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (segs.length > 0 && segs[segs.length - 1] !== '..') segs.pop();
      else segs.push('..');
    } else {
      segs.push(s);
    }
  }
  return segs.join('/');
}

/** Classify one already-extracted specifier; push a report onto `violations` if it crosses the boundary illegally. */
function checkSpecifier(spec, file, subjectNode, violations) {
  if (typeof spec !== 'string') return;

  // Not a relative specifier at all (a bare package, or a `node:` builtin) —
  // out of this check's scope. no-direct-fs and the roots-genericity ESLint
  // fence already police those.
  if (!spec.startsWith('.')) return;

  const norm = normalizeRelativeSpecifier(spec);

  // Normalizes to something with no surviving `..` segment: it resolves
  // inside src/roots/ itself — an intra-roots sibling import, always
  // allowed. This fences the boundary AROUND src/roots/, never movement
  // within it. (Covers both a plain './x.js' and an escape-then-return form
  // like './../model.js'.)
  if (!norm.startsWith('..')) return;

  // A `../` crossing (or deeper, `../../…`, which never matches below and is
  // therefore always a violation — THE CORE has no such import today). Strip
  // exactly one leading `../` and a trailing extension; compare the
  // remainder against THE ALLOWLIST as plain text (see header comment for
  // why this is text matching, not real path resolution).
  const resolved = norm.replace(/^\.\.\//, '').replace(/\.[cm]?[jt]sx?$/, '');
  if (ALLOWED_RESOLVED.has(resolved)) return;

  violations.push(
    report(
      file,
      subjectNode,
      `${file.path} imports '${spec}', crossing the roots-engine extraction boundary outside its ` +
        `fixed allowlist (ast/parser, ast/types, ast/node-types, utils/language-registry, ` +
        `utils/git-history, utils/debug-log, utils/mapping-path, io/hash, io/atomic-write, ` +
        `io/read-or-default, io/repo-scanner, io/roots-blob-cache, io/roots-history-store — plus any ` +
        `sibling './...' file inside src/roots/ itself). WHY: this file is one of the roots engine's/roots ` +
        `store's own mapped files; the day this engine is extracted into its own package, every import ` +
        `outside that list is a broken build discovered file-by-file under release pressure rather than a ` +
        `boundary decision made now — this holds for type-only imports and dynamic import()/require() too, ` +
        `since a type crossing the boundary still has to be resolved once the two sides are separate ` +
        `packages, and a dynamic escape is exactly as real a dependency as a static one. NEXT: either ` +
        `satisfy this need through an already-allowlisted module (add a helper there instead of reaching ` +
        `'${resolved}' directly — note 'formatters/message-builder' is NOT on this allowlist because ` +
        `roots-engine/roots-store are not permitted to call a formatter at all; that need has to be met by ` +
        `the CLI command layer, not this engine), or — if '${resolved}' genuinely belongs on the roots ` +
        `engine's external surface — extend this aspect's own allowlist deliberately ` +
        `(.yggdrasil/aspects/roots-import-boundary/check.mjs) rather than importing around it.`,
    ),
  );
}

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (!file.ast) continue;

    walk(file.ast.rootNode, (node) => {
      if (node.type === 'import_statement' || node.type === 'export_statement') {
        const sourceNode = node.childForFieldName('source');
        checkSpecifier(stringValue(sourceNode), file, sourceNode ?? node, violations);
        return;
      }

      if (node.type === 'call_expression') {
        const fn = node.childForFieldName('function');
        if (fn === null) return;
        // Dynamic import: callee is a node of type `import` (not an identifier).
        // Require: callee is an identifier whose text is `require`.
        const isDynamicImport = fn.type === 'import';
        const isRequire = fn.type === 'identifier' && fn.text === 'require';
        if (!isDynamicImport && !isRequire) return;
        const arg = firstArgument(node);
        if (arg === null) return;
        // A computed/interpolated argument yields undefined from stringValue
        // and is silently skipped — not a static fact this check can read
        // (see the header comment's DYNAMIC ESCAPES note).
        checkSpecifier(stringValue(arg), file, arg, violations);
      }
    });
  }

  return violations;
}
