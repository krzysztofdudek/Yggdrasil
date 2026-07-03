import { toPosixPath } from '../../utils/posix.js';
import { mappingEntryMatchesFile, normalizeMappingPath } from '../../utils/mapping-path.js';
import type { Graph } from '../../model/graph.js';

/**
 * portal/api/suppress-eligibility — the ONE file-eligibility rule shared by the
 * reviewer-honoring path and the `yg suppressions` audit inventory, split out of
 * the scan module so neither file grows past its focused boundary and the rule
 * lives in exactly one place.
 *
 * A real `yg-suppress` waiver lives in a SOURCE file that an aspect verifies —
 * the reviewer honors the marker there. Generated rules mirrors, per-node logs,
 * and prose docs only ever MENTION the marker syntax; they are not code an aspect
 * checks, so their marker-shaped text is noise, not a waiver. Exclude them so the
 * inventory lists only genuine code-side waivers.
 *
 * The noise filter applies to UNMAPPED files ONLY. A file that IS a mapped node
 * source is never noise — the reviewer-honoring path raw-scans any mapped
 * grammarless file, so a marker there is a LIVE waiver and MUST be inventoried.
 * Scoping the exclusion to unmapped prose keeps the honoring path and the audit
 * path on ONE eligibility rule, so no file can be a live waiver site while being
 * invisible to `yg suppressions`.
 *
 * Excluded (only when NOT a mapped source):
 *  - everything under `.yggdrasil/` — the generated `agent-rules.md` rules block,
 *    every node's `log.md`, aspect `content.md`, and `yg-node.yaml` examples.
 *    (A meta-modeling doc mapped under `.yggdrasil/` is a mapped source, so it is
 *    exempt from this exclusion and IS inventoried.)
 *  - generated rules mirrors written by `yg init` for other agents
 *    (`.cursor/...`, `.windsurfrules`, `.clinerules`, `.github/copilot-*`).
 *  - any `log.md` anywhere (per-node history is prose, never a waiver site).
 *  - prose/doc files (`.md`, `.mdc`, `.markdown`, `.txt`) — documentation and
 *    changelogs describe markers; they are not code an aspect checks.
 */
export function isNoiseFile(relFile: string): boolean {
  const p = toPosixPath(relFile);

  // .yggdrasil/ — generated rules, logs, aspect content, node yaml.
  if (p === '.yggdrasil' || p.startsWith('.yggdrasil/')) return true;

  // Generated rules mirrors for other agents (written by `yg init`).
  if (p.startsWith('.cursor/')) return true;
  if (p.startsWith('.github/copilot')) return true;
  const base = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
  if (base === '.windsurfrules' || base === '.clinerules') return true;

  // Per-node history is prose, never a real waiver site.
  if (base === 'log.md') return true;

  // Prose / documentation — describes marker syntax, not aspect-checked code.
  const lower = base.toLowerCase();
  if (
    lower.endsWith('.md') ||
    lower.endsWith('.mdc') ||
    lower.endsWith('.markdown') ||
    lower.endsWith('.txt')
  ) {
    return true;
  }

  return false;
}

/**
 * Every node mapping entry in the graph, normalized to POSIX. A git-tracked file
 * that matches one is a mapped node SOURCE — a file an aspect verifies and whose
 * in-source `yg-suppress` marker the reviewer honors — so the inventory must list
 * its markers regardless of extension. The two production callers (`yg suppressions`
 * and the portal) both derive this so the honoring path and the audit path share
 * one file-eligibility rule.
 */
export function collectMappingEntries(graph: Graph): string[] {
  const entries: string[] = [];
  for (const node of graph.nodes.values()) {
    for (const raw of node.meta.mapping ?? []) {
      const p = normalizeMappingPath(raw);
      if (p) entries.push(p);
    }
  }
  return entries;
}

/** True when `relFile` is covered by a node's mapping (a honored-waiver site). */
export function isMappedSource(relFile: string, mappingEntries: string[]): boolean {
  const p = toPosixPath(relFile);
  return mappingEntries.some((entry) => mappingEntryMatchesFile(entry, p));
}
