import { walk, report } from '@chrisdudek/yg/ast';

/**
 * G1 import boundary — quarantines BOTH ends of the verdict-events telemetry
 * sidecar from the parts of the engine that have no business touching them.
 *
 * This aspect cascades from the cli root node onto every descendant, so each
 * mapped source file is a subject of exactly one pair and EVERY potential
 * importer is seen — including everything under source/cli/src/core/**. The
 * check is self-contained: it inspects only its own subject files (ctx.files),
 * no cross-node reads. Every ban is alias-proof and AST-based (a string literal
 * containing the module text is never a hit).
 *
 * READER side (io/events-reader) — local, read-only telemetry that must never be
 * reachable from a check / verify / render / fill path:
 *   (a) importing / re-exporting the reader from ANY file other than the three
 *       sanctioned CLI presentation commands; and
 *   (b) importing it from ANY file under source/cli/src/core/** — reported with a
 *       core-specific message even though (a) already forbids it, so the engine
 *       breach is unmistakable.
 *
 * APPENDER side (io/events-store, appendVerdictEvent) — the write path that
 * produces telemetry lines. Every event line carries a `source` discriminator
 * ('fill' | 'drill' | 'diag'); a reader that mixes those regimes corrupts its
 * statistics, so the set of subsystems allowed to WRITE events is fixed and
 * closed. Only the sanctioned producers may import the appender FUNCTION:
 *   src/core/fill*.ts       (source: 'fill'  — yg check --approve)
 *   src/cli/drill.ts        (source: 'drill' — yg drill LLM case runs)
 *   src/cli/aspect-test.ts  (source: 'diag'  — yg aspect-test --repeat / --tier)
 * Any other file under source/cli/src that imports (or re-exports)
 * `appendVerdictEvent` is a violation. An allowlisted file that does not yet exist
 * (e.g. cli/drill.ts, added by a later task) is fine — the guard fires on UNEXPECTED
 * importers, never on ABSENT allowed ones; the appender clause is binding-specific,
 * so importing the
 * `EVENTS_FILENAME` constant or the `VerdictEvent` type from events-store — as the
 * reader and the presentation commands legitimately do — is never a hit.
 */

/** Files permitted to import the reader (repo-relative POSIX). */
const ALLOWED_READER_IMPORTERS = new Set([
  'source/cli/src/cli/log.ts',
  'source/cli/src/cli/aspects.ts',
  'source/cli/src/cli/advise.ts',
]);

/** Engine core layer — no file here may import the reader at all. */
const CORE_PREFIX = 'source/cli/src/core/';

/**
 * Files permitted to import the write-only appender FUNCTION (`appendVerdictEvent`).
 * `src/core/fill*.ts` is a glob (matched below): fill.ts and every fill-*.ts helper
 * directly in core/, all sanctioned emitters of source:'fill'. The two CLI commands
 * are exact paths — cli/drill.ts (source:'drill') does not exist until a later task,
 * which is fine (see header).
 */
const ALLOWED_APPENDER_IMPORTERS_EXACT = new Set([
  'source/cli/src/cli/drill.ts',
  'source/cli/src/cli/aspect-test.ts',
]);
/** Glob for the fill producers: source/cli/src/core/fill*.ts, no nested dirs. */
const ALLOWED_APPENDER_IMPORTERS_GLOB = /^source\/cli\/src\/core\/fill[^/]*\.ts$/;

function isAllowedAppenderImporter(filePath) {
  return (
    ALLOWED_APPENDER_IMPORTERS_EXACT.has(filePath) ||
    ALLOWED_APPENDER_IMPORTERS_GLOB.test(filePath)
  );
}

/**
 * Test code is outside the enforcement engine, so it may import either end freely
 * (the reader's own tests must). The boundary protects the production check /
 * verify / render / fill path, never the test tree.
 */
function isTestFile(filePath) {
  return filePath.startsWith('source/cli/tests/') || /\.(test|spec)\.[cm]?tsx?$/.test(filePath);
}

/**
 * Matches a module specifier that resolves to the events-reader module, with or
 * without a `.js` extension, as a bare module or a relative path.
 */
const READER_MODULE_RE = /(^|\/)events-reader(\.js)?$/;
/**
 * Matches a module specifier that resolves to the events-store (appender) module.
 * The boundary between `-reader` and `-store` is exact — one never matches the other.
 */
const STORE_MODULE_RE = /(^|\/)events-store(\.js)?$/;
/** The write-only appender binding whose import is fenced (constant/type imports are not). */
const APPENDER_SYMBOL = 'appendVerdictEvent';

/**
 * A statement-level type-only import/export (`import type … from`, `export type …
 * from`) is fully erased at compile — it creates NO runtime dependency. The `type`
 * modifier surfaces as a direct child token of the statement; an inline
 * `import { type X, y }` keeps `type` inside the specifier (not a direct child),
 * so a value import is never mistakenly skipped.
 */
function isTypeOnly(node) {
  return node.children.some((c) => c.type === 'type');
}

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

/**
 * True when an `import … from '<events-store>'` statement pulls the appender VALUE
 * binding into scope: a named `{ appendVerdictEvent }` (judged by ORIGINAL name,
 * alias-proof; an inline `type` modifier on the specifier is erased and does not
 * count) or a namespace `* as ns` import (which exposes the whole value surface,
 * appendVerdictEvent included). A side-effect import or a pure constant/type import
 * (EVENTS_FILENAME, VerdictEvent) is not a hit.
 */
function appenderValueImport(importNode) {
  const clause = importNode.namedChildren.find((c) => c.type === 'import_clause');
  if (!clause) return false; // side-effect `import 'events-store'` — no binding
  for (const child of clause.namedChildren) {
    if (child.type === 'namespace_import') return true; // `* as ns` — exposes the appender
    if (child.type === 'named_imports') {
      for (const spec of child.namedChildren) {
        if (spec.type !== 'import_specifier') continue;
        if (spec.children.some((c) => c.type === 'type')) continue; // inline `type X` — erased
        const name = spec.childForFieldName('name');
        if (name && name.text === APPENDER_SYMBOL) return true;
      }
    }
  }
  return false;
}

/**
 * True when an `export … from '<events-store>'` RE-EXPORT republishes the appender:
 *   export * from …          → bare star re-export (exposes appendVerdictEvent)
 *   export * as ns from …     → namespace re-export (exposes it)
 *   export { appendVerdictEvent } from …  → judged per ORIGINAL name (alias-proof)
 */
function appenderValueExport(exportNode) {
  if (exportNode.namedChildren.some((c) => c.type === 'namespace_export')) return true;
  const clause = exportNode.namedChildren.find((c) => c.type === 'export_clause');
  if (!clause) {
    return exportNode.children.some((c) => c.type === '*'); // `export * from …`
  }
  for (const spec of clause.namedChildren) {
    if (spec.type !== 'export_specifier') continue;
    const name = spec.childForFieldName('name');
    if (name && name.text === APPENDER_SYMBOL) return true;
  }
  return false;
}

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (!file.ast) continue;
    if (isTestFile(file.path)) continue;

    walk(file.ast.rootNode, (node) => {
      const isImport = node.type === 'import_statement';
      const isExportFrom = node.type === 'export_statement';
      if (!isImport && !isExportFrom) return;
      const spec = stringValue(node.childForFieldName('source'));
      if (typeof spec !== 'string') return;

      // ---- READER side: any import/re-export of the reader module is a hit. ----
      if (READER_MODULE_RE.test(spec)) {
        if (file.path.startsWith(CORE_PREFIX)) {
          violations.push(
            report(
              file,
              node,
              `Engine core (${file.path}) may not import the verdict-events reader ('${spec}') — ` +
                `the reader is local, read-only telemetry and must never be reachable from a ` +
                `check / verify / render / fill path. Core may use only the write-only appender (io/events-store).`,
            ),
          );
        } else if (!ALLOWED_READER_IMPORTERS.has(file.path)) {
          violations.push(
            report(
              file,
              node,
              `${file.path} may not import the verdict-events reader ('${spec}') — only the CLI ` +
                `presentation commands cli/log.ts, cli/aspects.ts, and cli/advise.ts may import it. ` +
                `Everything else must stay clear of the read-only telemetry sidecar.`,
            ),
          );
        }
        return;
      }

      // ---- APPENDER side: importing the write function from a non-producer is a hit. ----
      if (STORE_MODULE_RE.test(spec)) {
        if (isTypeOnly(node)) return; // `import type … from 'events-store'` — no runtime binding
        const pullsAppender = isImport ? appenderValueImport(node) : appenderValueExport(node);
        if (pullsAppender && !isAllowedAppenderImporter(file.path)) {
          violations.push(
            report(
              file,
              node,
              `${file.path} may not import the verdict-events appender ('${APPENDER_SYMBOL}' from '${spec}') — ` +
                `only the sanctioned event producers may write telemetry: src/core/fill*.ts (source:'fill'), ` +
                `cli/drill.ts (source:'drill'), and cli/aspect-test.ts (source:'diag'). Every event line carries a ` +
                `source discriminator; keeping the writer set closed prevents an unaccounted regime from corrupting ` +
                `the telemetry. Importing only EVENTS_FILENAME or the VerdictEvent type is fine.`,
            ),
          );
        }
      }
    });
  }

  return violations;
}
