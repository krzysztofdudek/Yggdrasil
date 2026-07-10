import { walk, report } from '@chrisdudek/yg/ast';

/**
 * G1 import boundary — the verdict-events READER (io/events-reader) is local,
 * read-only telemetry and must never be reachable from the engine.
 *
 * This aspect cascades from the cli root node onto every descendant, so each
 * mapped source file is a subject of exactly one pair and EVERY potential
 * importer is seen — including everything under source/cli/src/core/**. The
 * check is self-contained: it inspects only its own subject files (ctx.files),
 * no cross-node reads.
 *
 * Two bans, both alias-proof and AST-based (a string literal containing the text
 * "events-reader" is never a hit):
 *   (a) importing / re-exporting from events-reader from ANY file other than the
 *       three sanctioned CLI presentation commands; and
 *   (b) importing it from ANY file under source/cli/src/core/** — reported with a
 *       core-specific message even though (a) already forbids it, so the engine
 *       breach is unmistakable.
 *
 * The write-only appender (events-store) is deliberately NOT matched: core/** may
 * import events-store; only the reader is quarantined.
 */

/** Files permitted to import the reader (repo-relative POSIX). */
const ALLOWED_IMPORTERS = new Set([
  'source/cli/src/cli/log.ts',
  'source/cli/src/cli/aspects.ts',
  'source/cli/src/cli/advise.ts',
]);

/** Engine core layer — no file here may import the reader at all. */
const CORE_PREFIX = 'source/cli/src/core/';

/**
 * Test code is outside the enforcement engine, so it may import the reader freely
 * (the reader's own tests must). The boundary protects the production check /
 * verify / render / fill path, never the test tree.
 */
function isTestFile(filePath) {
  return filePath.startsWith('source/cli/tests/') || /\.(test|spec)\.[cm]?tsx?$/.test(filePath);
}

/**
 * Matches a module specifier that resolves to the events-reader module, with or
 * without a `.js` extension, as a bare module or a relative path. `events-store`
 * (the appender) does NOT match — the boundary between `-reader` and `-store` is
 * exact.
 */
const READER_MODULE_RE = /(^|\/)events-reader(\.js)?$/;

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

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (!file.ast) continue;
    if (isTestFile(file.path)) continue;

    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'import_statement' && node.type !== 'export_statement') return;
      const spec = stringValue(node.childForFieldName('source'));
      if (typeof spec !== 'string' || !READER_MODULE_RE.test(spec)) return;

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
        return;
      }

      if (!ALLOWED_IMPORTERS.has(file.path)) {
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
    });
  }

  return violations;
}
