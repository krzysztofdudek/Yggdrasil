import { walk, report } from '@chrisdudek/yg/ast';

/**
 * Instrument import fence (G2/G6) — two AST-based, alias-proof import bans that
 * keep the read-only structural instrument (`yg structure`) from ever reaching
 * the build's gating decision, and keep the read-only presentation commands from
 * ever acquiring graph-write capability.
 *
 * This aspect cascades from the cli root node onto every descendant, so each
 * mapped source file is a subject of exactly one pair and EVERY potential
 * importer is seen. The check is self-contained: it inspects only its own subject
 * files (ctx.files), no cross-node reads.
 *
 * Both bans match a static `import ... from '<spec>'` or `export ... from
 * '<spec>'` — a string literal that merely contains the text is never a hit. A
 * statement-level type-only form (`import type … from`, `export type … from`) is
 * erased at compile and creates no runtime dependency, so neither ban fires on it.
 *
 *   (a) The GATING modules — the ones that shape the exit code, issue emission,
 *       and suggestedNext — must not import the structural-metrics core
 *       (core/graph-metrics) or the verdict-events reader (io/events-reader).
 *       Ranking and telemetry are instruments; letting either into the gate
 *       would let an instrument decide whether the build passes.
 *
 *   (b) The read-only PRESENTATION commands must not import OR re-export a YAML
 *       serializer. There is no dedicated YAML-writer io helper in this codebase
 *       (verified: the `yaml` package is imported only as `parse` in io/*), so the
 *       only YAML-write capability is the `yaml` package's serializer — a named
 *       import/re-export of stringify / stringifyDocument / Document, or a
 *       namespace / default import or `export * [as] … from 'yaml'` re-export
 *       (which exposes stringify). A pure `parse` import is read-only and allowed.
 */

/** Files whose imports decide the build outcome (exit code / issues / suggestedNext). */
const GATING_MODULES = new Set([
  'source/cli/src/cli/check.ts',
  'source/cli/src/core/check.ts',
  'source/cli/src/cli/group-issues.ts',
]);

/** Module specifiers no gating module may import (resolved, alias-proof). */
const FORBIDDEN_ON_GATING = [
  { re: /(^|\/)graph-metrics(\.js)?$/, label: 'the structural-metrics core (core/graph-metrics)' },
  { re: /(^|\/)events-reader(\.js)?$/, label: 'the verdict-events reader (io/events-reader)' },
];

/** Read-only presentation commands that must never gain YAML-write capability. */
const PRESENTATION_COMMANDS = new Set([
  'source/cli/src/cli/structure.ts',
  'source/cli/src/cli/aspects.ts',
  'source/cli/src/cli/log.ts',
]);

/** The `yaml` package (bare specifier) — the sole YAML-write surface in the repo. */
const YAML_MODULE_RE = /^yaml$/;

/** Named exports of the `yaml` package that WRITE YAML (serialize a value to text). */
const YAML_WRITE_SYMBOLS = new Set(['stringify', 'stringifyDocument', 'Document']);

/**
 * A statement-level type-only import/export (`import type … from`, `export type
 * … from`) is fully erased at compile — it creates NO runtime dependency, so
 * neither ban applies. The `type` modifier surfaces as a direct child token of
 * the statement; an inline `import { type X, y }` keeps `type` inside the
 * specifier (not a direct child), so a value import is never mistakenly skipped.
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
 * Inspect a `'yaml'` import statement and return the offending write surface it
 * pulls in, or null if it is read-only (e.g. `import { parse } from 'yaml'`).
 * Alias-proof: a named specifier is judged by its ORIGINAL name, not its alias.
 */
function yamlWriteImport(importNode) {
  const clause = importNode.namedChildren.find((c) => c.type === 'import_clause');
  if (!clause) return null; // side-effect import `import 'yaml'` — no binding, no write

  for (const child of clause.namedChildren) {
    // `import * as yaml from 'yaml'` — exposes the whole serializer surface.
    if (child.type === 'namespace_import') return 'the whole `yaml` module (namespace import)';
    // `import YAML from 'yaml'` — the default export also exposes stringify.
    if (child.type === 'identifier') return 'the `yaml` default export';
    // `import { parse, stringify as s } from 'yaml'` — judge each original name.
    if (child.type === 'named_imports') {
      for (const spec of child.namedChildren) {
        if (spec.type !== 'import_specifier') continue;
        const name = spec.childForFieldName('name');
        if (name && YAML_WRITE_SYMBOLS.has(name.text)) return `\`${name.text}\` from 'yaml'`;
      }
    }
  }
  return null;
}

/**
 * Inspect a `… from 'yaml'` RE-EXPORT and return the offending write surface it
 * re-publishes, or null if it re-exports only read helpers. Mirrors
 * yamlWriteImport for the export-from forms:
 *   export * from 'yaml'          → the whole module (star re-export)
 *   export * as yaml from 'yaml'  → the whole module (namespace re-export)
 *   export { stringify } from …   → judged per ORIGINAL name (alias-proof)
 *   export { default } from …     → the default export (which exposes stringify)
 */
function yamlWriteExport(exportNode) {
  // `export * as ns from 'yaml'` — re-publishes the whole serializer surface.
  if (exportNode.namedChildren.some((c) => c.type === 'namespace_export')) {
    return 'the whole `yaml` module (namespace re-export)';
  }
  const clause = exportNode.namedChildren.find((c) => c.type === 'export_clause');
  if (!clause) {
    // `export * from 'yaml'` — bare star re-publishes every export, stringify included.
    if (exportNode.children.some((c) => c.type === '*')) {
      return 'the whole `yaml` module (star re-export)';
    }
    return null;
  }
  for (const spec of clause.namedChildren) {
    if (spec.type !== 'export_specifier') continue;
    const name = spec.childForFieldName('name');
    if (!name) continue;
    if (YAML_WRITE_SYMBOLS.has(name.text)) return `\`${name.text}\` from 'yaml'`;
    if (name.text === 'default') return 'the `yaml` default export';
  }
  return null;
}

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (!file.ast) continue;

    const onGating = GATING_MODULES.has(file.path);
    const isPresentation = PRESENTATION_COMMANDS.has(file.path);
    if (!onGating && !isPresentation) continue; // not a fenced file — nothing to check

    walk(file.ast.rootNode, (node) => {
      const isImport = node.type === 'import_statement';
      const isExportFrom = node.type === 'export_statement';
      if (!isImport && !isExportFrom) return;

      const spec = stringValue(node.childForFieldName('source'));
      if (typeof spec !== 'string') return;

      // A statement-level type-only form is erased at compile — no runtime
      // dependency — so neither ban fires on it.
      if (isTypeOnly(node)) return;

      // (a) Gating modules — no metrics core, no telemetry reader.
      if (onGating) {
        for (const { re, label } of FORBIDDEN_ON_GATING) {
          if (re.test(spec)) {
            violations.push(
              report(
                file,
                node,
                `${file.path} shapes the build's exit code / issue emission / suggestedNext and may ` +
                  `not import ${label} ('${spec}'). Ranking and telemetry are read-only instruments — ` +
                  `keep them out of the gating path so an instrument can never decide whether the build passes.`,
              ),
            );
          }
        }
      }

      // (b) Presentation commands — no YAML-write capability, via import OR re-export.
      if (isPresentation && YAML_MODULE_RE.test(spec)) {
        const surface = isImport ? yamlWriteImport(node) : yamlWriteExport(node);
        if (surface) {
          violations.push(
            report(
              file,
              node,
              `${file.path} is a read-only presentation command and may not import or re-export a YAML ` +
                `serializer (${surface}). These commands report on the graph; they never rewrite it. Use ` +
                `only read helpers (e.g. \`parse\`), never the write side of the \`yaml\` package.`,
            ),
          );
        }
      }
    });
  }

  return violations;
}
